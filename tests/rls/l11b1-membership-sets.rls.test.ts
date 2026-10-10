import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

// 0164 — L11B-1 : orders_select et customer_select en ensembles d'appartenance.
//
// La migration ne doit changer AUCUN droit : elle remplace deux appels de helper par ligne par
// deux ensembles calculés une fois par instruction. Ces tests verrouillent donc trois choses :
//   1. la matrice de visibilité par acteur, identique à celle des helpers (compte ET boutique) ;
//   2. les droits effectifs des deux fonctions de private, mesurés et non lus dans le SQL ;
//   3. la garde de plan : plus aucun appel de helper par ligne sur ces deux politiques.
//
// Mutations attendues, chacune devant rougir un test nommé ci-dessous :
//   * retirer la condition de COMPTE  → « ancien membre » voit de nouveau les commandes ;
//   * retirer la condition de BOUTIQUE → « manager de A » voit les commandes de B.

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'l11b1-membership-sets-password';
const users: string[] = [];
const run = serviceKey ? it : it.skip;
type Client = SupabaseClient<Database>;

let pg: TestPostgresClient | undefined;
async function db() {
  if (!pg) {
    pg = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', { connectionTimeoutMillis: 10_000 });
    await pg.connect();
  }
  return pg;
}
function admin(): Client {
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
async function createUser(a: Client, email: string) {
  const { data, error } = await a.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('user');
  users.push(data.user.id);
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

async function fixture(tag: string, ordersPerShop = 3) {
  const a = admin();
  const suffix = `${Date.now()}-${tag}`;
  const ownerEmail = `l11b1-owner-${suffix}@example.com`;
  const ownerId = await createUser(a, ownerEmail);
  let merchantId = '';
  for (let i = 0; i < 20 && !merchantId; i++) {
    const { data } = await a
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', ownerId)
      .maybeSingle();
    merchantId = data?.id ?? '';
    if (!merchantId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const { data: shopA } = await a
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantId)
    .eq('is_default', true)
    .single();
  if (!shopA) throw new Error('shop A');
  const b = await a
    .from('shop')
    .insert({
      merchant_account_id: merchantId,
      shop_domain: `l11b1-b-${suffix}.internal`,
      scopes: '',
      store_kind: 'manual',
      display_name: 'B',
    })
    .select('id')
    .single();
  if (!b.data) throw b.error;
  const shops = { A: shopA.id, B: b.data.id };

  const memberIds: Record<string, string> = {};
  async function member(key: string, role: 'owner' | 'manager' | 'agent', keep: string[]) {
    const email = `l11b1-${key}-${suffix}@example.com`;
    const id = await createUser(a, email);
    memberIds[key] = id;
    await a.from('merchant_account').delete().eq('owner_user_id', id);
    const inserted = await a
      .from('merchant_member')
      .insert({ merchant_account_id: merchantId, role, user_id: id });
    if (inserted.error) throw inserted.error;
    const removed = await a
      .from('shop_member')
      .delete()
      .eq('user_id', id)
      .not('shop_id', 'in', `(${keep.join(',') || '00000000-0000-0000-0000-000000000000'})`);
    if (removed.error) throw removed.error;
    return login(email);
  }
  for (const [key, shopId] of Object.entries(shops)) {
    for (let i = 0; i < ordersPerShop; i++) {
      const customer = await a
        .from('customer')
        .insert({
          merchant_account_id: merchantId,
          shop_id: shopId,
          full_name: `Client ${key}${i}`,
        })
        .select('id')
        .single();
      if (!customer.data) throw customer.error;
      const order = await a.from('orders').insert({
        merchant_account_id: merchantId,
        shop_id: shopId,
        customer_id: customer.data.id,
        order_number: `L11B1-${suffix}-${key}${i}`,
        total_amount: 1000,
        currency: 'XOF',
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      });
      if (order.error) throw order.error;
    }
  }
  const actors = {
    owner: await login(ownerEmail),
    ownerSansB: await member('ownerb', 'owner', [shops.A]),
    managerA: await member('manager', 'manager', [shops.A]),
    agentA: await member('agent', 'agent', [shops.A]),
    sansBoutique: await member('noshop', 'agent', []),
    ancienMembre: await member('revoked', 'agent', [shops.A, shops.B]),
  };
  // Ancien membre : la ligne merchant_member disparaît, les lignes shop_member subsistent.
  const revoked = await a.from('merchant_member').delete().eq('user_id', memberIds.revoked);
  if (revoked.error) throw revoked.error;
  const outsiderEmail = `l11b1-outsider-${suffix}@example.com`;
  await createUser(a, outsiderEmail);
  return {
    a,
    merchantId,
    shops,
    n: ordersPerShop,
    memberIds,
    actors: { ...actors, autreCompte: await login(outsiderEmail) },
    anon: createClient<Database>(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  };
}

async function visible(
  client: Client,
  table: 'orders' | 'customer',
  merchantId: string,
  shopId: string,
) {
  const { count, error } = await client
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('merchant_account_id', merchantId)
    .eq('shop_id', shopId);
  if (error) throw error;
  return count ?? 0;
}

afterEach(async () => {
  if (serviceKey) await Promise.all(users.splice(0).map((id) => admin().auth.admin.deleteUser(id)));
});
afterAll(async () => {
  await pg?.end();
});

describe('0164 — L11B-1 : ensembles d’appartenance sur orders et customer', () => {
  run('matrice de visibilité : compte ET boutique, pour orders et customer', async () => {
    const f = await fixture('matrice');
    const expected: Record<string, [number, number]> = {
      owner: [f.n, f.n],
      ownerSansB: [f.n, 0], // un owner sans ligne shop_member ne voit pas la boutique
      managerA: [f.n, 0], // mutation « boutique » : ce cas rougit
      agentA: [f.n, 0],
      sansBoutique: [0, 0],
      ancienMembre: [0, 0], // mutation « compte » : ce cas rougit (shop_member subsiste)
      autreCompte: [0, 0],
    };
    const leftover = await f.a
      .from('shop_member')
      .select('shop_id', { count: 'exact', head: true })
      .eq('user_id', f.memberIds.revoked);
    expect(leftover.count).toBe(2);
    for (const table of ['orders', 'customer'] as const) {
      for (const [actor, [inA, inB]] of Object.entries(expected)) {
        const client = f.actors[actor as keyof typeof f.actors];
        expect([actor, table, await visible(client, table, f.merchantId, f.shops.A)]).toEqual([
          actor,
          table,
          inA,
        ]);
        expect([actor, table, await visible(client, table, f.merchantId, f.shops.B)]).toEqual([
          actor,
          table,
          inB,
        ]);
      }
      expect(await visible(f.anon, table, f.merchantId, f.shops.A)).toBe(0);
      expect(await visible(f.a, table, f.merchantId, f.shops.B)).toBe(f.n); // service_role : RLS contournée
    }
  });

  run('compteurs et liste suivent la même visibilité', async () => {
    const f = await fixture('rpc');
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const total = async (client: Client, shopId: string | null) => {
      const { data, error } = await client.rpc('get_order_view_counts', {
        p_merchant_id: f.merchantId,
        p_from: from,
        p_to: to,
        ...(shopId ? { p_shop_id: shopId } : {}),
      });
      if (error) throw error;
      return (data ?? []).find((row) => row.view_id === 'toutes')?.count ?? 0;
    };
    const listed = async (client: Client, shopId: string) => {
      const { data, error } = await client.rpc('list_orders_keyset', {
        p_merchant_id: f.merchantId,
        p_view: 'toutes',
        p_from: from,
        p_to: to,
        p_shop_id: shopId,
      });
      if (error) throw error;
      return {
        rows: (data ?? []).length,
        withCustomer: (data ?? []).filter((r) => r.customer_full_name !== null).length,
      };
    };
    expect(await total(f.actors.owner, null)).toBe(2 * f.n);
    expect(await total(f.actors.managerA, null)).toBe(f.n);
    expect(await total(f.actors.managerA, f.shops.B)).toBe(0);
    expect(await total(f.actors.ancienMembre, null)).toBe(0);
    expect(await total(f.actors.autreCompte, null)).toBe(0);
    expect(await listed(f.actors.owner, f.shops.B)).toEqual({ rows: f.n, withCustomer: f.n });
    expect(await listed(f.actors.managerA, f.shops.A)).toEqual({ rows: f.n, withCustomer: f.n });
    expect(await listed(f.actors.managerA, f.shops.B)).toEqual({ rows: 0, withCustomer: 0 });
  });

  run('écritures : la politique SELECT borne toujours les lignes modifiables', async () => {
    const f = await fixture('ecritures');
    const touch = async (client: Client, shopId: string) => {
      const { data, error } = await client
        .from('orders')
        .update({ note: 'l11b1' })
        .eq('shop_id', shopId)
        .select('id');
      return error ? `erreur ${error.code}` : (data ?? []).length;
    };
    expect(await touch(f.actors.owner, f.shops.B)).toBe(f.n);
    expect(await touch(f.actors.managerA, f.shops.A)).toBe(f.n);
    expect(await touch(f.actors.managerA, f.shops.B)).toBe(0);
    expect(await touch(f.actors.ancienMembre, f.shops.A)).toBe(0);
    expect(await touch(f.actors.autreCompte, f.shops.A)).toBe(0);
  });

  run('droits effectifs des deux fonctions de private', async () => {
    const client = await db();
    const { rows } = await client.query<{
      fn: string;
      role: string;
      can: boolean;
      secdef: boolean;
      config: string[] | null;
      owner: string;
    }>(
      `select p.proname as fn, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') as can,
              p.prosecdef as secdef, p.proconfig as config, pg_get_userbyid(p.proowner) as owner
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       cross join unnest(array['anon', 'authenticated', 'service_role', 'authenticator']) as r(role)
       where n.nspname = 'private' and p.proname in ('current_user_merchant_ids', 'current_user_shop_ids')
       order by 1, 2`,
    );
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect([row.fn, row.role, row.can]).toEqual([row.fn, row.role, row.role === 'authenticated']);
      expect(row.secdef).toBe(true);
      expect(row.config).toEqual(['search_path=""']);
      expect(row.owner).toBe('postgres');
    }
    const { rows: schema } = await client.query<{ role: string; usage: boolean }>(
      `select r as role, has_schema_privilege(r, 'private', 'usage') as usage
       from unnest(array['anon', 'authenticated', 'service_role']) r order by 1`,
    );
    expect(schema).toEqual([
      { role: 'anon', usage: false },
      { role: 'authenticated', usage: true },
      { role: 'service_role', usage: false },
    ]);
  });

  run('garde de plan : plus aucun appel de helper par ligne sur ces deux politiques', async () => {
    // Semé au-delà du seuil du planificateur : 900 commandes par boutique.
    const f = await fixture('plan', 0);
    const client = await db();
    await client.query(
      `insert into public.orders (merchant_account_id, shop_id, order_number, total_amount, currency, order_state, call_state, delivery_state, cash_state)
       select $1, s, 'L11B1-PLAN-' || s || '-' || g, 1000, 'XOF', 'open', 'to_call', 'unassigned', 'not_due'
       from unnest($2::uuid[]) s cross join generate_series(1, 900) g`,
      [f.merchantId, [f.shops.A, f.shops.B]],
    );
    await client.query('analyze public.orders');
    const { data: session } = await f.actors.owner.auth.getUser();
    await client.query('begin');
    try {
      await client.query(`set local track_functions = 'all'`);
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: session.user?.id, role: 'authenticated' }),
      ]);
      await client.query('set local role authenticated');
      const counted = await client.query<{ n: string }>(
        'select count(*)::text as n from public.orders where merchant_account_id = $1',
        [f.merchantId],
      );
      expect(Number(counted.rows[0]?.n)).toBe(1800);
      await client.query('reset role');
      const { rows } = await client.query<{ funcname: string; calls: string }>(
        `select funcname, calls::text from pg_stat_xact_user_functions
         where funcname in ('current_member_role', 'is_shop_member_of', 'current_user_merchant_ids', 'current_user_shop_ids')`,
      );
      const calls = Object.fromEntries(rows.map((r) => [r.funcname, Number(r.calls)]));
      expect(calls.current_member_role ?? 0).toBe(0);
      expect(calls.is_shop_member_of ?? 0).toBe(0);
      expect(calls.current_user_merchant_ids).toBe(1);
      expect(calls.current_user_shop_ids).toBe(1);
    } finally {
      await client.query('rollback');
    }
  });
});
