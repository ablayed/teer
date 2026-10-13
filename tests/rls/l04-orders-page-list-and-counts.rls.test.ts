/**
 * L04 — la page Commandes lit sa liste et ses compteurs séparément.
 *
 * `getOrdersPageList` et `getOrderViewCountsForPage` sont exécutées jusqu'à leur retour final
 * contre le VRAI PostgREST local, avec un client soumis à la RLS (session réelle d'un membre).
 *
 * Ce qui est RÉEL : le constructeur `@supabase/supabase-js`, la session du membre, le transport
 * PostgREST, les politiques RLS, les RPC `list_orders_keyset` et `get_order_view_counts`.
 * Ce qui est SUBSTITUÉ, et pourquoi : `createSupabaseServerClient` (il lit des cookies de requête
 * Next ; on lui rend la session réelle du membre voulu), `@/lib/env`, `next/cache`,
 * `next/navigation` et `@sentry/nextjs`. Aucune valeur de retour de la base n'est simulée.
 *
 * Propriétés verrouillées :
 *   - liste + compteurs lus à part = exactement ce que rend `getOrdersPageData` (cas peuplé) ;
 *   - cas vide : liste vide et compteurs à zéro, rendus comme un SUCCÈS ;
 *   - la liste lue à part ne porte aucun compteur, et ne lance pas la requête des compteurs ;
 *   - une lecture de compteurs en échec est rendue `{ ok: false }`, jamais des zéros ;
 *   - un autre compte, même en nommant la boutique : liste refusée, compteurs à zéro.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = `l04-${randomUUID()}`;
const suite = serviceKey ? describe : describe.skip;
type Client = SupabaseClient<Database>;

const harness = vi.hoisted(() => ({
  captured: [] as unknown[],
  rpcCalls: [] as string[],
  session: null as unknown,
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ unstable_rethrow: () => undefined }));
vi.mock('@sentry/nextjs', () => ({
  captureException: (error: unknown) => harness.captured.push(error),
  captureMessage: () => undefined,
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => harness.session,
}));

const FROM = '2026-03-01T00:00:00.000Z';
const TO = '2026-03-31T23:59:59.999Z';
const IN = '2026-03-15T12:00:00.000Z';

const createdUsers: string[] = [];
let pg: TestPostgresClient;

function admin(): Client {
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Session réelle d'un membre ; chaque appel RPC est noté, puis transmis tel quel. */
async function login(email: string): Promise<Client> {
  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const rpc = client.rpc.bind(client);
  // biome-ignore lint/suspicious/noExplicitAny: compteur d'appels, la requête réelle part inchangée.
  (client as any).rpc = (fn: string, ...rest: unknown[]) => {
    harness.rpcCalls.push(fn);
    // biome-ignore lint/suspicious/noExplicitAny: idem.
    return (rpc as any)(fn, ...rest);
  };
  return client;
}

async function createTenant(a: Client, label: string) {
  const email = `l04-${label}-${Date.now()}-${randomUUID()}@example.com`;
  const { data, error } = await a.auth.admin.createUser({ email, email_confirm: true, password });
  if (error || !data.user) throw error ?? new Error('utilisateur de test absent');
  createdUsers.push(data.user.id);
  let merchantId = '';
  for (let i = 0; i < 30 && !merchantId; i++) {
    const account = await a
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', data.user.id)
      .maybeSingle();
    merchantId = account.data?.id ?? '';
    if (!merchantId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const shop = await a
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantId)
    .eq('is_default', true)
    .single();
  if (!shop.data) throw shop.error;
  return { email, merchantId, shopId: shop.data.id, userId: data.user.id };
}

suite('L04 — liste et compteurs de /commandes lus séparément', () => {
  let a: Client;
  let peuple: Awaited<ReturnType<typeof createTenant>>;
  let vide: Awaited<ReturnType<typeof createTenant>>;
  const sessions: Record<'peuple' | 'vide', Client | null> = { peuple: null, vide: null };
  let actions: typeof import('@/lib/actions/orders');

  const as = (who: 'peuple' | 'vide') => {
    harness.session = sessions[who];
    harness.rpcCalls.length = 0;
    harness.captured.length = 0;
  };

  beforeAll(async () => {
    if (!serviceKey) return;
    a = admin();
    pg = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', { connectionTimeoutMillis: 10_000 });
    await pg.connect();
    peuple = await createTenant(a, 'peuple');
    vide = await createTenant(a, 'vide');

    // Cinq commandes dans la fenêtre : trois à appeler, une à rappeler, une confirmée.
    const rows: Array<[string, string]> = [
      ['to_call', IN],
      ['to_call', '2026-03-16T12:00:00.000Z'],
      ['to_call', '2026-03-17T12:00:00.000Z'],
      ['callback', '2026-03-18T12:00:00.000Z'],
      ['validated', '2026-03-19T12:00:00.000Z'],
    ];
    for (const [index, [call, created]] of rows.entries()) {
      await pg.query(
        `insert into public.orders (
           merchant_account_id, shop_id, order_number, total_amount, currency,
           order_state, call_state, delivery_state, cash_state, created_at
         ) values ($1, $2, $3, 1000, 'XOF', 'open', $4, 'unassigned', 'not_due', $5)`,
        [peuple.merchantId, peuple.shopId, `L04-${index}`, call, created],
      );
    }

    sessions.peuple = await login(peuple.email);
    sessions.vide = await login(vide.email);
    actions = await import('@/lib/actions/orders');
  }, 120_000);

  beforeEach(() => {
    harness.session = null;
  });

  afterAll(async () => {
    await pg?.end().catch(() => undefined);
    if (!serviceKey) return;
    await Promise.all(createdUsers.splice(0).map((id) => a.auth.admin.deleteUser(id)));
  });

  it('cas peuplé : liste + compteurs lus à part = getOrdersPageData', async () => {
    const params = { dateFrom: FROM, dateTo: TO, shopId: peuple.shopId, view: 'toutes' };
    as('peuple');
    const full = await actions.getOrdersPageData(params);
    as('peuple');
    const list = await actions.getOrdersPageList(params);
    const counts = await actions.getOrderViewCountsForPage({
      dateFrom: FROM,
      dateTo: TO,
      shopId: peuple.shopId,
    });

    expect(full.orders).toHaveLength(5);
    expect(list.orders.map((order) => order.id)).toEqual(full.orders.map((order) => order.id));
    expect(list.hasMore).toBe(full.hasMore);
    expect(list.nextCursor).toEqual(full.nextCursor);
    expect(list.activeView).toBe(full.activeView);
    expect(counts).toEqual({ counts: full.viewCounts, ok: true });
    expect(full.viewCounts).toMatchObject({
      'a-appeler': 3,
      confirmee: 1,
      'tentee-a-rappeler': 1,
      toutes: 5,
    });
  });

  it('la liste lue à part ne porte aucun compteur et ne lance pas leur requête', async () => {
    as('peuple');
    const list = await actions.getOrdersPageList({
      dateFrom: FROM,
      dateTo: TO,
      shopId: peuple.shopId,
      view: 'a-appeler',
    });
    expect(list.orders).toHaveLength(3);
    expect(Object.keys(list)).not.toContain('viewCounts');
    expect(Object.keys(list)).not.toContain('totalCount');
    expect(harness.rpcCalls).toContain('list_orders_keyset');
    expect(harness.rpcCalls).not.toContain('get_order_view_counts');

    as('peuple');
    await actions.getOrdersPageData({ dateFrom: FROM, dateTo: TO, shopId: peuple.shopId });
    expect(harness.rpcCalls).toContain('get_order_view_counts');
  });

  it('cas vide : liste vide et compteurs à zéro, rendus comme un succès', async () => {
    as('vide');
    const list = await actions.getOrdersPageList({
      dateFrom: FROM,
      dateTo: TO,
      shopId: vide.shopId,
    });
    const counts = await actions.getOrderViewCountsForPage({
      dateFrom: FROM,
      dateTo: TO,
      shopId: vide.shopId,
    });
    expect(list.orders).toEqual([]);
    expect(counts.ok).toBe(true);
    if (counts.ok) expect(new Set(Object.values(counts.counts))).toEqual(new Set([0]));
    expect(harness.captured).toEqual([]);
  });

  it('lecture des compteurs en échec : { ok: false }, jamais des zéros', async () => {
    as('peuple');
    const failed = await actions.getOrderViewCountsForPage({
      dateFrom: 'pas-une-date',
      dateTo: TO,
      shopId: peuple.shopId,
    });
    expect(failed).toEqual({ ok: false });
    expect(harness.captured).toHaveLength(1);
  });

  it('un autre compte ne lit ni la liste ni les compteurs, même en nommant la boutique', async () => {
    // La liste est REFUSÉE, pas rendue vide : le journal d'accès n'accepte pas une boutique dont
    // l'appelant n'est pas membre. Comportement antérieur à ce lot, identique sur les deux lectures.
    const foreign = { dateFrom: FROM, dateTo: TO, shopId: peuple.shopId };
    as('vide');
    await expect(actions.getOrdersPageList(foreign)).rejects.toThrow(
      'pcd_access_audit_write_failed',
    );
    await expect(actions.getOrdersPageData(foreign)).rejects.toThrow(
      'pcd_access_audit_write_failed',
    );
    const counts = await actions.getOrderViewCountsForPage({
      dateFrom: FROM,
      dateTo: TO,
      shopId: peuple.shopId,
    });
    expect(counts.ok).toBe(true);
    if (counts.ok) expect(new Set(Object.values(counts.counts))).toEqual(new Set([0]));
  });
});
