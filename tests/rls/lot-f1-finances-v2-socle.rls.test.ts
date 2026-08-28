// Lot F1 — Socle de données Finances v2 (migration 0145). Preuves 7 à 13 du
// rapport de lot (les preuves 1 à 6, pures, vivent dans
// tests/unit/finance/lot-profitability.test.ts — aucune base nécessaire).

import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'lotf1-rls-test-pw';
const createdUserIds: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

type AdminClient = SupabaseClient<Database>;

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function anonClient(): AdminClient {
  return createClient<Database>(supabaseUrl, anonKey, {
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
  throw new Error('merchant_account not found after 20 retries');
}

async function waitForDefaultShop(admin: AdminClient, merchantAccountId: string) {
  for (let i = 0; i < 30; i++) {
    const { data } = await admin
      .from('shop')
      .select('id')
      .eq('merchant_account_id', merchantAccountId)
      .eq('is_default', true)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id as string;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('default shop not found after 30 retries');
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
  const email = `lotf1-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  const shopId = await waitForDefaultShop(admin, merchantAccountId);
  return { admin, email, merchantAccountId, shopId, userId };
}

async function addMember(admin: AdminClient, merchantAccountId: string, role: 'agent' | 'manager') {
  const email = `lotf1-member-${role}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  const { error } = await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role, user_id: userId });
  if (error) throw error;
  return { email, userId };
}

async function createDriver(admin: AdminClient, merchantAccountId: string, shopId: string) {
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
  await admin
    .from('driver_shop')
    .insert({ merchant_account_id: merchantAccountId, shop_id: shopId, driver_id: data.id });
  return data.id;
}

async function createProduct(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { data } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      title: `Prod-F1-${Date.now()}`,
      unit_cost: 0,
    })
    .select('id')
    .single();
  if (!data) throw new Error('product insert failed');
  return data.id;
}

type TransitionOrderArgs = {
  p_actor: string;
  p_order_id: string;
  p_call_state?: string;
  p_delivery_state?: string;
  p_order_state?: string;
  p_cash_state?: string;
  p_attempt_count?: number;
  p_payment_channel?: string;
  p_invalidate_delivered?: boolean;
};

function transitionRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'transition_order',
    args: TransitionOrderArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}

async function createOrderWithLine(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  driverId: string,
  productId: string,
  qty: number,
) {
  const { data: order } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      order_number: `F1-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      total_amount: 10000,
      currency: 'XOF',
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      assigned_driver_id: driverId,
    })
    .select('id')
    .single();
  if (!order) throw new Error('order insert failed');

  const { data: line } = await admin
    .from('order_line')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      order_id: order.id,
      product_id: productId,
      raw_title: 'Produit F1',
      qty,
      match_status: 'matched',
    })
    .select('id')
    .single();
  if (!line) throw new Error('order_line insert failed');

  return { orderId: order.id as string, orderLineId: line.id as string };
}

/** Confirmer → programmer → dispatch → livrer (encaissé), séquence réaliste identique aux autres suites RLS. */
async function deliverAndCollect(
  client: SupabaseClient<Database>,
  userId: string,
  orderId: string,
) {
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_call_state: 'validated',
    p_attempt_count: 1,
  });
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'scheduled',
  });
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'out_for_delivery',
  });
  return transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'delivered',
    p_order_state: 'completed',
    p_cash_state: 'collected',
    p_payment_channel: 'ESPECES',
  });
}

type ReceiveRpcArgs = {
  p_lot_id: string;
  p_merchant_account_id: string;
  p_actor_id: string;
  p_lines: Array<{
    line_id: string;
    line_value: number;
    allocated_fees: number;
    landed_total_value: number;
    landed_unit_cost: number;
  }>;
};

function receiveRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'receive_purchase_lot',
    args: ReceiveRpcArgs,
  ) => Promise<{ data: null; error: { message: string } | null }>;
}

async function receiveLot(
  admin: AdminClient,
  ownerClient: SupabaseClient<Database>,
  merchantAccountId: string,
  shopId: string,
  userId: string,
  productId: string,
  qtyReceived: number,
  purchasePriceTotal: number,
) {
  const { data: lot } = await admin
    .from('purchase_lot')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      supplier_name: 'Fournisseur F1',
      ordered_at: '2026-01-01',
    })
    .select('id')
    .single();
  if (!lot) throw new Error('purchase_lot insert failed');

  const { data: line } = await admin
    .from('purchase_lot_line')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      purchase_lot_id: lot.id,
      product_id: productId,
      qty: qtyReceived,
      purchase_price_total: purchasePriceTotal,
    })
    .select('id')
    .single();
  if (!line) throw new Error('purchase_lot_line insert failed');

  const landedUnitCost = Math.floor(purchasePriceTotal / qtyReceived);
  const { error } = await receiveRpc(ownerClient)('receive_purchase_lot', {
    p_lot_id: lot.id,
    p_merchant_account_id: merchantAccountId,
    p_actor_id: userId,
    p_lines: [
      {
        line_id: line.id,
        line_value: purchasePriceTotal,
        allocated_fees: 0,
        landed_total_value: purchasePriceTotal,
        landed_unit_cost: landedUnitCost,
      },
    ],
  });
  if (error) throw new Error(`receive_purchase_lot failed: ${error.message}`);

  return { lotId: lot.id as string, purchaseLotLineId: line.id as string };
}

async function recognizedAllocationSum(admin: AdminClient, orderLineId: string) {
  const { data } = await admin
    .from('purchase_lot_line_allocation')
    .select('qty')
    .eq('order_line_id', orderLineId);
  return (data ?? []).reduce((sum, row) => sum + (row.qty ?? 0), 0);
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
// Preuve 7 : allocation FIFO — invariant qty allouée = qty reconnue vendue.
// ──────────────────────────────────────────────────────────────────────────

describe('purchase_lot_line_allocation — allocation FIFO (preuve 7)', () => {
  skipIfNoServiceRole(
    'commande livrée et encaissée crée l’allocation, invariant = qty vendue',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('fifo-sale');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const driverId = await createDriver(admin, merchantAccountId, shopId);
      const { purchaseLotLineId } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopId,
        userId,
        productId,
        20,
        265_200,
      );
      const { orderId, orderLineId } = await createOrderWithLine(
        admin,
        merchantAccountId,
        shopId,
        driverId,
        productId,
        3,
      );

      const delivered = await deliverAndCollect(owner, userId, orderId);
      expect(delivered.error).toBeNull();
      expect(delivered.data).toBe('LIVREE');

      const { data: allocations } = await admin
        .from('purchase_lot_line_allocation')
        .select('purchase_lot_line_id, qty, reason, recognized_transition_id')
        .eq('order_line_id', orderLineId);

      expect(allocations).toHaveLength(1);
      expect(allocations?.[0]?.purchase_lot_line_id).toBe(purchaseLotLineId);
      expect(allocations?.[0]?.qty).toBe(3);
      expect(allocations?.[0]?.reason).toBe('sale');
      expect(allocations?.[0]?.recognized_transition_id).not.toBeNull();

      expect(await recognizedAllocationSum(admin, orderLineId)).toBe(3);
    },
  );

  skipIfNoServiceRole(
    'une transition ultérieure (livrer rejoué implicitement) ne réécrit pas l’allocation',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('fifo-idem');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const driverId = await createDriver(admin, merchantAccountId, shopId);
      await receiveLot(admin, owner, merchantAccountId, shopId, userId, productId, 20, 265_200);
      const { orderId, orderLineId } = await createOrderWithLine(
        admin,
        merchantAccountId,
        shopId,
        driverId,
        productId,
        3,
      );

      await deliverAndCollect(owner, userId, orderId);
      // Un « redélivrer » n'a pas de sens côté produit (déjà delivered/collected),
      // mais la même garde que cash_collected_at (idempotence) protège aussi
      // contre un second appel direct avec les mêmes paramètres.
      await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'delivered',
        p_order_state: 'completed',
        p_cash_state: 'collected',
        p_payment_channel: 'ESPECES',
      });

      expect(await recognizedAllocationSum(admin, orderLineId)).toBe(3);
    },
  );

  skipIfNoServiceRole(
    'retour après livraison inverse l’allocation, invariant retombe à 0',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('fifo-return');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const driverId = await createDriver(admin, merchantAccountId, shopId);
      await receiveLot(admin, owner, merchantAccountId, shopId, userId, productId, 20, 265_200);
      const { orderId, orderLineId } = await createOrderWithLine(
        admin,
        merchantAccountId,
        shopId,
        driverId,
        productId,
        3,
      );

      await deliverAndCollect(owner, userId, orderId);
      expect(await recognizedAllocationSum(admin, orderLineId)).toBe(3);

      const returned = await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'returned',
        p_delivery_state: 'returned',
      });
      expect(returned.error).toBeNull();
      expect(returned.data).toBe('REFUSEE');

      expect(await recognizedAllocationSum(admin, orderLineId)).toBe(0);

      const { data: rows } = await admin
        .from('purchase_lot_line_allocation')
        .select('qty, reason, recognized_transition_id')
        .eq('order_line_id', orderLineId)
        .order('created_at');
      expect(rows).toHaveLength(2);
      expect(rows?.[1]?.qty).toBe(-3);
      expect(rows?.[1]?.reason).toBe('return');
      expect(rows?.[1]?.recognized_transition_id).not.toBeNull();
    },
  );

  skipIfNoServiceRole(
    'invalidation après livraison inverse l’allocation, recognized_transition_id NULL',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('fifo-invalidate');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const driverId = await createDriver(admin, merchantAccountId, shopId);
      await receiveLot(admin, owner, merchantAccountId, shopId, userId, productId, 20, 265_200);
      const { orderId, orderLineId } = await createOrderWithLine(
        admin,
        merchantAccountId,
        shopId,
        driverId,
        productId,
        3,
      );

      await deliverAndCollect(owner, userId, orderId);
      expect(await recognizedAllocationSum(admin, orderLineId)).toBe(3);

      // buildTransitionDimensionPatch('invalider') pose p_invalidate_delivered
      // ET les 4 dimensions de legacyStatusToDimensions('A_APPELER') dans le
      // même appel — la RPC ne les déduit jamais de p_invalidate_delivered seul.
      const invalidated = await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'open',
        p_call_state: 'to_call',
        p_delivery_state: 'unassigned',
        p_cash_state: 'not_due',
        p_invalidate_delivered: true,
      });
      expect(invalidated.error).toBeNull();
      expect(invalidated.data).toBe('A_APPELER');

      expect(await recognizedAllocationSum(admin, orderLineId)).toBe(0);

      const { data: rows } = await admin
        .from('purchase_lot_line_allocation')
        .select('qty, reason, recognized_transition_id')
        .eq('order_line_id', orderLineId)
        .order('created_at');
      expect(rows).toHaveLength(2);
      expect(rows?.[1]?.qty).toBe(-3);
      expect(rows?.[1]?.reason).toBe('invalidation');
      // 0116 : aucune ligne order_state_transition sur ce chemin — même régime
      // que stock_movement.transition_id, jamais un UUID fantôme.
      expect(rows?.[1]?.recognized_transition_id).toBeNull();
    },
  );

  skipIfNoServiceRole(
    'mutation-test : une inversion manquante fait échouer l’invariant (le checker est sensible)',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('fifo-mutation');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const driverId = await createDriver(admin, merchantAccountId, shopId);
      await receiveLot(admin, owner, merchantAccountId, shopId, userId, productId, 20, 265_200);
      const { orderId, orderLineId } = await createOrderWithLine(
        admin,
        merchantAccountId,
        shopId,
        driverId,
        productId,
        3,
      );

      await deliverAndCollect(owner, userId, orderId);
      const invalidated = await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'open',
        p_call_state: 'to_call',
        p_delivery_state: 'unassigned',
        p_cash_state: 'not_due',
        p_invalidate_delivered: true,
      });
      expect(invalidated.error).toBeNull();

      // Invariant respecté par transition_order lui-même.
      expect(await recognizedAllocationSum(admin, orderLineId)).toBe(0);

      // Simule EXACTEMENT ce qu'une régression de la réversion produirait :
      // la ligne compensatoire n'a jamais été posée. Le checker doit alors
      // détecter l'invariant cassé — sinon le checker lui-même est aveugle.
      const { data: rows } = await admin
        .from('purchase_lot_line_allocation')
        .select('id, qty')
        .eq('order_line_id', orderLineId)
        .order('created_at');
      const reversalRowId = rows?.[1]?.id;
      expect(reversalRowId).toBeTruthy();
      await admin
        .from('purchase_lot_line_allocation')
        .delete()
        .eq('id', reversalRowId as string);

      expect(await recognizedAllocationSum(admin, orderLineId)).not.toBe(0);
      expect(await recognizedAllocationSum(admin, orderLineId)).toBe(3);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Preuve 8 : correction de coût — audit posé, quantités jamais touchées.
// ──────────────────────────────────────────────────────────────────────────

type CorrectCostArgs = {
  p_merchant_account_id: string;
  p_purchase_lot_id: string;
  p_purchase_lot_line_id: string | null;
  p_field: 'purchase_price_total' | 'transport_total';
  p_new_value: number;
  p_actor_id: string;
};

function correctCostRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'correct_purchase_lot_cost',
    args: CorrectCostArgs,
  ) => Promise<{ data: null; error: { message: string } | null }>;
}

describe('correct_purchase_lot_cost — correction de coût sans effet sur les quantités (preuve 8)', () => {
  skipIfNoServiceRole(
    'corrige le prix d’achat puis le transport : audit posé, qty allouée inchangée',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('correct-cost');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const driverId = await createDriver(admin, merchantAccountId, shopId);
      const { lotId, purchaseLotLineId } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopId,
        userId,
        productId,
        20,
        265_200,
      );
      const { orderId, orderLineId } = await createOrderWithLine(
        admin,
        merchantAccountId,
        shopId,
        driverId,
        productId,
        3,
      );
      await deliverAndCollect(owner, userId, orderId);
      const qtyAllocatedBefore = await recognizedAllocationSum(admin, orderLineId);

      // Lecture AVANT.
      const { data: lineBefore } = await admin
        .from('purchase_lot_line')
        .select('purchase_price_total, qty')
        .eq('id', purchaseLotLineId)
        .single();
      const { data: lotBefore } = await admin
        .from('purchase_lot')
        .select('transport_total')
        .eq('id', lotId)
        .single();

      // Corrige le prix d'achat de la ligne.
      const priceCorrection = await correctCostRpc(owner)('correct_purchase_lot_cost', {
        p_merchant_account_id: merchantAccountId,
        p_purchase_lot_id: lotId,
        p_purchase_lot_line_id: purchaseLotLineId,
        p_field: 'purchase_price_total',
        p_new_value: 240_000,
        p_actor_id: userId,
      });
      expect(priceCorrection.error).toBeNull();

      // Corrige le transport du lot.
      const transportCorrection = await correctCostRpc(owner)('correct_purchase_lot_cost', {
        p_merchant_account_id: merchantAccountId,
        p_purchase_lot_id: lotId,
        p_purchase_lot_line_id: null,
        p_field: 'transport_total',
        p_new_value: 25_200,
        p_actor_id: userId,
      });
      expect(transportCorrection.error).toBeNull();

      // Lecture APRÈS.
      const { data: lineAfter } = await admin
        .from('purchase_lot_line')
        .select('purchase_price_total, qty')
        .eq('id', purchaseLotLineId)
        .single();
      const { data: lotAfter } = await admin
        .from('purchase_lot')
        .select('transport_total')
        .eq('id', lotId)
        .single();

      expect(lineAfter?.purchase_price_total).toBe(240_000);
      expect(lineAfter?.purchase_price_total).not.toBe(lineBefore?.purchase_price_total);
      expect(lotAfter?.transport_total).toBe(25_200);
      expect(lotAfter?.transport_total).not.toBe(lotBefore?.transport_total);

      // Les QUANTITÉS ne bougent jamais.
      expect(lineAfter?.qty).toBe(lineBefore?.qty);
      expect(await recognizedAllocationSum(admin, orderLineId)).toBe(qtyAllocatedBefore);

      // Piste d'audit : deux lignes, l'une par champ corrigé, valeurs avant/après exactes.
      const { data: corrections } = await admin
        .from('purchase_lot_cost_correction')
        .select('field, previous_value, new_value, purchase_lot_line_id, corrected_by')
        .eq('purchase_lot_id', lotId)
        .order('corrected_at');

      expect(corrections).toHaveLength(2);
      const priceRow = corrections?.find((c) => c.field === 'purchase_price_total');
      const transportRow = corrections?.find((c) => c.field === 'transport_total');
      expect(priceRow?.previous_value).toBe(265_200);
      expect(priceRow?.new_value).toBe(240_000);
      expect(priceRow?.purchase_lot_line_id).toBe(purchaseLotLineId);
      expect(priceRow?.corrected_by).toBe(userId);
      expect(transportRow?.previous_value).toBe(0);
      expect(transportRow?.new_value).toBe(25_200);
      expect(transportRow?.purchase_lot_line_id).toBeNull();
    },
  );

  skipIfNoServiceRole('manager ne peut pas corriger un coût (owner-only)', async () => {
    const { admin, email, merchantAccountId, shopId, userId } =
      await createOwnerFixture('correct-cost-manager');
    const owner = await signIn(email);
    const productId = await createProduct(admin, merchantAccountId, shopId);
    const { lotId, purchaseLotLineId } = await receiveLot(
      admin,
      owner,
      merchantAccountId,
      shopId,
      userId,
      productId,
      10,
      100_000,
    );
    const { email: managerEmail } = await addMember(admin, merchantAccountId, 'manager');
    const manager = await signIn(managerEmail);

    const { error } = await correctCostRpc(manager)('correct_purchase_lot_cost', {
      p_merchant_account_id: merchantAccountId,
      p_purchase_lot_id: lotId,
      p_purchase_lot_line_id: purchaseLotLineId,
      p_field: 'purchase_price_total',
      p_new_value: 1,
      p_actor_id: userId,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/forbidden/);
  });

  skipIfNoServiceRole('refuse un lot appartenant à un autre tenant', async () => {
    const a = await createOwnerFixture('correct-cost-cross-a');
    const b = await createOwnerFixture('correct-cost-cross-b');
    const ownerB = await signIn(b.email);
    const productB = await createProduct(b.admin, b.merchantAccountId, b.shopId);
    const { lotId } = await receiveLot(
      b.admin,
      ownerB,
      b.merchantAccountId,
      b.shopId,
      b.userId,
      productB,
      10,
      100_000,
    );

    const ownerA = await signIn(a.email);
    const { error } = await correctCostRpc(ownerA)('correct_purchase_lot_cost', {
      p_merchant_account_id: a.merchantAccountId,
      p_purchase_lot_id: lotId, // lot de B
      p_purchase_lot_line_id: null,
      p_field: 'transport_total',
      p_new_value: 5_000,
      p_actor_id: a.userId,
    });

    expect(error).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Preuve 9 : unicité de external_ref dans son périmètre.
// ──────────────────────────────────────────────────────────────────────────

describe('product_ad_spend — unicité external_ref dans son périmètre (preuve 9)', () => {
  skipIfNoServiceRole(
    'deux dépenses avec le même external_ref dans la même boutique : la seconde est refusée',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('adspend-dupe');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);

      const first = await owner.from('product_ad_spend').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        product_id: productId,
        amount_minor: 10_000,
        spent_at: '2026-04-01',
        source: 'connecteur',
        external_ref: 'meta-campaign-42',
        created_by: userId,
      });
      expect(first.error).toBeNull();

      const second = await owner.from('product_ad_spend').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        product_id: productId,
        amount_minor: 5_000,
        spent_at: '2026-04-02',
        source: 'connecteur',
        external_ref: 'meta-campaign-42',
        created_by: userId,
      });
      expect(second.error).not.toBeNull();
    },
  );

  skipIfNoServiceRole(
    'plusieurs dépenses manuelles sans external_ref (null) : aucune contrainte, toutes acceptées',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('adspend-null');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);

      const first = await owner.from('product_ad_spend').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        product_id: productId,
        amount_minor: 10_000,
        spent_at: '2026-04-01',
        source: 'manuel',
        created_by: userId,
      });
      const second = await owner.from('product_ad_spend').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        product_id: productId,
        amount_minor: 5_000,
        spent_at: '2026-04-02',
        source: 'manuel',
        created_by: userId,
      });

      expect(first.error).toBeNull();
      expect(second.error).toBeNull();
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Correctif F2 : createProductAdSpendAction (lib/actions/purchases.ts) doit
// refuser une dépense publicitaire pour un produit/lot valides individuellement
// (même compte, même boutique) mais SANS relation réelle entre eux — c'est-à-
// dire sans purchase_lot_line (product_id, purchase_lot_id) correspondante.
//
// Avant ce correctif, l'action ne vérifiait que l'appartenance tenant/boutique
// du produit et du lot séparément (jamais leur relation), et son message
// d'erreur « Ce produit n'appartient pas à cet arrivage. » n'était en réalité
// JAMAIS émis dans ce cas (seulement sur un mismatch shop_id structurellement
// impossible, les deux requêtes filtrant déjà sur la même boutique active).
// Une dépense orpheline, sans purchase_lot_line pour la porter, ne serait
// jamais distribuée par computeAdSpendByLine (assemblage — cf.
// lib/finance/lot-profitability-assembly.ts) : ni déduite de
// totals.marginMinor, ni comptée dans totals.adSpendMinor (les deux dérivent
// désormais de la même distribution par construction) — mais elle resterait
// quand même en base, invisible, tant qu'aucune ligne ne la relie au lot.
//
// createProductAdSpendAction n'est PAS une fonction injectable comme
// performTransitionForContext/performReassignDriverForContext (elle construit
// son propre client admin en interne et lit la boutique active via
// getRequestStoreId(), qui dépend de next/headers) — aucune action de ce
// fichier n'est appelée directement par les tests existants de ce dépôt
// (cf. tests/rls/purchases.rls.test.ts, commentaire ligne ~345 : les tests
// reproduisent l'opération DB équivalente plutôt que d'invoquer l'action).
// On suit donc ici cette même convention : on reproduit exactement la requête
// de garde ajoutée par le correctif (SELECT id FROM purchase_lot_line WHERE
// product_id=… AND purchase_lot_id=… AND merchant_account_id=… AND shop_id=…
// LIMIT 1) et on prouve qu'elle distingue bien le cas légitime du cas orphelin.
// ──────────────────────────────────────────────────────────────────────────

describe('createProductAdSpendAction — dépense publicitaire orpheline refusée (correctif F2)', () => {
  skipIfNoServiceRole(
    'produit RÉELLEMENT reçu dans le lot → la garde applicative trouve la purchase_lot_line',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('adspend-line-match');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const { lotId } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopId,
        userId,
        productId,
        10,
        100_000,
      );

      // Requête identique à la garde ajoutée dans createProductAdSpendAction.
      const { data: line } = await admin
        .from('purchase_lot_line')
        .select('id')
        .eq('product_id', productId)
        .eq('purchase_lot_id', lotId)
        .eq('merchant_account_id', merchantAccountId)
        .eq('shop_id', shopId)
        .limit(1)
        .maybeSingle();

      expect(line).not.toBeNull();
    },
  );

  skipIfNoServiceRole(
    'produit et lot valides individuellement mais SANS ligne commune → la garde applicative ne trouve rien (dépense orpheline à refuser)',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('adspend-orphan');
      const owner = await signIn(email);

      // Deux produits distincts, chacun reçu dans SON PROPRE lot — aucun des
      // deux n'a de purchase_lot_line pointant vers le lot de l'autre.
      const productA = await createProduct(admin, merchantAccountId, shopId);
      const productB = await createProduct(admin, merchantAccountId, shopId);
      const { lotId: lotA } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopId,
        userId,
        productA,
        10,
        100_000,
      );
      await receiveLot(admin, owner, merchantAccountId, shopId, userId, productB, 5, 50_000);

      // productA existe (même compte/boutique) ; lotA existe (même
      // compte/boutique) — les deux gardes tenant/boutique de l'action
      // passeraient. Mais productB n'a JAMAIS été reçu dans lotA : c'est le
      // cas orphelin que le correctif doit intercepter.
      const { data: product } = await admin
        .from('product')
        .select('id')
        .eq('id', productB)
        .eq('merchant_account_id', merchantAccountId)
        .eq('shop_id', shopId)
        .maybeSingle();
      expect(product).not.toBeNull();

      const { data: lot } = await admin
        .from('purchase_lot')
        .select('id')
        .eq('id', lotA)
        .eq('merchant_account_id', merchantAccountId)
        .eq('shop_id', shopId)
        .maybeSingle();
      expect(lot).not.toBeNull();

      // La garde de relation (ajoutée par le correctif) ne trouve rien pour
      // (productB, lotA) : c'est ce qui doit faire échouer
      // createProductAdSpendAction avec « Ce produit n'appartient pas à cet
      // arrivage. » plutôt que d'insérer une dépense orpheline.
      const { data: line } = await admin
        .from('purchase_lot_line')
        .select('id')
        .eq('product_id', productB)
        .eq('purchase_lot_id', lotA)
        .eq('merchant_account_id', merchantAccountId)
        .eq('shop_id', shopId)
        .limit(1)
        .maybeSingle();

      expect(line).toBeNull();
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Preuve 10 : isolation des tables neuves. anon / tenant voisin / membre sans
// accès à la boutique → 0 ligne ; contrôle positif → lecture légitime rendue.
// ──────────────────────────────────────────────────────────────────────────

describe('Lot F1 — isolation des tables neuves (preuve 10)', () => {
  skipIfNoServiceRole('product_ad_spend : anon ne lit rien (PostgREST direct)', async () => {
    const { admin, merchantAccountId, shopId, userId } = await createOwnerFixture('iso-anon-ads');
    const productId = await createProduct(admin, merchantAccountId, shopId);
    await admin.from('product_ad_spend').insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      product_id: productId,
      amount_minor: 1_000,
      spent_at: '2026-04-01',
      created_by: userId,
    });

    const { data, error } = await anonClient()
      .from('product_ad_spend')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);

    expect(data ?? []).toHaveLength(0);
    // RLS deny-by-default renvoie soit [] (select refusé silencieusement),
    // soit une erreur explicite selon la couche de grant — les deux prouvent
    // l'absence d'accès ; jamais une ligne.
    void error;
  });

  skipIfNoServiceRole(
    'product_ad_spend : contrôle positif — owner légitime lit bien sa ligne',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('iso-positive-ads');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      await admin.from('product_ad_spend').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        product_id: productId,
        amount_minor: 1_000,
        spent_at: '2026-04-01',
        created_by: userId,
      });

      const { data, error } = await owner
        .from('product_ad_spend')
        .select('id')
        .eq('merchant_account_id', merchantAccountId);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    },
  );

  skipIfNoServiceRole('product_ad_spend : tenant voisin ne voit rien', async () => {
    const a = await createOwnerFixture('iso-tenant-a-ads');
    const b = await createOwnerFixture('iso-tenant-b-ads');
    const productB = await createProduct(b.admin, b.merchantAccountId, b.shopId);
    await b.admin.from('product_ad_spend').insert({
      merchant_account_id: b.merchantAccountId,
      shop_id: b.shopId,
      product_id: productB,
      amount_minor: 1_000,
      spent_at: '2026-04-01',
      created_by: b.userId,
    });

    const ownerA = await signIn(a.email);
    const { data } = await ownerA
      .from('product_ad_spend')
      .select('id')
      .eq('merchant_account_id', b.merchantAccountId);

    expect(data ?? []).toHaveLength(0);
  });

  skipIfNoServiceRole(
    'product_ad_spend : un manager (non-owner de boutique) ne voit rien',
    async () => {
      const { admin, merchantAccountId, shopId, userId } =
        await createOwnerFixture('iso-manager-ads');
      const productId = await createProduct(admin, merchantAccountId, shopId);
      await admin.from('product_ad_spend').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        product_id: productId,
        amount_minor: 1_000,
        spent_at: '2026-04-01',
        created_by: userId,
      });
      const { email: managerEmail } = await addMember(admin, merchantAccountId, 'manager');
      const manager = await signIn(managerEmail);

      const { data, error } = await manager
        .from('product_ad_spend')
        .select('id')
        .eq('merchant_account_id', merchantAccountId);

      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    },
  );

  skipIfNoServiceRole('purchase_lot_line_allocation : anon ne lit rien', async () => {
    const { admin, email, merchantAccountId, shopId, userId } =
      await createOwnerFixture('iso-anon-alloc');
    const owner = await signIn(email);
    const productId = await createProduct(admin, merchantAccountId, shopId);
    const driverId = await createDriver(admin, merchantAccountId, shopId);
    await receiveLot(admin, owner, merchantAccountId, shopId, userId, productId, 10, 50_000);
    const { orderId } = await createOrderWithLine(
      admin,
      merchantAccountId,
      shopId,
      driverId,
      productId,
      2,
    );
    await deliverAndCollect(owner, userId, orderId);

    const { data } = await anonClient()
      .from('purchase_lot_line_allocation')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);

    expect(data ?? []).toHaveLength(0);
  });

  skipIfNoServiceRole(
    'purchase_lot_line_allocation : contrôle positif — agent (visible, pas juste owner) lit la ligne',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('iso-positive-alloc');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const driverId = await createDriver(admin, merchantAccountId, shopId);
      await receiveLot(admin, owner, merchantAccountId, shopId, userId, productId, 10, 50_000);
      const { orderId } = await createOrderWithLine(
        admin,
        merchantAccountId,
        shopId,
        driverId,
        productId,
        2,
      );
      await deliverAndCollect(owner, userId, orderId);
      const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
      const agent = await signIn(agentEmail);

      const { data, error } = await agent
        .from('purchase_lot_line_allocation')
        .select('id')
        .eq('merchant_account_id', merchantAccountId);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    },
  );

  skipIfNoServiceRole('purchase_lot_line_allocation : tenant voisin ne voit rien', async () => {
    const a = await createOwnerFixture('iso-tenant-a-alloc');
    const b = await createOwnerFixture('iso-tenant-b-alloc');
    const ownerB = await signIn(b.email);
    const productB = await createProduct(b.admin, b.merchantAccountId, b.shopId);
    const driverB = await createDriver(b.admin, b.merchantAccountId, b.shopId);
    await receiveLot(
      b.admin,
      ownerB,
      b.merchantAccountId,
      b.shopId,
      b.userId,
      productB,
      10,
      50_000,
    );
    const { orderId } = await createOrderWithLine(
      b.admin,
      b.merchantAccountId,
      b.shopId,
      driverB,
      productB,
      2,
    );
    await deliverAndCollect(ownerB, b.userId, orderId);

    const ownerA = await signIn(a.email);
    const { data } = await ownerA
      .from('purchase_lot_line_allocation')
      .select('id')
      .eq('merchant_account_id', b.merchantAccountId);

    expect(data ?? []).toHaveLength(0);
  });

  skipIfNoServiceRole('purchase_lot_cost_correction : anon ne lit rien', async () => {
    const { admin, email, merchantAccountId, shopId, userId } =
      await createOwnerFixture('iso-anon-correction');
    const owner = await signIn(email);
    const productId = await createProduct(admin, merchantAccountId, shopId);
    const { lotId } = await receiveLot(
      admin,
      owner,
      merchantAccountId,
      shopId,
      userId,
      productId,
      10,
      100_000,
    );
    await correctCostRpc(owner)('correct_purchase_lot_cost', {
      p_merchant_account_id: merchantAccountId,
      p_purchase_lot_id: lotId,
      p_purchase_lot_line_id: null,
      p_field: 'transport_total',
      p_new_value: 2_000,
      p_actor_id: userId,
    });

    const { data } = await anonClient()
      .from('purchase_lot_cost_correction')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);

    expect(data ?? []).toHaveLength(0);
  });

  skipIfNoServiceRole(
    'purchase_lot_cost_correction : contrôle positif — owner légitime lit la correction',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('iso-positive-correction');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const { lotId } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopId,
        userId,
        productId,
        10,
        100_000,
      );
      await correctCostRpc(owner)('correct_purchase_lot_cost', {
        p_merchant_account_id: merchantAccountId,
        p_purchase_lot_id: lotId,
        p_purchase_lot_line_id: null,
        p_field: 'transport_total',
        p_new_value: 2_000,
        p_actor_id: userId,
      });

      const { data, error } = await owner
        .from('purchase_lot_cost_correction')
        .select('id')
        .eq('merchant_account_id', merchantAccountId);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Preuve 4 (base) : la colonne weight_grams existe et reste nullable — la
// disponibilité de la méthode 'weight' est un calcul TS (lot-profitability.ts,
// preuves 1-6), jamais une contrainte SQL.
// ──────────────────────────────────────────────────────────────────────────

describe('purchase_lot_line.weight_grams — colonne additive', () => {
  skipIfNoServiceRole('nullable : une ligne sans poids reste valide', async () => {
    const { admin, email, merchantAccountId, shopId, userId } =
      await createOwnerFixture('weight-nullable');
    const owner = await signIn(email);
    const productId = await createProduct(admin, merchantAccountId, shopId);
    const { purchaseLotLineId } = await receiveLot(
      admin,
      owner,
      merchantAccountId,
      shopId,
      userId,
      productId,
      10,
      100_000,
    );

    const { data } = await admin
      .from('purchase_lot_line')
      .select('weight_grams')
      .eq('id', purchaseLotLineId)
      .single();
    expect(data?.weight_grams).toBeNull();

    const update = await owner
      .from('purchase_lot_line')
      .update({ weight_grams: 4_500 })
      .eq('id', purchaseLotLineId);
    expect(update.error).toBeNull();
  });
});
