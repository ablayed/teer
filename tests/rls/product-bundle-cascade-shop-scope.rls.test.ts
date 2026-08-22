/**
 * Fuite 2 (migration 0137) — assert_bundle_component_integrity compare désormais aussi
 * shop_id, pas seulement merchant_account_id. Ce fichier exerce le trigger PostgREST
 * DIRECT (client authenticated signé, même appel que ferait saveBundleConfigurationAction
 * sans sa garde TS) : preuve de la couche SQL, distincte du canal HTTP réel de la Server
 * Action couvert par tests/e2e/products-bundle-shop-tenant-isolation.spec.ts. Aucun des
 * deux tests ne remplace l'autre — cf. CLAUDE.md, discipline « deux niveaux ».
 *
 * Piège documenté ici pour ne pas le reproduire ailleurs : les deux triggers BEFORE
 * INSERT sur product_bundle_component (assert_integrity et default_store_context)
 * s'exécutent dans l'ordre ALPHABÉTIQUE de leur nom, pas dans l'ordre de création.
 * `assert_integrity` (« assert… ») s'exécute avant `default_store_context`
 * (« default… », migration 0126) — un insert qui omet shop_id verrait donc new.shop_id
 * encore NULL au moment de la comparaison. 0137 neutralise ce risque en répliquant la
 * résolution du shop par défaut À L'INTÉRIEUR du trigger renforcé (mêmes conditions que
 * assign_default_store_context) : à documenter comme invariant à maintenir en parallèle
 * de toute future modification de assign_default_store_context.
 */
import type { Database } from '@/lib/supabase/database.types';
import { callStockMovementEngine } from '@/tests/helpers/stock-movement-engine';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'bundle-shop-scope-test-pw';

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

type AdminClient = SupabaseClient<Database>;

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('User creation failed');
  return data.user.id;
}

async function waitForMerchantAccountAndShop(admin: AdminClient, userId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.id) {
      const { data: shopRow } = await admin
        .from('shop')
        .select('id')
        .eq('merchant_account_id', data.id)
        .limit(1)
        .maybeSingle();
      if (shopRow?.id) return { merchantAccountId: data.id, shopId: shopRow.id as string };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('merchant_account/shop not found');
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = `bundle-shop-scope-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const { merchantAccountId, shopId } = await waitForMerchantAccountAndShop(admin, userId);
  return { admin, email, userId, merchantAccountId, shopId };
}

async function signIn(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await client.auth.signInWithPassword({ email, password });
  return client;
}

async function createShop(admin: AdminClient, merchantAccountId: string, domain: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      access_token_encrypted: 'enc',
      merchant_account_id: merchantAccountId,
      scopes: 'read_orders',
      shop_domain: domain,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data.id as string;
}

async function createProduct(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  opts: { title: string; isBundle?: boolean },
) {
  const { data, error } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      title: opts.title,
      unit_cost: 0,
      is_bundle: opts.isBundle ?? false,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return data.id as string;
}

async function insertBundleComponentAs(
  client: AdminClient,
  merchantAccountId: string,
  shopId: string,
  bundleProductId: string,
  componentProductId: string,
  quantity: number,
) {
  const { error } = await client.from('product_bundle_component').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    bundle_product_id: bundleProductId,
    component_product_id: componentProductId,
    quantity,
  });
  return error;
}

describe('0137 — assert_bundle_component_integrity compare aussi shop_id', () => {
  skipIfNoServiceRole(
    'enregistrement positif : bundle et composant dans la même boutique',
    async () => {
      const { admin, merchantAccountId, shopId } = await createOwnerFixture('positive');
      const bundleId = await createProduct(admin, merchantAccountId, shopId, {
        title: 'Bundle même boutique',
        isBundle: true,
      });
      const componentId = await createProduct(admin, merchantAccountId, shopId, {
        title: 'Composant même boutique',
      });
      const error = await insertBundleComponentAs(
        admin,
        merchantAccountId,
        shopId,
        bundleId,
        componentId,
        2,
      );
      expect(error).toBeNull();
    },
  );

  skipIfNoServiceRole(
    'refus : composant réel dans une autre boutique du même tenant, en session owner authentifiée',
    async () => {
      const {
        admin,
        email,
        merchantAccountId,
        shopId: shopA1,
      } = await createOwnerFixture('cross-shop-component');
      const shopA2 = await createShop(
        admin,
        merchantAccountId,
        `bundle-shop-scope-cs-a2-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`,
      );
      const bundleId = await createProduct(admin, merchantAccountId, shopA1, {
        title: 'Bundle A1',
        isBundle: true,
      });
      const componentId = await createProduct(admin, merchantAccountId, shopA2, {
        title: 'Composant réellement en A2',
      });
      const client = await signIn(email);
      // Même appel que saveBundleConfigurationAction (ctx.supabase.insert), en session
      // owner réelle : ligne posée dans la boutique du bundle (A1), composant réel A2.
      const { error } = await client.from('product_bundle_component').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopA1,
        bundle_product_id: bundleId,
        component_product_id: componentId,
        quantity: 1,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/same shop_id/);
    },
  );

  skipIfNoServiceRole(
    'refus : bundle_product_id forgé pointant une autre boutique du même tenant',
    async () => {
      const {
        admin,
        email,
        merchantAccountId,
        shopId: shopA1,
      } = await createOwnerFixture('cross-shop-bundle');
      const shopA2 = await createShop(
        admin,
        merchantAccountId,
        `bundle-shop-scope-cb-a2-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`,
      );
      const bundleId = await createProduct(admin, merchantAccountId, shopA2, {
        title: 'Bundle réellement en A2',
        isBundle: true,
      });
      const componentId = await createProduct(admin, merchantAccountId, shopA1, {
        title: 'Composant A1',
      });
      const client = await signIn(email);
      const { error } = await client.from('product_bundle_component').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopA1,
        bundle_product_id: bundleId,
        component_product_id: componentId,
        quantity: 1,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/same shop_id/);
    },
  );

  skipIfNoServiceRole(
    'refus (non-régression) : composant appartenant à un autre tenant, invariant préexistant',
    async () => {
      const tenantA = await createOwnerFixture('tenant-a');
      const tenantB = await createOwnerFixture('tenant-b');
      const bundleId = await createProduct(
        tenantA.admin,
        tenantA.merchantAccountId,
        tenantA.shopId,
        { title: 'Bundle tenant A', isBundle: true },
      );
      const componentId = await createProduct(
        tenantB.admin,
        tenantB.merchantAccountId,
        tenantB.shopId,
        { title: 'Composant tenant B' },
      );
      const client = await signIn(tenantA.email);
      const { error } = await client.from('product_bundle_component').insert({
        merchant_account_id: tenantA.merchantAccountId,
        shop_id: tenantA.shopId,
        bundle_product_id: bundleId,
        component_product_id: componentId,
        quantity: 1,
      });
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/merchant_account_id/);
    },
  );

  skipIfNoServiceRole(
    'vente réelle avec récursion : le mouvement composant atterrit dans SA propre boutique',
    async () => {
      const { admin, merchantAccountId, shopId, userId } = await createOwnerFixture('sale');
      const bundleId = await createProduct(admin, merchantAccountId, shopId, {
        title: 'Bundle vendu',
        isBundle: true,
      });
      const componentId = await createProduct(admin, merchantAccountId, shopId, {
        title: 'Composant du bundle vendu',
      });
      const compositionError = await insertBundleComponentAs(
        admin,
        merchantAccountId,
        shopId,
        bundleId,
        componentId,
        3,
      );
      expect(compositionError).toBeNull();

      const result = await callStockMovementEngine({
        p_merchant_account_id: merchantAccountId,
        p_product_id: bundleId,
        p_movement_type: 'sold',
        p_qty: 2,
        p_idempotency_key: `bundle-shop-scope-sale-${Date.now()}`,
        p_created_by: userId,
      });
      expect(result.error).toBeNull();

      const { data: bundleMovements } = await admin
        .from('stock_movement')
        .select('id')
        .eq('product_id', bundleId);
      expect(bundleMovements ?? []).toHaveLength(0);

      const { data: componentMovements, error: readError } = await admin
        .from('stock_movement')
        .select('product_id, shop_id, movement_type, qty')
        .eq('product_id', componentId)
        .eq('movement_type', 'sold');
      expect(readError).toBeNull();
      expect(componentMovements).toHaveLength(1);
      expect(componentMovements?.[0]?.shop_id).toBe(shopId);
      expect(componentMovements?.[0]?.qty).toBe(6);
    },
  );
});
