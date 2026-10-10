import type { Database } from '@/lib/supabase/database.types';
import { isLastOwnerViolation } from '@/lib/team/last-owner';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

// 0162 — Appartenance : écritures directes fermées, dernier owner gardé en base.
//
// Ce que ces tests verrouillent :
//   A. aucune session ne supprime ni ne modifie une ligne merchant_member (mm_delete supprimée) ;
//   B. aucune session n'insère ni ne modifie une ligne shop_member (deux politiques supprimées) ;
//   C. le dernier owner ne peut être ni retiré ni rétrogradé, quel que soit le rôle appelant
//      (service-role et SQL direct compris), et deux retraits concurrents sont sérialisés ;
//   D. les deux cascades légitimes passent : suppression du compte, suppression de l'utilisateur.
//
// Mutations attendues, chacune devant rougir un test nommé ci-dessous :
//   * recréer mm_delete (0001:77)            → « A · … DELETE merchant_member … » ;
//   * recréer shop_member_update (0126:161)  → « B · manager · PATCH shop_member … » ;
//   * recréer shop_member_insert (0126:158)  → « B · manager · POST shop_member … » ;
//   * supprimer le trigger du dernier owner  → « C · … » (service-role, SQL direct, concurrence).
//
// Les essais de concurrence répétés tournent sur des connexions PostgreSQL directes, sous le RÔLE
// de base concerné (`set local role`), et non par la passerelle HTTP. Motif mesuré : en CI, deux
// exécutions initiales de ce fichier ont échoué sur « An invalid response was received from the
// upstream server » au milieu de ces boucles, erreur de la passerelle que la suite connaît déjà
// sur des requêtes non idempotentes. La garde vit en base : c'est là que la course se joue.

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'membership-write-guards-password';
const CONCURRENCY_TRIALS = 20;
const suite = serviceKey ? describe : describe.skip;

type Client = SupabaseClient<Database>;
type Role = 'owner' | 'manager' | 'agent';
type ActorKey = 'owner1' | 'owner1b' | 'manager' | 'agent' | 'noshop' | 'owner2';
type ShopKey = 's1' | 's2' | 's3' | 's4' | 't1';

const createdUsers: string[] = [];
const pgClients: TestPostgresClient[] = [];

async function connect() {
  const client = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', {
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  pgClients.push(client);
  return client;
}

function admin(): Client {
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createUser(a: Client, email: string) {
  const { data, error } = await a.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('user');
  createdUsers.push(data.user.id);
  return data.user.id;
}

async function login(email: string) {
  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function accountOf(a: Client, ownerId: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const { data } = await a
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', ownerId)
      .maybeSingle();
    if (data?.id) return data.id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('merchant_account introuvable');
}

/** Compte neuf dont le créateur est l'unique owner. */
async function soloAccount(a: Client, tag: string) {
  const email = `mwg-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const userId = await createUser(a, email);
  const merchantId = await accountOf(a, userId);
  return { email, merchantId, userId };
}

/** Utilisateur neuf, sorti de son compte d'inscription (cascade « compte »), ajouté au nôtre. */
async function addMember(a: Client, merchantId: string, role: Role, tag: string) {
  const email = `mwg-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const userId = await createUser(a, email);
  const left = await a.from('merchant_account').delete().eq('owner_user_id', userId);
  if (left.error) throw left.error;
  const joined = await a
    .from('merchant_member')
    .insert({ merchant_account_id: merchantId, role, user_id: userId })
    .select('id')
    .single();
  if (joined.error || !joined.data) throw joined.error ?? new Error('member');
  return { email, memberId: joined.data.id, userId };
}

type DbRole = 'authenticated' | 'service_role';

/**
 * Exécute une instruction sous un rôle de base, dans sa propre transaction. `sub` pose
 * l'identité que lit `auth.uid()` ; sans lui, c'est un appel de service.
 */
async function runAs(
  client: TestPostgresClient,
  role: DbRole,
  sub: string | null,
  sql: string,
  params: unknown[],
) {
  await client.query('begin');
  try {
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(sub ? { role, sub } : { role }),
    ]);
    const result = await client.query(sql, params);
    await client.query('commit');
    return { code: null as string | null, rows: result.rowCount ?? 0 };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return { code: (error as { code?: string }).code ?? 'inconnu', rows: 0 };
  }
}

async function ownerCountSql(client: TestPostgresClient, merchantId: string) {
  const { rows } = await client.query(
    `select count(*)::int as n from public.merchant_member
      where merchant_account_id = $1 and role = 'owner'`,
    [merchantId],
  );
  return rows[0].n as number;
}

async function ownerCount(a: Client, merchantId: string) {
  const { count, error } = await a
    .from('merchant_member')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_account_id', merchantId)
    .eq('role', 'owner');
  if (error) throw error;
  return count ?? 0;
}

afterAll(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.end().catch(() => undefined)));
  if (!serviceKey) return;
  const a = admin();
  await Promise.all(createdUsers.splice(0).map((id) => a.auth.admin.deleteUser(id)));
});

suite('0162 — écritures directes d appartenance par une session', () => {
  let a: Client;
  let pg: TestPostgresClient;
  let m1 = '';
  let m2 = '';
  const users = {} as Record<ActorKey, string>;
  const sessions = {} as Record<ActorKey, Client>;
  const shops = {} as Record<ShopKey, string>;

  /** Remet le compte dans son état de référence : rôles de compte et accès par boutique. */
  async function canon() {
    await pg.query('begin');
    try {
      await pg.query(
        `insert into public.merchant_member (merchant_account_id, user_id, role)
         values ($1, $2, 'owner'), ($1, $3, 'owner'), ($1, $4, 'manager'), ($1, $5, 'agent'),
                ($1, $6, 'agent')
         on conflict (merchant_account_id, user_id) do update set role = excluded.role`,
        [m1, users.owner1, users.owner1b, users.manager, users.agent, users.noshop],
      );
      await pg.query('delete from public.shop_member where merchant_account_id = $1', [m1]);
      await pg.query(
        `insert into public.shop_member (merchant_account_id, shop_id, user_id, role)
         select $1::uuid, s.id, u.id, 'owner'
           from unnest($2::uuid[]) as s(id) cross join unnest($3::uuid[]) as u(id)
         union all
         select $1::uuid, $4::uuid, $5::uuid, 'manager'
         union all
         select $1::uuid, $4::uuid, $6::uuid, 'agent'`,
        [
          m1,
          [shops.s1, shops.s2, shops.s3, shops.s4],
          [users.owner1, users.owner1b],
          shops.s1,
          users.manager,
          users.agent,
        ],
      );
      await pg.query('commit');
    } catch (error) {
      await pg.query('rollback');
      throw error;
    }
  }

  /** État complet des deux tables pour le compte : sert à prouver qu'un refus n'a rien écrit. */
  async function snapshot() {
    const members = await pg.query(
      `select user_id, role from public.merchant_member
        where merchant_account_id = $1 order by user_id`,
      [m1],
    );
    const access = await pg.query(
      `select shop_id, user_id, role, merchant_account_id from public.shop_member
        where merchant_account_id = $1 or user_id = any($2::uuid[]) order by shop_id, user_id`,
      [m1, Object.values(users)],
    );
    return JSON.stringify({ access: access.rows, members: members.rows });
  }

  beforeAll(async () => {
    if (!serviceKey) return;
    a = admin();
    pg = await connect();

    const first = await soloAccount(a, 'owner1');
    m1 = first.merchantId;
    users.owner1 = first.userId;
    const other = await soloAccount(a, 'owner2');
    m2 = other.merchantId;
    users.owner2 = other.userId;

    const emails = { owner1: first.email, owner2: other.email } as Record<ActorKey, string>;
    for (const [key, role] of [
      ['owner1b', 'owner'],
      ['manager', 'manager'],
      ['agent', 'agent'],
      ['noshop', 'agent'],
    ] as const) {
      const member = await addMember(a, m1, role, key);
      users[key] = member.userId;
      emails[key] = member.email;
    }

    const defaults = await a
      .from('shop')
      .select('id, merchant_account_id')
      .in('merchant_account_id', [m1, m2])
      .eq('is_default', true);
    if (defaults.error) throw defaults.error;
    for (const row of defaults.data ?? []) {
      if (row.merchant_account_id === m1) shops.s1 = row.id;
      else shops.t1 = row.id;
    }
    for (const key of ['s2', 's3', 's4'] as const) {
      const created = await a
        .from('shop')
        .insert({
          display_name: key.toUpperCase(),
          merchant_account_id: m1,
          scopes: '',
          shop_domain: `mwg-${key}-${Date.now()}-${Math.random().toString(36).slice(2)}.internal`,
          store_kind: 'manual',
        })
        .select('id')
        .single();
      if (created.error || !created.data) throw created.error ?? new Error('shop');
      shops[key] = created.data.id;
    }
    for (let i = 0; i < 3; i++) {
      const order = await a.from('orders').insert({
        call_state: 'to_call',
        cash_state: 'not_due',
        currency: 'XOF',
        delivery_state: 'unassigned',
        merchant_account_id: m1,
        order_number: `MWG-S3-${Date.now()}-${i}`,
        order_state: 'open',
        shop_id: shops.s3,
        total_amount: 1000,
      });
      if (order.error) throw order.error;
    }

    await canon();
    for (const key of Object.keys(emails) as ActorKey[]) {
      sessions[key] = await login(emails[key]);
    }
  }, 120_000);

  // ── A. merchant_member ──────────────────────────────────────────────────────────────────
  const memberDeletes: Array<[string, ActorKey, ActorKey, string]> = [
    ['A1', 'agent', 'owner1', 'la ligne d un owner'],
    ['A2', 'agent', 'manager', 'un membre de rôle supérieur'],
    ['A3', 'agent', 'noshop', 'un autre agent'],
    ['A4', 'agent', 'agent', 'sa propre ligne'],
    ['A5', 'manager', 'owner1', 'la ligne d un owner'],
    ['A6', 'manager', 'manager', 'sa propre ligne'],
    ['A7', 'owner1b', 'owner1', 'l autre owner'],
    ['A8', 'owner2', 'owner1', 'un membre d un autre compte'],
    ['A9', 'noshop', 'owner1', 'un owner, sans accès à aucune boutique'],
    ['A11', 'owner1', 'owner1', 'sa propre ligne d owner'],
  ];

  it.each(memberDeletes)(
    'A · %s · %s · DELETE merchant_member (%s → %s) : 0 ligne, rien d écrit',
    async (_id, actor, target) => {
      await canon();
      const before = await snapshot();
      const res = await sessions[actor]
        .from('merchant_member')
        .delete()
        .eq('merchant_account_id', m1)
        .eq('user_id', users[target])
        .select('id');
      expect(res.error).toBeNull();
      expect(res.data).toEqual([]);
      expect(await snapshot()).toBe(before);
    },
  );

  it('A · A10 · agent · DELETE merchant_member des deux owners à la suite : le compte garde ses deux owners', async () => {
    await canon();
    for (const target of ['owner1b', 'owner1'] as const) {
      const res = await sessions.agent
        .from('merchant_member')
        .delete()
        .eq('merchant_account_id', m1)
        .eq('user_id', users[target])
        .select('id');
      expect(res.data).toEqual([]);
    }
    expect(await ownerCount(a, m1)).toBe(2);
  });

  it(`A · A12 · deux owners · DELETE croisés simultanés sous le rôle authenticated, ${CONCURRENCY_TRIALS} essais : jamais une ligne supprimée`, async () => {
    await canon();
    const [left, right] = await Promise.all([connect(), connect()]);
    const sql =
      'delete from public.merchant_member where merchant_account_id = $1 and user_id = $2';
    for (let trial = 0; trial < CONCURRENCY_TRIALS; trial++) {
      const results = await Promise.all([
        runAs(left, 'authenticated', users.owner1, sql, [m1, users.owner1b]),
        runAs(right, 'authenticated', users.owner1b, sql, [m1, users.owner1]),
      ]);
      expect(results, `essai ${trial}`).toEqual([
        { code: null, rows: 0 },
        { code: null, rows: 0 },
      ]);
      expect(await ownerCountSql(pg, m1), `essai ${trial}`).toBe(2);
    }
  });

  it('A · A13 · après un retrait, seul un owner réinsère le membre', async () => {
    await canon();
    const removed = await a
      .from('merchant_member')
      .delete()
      .eq('merchant_account_id', m1)
      .eq('user_id', users.manager);
    expect(removed.error).toBeNull();
    const row = { merchant_account_id: m1, role: 'manager', user_id: users.manager };

    const byAgent = await sessions.agent.from('merchant_member').insert(row).select('id');
    expect(byAgent.error?.code).toBe('42501');
    const bySelf = await sessions.manager.from('merchant_member').insert(row).select('id');
    expect(bySelf.error?.code).toBe('42501');
    const asOwner = await sessions.manager
      .from('merchant_member')
      .insert({ ...row, role: 'owner' })
      .select('id');
    expect(asOwner.error?.code).toBe('42501');

    const byOwner = await sessions.owner1.from('merchant_member').insert(row).select('id');
    expect(byOwner.error).toBeNull();
    expect(byOwner.data).toHaveLength(1);
  });

  it('A · A14 · agent · PATCH merchant_member (se donner le rôle owner) : 0 ligne', async () => {
    await canon();
    const before = await snapshot();
    const res = await sessions.agent
      .from('merchant_member')
      .update({ role: 'owner' })
      .eq('merchant_account_id', m1)
      .eq('user_id', users.agent)
      .select('id');
    expect(res.data ?? []).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it('A · A14 bis · owner · PATCH merchant_member (rétrograder l autre owner) : 0 ligne, aucune politique UPDATE', async () => {
    await canon();
    const before = await snapshot();
    const res = await sessions.owner1
      .from('merchant_member')
      .update({ role: 'agent' })
      .eq('merchant_account_id', m1)
      .eq('user_id', users.owner1b)
      .select('id');
    expect(res.data ?? []).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it('A · A15 · agent · POST merchant_member (ajouter un tiers comme owner) : refusé', async () => {
    await canon();
    const before = await snapshot();
    const res = await sessions.agent
      .from('merchant_member')
      .insert({ merchant_account_id: m1, role: 'owner', user_id: users.owner2 })
      .select('id');
    // Refus par la garde d'organisation unique (P0001) ou par mm_insert (42501), selon l'ordre.
    expect(res.error).not.toBeNull();
    expect(await snapshot()).toBe(before);
  });

  // ── B. shop_member ──────────────────────────────────────────────────────────────────────
  type ShopPatch = {
    id: string;
    label: string;
    patch: (actor: 'manager' | 'agent') => Database['public']['Tables']['shop_member']['Update'];
    target: (actor: 'manager' | 'agent') => { shop: ShopKey; user: ActorKey };
  };
  const shopPatches: ShopPatch[] = [
    {
      id: '1',
      label: 'passer son propre rôle sur S1 à owner',
      patch: () => ({ role: 'owner' }),
      target: (actor) => ({ shop: 's1', user: actor }),
    },
    {
      id: '2',
      label: 'rétrograder l owner en agent sur S1',
      patch: () => ({ role: 'agent' }),
      target: () => ({ shop: 's1', user: 'owner1' }),
    },
    {
      id: '3',
      label: 'déplacer sa ligne de S1 vers S3',
      patch: () => ({ shop_id: shops.s3 }),
      target: (actor) => ({ shop: 's1', user: actor }),
    },
    {
      id: '4',
      label: 's attribuer la ligne de l owner sur S2',
      patch: (actor) => ({ user_id: users[actor] }),
      target: () => ({ shop: 's2', user: 'owner1' }),
    },
    {
      id: '5',
      label: 'déplacer sa ligne vers la boutique d un autre compte',
      patch: () => ({ merchant_account_id: m2, shop_id: shops.t1 }),
      target: (actor) => ({ shop: 's1', user: actor }),
    },
  ];

  for (const actor of ['manager', 'agent'] as const) {
    const prefix = actor === 'manager' ? 'B' : 'C';

    it.each(shopPatches)(
      `B · ${actor} · PATCH shop_member · ${prefix}$id · $label : 0 ligne, rien d écrit`,
      async ({ patch, target }) => {
        await canon();
        const before = await snapshot();
        const { shop, user } = target(actor);
        const res = await sessions[actor]
          .from('shop_member')
          .update(patch(actor))
          .eq('shop_id', shops[shop])
          .eq('user_id', users[user])
          .select('id');
        expect(res.data ?? []).toEqual([]);
        expect(await snapshot()).toBe(before);
      },
    );

    it(`B · ${actor} · POST shop_member · ${prefix}6 · s ajouter sur S3 comme owner : refusé, commandes de S3 toujours invisibles`, async () => {
      await canon();
      const before = await snapshot();
      const res = await sessions[actor]
        .from('shop_member')
        .insert({
          merchant_account_id: m1,
          role: 'owner',
          shop_id: shops.s3,
          user_id: users[actor],
        })
        .select('id');
      expect(res.error?.code).toBe('42501');
      expect(await snapshot()).toBe(before);

      const seen = await sessions[actor].from('orders').select('id').eq('shop_id', shops.s3);
      expect(seen.data).toEqual([]);
      const deleted = await sessions[actor]
        .from('orders')
        .delete()
        .eq('shop_id', shops.s3)
        .select('id');
      expect(deleted.data ?? []).toEqual([]);
      const kept = await a
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('shop_id', shops.s3);
      expect(kept.count).toBe(3);
    });

    it(`B · ${actor} · POST shop_member · ${prefix}7 · ajouter un tiers sur S2 comme owner : refusé`, async () => {
      await canon();
      const before = await snapshot();
      const res = await sessions[actor]
        .from('shop_member')
        .insert({
          merchant_account_id: m1,
          role: 'owner',
          shop_id: shops.s2,
          user_id: users.noshop,
        })
        .select('id');
      expect(res.error?.code).toBe('42501');
      expect(await snapshot()).toBe(before);
    });

    it(`B · ${actor} · POST shop_member · ${prefix}8 · devenir owner de S4 puis supprimer S4 : refusé, la boutique existe toujours`, async () => {
      await canon();
      const before = await snapshot();
      const res = await sessions[actor]
        .from('shop_member')
        .insert({
          merchant_account_id: m1,
          role: 'owner',
          shop_id: shops.s4,
          user_id: users[actor],
        })
        .select('id');
      expect(res.error?.code).toBe('42501');
      const dropped = await sessions[actor].from('shop').delete().eq('id', shops.s4).select('id');
      expect(dropped.data ?? []).toEqual([]);
      const still = await a.from('shop').select('id').eq('id', shops.s4);
      expect(still.data).toHaveLength(1);
      expect(await snapshot()).toBe(before);
    });
  }

  it('B · owner · la suppression d un accès par l owner du compte reste permise (shop_member_delete inchangée)', async () => {
    await canon();
    const res = await sessions.owner1
      .from('shop_member')
      .delete()
      .eq('shop_id', shops.s1)
      .eq('user_id', users.agent)
      .select('id');
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
    await canon();
  });
});

suite('0162 — dernier owner : garde en base pour tous les rôles', () => {
  let a: Client;

  beforeAll(() => {
    if (serviceKey) a = admin();
  });

  it('C · service-role · retirer un owner sur deux passe, retirer le dernier lève 23514 last_owner', async () => {
    const account = await soloAccount(a, 'c-del');
    const second = await addMember(a, account.merchantId, 'owner', 'c-del-b');

    const first = await a.from('merchant_member').delete().eq('id', second.memberId).select('id');
    expect(first.error).toBeNull();
    expect(first.data).toHaveLength(1);

    const last = await a
      .from('merchant_member')
      .delete()
      .eq('merchant_account_id', account.merchantId)
      .eq('user_id', account.userId)
      .select('id');
    expect(last.error?.code).toBe('23514');
    expect(last.error?.message).toContain('last_owner');
    // L'erreur réelle de PostgREST est bien celle que l'action serveur sait reconnaître.
    expect(isLastOwnerViolation(last.error)).toBe(true);
    expect(await ownerCount(a, account.merchantId)).toBe(1);
  });

  it('C · service-role · rétrograder le dernier owner lève 23514, puis passe dès qu un second owner existe', async () => {
    const account = await soloAccount(a, 'c-upd');
    const manager = await addMember(a, account.merchantId, 'manager', 'c-upd-b');

    const refused = await a
      .from('merchant_member')
      .update({ role: 'manager' })
      .eq('merchant_account_id', account.merchantId)
      .eq('user_id', account.userId)
      .select('id');
    expect(refused.error?.code).toBe('23514');
    expect(isLastOwnerViolation(refused.error)).toBe(true);
    expect(await ownerCount(a, account.merchantId)).toBe(1);

    const promoted = await a
      .from('merchant_member')
      .update({ role: 'owner' })
      .eq('id', manager.memberId)
      .select('id');
    expect(promoted.error).toBeNull();
    const allowed = await a
      .from('merchant_member')
      .update({ role: 'manager' })
      .eq('merchant_account_id', account.merchantId)
      .eq('user_id', account.userId)
      .select('id');
    expect(allowed.error).toBeNull();
    expect(allowed.data).toHaveLength(1);
    expect(await ownerCount(a, account.merchantId)).toBe(1);
  });

  it('C · service-role · une instruction qui retire tous les membres échoue entièrement', async () => {
    const account = await soloAccount(a, 'c-all');
    await addMember(a, account.merchantId, 'owner', 'c-all-b');
    await addMember(a, account.merchantId, 'agent', 'c-all-c');

    const res = await a
      .from('merchant_member')
      .delete()
      .eq('merchant_account_id', account.merchantId)
      .select('id');
    expect(res.error?.code).toBe('23514');
    const left = await a
      .from('merchant_member')
      .select('id', { count: 'exact', head: true })
      .eq('merchant_account_id', account.merchantId);
    expect(left.count).toBe(3);
  });

  it('C · service-role · une instruction qui rétrograde tous les owners échoue entièrement', async () => {
    const account = await soloAccount(a, 'c-allupd');
    await addMember(a, account.merchantId, 'owner', 'c-allupd-b');

    const res = await a
      .from('merchant_member')
      .update({ role: 'agent' })
      .eq('merchant_account_id', account.merchantId)
      .eq('role', 'owner')
      .select('id');
    expect(res.error?.code).toBe('23514');
    expect(await ownerCount(a, account.merchantId)).toBe(2);
  });

  it('C · SQL direct (postgres) · retirer, rétrograder ou déplacer le dernier owner lève 23514', async () => {
    const account = await soloAccount(a, 'c-sql');
    const elsewhere = await soloAccount(a, 'c-sql-other');
    const pg = await connect();

    for (const [label, sql, params] of [
      [
        'DELETE',
        'delete from public.merchant_member where merchant_account_id = $1 and user_id = $2',
        [account.merchantId, account.userId],
      ],
      [
        'UPDATE role',
        `update public.merchant_member set role = 'agent'
          where merchant_account_id = $1 and user_id = $2`,
        [account.merchantId, account.userId],
      ],
      [
        'UPDATE merchant_account_id',
        `update public.merchant_member set merchant_account_id = $3
          where merchant_account_id = $1 and user_id = $2`,
        [account.merchantId, account.userId, elsewhere.merchantId],
      ],
    ] as const) {
      await expect(pg.query(sql, [...params]), label).rejects.toMatchObject({
        code: '23514',
        message: 'last_owner',
      });
    }
    expect(await ownerCount(a, account.merchantId)).toBe(1);
  });

  it('C · verrou · un second retrait ATTEND le premier, puis échoue : les deux retraits sont sérialisés', async () => {
    const account = await soloAccount(a, 'c-lock');
    const second = await addMember(a, account.merchantId, 'owner', 'c-lock-b');
    const [first, other, observer] = await Promise.all([connect(), connect(), connect()]);

    await first.query('begin');
    await first.query('delete from public.merchant_member where id = $1', [second.memberId]);

    const otherPid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid;
    const pending = other
      .query('delete from public.merchant_member where merchant_account_id = $1 and user_id = $2', [
        account.merchantId,
        account.userId,
      ])
      .then(
        () => ({ code: null as string | null }),
        (error: { code?: string }) => ({ code: error.code ?? 'inconnu' }),
      );

    // Le second retrait est bloqué sur un verrou tant que le premier n'a pas validé.
    let waiting = false;
    for (let attempt = 0; attempt < 50 && !waiting; attempt++) {
      const state = await observer.query(
        'select wait_event_type from pg_stat_activity where pid = $1',
        [otherPid],
      );
      waiting = state.rows[0]?.wait_event_type === 'Lock';
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(waiting).toBe(true);

    await first.query('commit');
    expect(await pending).toEqual({ code: '23514' });
    expect(await ownerCount(a, account.merchantId)).toBe(1);
  });

  type Attempt = 'delete' | 'demote';
  const attemptSql: Record<Attempt, string> = {
    delete: 'delete from public.merchant_member where id = $1',
    demote: "update public.merchant_member set role = 'manager' where id = $1",
  };
  const concurrentPairs: Array<[string, Attempt, Attempt]> = [
    ['deux retraits', 'delete', 'delete'],
    ['deux rétrogradations', 'demote', 'demote'],
    ['un retrait et une rétrogradation', 'delete', 'demote'],
  ];

  it.each(concurrentPairs)(
    `C · service_role · concurrence · %s croisés, ${CONCURRENCY_TRIALS} essais : exactement un aboutit, il reste un owner`,
    async (_label, left, right) => {
      const account = await soloAccount(a, 'c-race');
      const other = await addMember(a, account.merchantId, 'owner', 'c-race-b');
      const [first, second, control] = await Promise.all([connect(), connect(), connect()]);
      const memberIds = async () => {
        const { rows } = await control.query(
          'select id, user_id from public.merchant_member where merchant_account_id = $1',
          [account.merchantId],
        );
        const idOf = (userId: string) => rows.find((row) => row.user_id === userId)?.id as string;
        return { creator: idOf(account.userId), other: idOf(other.userId) };
      };

      for (let trial = 0; trial < CONCURRENCY_TRIALS; trial++) {
        const ids = await memberIds();
        const results = await Promise.all([
          runAs(first, 'service_role', null, attemptSql[left], [ids.creator]),
          runAs(second, 'service_role', null, attemptSql[right], [ids.other]),
        ]);
        const refused = results.filter((result) => result.code !== null);
        expect(refused, `essai ${trial}`).toHaveLength(1);
        expect(refused[0]?.code, `essai ${trial}`).toBe('23514');
        expect(results.filter((result) => result.rows === 1)).toHaveLength(1);
        expect(await ownerCountSql(control, account.merchantId), `essai ${trial}`).toBe(1);

        // Remise à deux owners pour l'essai suivant.
        await control.query(
          `insert into public.merchant_member (merchant_account_id, user_id, role)
           values ($1, $2, 'owner'), ($1, $3, 'owner')
           on conflict (merchant_account_id, user_id) do update set role = excluded.role`,
          [account.merchantId, account.userId, other.userId],
        );
        expect(await ownerCountSql(control, account.merchantId)).toBe(2);
      }
    },
    120_000,
  );

  // ── D. Cascades légitimes ───────────────────────────────────────────────────────────────
  it('D · cascade compte · supprimer le compte retire son unique owner', async () => {
    const account = await soloAccount(a, 'd-account');
    await addMember(a, account.merchantId, 'agent', 'd-account-b');

    const res = await a.from('merchant_account').delete().eq('id', account.merchantId).select('id');
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
    const left = await a
      .from('merchant_member')
      .select('id', { count: 'exact', head: true })
      .eq('merchant_account_id', account.merchantId);
    expect(left.count).toBe(0);
  });

  it('D · cascade utilisateur · supprimer le créateur, unique owner, emporte le compte', async () => {
    const account = await soloAccount(a, 'd-user');
    // Sans rapport avec la garde : la trace `account.created` référence son auteur par une clé
    // sans cascade (audit_log_actor_user_id_fkey), qui bloque à elle seule cette suppression.
    const trace = await a.from('audit_log').delete().eq('actor_user_id', account.userId);
    expect(trace.error).toBeNull();

    const res = await a.auth.admin.deleteUser(account.userId);
    expect(res.error).toBeNull();
    const gone = await a.from('merchant_account').select('id').eq('id', account.merchantId);
    expect(gone.data).toEqual([]);
  });

  it('D · cascade utilisateur · supprimer un owner qui n est pas le dernier laisse l autre en place', async () => {
    const account = await soloAccount(a, 'd-user2');
    const second = await addMember(a, account.merchantId, 'owner', 'd-user2-b');

    const res = await a.auth.admin.deleteUser(second.userId);
    expect(res.error).toBeNull();
    expect(await ownerCount(a, account.merchantId)).toBe(1);
  });

  it('D · cascade utilisateur · supprimer le dernier owner, non créateur du compte, passe et laisse le compte sans owner', async () => {
    const account = await soloAccount(a, 'd-user3');
    const second = await addMember(a, account.merchantId, 'owner', 'd-user3-b');
    const creatorLeft = await a
      .from('merchant_member')
      .delete()
      .eq('merchant_account_id', account.merchantId)
      .eq('user_id', account.userId)
      .select('id');
    expect(creatorLeft.data).toHaveLength(1);
    expect(await ownerCount(a, account.merchantId)).toBe(1);

    const res = await a.auth.admin.deleteUser(second.userId);
    expect(res.error).toBeNull();
    // État consigné, non corrigé par ce lot : le compte subsiste, sans owner.
    const kept = await a.from('merchant_account').select('id').eq('id', account.merchantId);
    expect(kept.data).toHaveLength(1);
    expect(await ownerCount(a, account.merchantId)).toBe(0);
  });
});
