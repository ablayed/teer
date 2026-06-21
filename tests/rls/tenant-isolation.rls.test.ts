import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

// Phase 9 / Stage 6 — Garantie SYSTÉMATIQUE d'isolation tenant.
//
// Deux niveaux complémentaires :
//   1. STRUCTUREL (data-driven, connexion pg au catalogue) : pour CHAQUE table
//      portant `merchant_account_id`, on prouve RLS activée + FORCED, et que toute
//      policy existante est SOIT un déni total (`false`) SOIT tenant-scopée (via le
//      prédicat d'appartenance), avec un WITH CHECK présent sur toute policy
//      d'écriture. C'est le filet qui attrape une NOUVELLE table livrée sans RLS, une
//      policy en `true` (ouverte à tous) ou une écriture sans WITH CHECK — la classe
//      de fuite cross-tenant. (Les tests par domaine — orders/stock/finance/purchases/
//      drivers/customers/ia — prouvent en plus le déni de ligne réel.)
//   2. COMPORTEMENTAL (supabase-js, RLS appliquée) : déni de role-escalation
//      RLS-enforced (un non-owner ne lit pas une table owner-only) + aller-retour XOF
//      scale-0 (aucun drift /100) + déni de lecture cross-tenant direct.
//
// NB : l'ancien écart « un non-owner ne crée pas de membre » n'est plus vrai :
// depuis 0051, merchant_member.INSERT est owner-only au niveau RLS
// (current_member_role(merchant_account_id) = 'owner'), et 0071–0072 ajoutent en
// plus le garde-fou single-org par trigger. Le sweep structurel reste utile pour
// attraper tout futur relâchement de policy ou WITH CHECK manquant.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const hasEnv = Boolean(supabaseUrl && serviceRoleKey && anonKey);
const password = 'mot-de-passe-test-rls';
const createdUserIds: string[] = [];

function serviceClient() {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function makeUser(label: string): Promise<{ id: string; email: string }> {
  const email = `tenant-iso-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const { data, error } = await serviceClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(error).toBeNull();
  const id = data.user?.id;
  if (!id) {
    throw new Error('Utilisateur non créé');
  }
  createdUserIds.push(id);
  return { id, email };
}

async function makeUserWithoutOrg(label: string): Promise<{ id: string; email: string }> {
  const user = await makeUser(label);
  const { error } = await serviceClient()
    .from('merchant_account')
    .delete()
    .eq('owner_user_id', user.id);
  expect(error).toBeNull();
  return user;
}

async function authClientFor(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  expect(error).toBeNull();
  return client;
}

async function accountIdOf(userId: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from('merchant_account')
    .select('id')
    .eq('owner_user_id', userId)
    .single();
  expect(error).toBeNull();
  if (!data) {
    throw new Error('Compte marchand introuvable');
  }
  return data.id;
}

// Tokens prouvant qu'une expression de policy est scopée au tenant/à l'utilisateur.
const SCOPE_TOKENS = [
  'is_member_of',
  'current_member_role',
  'merchant_account_id',
  'auth.uid',
  'merchant_member',
];

// Classe une expression USING/WITH CHECK. 'na' = absente, 'deny' = déni total (safe),
// 'allow_all' = ouverte à tous (UNSAFE), 'scoped' = tenant-scopée (safe),
// 'unscoped' = ni déni ni scopée (à signaler).
function classifyExpr(expr: string | null): 'na' | 'deny' | 'allow_all' | 'scoped' | 'unscoped' {
  if (expr === null) {
    return 'na';
  }
  const normalized = expr
    .trim()
    .replace(/^\(+|\)+$/g, '')
    .trim();
  if (normalized === 'false') {
    return 'deny';
  }
  if (normalized === 'true') {
    return 'allow_all';
  }
  return SCOPE_TOKENS.some((t) => expr.includes(t)) ? 'scoped' : 'unscoped';
}

afterEach(async () => {
  if (!hasEnv) {
    return;
  }
  const svc = serviceClient();
  await Promise.all(createdUserIds.map((id) => svc.auth.admin.deleteUser(id)));
  createdUserIds.length = 0;
});

describe.skipIf(!hasEnv)('Tenant isolation — sweep structurel + comportemental', () => {
  it('chaque table tenant a RLS FORCED, des policies tenant-scopées (ou déni) et un WITH CHECK en écriture', async () => {
    const pg = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });
    await pg.connect();
    try {
      const { rows: tenantTables } = await pg.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(`
        select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_attribute a
          on a.attrelid = c.oid and a.attname = 'merchant_account_id' and not a.attisdropped
        where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace
        order by c.relname
      `);

      // Garde-fou : on a bien découvert l'ensemble des tables tenant (sinon faux vert).
      expect(tenantTables.length).toBeGreaterThan(10);

      const { rows: policies } = await pg.query<{
        tablename: string;
        policyname: string;
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }>(`
        select tablename, policyname, cmd, qual, with_check
        from pg_policies
        where schemaname = 'public'
      `);

      // Exception FORCE documentée (Phase 8) : ia_tool_audit est ENABLE-sans-FORCE
      // à dessein — le writer SECURITY DEFINER doit pouvoir journaliser les refus
      // d'outils même quand la RLS de l'appelant bloquerait. Les utilisateurs
      // authentifiés normaux restent isolés par ENABLE (SELECT owner-only) ; FORCE ne
      // concerne que le rôle propriétaire de la table.
      const forceExceptions = new Set<string>(['ia_tool_audit']);

      const problems: string[] = [];
      for (const t of tenantTables) {
        if (!t.relrowsecurity) {
          problems.push(`${t.relname} : RLS non activée`);
        }
        if (!t.relforcerowsecurity && !forceExceptions.has(t.relname)) {
          problems.push(`${t.relname} : RLS non FORCED`);
        }
        // Zéro policy + RLS FORCED = déni total aux utilisateurs (isolation maximale),
        // p. ex. webhook_event écrit uniquement par le service role. C'est SÛR.
        const tablePolicies = policies.filter((p) => p.tablename === t.relname);
        for (const p of tablePolicies) {
          const qual = classifyExpr(p.qual);
          const check = classifyExpr(p.with_check);
          // L'expression USING gouverne SELECT/DELETE/UPDATE ; WITH CHECK gouverne
          // INSERT/UPDATE. Un déni (`false`) ou un scopage tenant est sûr ; une
          // expression ouverte (`true`) ou non-scopée est signalée.
          for (const [kind, cls] of [
            ['USING', qual],
            ['CHECK', check],
          ] as const) {
            if (cls === 'allow_all') {
              problems.push(
                `${t.relname}/${p.policyname} (${p.cmd}) : ${kind} ouvert à tous (true)`,
              );
            } else if (cls === 'unscoped') {
              problems.push(`${t.relname}/${p.policyname} (${p.cmd}) : ${kind} non tenant-scopé`);
            }
          }
          // Toute policy d'écriture doit porter un WITH CHECK (sinon écriture possible
          // hors périmètre tenant). 'deny' (false) compte comme présent.
          if ((p.cmd === 'INSERT' || p.cmd === 'UPDATE' || p.cmd === 'ALL') && check === 'na') {
            problems.push(`${t.relname}/${p.policyname} (${p.cmd}) : WITH CHECK manquant`);
          }
        }
      }

      expect(problems).toEqual([]);
    } finally {
      await pg.end();
    }
  });

  it('un non-owner ne lit pas une table owner-only (déni de role-escalation RLS)', async () => {
    const owner = await makeUser('po-owner');
    const accountA = await accountIdOf(owner.id);
    const manager = await makeUserWithoutOrg('po-manager');

    const svc = serviceClient();
    const addMember = await svc
      .from('merchant_member')
      .insert({ merchant_account_id: accountA, user_id: manager.id, role: 'manager' });
    expect(addMember.error).toBeNull();

    // purchase_lot est owner-only au niveau RLS (current_member_role = 'owner').
    const seedLot = await svc
      .from('purchase_lot')
      .insert({
        merchant_account_id: accountA,
        ordered_at: new Date().toISOString(),
        supplier_name: 'Fournisseur Test',
      })
      .select('id')
      .single();
    expect(seedLot.error).toBeNull();

    // L'owner voit son lot ; le manager (même tenant) ne le voit pas.
    const ownerClient = await authClientFor(owner.email);
    const ownerRows = await ownerClient
      .from('purchase_lot')
      .select('id')
      .eq('merchant_account_id', accountA);
    expect(ownerRows.error).toBeNull();
    expect((ownerRows.data ?? []).length).toBeGreaterThanOrEqual(1);

    const managerClient = await authClientFor(manager.email);
    const managerRows = await managerClient
      .from('purchase_lot')
      .select('id')
      .eq('merchant_account_id', accountA);
    expect(managerRows.error).toBeNull();
    expect(managerRows.data).toEqual([]);

    // Et un manager ne peut pas créer de lot (WITH CHECK owner-only).
    const managerInsert = await managerClient
      .from('purchase_lot')
      .insert({
        merchant_account_id: accountA,
        ordered_at: new Date().toISOString(),
        supplier_name: 'Tentative manager',
      })
      .select();
    expect(managerInsert.error).not.toBeNull();
    expect(managerInsert.data).toBeNull();
  });

  it('aucun drift d’échelle sur un montant minor-unit (XOF scale 0, aller-retour)', async () => {
    const owner = await makeUser('xof');
    const accountA = await accountIdOf(owner.id);
    const amountMinor = 1234567; // F CFA en unités mineures — entier, scale 0

    const svc = serviceClient();
    const { data: inserted, error: insErr } = await svc
      .from('orders')
      .insert({
        merchant_account_id: accountA,
        cash_collectable_minor: amountMinor,
        total_amount: amountMinor,
      })
      .select('id, cash_collectable_minor')
      .single();
    expect(insErr).toBeNull();
    if (!inserted) {
      throw new Error('Commande non créée');
    }

    const ownerClient = await authClientFor(owner.email);
    const { data: readBack, error: readErr } = await ownerClient
      .from('orders')
      .select('cash_collectable_minor')
      .eq('id', inserted.id)
      .single();
    expect(readErr).toBeNull();
    // Aucun /100 ni arrondi : la valeur revient à l'identique, en entier.
    expect(Number(readBack?.cash_collectable_minor)).toBe(amountMinor);
  });

  it('un tenant ne lit jamais une commande d’un autre tenant', async () => {
    const ownerA = await makeUser('a');
    const accountA = await accountIdOf(ownerA.id);
    const svc = serviceClient();
    const { data: orderA, error } = await svc
      .from('orders')
      .insert({ merchant_account_id: accountA, total_amount: 5000 })
      .select('id')
      .single();
    expect(error).toBeNull();
    if (!orderA) {
      throw new Error('Commande A non créée');
    }

    const ownerB = await makeUser('b');
    const clientB = await authClientFor(ownerB.email);
    const { data: rows, error: selErr } = await clientB
      .from('orders')
      .select('id')
      .eq('id', orderA.id);
    expect(selErr).toBeNull();
    expect(rows).toEqual([]);
  });
});
