/**
 * Tests RLS / intégration du module Livreurs (Phase 4, migration 0031).
 *
 * Couvre : allocation de lot (allocate_to_courier) + retour (courier_return_lot)
 * via post_stock_movement avec driver_id, l'invariant stock (Σ stock en main
 * livreurs + entrepôt = total ledger), l'idempotence des allocations de lot,
 * la contrainte « lot exige un livreur », et l'invisibilité du cash livreur
 * pour l'agent.
 */

import { type DriverStockMovement, driverStockRows } from '@/lib/drivers/stock-on-hand';
import type { Database } from '@/lib/supabase/database.types';
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

async function createProduct(admin: AdminClient, merchantAccountId: string) {
  const { data } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      title: `Prod-${Date.now()}`,
      unit_cost: 5000,
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
      p_driver_id?: string | null;
      p_unit_cost?: number | null;
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

// ──────────────────────────────────────────────────────────────────────────
// ALLOCATION / RETOUR DE LOT + INVARIANT STOCK
// ──────────────────────────────────────────────────────────────────────────

describe('lot livreur : allocate_to_courier / courier_return_lot + invariant', () => {
  skipIfNoServiceRole(
    'allocation et retour de lot déplacent le stock entrepôt ↔ livreur ; invariant conservé',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('lot');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const ownerClient = await signIn(email);
      const post = postMovementRpc(ownerClient);

      // purchase_in 100 → entrepôt 100
      await post('post_stock_movement', {
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'purchase_in',
        p_qty: 100,
        p_idempotency_key: `lot:${productId}:in`,
        p_created_by: userId,
        p_unit_cost: 5000,
      });

      // allocate_to_courier -30 → entrepôt 70, en main 30
      const { error: allocErr } = await post('post_stock_movement', {
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'allocate_to_courier',
        p_qty: -30,
        p_idempotency_key: `lot:${productId}:alloc`,
        p_created_by: userId,
        p_driver_id: driverId,
      });
      expect(allocErr).toBeNull();

      // courier_return_lot +10 → entrepôt 80, en main 20
      await post('post_stock_movement', {
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
      expect(stock?.qty_on_hand).toBe(80);

      // Stock en main du livreur dérivé du ledger
      const { data: movements } = await admin
        .from('stock_movement')
        .select('driver_id, product_id, movement_type, qty')
        .eq('merchant_account_id', merchantAccountId)
        .eq('driver_id', driverId);

      const hand = driverStockRows((movements ?? []) as DriverStockMovement[], driverId);
      expect(hand).toEqual([{ driverId, productId, qtyOnHand: 20 }]);

      // INVARIANT : entrepôt (80) + en main livreur (20) = total acheté (100)
      const driverHand = hand.reduce((sum, r) => sum + r.qtyOnHand, 0);
      expect((stock?.qty_on_hand ?? 0) + driverHand).toBe(100);

      // Le mouvement d'allocation porte bien le livreur
      const alloc = (movements ?? []).find((m) => m.movement_type === 'allocate_to_courier');
      expect(alloc?.driver_id).toBe(driverId);
    },
  );

  skipIfNoServiceRole(
    'réconciliation après allocation de lot : 0 écart + rebuild reconstruit la bonne valeur',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('lot-recon');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const ownerClient = await signIn(email);
      const post = postMovementRpc(ownerClient);

      // purchase_in 100 puis allocate_to_courier -30 → entrepôt 70.
      await post('post_stock_movement', {
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'purchase_in',
        p_qty: 100,
        p_idempotency_key: `recon-lot:${productId}:in`,
        p_created_by: userId,
        p_unit_cost: 5000,
      });
      await post('post_stock_movement', {
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

      // reconcile : allocate_to_courier est désormais compté (0032) → aucun écart.
      const { data: discrepancies, error: reconErr } = await rpc('reconcile_product_stock');
      expect(reconErr).toBeNull();
      const productDiscrepancies = (discrepancies as { product_id: string }[] | null)?.filter(
        (row) => row.product_id === productId,
      );
      expect(productDiscrepancies).toHaveLength(0);

      // rebuild : on corrompt la projection, rebuild doit la ramener à 70
      // (somme ledger incluant le lot), pas à 100.
      await admin.from('product_stock').update({ qty_on_hand: 999 }).eq('product_id', productId);

      const { error: rebuildErr } = await rpc('rebuild_product_stock');
      expect(rebuildErr).toBeNull();

      const { data: rebuilt } = await admin
        .from('product_stock')
        .select('qty_on_hand')
        .eq('product_id', productId)
        .single();
      expect(rebuilt?.qty_on_hand).toBe(70);
    },
  );

  skipIfNoServiceRole('idempotence : même clé d’allocation de lot → no-op', async () => {
    const { admin, email, merchantAccountId, userId } = await createOwnerFixture('lot-idem');
    const productId = await createProduct(admin, merchantAccountId);
    const driverId = await createDriver(admin, merchantAccountId);
    const ownerClient = await signIn(email);
    const post = postMovementRpc(ownerClient);

    await post('post_stock_movement', {
      p_merchant_account_id: merchantAccountId,
      p_product_id: productId,
      p_movement_type: 'purchase_in',
      p_qty: 50,
      p_idempotency_key: `idem:${productId}:in`,
      p_created_by: userId,
      p_unit_cost: 5000,
    });

    const key = `idem:${productId}:alloc`;
    const { data: id1 } = await post('post_stock_movement', {
      p_merchant_account_id: merchantAccountId,
      p_product_id: productId,
      p_movement_type: 'allocate_to_courier',
      p_qty: -20,
      p_idempotency_key: key,
      p_created_by: userId,
      p_driver_id: driverId,
    });
    expect(id1).not.toBeNull();

    const { data: id2 } = await post('post_stock_movement', {
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
    expect(stock?.qty_on_hand).toBe(30); // 50 - 20 une seule fois
  });

  skipIfNoServiceRole('un lot sans livreur est rejeté (contrainte)', async () => {
    const { admin, email, merchantAccountId, userId } = await createOwnerFixture('lot-nodriver');
    const productId = await createProduct(admin, merchantAccountId);
    const ownerClient = await signIn(email);
    const post = postMovementRpc(ownerClient);

    const { error } = await post('post_stock_movement', {
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
// CASH LIVREUR INVISIBLE À L'AGENT
// ──────────────────────────────────────────────────────────────────────────

describe('cash livreur : invisible à l’agent (RLS owner/manager)', () => {
  skipIfNoServiceRole('un agent ne lit aucun cash_settlement ni allocation', async () => {
    const { admin, merchantAccountId, userId } = await createOwnerFixture('cash-agent');
    const driverId = await createDriver(admin, merchantAccountId);
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
