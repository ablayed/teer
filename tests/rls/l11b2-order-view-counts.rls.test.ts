import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

// 0166 — L11B-2 : get_order_view_counts en un seul passage.
//
// La migration ne doit changer AUCUN résultat. Ces tests verrouillent :
//   1. les sept valeurs, attendues littéralement sur une fixture construite ligne par ligne
//      autour des bornes exactes de la fenêtre ;
//   2. l'équivalence avec le TEXTE de l'ancienne requête (0149), jouée sous le même rôle et sur
//      les mêmes données, pour chaque acteur, chaque boutique et plusieurs fenêtres ;
//   3. la visibilité par rôle, inchangée : c'est la RLS de l'appelant qui borne le décompte.
//
// Mutations attendues, chacune devant rougir « les sept valeurs » (et l'équivalence) :
//   * borne haute exclusive sur « a-appeler » ;
//   * « a-appeler » datée sur coalesce(created_at_shopify, created_at) ;
//   * prédicat de boutique retiré ;
//   * 'assigned' retiré de « confirmee » ;
//   * borne basse exclusive sur « toutes ».

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'l11b2-order-view-counts-password';
const suite = serviceKey ? describe : describe.skip;
type Client = SupabaseClient<Database>;

const FROM = '2026-03-01T00:00:00.000Z';
const TO = '2026-03-31T23:59:59.999Z';
const BEFORE_FROM = '2026-02-28T23:59:59.999Z';
const AFTER_TO = '2026-04-01T00:00:00.000Z';
const IN = '2026-03-15T12:00:00.000Z';
const JANUARY = '2026-01-10T12:00:00.000Z';
const FEBRUARY = '2026-02-10T12:00:00.000Z';
const APRIL = '2026-04-10T12:00:00.000Z';

const VIEWS = [
  'toutes',
  'a-appeler',
  'tentee-a-rappeler',
  'confirmee',
  'en-livraison',
  'valide',
  'annulees-retours',
] as const;
type Counts = Record<(typeof VIEWS)[number], number>;
const counts = (...values: number[]): Counts =>
  Object.fromEntries(VIEWS.map((view, index) => [view, values[index] ?? 0])) as Counts;

// Texte de la requête de 0149, avant ce lot. Référence d'équivalence, ne pas « corriger ».
const QUERY_0149 = `
  with scoped_orders as (
    select o.id, o.order_state, o.call_state, o.delivery_state, o.created_at, o.created_at_shopify
    from public.orders o
    where o.merchant_account_id = $1
      and ($4::uuid is null or o.shop_id = $4::uuid)
  )
  select 'toutes'::text as view_id, count(*) as count
  from scoped_orders so
  where coalesce(so.created_at_shopify, so.created_at) >= $2
    and coalesce(so.created_at_shopify, so.created_at) <= $3
  union all
  select 'a-appeler', count(*)
  from scoped_orders so
  where so.order_state = 'open' and so.call_state = 'to_call'
    and so.created_at >= $2 and so.created_at <= $3
  union all
  select 'tentee-a-rappeler', count(*)
  from scoped_orders so
  where so.order_state = 'open' and so.call_state = 'callback'
    and coalesce(so.created_at_shopify, so.created_at) >= $2
    and coalesce(so.created_at_shopify, so.created_at) <= $3
  union all
  select 'confirmee', count(*)
  from scoped_orders so
  where so.order_state = 'open' and so.call_state = 'validated'
    and so.delivery_state in ('unassigned', 'scheduled', 'assigned')
    and coalesce(so.created_at_shopify, so.created_at) >= $2
    and coalesce(so.created_at_shopify, so.created_at) <= $3
  union all
  select 'en-livraison', count(*)
  from scoped_orders so
  where so.delivery_state = 'out_for_delivery'
  union all
  select 'valide', count(*)
  from scoped_orders so
  where so.order_state = 'completed'
    and coalesce(so.created_at_shopify, so.created_at) >= $2
    and coalesce(so.created_at_shopify, so.created_at) <= $3
  union all
  select 'annulees-retours', count(*)
  from scoped_orders so
  where so.order_state in ('cancelled', 'returned')`;

const createdUsers: string[] = [];
let pg: TestPostgresClient;

function admin(): Client {
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
async function createUser(a: Client, email: string) {
  const { data, error } = await a.auth.admin.createUser({ email, email_confirm: true, password });
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

/** Joue une requête sous le rôle authenticated et l'identité donnée, comme le ferait PostgREST. */
async function asUser(userId: string, sql: string, params: unknown[]) {
  await pg.query('begin');
  try {
    await pg.query('set local role authenticated');
    await pg.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ role: 'authenticated', sub: userId }),
    ]);
    const { rows } = await pg.query(sql, params);
    return Object.fromEntries(
      rows.map((row) => [row.view_id as string, Number(row.count)]),
    ) as Counts;
  } finally {
    await pg.query('rollback');
  }
}

async function viaRpc(
  client: Client,
  merchantId: string,
  from: string,
  to: string,
  shop: string | null,
) {
  const { data, error } = await client.rpc('get_order_view_counts', {
    p_from: from,
    p_merchant_id: merchantId,
    p_shop_id: shop ?? undefined,
    p_to: to,
  });
  if (error) throw error;
  return {
    counts: Object.fromEntries(
      (data ?? []).map((row) => [row.view_id, Number(row.count)]),
    ) as Counts,
    order: (data ?? []).map((row) => row.view_id),
  };
}

suite('0166 — L11B-2 : get_order_view_counts en un passage', () => {
  let a: Client;
  let merchantId = '';
  const shops = { A: '', B: '' };
  const users: Record<string, string> = {};
  const sessions: Record<string, Client> = {};

  beforeAll(async () => {
    if (!serviceKey) return;
    a = admin();
    pg = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', { connectionTimeoutMillis: 10_000 });
    await pg.connect();

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ownerEmail = `l11b2-owner-${suffix}@example.com`;
    users.owner = await createUser(a, ownerEmail);
    for (let i = 0; i < 30 && !merchantId; i++) {
      const { data } = await a
        .from('merchant_account')
        .select('id')
        .eq('owner_user_id', users.owner)
        .maybeSingle();
      merchantId = data?.id ?? '';
      if (!merchantId) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const shopA = await a
      .from('shop')
      .select('id')
      .eq('merchant_account_id', merchantId)
      .eq('is_default', true)
      .single();
    if (!shopA.data) throw shopA.error;
    shops.A = shopA.data.id;
    const shopB = await a
      .from('shop')
      .insert({
        display_name: 'B',
        merchant_account_id: merchantId,
        scopes: '',
        shop_domain: `l11b2-b-${suffix}.internal`,
        store_kind: 'manual',
      })
      .select('id')
      .single();
    if (!shopB.data) throw shopB.error;
    shops.B = shopB.data.id;

    const emails: Record<string, string> = { owner: ownerEmail };
    for (const [key, role, keep] of [
      ['managerA', 'manager', [shops.A]],
      ['agentA', 'agent', [shops.A]],
      ['sansBoutique', 'agent', []],
    ] as const) {
      const email = `l11b2-${key}-${suffix}@example.com`;
      const id = await createUser(a, email);
      users[key] = id;
      emails[key] = email;
      const left = await a.from('merchant_account').delete().eq('owner_user_id', id);
      if (left.error) throw left.error;
      const joined = await a
        .from('merchant_member')
        .insert({ merchant_account_id: merchantId, role, user_id: id });
      if (joined.error) throw joined.error;
      const removed = await a
        .from('shop_member')
        .delete()
        .eq('user_id', id)
        .not('shop_id', 'in', `(${[...keep, '00000000-0000-0000-0000-000000000000'].join(',')})`);
      if (removed.error) throw removed.error;
    }
    const outsiderEmail = `l11b2-outsider-${suffix}@example.com`;
    users.autreCompte = await createUser(a, outsiderEmail);
    emails.autreCompte = outsiderEmail;

    const driver = await a
      .from('driver')
      .insert({
        full_name: 'Livreur',
        merchant_account_id: merchantId,
        phone: `+22177${String(Date.now()).slice(-7)}`,
      })
      .select('id')
      .single();
    if (!driver.data) throw driver.error;
    const linked = await a
      .from('driver_shop')
      .insert({ driver_id: driver.data.id, merchant_account_id: merchantId, shop_id: shops.A });
    if (linked.error) throw linked.error;

    // Une ligne par propriété à verrouiller. `created_at` est posé explicitement.
    type Row = {
      call?: string;
      cash?: string;
      created: string;
      delivery?: string;
      driver?: boolean;
      order?: string;
      shop: 'A' | 'B';
      shopify?: string;
    };
    const rows: Row[] = [
      { created: FROM, shop: 'A' }, // borne basse incluse
      { created: TO, shop: 'A' }, // borne haute incluse
      { created: BEFORE_FROM, shop: 'A' }, // 1 ms avant : hors fenêtre
      { created: AFTER_TO, shop: 'A' }, // 1 ms après : hors fenêtre
      { created: IN, shop: 'A', shopify: FEBRUARY }, // « a-appeler » oui, « toutes » non
      { created: APRIL, shop: 'A', shopify: IN }, // « toutes » oui, « a-appeler » non
      { call: 'callback', created: IN, shop: 'A' },
      { call: 'validated', created: IN, shop: 'A' },
      {
        call: 'validated',
        cash: 'expected',
        created: IN,
        delivery: 'assigned',
        driver: true,
        shop: 'A',
      },
      {
        call: 'validated',
        cash: 'expected',
        created: JANUARY,
        delivery: 'out_for_delivery',
        driver: true,
        shop: 'A',
      }, // sans fenêtre
      {
        call: 'validated',
        cash: 'collected',
        created: IN,
        delivery: 'delivered',
        order: 'completed',
        shop: 'A',
      },
      {
        call: 'validated',
        cash: 'collected',
        created: JANUARY,
        delivery: 'delivered',
        order: 'completed',
        shop: 'A',
      },
      { created: JANUARY, order: 'cancelled', shop: 'A' }, // sans fenêtre
      { created: IN, order: 'cancelled', shop: 'A' },
      { created: IN, shop: 'B' },
      {
        call: 'validated',
        cash: 'collected',
        created: IN,
        delivery: 'delivered',
        order: 'completed',
        shop: 'B',
      },
    ];
    for (const [index, row] of rows.entries()) {
      await pg.query(
        `insert into public.orders (
           merchant_account_id, shop_id, order_number, total_amount, currency,
           order_state, call_state, delivery_state, cash_state,
           assigned_driver_id, created_at, created_at_shopify
         ) values ($1, $2, $3, 1000, 'XOF', $4, $5, $6, $7, $8, $9, $10)`,
        [
          merchantId,
          shops[row.shop],
          `L11B2-${suffix}-${index}`,
          row.order ?? 'open',
          row.call ?? 'to_call',
          row.delivery ?? 'unassigned',
          row.cash ?? 'not_due',
          row.driver ? driver.data.id : null,
          row.created,
          row.shopify ?? null,
        ],
      );
    }

    for (const key of Object.keys(emails)) sessions[key] = await login(emails[key]);
  }, 120_000);

  afterAll(async () => {
    await pg?.end().catch(() => undefined);
    if (!serviceKey) return;
    await Promise.all(createdUsers.splice(0).map((id) => a.auth.admin.deleteUser(id)));
  });

  // Attendu, compté à la main sur la fixture ci-dessus, fenêtre de mars.
  const EXPECTED_A = counts(8, 3, 1, 2, 1, 1, 2);
  const EXPECTED_B = counts(2, 1, 0, 0, 0, 1, 0);
  const EXPECTED_ALL = counts(10, 4, 1, 2, 1, 2, 2);
  const ZERO = counts();

  it('les sept valeurs, dans l ordre, sur les bornes exactes de la fenêtre', async () => {
    const all = await viaRpc(sessions.owner, merchantId, FROM, TO, null);
    expect(all.order).toEqual([...VIEWS]);
    expect(all.counts).toEqual(EXPECTED_ALL);
    expect((await viaRpc(sessions.owner, merchantId, FROM, TO, shops.A)).counts).toEqual(
      EXPECTED_A,
    );
    expect((await viaRpc(sessions.owner, merchantId, FROM, TO, shops.B)).counts).toEqual(
      EXPECTED_B,
    );
  });

  it('une fenêtre réduite à un instant ne compte que la commande posée sur cet instant', async () => {
    // Fenêtre [FROM, FROM] : seule la commande créée à FROM y entre. Les deux vues sans fenêtre
    // gardent leur valeur.
    expect((await viaRpc(sessions.owner, merchantId, FROM, FROM, shops.A)).counts).toEqual(
      counts(1, 1, 0, 0, 1, 0, 2),
    );
    expect((await viaRpc(sessions.owner, merchantId, TO, TO, shops.A)).counts).toEqual(
      counts(1, 1, 0, 0, 1, 0, 2),
    );
    // Les instants voisins, à 1 ms : chacun ne voit que sa propre commande.
    expect((await viaRpc(sessions.owner, merchantId, AFTER_TO, AFTER_TO, shops.A)).counts).toEqual(
      counts(1, 1, 0, 0, 1, 0, 2),
    );
  });

  it('toujours sept lignes, zéros compris, sur une fenêtre vide', async () => {
    const empty = await viaRpc(
      sessions.owner,
      merchantId,
      '2020-01-01T00:00:00Z',
      '2020-01-02T00:00:00Z',
      shops.B,
    );
    expect(empty.order).toEqual([...VIEWS]);
    expect(empty.counts).toEqual(ZERO);
  });

  it('rôles : le décompte suit la visibilité de l appelant', async () => {
    for (const key of ['managerA', 'agentA']) {
      expect((await viaRpc(sessions[key], merchantId, FROM, TO, null)).counts, key).toEqual(
        EXPECTED_A,
      );
      expect((await viaRpc(sessions[key], merchantId, FROM, TO, shops.A)).counts, key).toEqual(
        EXPECTED_A,
      );
      expect((await viaRpc(sessions[key], merchantId, FROM, TO, shops.B)).counts, key).toEqual(
        ZERO,
      );
    }
    for (const key of ['sansBoutique', 'autreCompte']) {
      expect((await viaRpc(sessions[key], merchantId, FROM, TO, null)).counts, key).toEqual(ZERO);
      expect((await viaRpc(sessions[key], merchantId, FROM, TO, shops.A)).counts, key).toEqual(
        ZERO,
      );
    }
  });

  it('équivalence avec la requête de 0149 : chaque acteur, chaque boutique, plusieurs fenêtres', async () => {
    const windows: Array<[string, string]> = [
      [FROM, TO],
      [FROM, FROM],
      [TO, TO],
      [BEFORE_FROM, AFTER_TO],
      [JANUARY, APRIL],
      [FEBRUARY, IN],
      [IN, IN],
      ['2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z'],
      [TO, FROM], // fenêtre inversée : vide pour les vues à fenêtre
    ];
    let compared = 0;
    for (const actor of ['owner', 'managerA', 'agentA', 'sansBoutique', 'autreCompte']) {
      for (const shop of [null, shops.A, shops.B]) {
        for (const [from, to] of windows) {
          const params = [merchantId, from, to, shop];
          const reference = await asUser(users[actor], QUERY_0149, params);
          const actual = await asUser(
            users[actor],
            'select view_id, count from public.get_order_view_counts($1, $2, $3, $4)',
            params,
          );
          expect(actual, `${actor} / ${shop ?? 'toutes boutiques'} / ${from} → ${to}`).toEqual(
            reference,
          );
          compared += 1;
        }
      }
    }
    expect(compared).toBe(135);
  });

  it('catalogue : signature, mode de sécurité, volatilité et droits inchangés', async () => {
    const { rows } = await pg.query(
      `select pg_get_function_identity_arguments(p.oid) as args,
              pg_get_function_result(p.oid) as result,
              p.prosecdef, p.provolatile, p.proconfig::text as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service_role
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname = 'get_order_view_counts'`,
    );
    expect(rows).toEqual([
      {
        anon: false,
        args: 'p_merchant_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_shop_id uuid',
        authenticated: true,
        config: '{search_path=public}',
        prosecdef: false,
        provolatile: 's',
        result: 'TABLE(view_id text, count bigint)',
        service_role: true,
      },
    ]);
  });
});
