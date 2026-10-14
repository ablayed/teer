// Lectures du catalogue (`getProductsPageData`, `getStockCatalogSummaryData`,
// `getProductCatalogPageData`) : la boutique demandée est confrontée aux droits du membre, par sa
// SESSION. Ces lectures passent par le client service-role ; sans cette confrontation, l'identifiant
// de boutique reçu en argument suffisait à lire une boutique du même compte dont le membre est exclu.
//
// Réel : la base locale, PostgREST, `get_my_store`, la session du membre, le vrai module d'actions.
// Substitué : `next/cache` et le client de session (rendu = la vraie session du membre connecté),
// `lib/env` (valeurs locales), la fabrique des actions sûres (inutilisée par ces lectures).
//
// Pour chaque rôle (agent, manager, owner) limité à la boutique S1 :
//   - S1 : lu comme avant (produits, coûts masqués ou non selon le rôle) ;
//   - S2, même compte, sans appartenance : refus, aucune donnée ;
//   - boutique d'un autre compte, identifiant inexistant ou mal formé : refus.
// Un propriétaire du compte, membre des deux boutiques, lit S2.
import { randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = `acces-${randomUUID()}`;
type Client = SupabaseClient<Database>;

const harness = vi.hoisted(() => ({ session: null as unknown }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => harness.session,
}));
vi.mock('@/lib/actions/safe-action', () => {
  const chain: Record<string, unknown> = {};
  chain.metadata = () => chain;
  chain.inputSchema = () => chain;
  chain.action = () => async () => undefined;
  return { authActionClient: chain, requireRole: () => chain };
});
vi.mock('@/lib/actions/stock', () => ({ resolveActiveStoreProduct: vi.fn() }));
vi.mock('@/lib/workspace/store', () => ({ getRequestStoreId: vi.fn() }));

const suite = serviceKey ? describe : describe.skip;
const users: string[] = [];
const admin: Client = createClient<Database>(url, serviceKey || 'absent', {
  auth: { autoRefreshToken: false, persistSession: false },
});
let pg: TestPostgresClient;
let actions: typeof import('@/lib/actions/products');

async function createUser(label: string) {
  const email = `acces-${label}-${Date.now()}-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
  });
  if (error || !data.user) throw error ?? new Error('utilisateur de test absent');
  users.push(data.user.id);
  let merchantId = '';
  for (let i = 0; i < 30 && !merchantId; i++) {
    const account = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', data.user.id)
      .maybeSingle();
    merchantId = account.data?.id ?? '';
    if (!merchantId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!merchantId) throw new Error('compte de test absent');
  return { email, merchantId, userId: data.user.id };
}

async function login(email: string): Promise<Client> {
  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function seedAccount(label: string) {
  const owner = await createUser(label);
  const s1 = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', owner.merchantId)
    .eq('is_default', true)
    .single();
  const s2 = await admin
    .from('shop')
    .insert({
      access_token_encrypted: 'enc',
      merchant_account_id: owner.merchantId,
      scopes: 'read_orders',
      shop_domain: `acces-s2-${Date.now()}-${randomUUID()}.internal`,
    })
    .select('id')
    .single();
  if (!s1.data || !s2.data) throw s1.error ?? s2.error ?? new Error('boutiques de test absentes');
  for (const [shopId, count] of [
    [s1.data.id, 2],
    [s2.data.id, 3],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const product = await admin.from('product').insert({
        merchant_account_id: owner.merchantId,
        shop_id: shopId,
        title: `Produit ${shopId === s1.data.id ? 'S1' : 'S2'} ${i}`,
        unit_cost: 700,
      });
      if (product.error) throw product.error;
    }
  }
  return { owner, s1: s1.data.id, s2: s2.data.id };
}

/** Un membre du compte, rôle donné, appartenant à la seule boutique S1. */
async function limitedMember(
  account: Awaited<ReturnType<typeof seedAccount>>,
  role: 'agent' | 'manager' | 'owner',
) {
  const member = await createUser(`${role}-limite`);
  await pg.query('delete from public.merchant_account where owner_user_id = $1', [member.userId]);
  await pg.query(
    'insert into public.merchant_member (merchant_account_id, user_id, role) values ($1, $2, $3)',
    [account.owner.merchantId, member.userId, role],
  );
  await pg.query('delete from public.shop_member where user_id = $1', [member.userId]);
  await pg.query(
    'insert into public.shop_member (merchant_account_id, shop_id, user_id, role) values ($1, $2, $3, $4)',
    [account.owner.merchantId, account.s1, member.userId, role],
  );
  return member;
}

suite('lectures du catalogue — la boutique demandée est confrontée aux droits du membre', () => {
  let account: Awaited<ReturnType<typeof seedAccount>>;
  let other: Awaited<ReturnType<typeof seedAccount>>;

  beforeAll(async () => {
    pg = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', { connectionTimeoutMillis: 10_000 });
    await pg.connect();
    account = await seedAccount('proprietaire');
    other = await seedAccount('autre-compte');
    actions = await import('@/lib/actions/products');
  }, 120_000);

  afterAll(async () => {
    await pg?.end().catch(() => undefined);
    await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
  });

  it.each(['agent', 'manager', 'owner'] as const)(
    '%s limité à S1 : S1 lu comme avant, S2 refusé',
    async (role) => {
      const member = await limitedMember(account, role);
      harness.session = await login(member.email);
      const costsVisible = role !== 'agent';

      // Contrôle : la RLS elle-même cache S2 à ce membre — c'est ce que les lectures doivent respecter.
      const session = harness.session as Client;
      const rlsS2 = await session
        .from('product')
        .select('id', { count: 'exact', head: true })
        .eq('shop_id', account.s2);
      expect(rlsS2.count).toBe(0);

      // S1 : accès inchangé.
      const page = await actions.getProductsPageData({ shopId: account.s1 });
      expect(page.ok).toBe(true);
      if (page.ok) {
        expect(page.items).toHaveLength(2);
        expect(page.items.every((item) => (item.unit_cost !== null) === costsVisible)).toBe(true);
      }
      const summary = await actions.getStockCatalogSummaryData(account.s1);
      expect(summary.ok).toBe(true);
      if (summary.ok) expect(summary.summary.totalValueMinor !== null).toBe(costsVisible);
      const catalog = await actions.getProductCatalogPageData(account.s1);
      expect(catalog.ok).toBe(true);
      if (catalog.ok) {
        expect(catalog.products).toHaveLength(2);
        expect(catalog.products.every((p) => (p.unit_cost !== null) === costsVisible)).toBe(true);
      }

      // S2, même compte, sans appartenance : refus, et rien d'autre qu'un code.
      for (const shopId of [account.s2]) {
        expect(await actions.getProductsPageData({ shopId })).toEqual({
          errorCode: 'forbidden',
          ok: false,
        });
        expect(await actions.getStockCatalogSummaryData(shopId)).toEqual({
          errorCode: 'forbidden',
          ok: false,
        });
        expect(await actions.getProductCatalogPageData(shopId)).toEqual({
          errorCode: 'forbidden',
          ok: false,
        });
      }
    },
    120_000,
  );

  it('une boutique d’un autre compte, un identifiant inexistant ou mal formé : refus', async () => {
    const member = await limitedMember(account, 'manager');
    harness.session = await login(member.email);
    for (const shopId of [other.s1, randomUUID(), 'pas-un-identifiant', '']) {
      expect(await actions.getProductsPageData({ shopId })).toEqual({
        errorCode: 'forbidden',
        ok: false,
      });
      expect(await actions.getStockCatalogSummaryData(shopId)).toEqual({
        errorCode: 'forbidden',
        ok: false,
      });
      expect(await actions.getProductCatalogPageData(shopId)).toEqual({
        errorCode: 'forbidden',
        ok: false,
      });
    }
  });

  it('le propriétaire du compte, membre des deux boutiques, lit S1 et S2', async () => {
    harness.session = await login(account.owner.email);
    const s1 = await actions.getProductsPageData({ shopId: account.s1 });
    const s2 = await actions.getProductsPageData({ shopId: account.s2 });
    expect(s1.ok && s1.items.length).toBe(2);
    expect(s2.ok && s2.items.length).toBe(3);
    const catalog = await actions.getProductCatalogPageData(account.s2);
    expect(catalog.ok && catalog.products.length).toBe(3);
    const summary = await actions.getStockCatalogSummaryData(account.s2);
    expect(summary.ok).toBe(true);
  });

  it('sans session : aucune donnée', async () => {
    harness.session = createClient<Database>(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    expect(await actions.getProductsPageData({ shopId: account.s1 })).toEqual({
      errorCode: 'unauthenticated',
      ok: false,
    });
  });
});
