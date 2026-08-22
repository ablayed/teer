/**
 * Tests RLS / intégration du module Livreurs (Phase 4, migration 0031).
 *
 * Couvre : allocation de lot (allocate_to_courier) + retour (courier_return_lot)
 * via post_stock_movement avec driver_id, l'idempotence des allocations de lot,
 * la contrainte « lot exige un livreur », et l'invisibilité du cash livreur
 * pour l'agent.
 *
 * Depuis la migration 0093 (Lot 4b+4c / PR 1), ces deux movement_type sont
 * ledger-only : ils ne mutent plus product_stock.qty_on_hand. L'ancien
 * invariant « Σ stock en main livreurs + entrepôt = total ledger » ne
 * s'applique plus — le stock en main du livreur (driverStockRows) reste
 * dérivé du ledger seul, découplé de product_stock.
 */

import { randomUUID } from 'node:crypto';
import { type DriverStockMovement, driverStockRows } from '@/lib/drivers/stock-on-hand';
import type { Database } from '@/lib/supabase/database.types';
import { callStockMovementEngine } from '@/tests/helpers/stock-movement-engine';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'driver-stock-test-pw-4';
const createdUserIds: string[] = [];

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
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function waitForMerchantAccount(admin: AdminClient, userId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('merchant_account not found');
}

async function signIn(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await client.auth.signInWithPassword({ email, password });
  return client;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = `driver-stock-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function createSecondaryShop(admin: AdminClient, merchantAccountId: string, userId: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `driver-stock-${Date.now()}-${randomUUID()}.internal`,
      access_token_encrypted: 'enc',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('secondary shop insert failed');
  const { error: memberError } = await admin.from('shop_member').insert({
    merchant_account_id: merchantAccountId,
    shop_id: data.id,
    user_id: userId,
    role: 'owner',
  });
  if (memberError && !memberError.message.includes('duplicate')) throw memberError;
  return data.id;
}

async function addAgent(admin: AdminClient, merchantAccountId: string, label: string) {
  const email = `driver-stock-agent-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_member').insert({
    merchant_account_id: merchantAccountId,
    user_id: userId,
    role: 'agent',
  });
  return { email, userId };
}

async function createProduct(admin: AdminClient, merchantAccountId: string, shopId?: string) {
  const { data } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      title: `Prod-${Date.now()}`,
      unit_cost: 5000,
      ...(shopId ? { shop_id: shopId } : {}),
    })
    .select('id')
    .single();
  if (!data) throw new Error('product insert failed');
  return data.id;
}

async function createDriver(admin: AdminClient, merchantAccountId: string) {
  const { data } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: `Livreur-${Date.now()}`,
      phone: '+221770000000',
    })
    .select('id')
    .single();
  if (!data) throw new Error('driver insert failed');
  return data.id;
}

async function seedDriverShop(
  admin: AdminClient,
  merchantAccountId: string,
  driverId: string,
  shopId?: string,
) {
  let shopQuery = admin.from('shop').select('id').eq('merchant_account_id', merchantAccountId);
  shopQuery = shopId ? shopQuery.eq('id', shopId) : shopQuery.eq('is_default', true);
  const { data: shop } = await shopQuery.single();
  if (!shop) throw new Error('default shop missing');
  const { error } = await admin.from('driver_shop').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shop.id,
    driver_id: driverId,
  });
  if (error) throw error;
  return shop.id;
}

function postMovementRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'post_stock_movement',
    args: {
      p_merchant_account_id: string;
      p_product_id: string;
      p_movement_type: string;
      p_qty: number;
      p_idempotency_key: string;
      p_created_by: string;
      p_expected_shop_id?: string;
      p_driver_id?: string | null;
      p_unit_cost?: number | null;
      p_reason?: string | null;
    },
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('post_stock_movement — cœur privé (0136) / capacité publique scopée', () => {
  skipIfNoServiceRole(
    'un owner authentifié ne peut plus atteindre le cœur en HTTP ; la surcharge publique scopée reste résolue',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('public-capability');
      const productId = await createProduct(admin, merchantAccountId);
      const { data: product } = await admin
        .from('product')
        .select('shop_id')
        .eq('id', productId)
        .single();
      if (!product?.shop_id) throw new Error('product shop_id missing');

      const ownerClient = await signIn(email);
      const post = postMovementRpc(ownerClient);
      const payload = {
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'manual_adjustment',
        p_qty: 1,
        p_created_by: userId,
        p_reason: 'preuve 0136',
      };

      // 0136 a déplacé le cœur à 12 arguments dans le schéma `private`, non exposé
      // par PostgREST : ce contournement HTTP authenticated (0134/0135) est fermé,
      // pour TOUS les rôles, pas seulement l'agent — c'est le point exact de ce lot.
      // PGRST202 (fonction introuvable), pas 42501 (droit refusé) : la barrière est
      // au niveau du cache de schéma PostgREST, pas des grants SQL.
      const core = await post('post_stock_movement', {
        ...payload,
        p_idempotency_key: `0136:core:${productId}`,
      });
      expect(core.error).not.toBeNull();
      expect(core.error?.message ?? '').toContain('Could not find the function');

      // Même charge utile, enrichie du contexte de boutique obligatoire : la
      // surcharge 13-arguments, elle, reste publique — signature/grants/gardes
      // inchangés par 0136, seule sa cible interne qualifiée a changé.
      const scoped = await post('post_stock_movement', {
        ...payload,
        p_idempotency_key: `0136:public:${productId}`,
        p_expected_shop_id: product.shop_id,
      });
      expect(scoped.error).toBeNull();
      expect(scoped.data).not.toBeNull();

      // Aucune écriture fantôme depuis l'appel refusé sur le cœur : un seul
      // mouvement au ledger, celui posé par la surcharge publique.
      const { data: movements } = await admin
        .from('stock_movement')
        .select('id')
        .eq('product_id', productId);
      expect(movements).toHaveLength(1);
    },
  );
});

describe('0134/0135 — incident cross-boutique et read model', () => {
  skipIfNoServiceRole(
    'les gardes boutique refusent toute combinaison croisée sans écrire de mouvement',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('cross-shop');
      const shopA = await seedDriverShop(
        admin,
        merchantAccountId,
        await createDriver(admin, merchantAccountId),
      );
      const shopB = await createSecondaryShop(admin, merchantAccountId, userId);
      const productA = await createProduct(admin, merchantAccountId, shopA);
      const productB = await createProduct(admin, merchantAccountId, shopB);
      const driverA = await createDriver(admin, merchantAccountId);
      const driverB = await createDriver(admin, merchantAccountId);
      await seedDriverShop(admin, merchantAccountId, driverA, shopA);
      await seedDriverShop(admin, merchantAccountId, driverB, shopB);
      await admin.from('product_stock').upsert(
        {
          product_id: productA,
          merchant_account_id: merchantAccountId,
          qty_on_hand: 10,
          unit_cost: 5000,
        },
        { onConflict: 'product_id' },
      );

      const owner = postMovementRpc(await signIn(email));
      const call = (productId: string, driverId: string, expectedShopId: string, key: string) =>
        owner('post_stock_movement', {
          p_merchant_account_id: merchantAccountId,
          p_product_id: productId,
          p_movement_type: 'driver_stock_set',
          p_qty: 4,
          p_idempotency_key: `cross:${merchantAccountId}:${key}`,
          p_created_by: userId,
          p_expected_shop_id: expectedShopId,
          p_driver_id: driverId,
        });

      const crossProduct = await call(productB, driverA, shopA, 'cross:product');
      const crossDriver = await call(productA, driverB, shopA, 'cross:driver');
      const wrongExpectedShop = await call(productB, driverB, shopA, 'cross:expected');
      expect(crossProduct.error).not.toBeNull();
      expect(crossDriver.error).not.toBeNull();
      expect(wrongExpectedShop.error).not.toBeNull();

      const valid = await call(productA, driverA, shopA, 'cross:valid');
      expect(valid.error).toBeNull();

      const { data: movements } = await admin
        .from('stock_movement')
        .select('id, shop_id, product_id, driver_id, movement_type, qty')
        .eq('merchant_account_id', merchantAccountId)
        .in('product_id', [productA, productB]);
      expect(movements).toHaveLength(1);
      expect(movements?.[0]).toMatchObject({
        shop_id: shopA,
        product_id: productA,
        driver_id: driverA,
      });

      const { data: driverBInA } = await admin
        .from('driver_shop')
        .select('driver_id')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shop_id', shopA)
        .eq('driver_id', driverB);
      expect(driverBInA).toHaveLength(0);

      const { data: central } = await admin
        .from('product_stock')
        .select('qty_on_hand')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shop_id', shopA)
        .eq('product_id', productA)
        .single();
      expect(central?.qty_on_hand).toBe(10);
      expect(driverStockRows((movements ?? []) as DriverStockMovement[], driverA)).toEqual([
        { driverId: driverA, productId: productA, qtyOnHand: 4 },
      ]);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// ALLOCATION / RETOUR DE LOT + INVARIANT STOCK
// ──────────────────────────────────────────────────────────────────────────

describe('lot livreur : allocate_to_courier / courier_return_lot + invariant', () => {
  skipIfNoServiceRole(
    'allocation et retour de lot sont ledger-only (0093) : entrepôt inchangé, stock en main dérivé du ledger',
    async () => {
      const { admin, merchantAccountId, userId } = await createOwnerFixture('lot');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      await seedDriverShop(admin, merchantAccountId, driverId);

      // 0136 : cœur post_stock_movement dans `private` — connexion Postgres directe.
      // purchase_in 100 → entrepôt 100
      await callStockMovementEngine({
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'purchase_in',
        p_qty: 100,
        p_idempotency_key: `lot:${productId}:in`,
        p_created_by: userId,
        p_unit_cost: 5000,
      });

      // allocate_to_courier -30 → ledger-only depuis 0093 : entrepôt reste 100
      const { error: allocErr } = await callStockMovementEngine({
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'allocate_to_courier',
        p_qty: -30,
        p_idempotency_key: `lot:${productId}:alloc`,
        p_created_by: userId,
        p_driver_id: driverId,
      });
      expect(allocErr).toBeNull();

      // courier_return_lot +10 → ledger-only depuis 0093 : entrepôt reste 100
      await callStockMovementEngine({
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'courier_return_lot',
        p_qty: 10,
        p_idempotency_key: `lot:${productId}:return`,
        p_created_by: userId,
        p_driver_id: driverId,
      });

      const { data: stock } = await admin
        .from('product_stock')
        .select('qty_on_hand')
        .eq('product_id', productId)
        .single();
      // 0093 : allocate_to_courier / courier_return_lot ne mutent plus qty_on_hand.
      expect(stock?.qty_on_hand).toBe(100);

      // Stock en main du livreur reste dérivé du ledger seul (inchangé par 0093,
      // ce calcul n'a jamais dépendu de product_stock).
      const { data: movements } = await admin
        .from('stock_movement')
        .select('driver_id, product_id, movement_type, qty')
        .eq('merchant_account_id', merchantAccountId)
        .eq('driver_id', driverId);

      const hand = driverStockRows((movements ?? []) as DriverStockMovement[], driverId);
      expect(hand).toEqual([{ driverId, productId, qtyOnHand: 20 }]);

      // Le mouvement d'allocation porte bien le livreur
      const alloc = (movements ?? []).find((m) => m.movement_type === 'allocate_to_courier');
      expect(alloc?.driver_id).toBe(driverId);
    },
  );

  skipIfNoServiceRole(
    'réconciliation après allocation de lot : 0 écart + rebuild reconstruit la bonne valeur',
    async () => {
      const { admin, merchantAccountId, userId } = await createOwnerFixture('lot-recon');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      await seedDriverShop(admin, merchantAccountId, driverId);

      // 0136 : cœur post_stock_movement dans `private` — connexion Postgres directe.
      // purchase_in 100 puis allocate_to_courier -30 → ledger-only depuis 0093,
      // entrepôt reste 100.
      await callStockMovementEngine({
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'purchase_in',
        p_qty: 100,
        p_idempotency_key: `recon-lot:${productId}:in`,
        p_created_by: userId,
        p_unit_cost: 5000,
      });
      await callStockMovementEngine({
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'allocate_to_courier',
        p_qty: -30,
        p_idempotency_key: `recon-lot:${productId}:alloc`,
        p_created_by: userId,
        p_driver_id: driverId,
      });

      const rpc = admin.rpc.bind(admin) as unknown as (
        fn: string,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;

      // reconcile : allocate_to_courier est exclu de l'allowlist depuis 0094 (comme
      // il ne mute plus qty_on_hand depuis 0093) → toujours aucun écart.
      const { data: discrepancies, error: reconErr } = await rpc('reconcile_product_stock');
      expect(reconErr).toBeNull();
      const productDiscrepancies = (discrepancies as { product_id: string }[] | null)?.filter(
        (row) => row.product_id === productId,
      );
      expect(productDiscrepancies).toHaveLength(0);

      // rebuild : on corrompt la projection, rebuild doit la ramener à 100
      // (somme ledger purchase_in seul depuis 0094, le lot n'y figure plus).
      await admin.from('product_stock').update({ qty_on_hand: 999 }).eq('product_id', productId);

      const { error: rebuildErr } = await rpc('rebuild_product_stock');
      expect(rebuildErr).toBeNull();

      const { data: rebuilt } = await admin
        .from('product_stock')
        .select('qty_on_hand')
        .eq('product_id', productId)
        .single();
      expect(rebuilt?.qty_on_hand).toBe(100);
    },
  );

  skipIfNoServiceRole('idempotence : même clé d’allocation de lot → no-op', async () => {
    const { admin, merchantAccountId, userId } = await createOwnerFixture('lot-idem');
    const productId = await createProduct(admin, merchantAccountId);
    const driverId = await createDriver(admin, merchantAccountId);
    await seedDriverShop(admin, merchantAccountId, driverId);

    // 0136 : cœur post_stock_movement dans `private` — connexion Postgres directe.
    await callStockMovementEngine({
      p_merchant_account_id: merchantAccountId,
      p_product_id: productId,
      p_movement_type: 'purchase_in',
      p_qty: 50,
      p_idempotency_key: `idem:${productId}:in`,
      p_created_by: userId,
      p_unit_cost: 5000,
    });

    const key = `idem:${productId}:alloc`;
    const { data: id1 } = await callStockMovementEngine({
      p_merchant_account_id: merchantAccountId,
      p_product_id: productId,
      p_movement_type: 'allocate_to_courier',
      p_qty: -20,
      p_idempotency_key: key,
      p_created_by: userId,
      p_driver_id: driverId,
    });
    expect(id1).not.toBeNull();

    const { data: id2 } = await callStockMovementEngine({
      p_merchant_account_id: merchantAccountId,
      p_product_id: productId,
      p_movement_type: 'allocate_to_courier',
      p_qty: -20,
      p_idempotency_key: key,
      p_created_by: userId,
      p_driver_id: driverId,
    });
    expect(id2).toBeNull(); // doublon

    const { data: stock } = await admin
      .from('product_stock')
      .select('qty_on_hand')
      .eq('product_id', productId)
      .single();
    // 0093 : allocate_to_courier ne mute plus qty_on_hand → reste 50, que
    // l'idempotence ait joué ou non (l'assertion id2===null ci-dessus reste
    // le test d'idempotence pertinent).
    expect(stock?.qty_on_hand).toBe(50);
  });

  skipIfNoServiceRole('un lot sans livreur est rejeté (contrainte)', async () => {
    const { admin, merchantAccountId, userId } = await createOwnerFixture('lot-nodriver');
    const productId = await createProduct(admin, merchantAccountId);

    // 0136 : cœur post_stock_movement dans `private` — connexion Postgres directe.
    const { error } = await callStockMovementEngine({
      p_merchant_account_id: merchantAccountId,
      p_product_id: productId,
      p_movement_type: 'allocate_to_courier',
      p_qty: -5,
      p_idempotency_key: `nodriver:${productId}`,
      p_created_by: userId,
      p_driver_id: null,
    });
    expect(error).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// driver_stock_set (Lot 4b+4c / PR 2) : ledger-only, jamais qty_on_hand
// ──────────────────────────────────────────────────────────────────────────

describe('driver_stock_set : ledger-only, sans effet sur product_stock', () => {
  skipIfNoServiceRole('poste un mouvement driver_stock_set sans muter qty_on_hand', async () => {
    const { admin, email, merchantAccountId, userId } = await createOwnerFixture('dss');
    const productId = await createProduct(admin, merchantAccountId);
    const driverId = await createDriver(admin, merchantAccountId);
    await seedDriverShop(admin, merchantAccountId, driverId);
    const ownerClient = await signIn(email);
    const post = postMovementRpc(ownerClient);
    const { data: product } = await admin
      .from('product')
      .select('shop_id')
      .eq('id', productId)
      .single();
    if (!product?.shop_id) throw new Error('product shop_id missing');

    // Stock central : purchase_in 100 → entrepôt 100.
    // 0136 : cœur post_stock_movement dans `private` — connexion Postgres directe.
    await callStockMovementEngine({
      p_merchant_account_id: merchantAccountId,
      p_product_id: productId,
      p_movement_type: 'purchase_in',
      p_qty: 100,
      p_idempotency_key: `dss:${productId}:in`,
      p_created_by: userId,
      p_unit_cost: 5000,
    });

    const { error } = await post('post_stock_movement', {
      p_merchant_account_id: merchantAccountId,
      p_product_id: productId,
      p_movement_type: 'driver_stock_set',
      p_qty: 12,
      p_idempotency_key: `dss:${productId}:set`,
      p_created_by: userId,
      p_expected_shop_id: product.shop_id,
      p_driver_id: driverId,
    });
    expect(error).toBeNull();

    const { data: stock } = await admin
      .from('product_stock')
      .select('qty_on_hand')
      .eq('product_id', productId)
      .single();
    // driver_stock_set est ledger-only (0095) : l'entrepôt reste 100.
    expect(stock?.qty_on_hand).toBe(100);

    const { data: movements } = await admin
      .from('stock_movement')
      .select('driver_id, movement_type, qty')
      .eq('merchant_account_id', merchantAccountId)
      .eq('driver_id', driverId);
    const set = (movements ?? []).find((m) => m.movement_type === 'driver_stock_set');
    expect(set?.qty).toBe(12);
    expect(set?.driver_id).toBe(driverId);
  });

  skipIfNoServiceRole('driver_stock_set sans livreur est rejeté (contrainte)', async () => {
    const { admin, merchantAccountId, userId } = await createOwnerFixture('dss-nodriver');
    const productId = await createProduct(admin, merchantAccountId);

    // 0136 : cœur post_stock_movement dans `private` — connexion Postgres directe
    // (cette garde vit dans le cœur, jamais dans la surcharge publique).
    const { error } = await callStockMovementEngine({
      p_merchant_account_id: merchantAccountId,
      p_product_id: productId,
      p_movement_type: 'driver_stock_set',
      p_qty: 5,
      p_idempotency_key: `dss-nodriver:${productId}`,
      p_created_by: userId,
      p_driver_id: null,
    });
    expect(error).not.toBeNull();
  });

  skipIfNoServiceRole(
    "driver_stock_set n'entre jamais dans l'allowlist de réconciliation (0032/0094)",
    async () => {
      const { admin, merchantAccountId, userId } = await createOwnerFixture('dss-recon');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      await seedDriverShop(admin, merchantAccountId, driverId);

      // 0136 : cœur post_stock_movement dans `private` — connexion Postgres directe.
      await callStockMovementEngine({
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'purchase_in',
        p_qty: 20,
        p_idempotency_key: `dss-recon:${productId}:in`,
        p_created_by: userId,
        p_unit_cost: 5000,
      });
      await callStockMovementEngine({
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'driver_stock_set',
        p_qty: 8,
        p_idempotency_key: `dss-recon:${productId}:set`,
        p_created_by: userId,
        p_driver_id: driverId,
      });

      const rpc = admin.rpc.bind(admin) as unknown as (
        fn: string,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
      const { data: discrepancies, error } = await rpc('reconcile_product_stock');
      expect(error).toBeNull();
      const productDiscrepancies = (discrepancies as { product_id: string }[] | null)?.filter(
        (row) => row.product_id === productId,
      );
      // driver_stock_set ne touchant jamais qty_on_hand, aucun écart ne peut
      // apparaître même sans figurer dans l'allowlist de reconcile_product_stock.
      expect(productDiscrepancies).toHaveLength(0);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// CASH LIVREUR INVISIBLE À L'AGENT
// ──────────────────────────────────────────────────────────────────────────

describe('cash livreur : invisible à l’agent (RLS owner/manager)', () => {
  skipIfNoServiceRole('un agent ne lit aucun cash_settlement ni allocation', async () => {
    const { admin, merchantAccountId, userId } = await createOwnerFixture('cash-agent');
    const driverId = await createDriver(admin, merchantAccountId);
    await seedDriverShop(admin, merchantAccountId, driverId);
    const { email: agentEmail } = await addAgent(admin, merchantAccountId, 'cash');

    // Seed un versement
    const { data: settlement } = await admin
      .from('cash_settlement')
      .insert({
        merchant_account_id: merchantAccountId,
        driver_id: driverId,
        amount_received_minor: 5000,
        method: 'ESPECES',
        client_request_id: crypto.randomUUID(),
        created_by: userId,
      })
      .select('id')
      .single();
    expect(settlement?.id).toBeTruthy();

    const agentClient = await signIn(agentEmail);
    const { data: settlements } = await agentClient
      .from('cash_settlement')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    expect(settlements ?? []).toHaveLength(0);

    const { data: allocations } = await agentClient
      .from('settlement_allocation')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    expect(allocations ?? []).toHaveLength(0);
  });
});
