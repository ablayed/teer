/**
 * Tests d'atomicité du module stock (Phase 3b, migration 0029).
 *
 * Principe vérifié : transition_order + post_stock_movement commitent
 * ensemble. Un échec dans post_stock_movement rollback la transition entière.
 * Un succès commite les deux sans aucun écart.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'atomicity-test-pw-3b';
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
  const email = `atomicity-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

type TransitionOrderArgs = {
  p_actor: string;
  p_order_id: string;
  p_call_state?: string;
  p_delivery_state?: string;
  p_order_state?: string;
  p_cash_state?: string;
  p_attempt_count?: number;
  p_note?: string;
  p_payment_channel?: string;
  p_scheduled_for?: string;
  p_assigned_driver_id?: string;
  p_cancel_reasons?: string[];
  p_clear_scheduled_for?: boolean;
  p_clear_cancel_reasons?: boolean;
  p_clear_assigned_driver?: boolean;
};

function transitionRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'transition_order',
    args: TransitionOrderArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
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

async function seedProductStock(
  admin: AdminClient,
  productId: string,
  merchantAccountId: string,
  qtyOnHand = 50,
) {
  await admin.from('product_stock').upsert(
    {
      product_id: productId,
      merchant_account_id: merchantAccountId,
      qty_on_hand: qtyOnHand,
      unit_cost: 5000,
    },
    { onConflict: 'product_id' },
  );
}

async function createOrderWithLine(
  admin: AdminClient,
  merchantAccountId: string,
  _actorId: string,
  productId: string | null, // null = unresolved line
) {
  // Livreur attaché dès la création (delivery_state=unassigned → autorisé par la
  // contrainte 0057). Les dispatches RPC ultérieurs l'héritent via coalesce, donc
  // delivery_state=assigned/out_for_delivery ne viole jamais orders_dispatch_requires_driver.
  const driverId = await createDriver(admin, merchantAccountId);
  const { data: order } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `TEST-${Date.now()}`,
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

  await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    order_id: order.id,
    product_id: productId,
    raw_title: 'Produit test',
    qty: 3,
    match_status: productId ? 'matched' : 'unresolved',
  });

  return order.id;
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
// ATOMICITÉ : transition + mouvement commitent ensemble
// ──────────────────────────────────────────────────────────────────────────

describe('atomicité transition + mouvement stock', () => {
  skipIfNoServiceRole(
    'confirmer : transition ET réserve committent ensemble (qty_reserved +3)',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('confirm-ok');
      const productId = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);
      const { data: newStatus, error } = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      });

      expect(error).toBeNull();
      expect(newStatus).toBe('CONFIRMEE');

      const { data: stock } = await admin
        .from('product_stock')
        .select('qty_on_hand, qty_reserved')
        .eq('product_id', productId)
        .single();

      expect(stock?.qty_on_hand).toBe(50); // confirmer ne touche pas qty_on_hand
      expect(stock?.qty_reserved).toBe(3); // +3 réservés

      const { data: movements } = await admin
        .from('stock_movement')
        .select('movement_type, qty')
        .eq('order_id', orderId);

      expect(movements).toHaveLength(1);
      expect(movements?.[0]?.movement_type).toBe('reserve');
      expect(movements?.[0]?.qty).toBe(3);
    },
  );

  skipIfNoServiceRole(
    'dispatch : qty_on_hand décrémenté ET qty_reserved vidé dans la même transaction',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('dispatch-ok');
      const productId = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);

      // confirmer (→ CONFIRMEE, +3 reserved)
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      });
      // programmer (→ PROGRAMMEE)
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'scheduled',
      });
      // assigner (→ EN_LIVRAISON = dispatch)
      const { data: newStatus, error } = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
      });

      expect(error).toBeNull();
      expect(newStatus).toBe('EN_LIVRAISON');

      const { data: stock } = await admin
        .from('product_stock')
        .select('qty_on_hand, qty_reserved')
        .eq('product_id', productId)
        .single();

      expect(stock?.qty_on_hand).toBe(47); // 50 - 3
      expect(stock?.qty_reserved).toBe(0); // réserve vidée

      const { data: movements } = await admin
        .from('stock_movement')
        .select('movement_type, qty')
        .eq('order_id', orderId)
        .order('created_at');

      // reserve (+3) + dispatch (-3) + disponibilite livreur engagee (+3)
      expect(movements).toHaveLength(3);
      const dispatch = movements?.find((m) => m.movement_type === 'dispatch');
      expect(dispatch?.qty).toBe(-3);
      const assignmentCommit = movements?.find(
        (m) => m.movement_type === 'order_assignment_commit',
      );
      expect(assignmentCommit?.qty).toBe(3);
    },
  );

  skipIfNoServiceRole('annuler avant dispatch : release poste -3 sur qty_reserved', async () => {
    const { admin, email, merchantAccountId, userId } = await createOwnerFixture('cancel-pre');
    const productId = await createProduct(admin, merchantAccountId);
    await seedProductStock(admin, productId, merchantAccountId, 50);
    const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

    const client = await signIn(email);
    await transitionRpc(client)('transition_order', {
      p_actor: userId,
      p_order_id: orderId,
      p_call_state: 'validated',
      p_attempt_count: 1,
    });

    // reserved = 3 ici ; annuler → release
    const { data: newStatus, error } = await transitionRpc(client)('transition_order', {
      p_actor: userId,
      p_order_id: orderId,
      p_order_state: 'cancelled',
      p_cash_state: 'not_due',
    });

    expect(error).toBeNull();
    expect(newStatus).toBe('ANNULEE');

    const { data: stock } = await admin
      .from('product_stock')
      .select('qty_on_hand, qty_reserved')
      .eq('product_id', productId)
      .single();

    expect(stock?.qty_on_hand).toBe(50);
    expect(stock?.qty_reserved).toBe(0); // réserve libérée

    const { data: movements } = await admin
      .from('stock_movement')
      .select('movement_type, qty')
      .eq('order_id', orderId)
      .order('created_at');

    const release = movements?.find((m) => m.movement_type === 'release');
    expect(release?.qty).toBe(-3);
  });

  skipIfNoServiceRole(
    'annuler post-dispatch : libere la disponibilite engagee sans courier_return',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('cancel-post');
      const productId = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);
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

      const stockBeforeCancel = await admin
        .from('product_stock')
        .select('qty_on_hand, qty_reserved')
        .eq('product_id', productId)
        .single();

      // annuler post-dispatch → pas de mouvement stock automatique
      const cancelled = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'cancelled',
        p_delivery_state: 'failed',
        p_cash_state: 'not_due',
      });
      expect(cancelled.error).toBeNull();

      const { data: stockAfter } = await admin
        .from('product_stock')
        .select('qty_on_hand, qty_reserved')
        .eq('product_id', productId)
        .single();

      expect(stockAfter?.qty_on_hand).toBe(stockBeforeCancel.data?.qty_on_hand);
      expect(stockAfter?.qty_reserved).toBe(stockBeforeCancel.data?.qty_reserved);

      // Aucun mouvement courier_return posté automatiquement
      const { data: movements } = await admin
        .from('stock_movement')
        .select('movement_type, qty')
        .eq('order_id', orderId);

      const hasReturn = movements?.some((m) => m.movement_type === 'courier_return');
      expect(hasReturn).toBe(false);
      const assignmentRelease = movements?.find(
        (m) => m.movement_type === 'order_assignment_release',
      );
      expect(assignmentRelease?.qty).toBe(-3);
    },
  );
});

describe('Lot 2 PR1 - ledger de disponibilite livreur', () => {
  skipIfNoServiceRole(
    'assigner groupe les lignes par produit et poste order_assignment_commit',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('assignment-commit');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const owner = await signIn(email);
      await purchaseIn(owner, merchantAccountId, productId, userId, 50);

      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId, qty: 1 },
        { productId, qty: 2 },
      ]);
      const client = await signIn(email);
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

      const assign = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
      });
      expect(assign.error).toBeNull();

      const assignmentMoves = await readOrderAssignmentMovements(admin, orderId);
      expect(assignmentMoves).toHaveLength(1);
      expect(assignmentMoves[0]).toMatchObject({
        movement_type: 'order_assignment_commit',
        product_id: productId,
        driver_id: driverId,
        qty: 3,
      });
    },
  );

  skipIfNoServiceRole('livrer ne poste aucun order_assignment_* supplementaire', async () => {
    const { admin, email, merchantAccountId, userId } =
      await createOwnerFixture('assignment-deliver');
    const productId = await createProduct(admin, merchantAccountId);
    const driverId = await createDriver(admin, merchantAccountId);
    const owner = await signIn(email);
    await purchaseIn(owner, merchantAccountId, productId, userId, 50);
    const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
      { productId, qty: 3 },
    ]);

    const client = await signIn(email);
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
    const beforeDeliver = await readOrderAssignmentMovements(admin, orderId);

    const delivered = await transitionRpc(client)('transition_order', {
      p_actor: userId,
      p_order_id: orderId,
      p_delivery_state: 'delivered',
      p_order_state: 'completed',
      p_cash_state: 'collected',
      p_payment_channel: 'ESPECES',
    });
    expect(delivered.error).toBeNull();

    const afterDeliver = await readOrderAssignmentMovements(admin, orderId);
    expect(afterDeliver).toEqual(beforeDeliver);
  });

  skipIfNoServiceRole(
    'annuler sans commit net ouvert ne poste aucun release et ne leve pas erreur',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('assignment-no-open');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId, qty: 3 },
      ]);
      await admin.from('orders').update({ delivery_state: 'assigned' }).eq('id', orderId);

      const client = await signIn(email);
      const cancelled = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'cancelled',
        p_delivery_state: 'failed',
        p_cash_state: 'not_due',
      });
      expect(cancelled.error).toBeNull();

      const assignmentMoves = await readOrderAssignmentMovements(admin, orderId);
      expect(assignmentMoves).toHaveLength(0);
    },
  );

  skipIfNoServiceRole(
    'reassign_order_driver libere seulement ancien livreur et engage le nouveau',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('assignment-reassign');
      const productId = await createProduct(admin, merchantAccountId);
      const oldDriverId = await createDriver(admin, merchantAccountId);
      const newDriverId = await createDriver(admin, merchantAccountId);
      const anomalyDriverId = await createDriver(admin, merchantAccountId);
      const owner = await signIn(email);
      await purchaseIn(owner, merchantAccountId, productId, userId, 50);
      const orderId = await createOrderForDriver(admin, merchantAccountId, oldDriverId, [
        { productId, qty: 3 },
      ]);

      const client = await signIn(email);
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
      await admin.from('stock_movement').insert({
        merchant_account_id: merchantAccountId,
        product_id: productId,
        movement_type: 'order_assignment_commit',
        qty: 3,
        idempotency_key: `test-anomaly:${orderId}:${anomalyDriverId}`,
        created_by: userId,
        order_id: orderId,
        driver_id: anomalyDriverId,
        reason: 'Test anomaly: unrelated open commitment must not be released',
      });

      const reassign = await client.rpc('reassign_order_driver', {
        p_actor: userId,
        p_order_id: orderId,
        p_new_driver: newDriverId,
      });
      expect(reassign.error).toBeNull();

      const assignmentMoves = await readOrderAssignmentMovements(admin, orderId);
      const oldRelease = assignmentMoves.find(
        (m) => m.movement_type === 'order_assignment_release' && m.driver_id === oldDriverId,
      );
      const anomalyRelease = assignmentMoves.find(
        (m) => m.movement_type === 'order_assignment_release' && m.driver_id === anomalyDriverId,
      );
      const newCommit = assignmentMoves.find(
        (m) => m.movement_type === 'order_assignment_commit' && m.driver_id === newDriverId,
      );
      expect(oldRelease?.qty).toBe(-3);
      expect(anomalyRelease).toBeUndefined();
      expect(newCommit?.qty).toBe(3);
    },
  );

  skipIfNoServiceRole(
    'reassign_order_driver sans engagement ouvert ancien ne release rien mais engage le nouveau',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture(
        'assignment-reassign-no-open',
      );
      const productId = await createProduct(admin, merchantAccountId);
      const oldDriverId = await createDriver(admin, merchantAccountId);
      const newDriverId = await createDriver(admin, merchantAccountId);
      const orderId = await createOrderForDriver(admin, merchantAccountId, oldDriverId, [
        { productId, qty: 3 },
      ]);
      await admin.from('orders').update({ delivery_state: 'assigned' }).eq('id', orderId);

      const client = await signIn(email);
      const reassign = await client.rpc('reassign_order_driver', {
        p_actor: userId,
        p_order_id: orderId,
        p_new_driver: newDriverId,
      });
      expect(reassign.error).toBeNull();

      const assignmentMoves = await readOrderAssignmentMovements(admin, orderId);
      expect(
        assignmentMoves.some(
          (m) => m.movement_type === 'order_assignment_release' && m.driver_id === oldDriverId,
        ),
      ).toBe(false);
      expect(
        assignmentMoves.find(
          (m) => m.movement_type === 'order_assignment_commit' && m.driver_id === newDriverId,
        )?.qty,
      ).toBe(3);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// ROLLBACK : échec stock → rollback de la transition entière
// ──────────────────────────────────────────────────────────────────────────

describe('rollback : échec post_stock_movement rollback la transition', () => {
  skipIfNoServiceRole(
    'order_line résolue vers un produit d’un AUTRE marchand → guard échoue → rollback (cod_status inchangé)',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('rollback');

      // Produit appartenant à un SECOND marchand : le guard de post_stock_movement
      // (« product not found for this merchant account ») lèvera une exception
      // → rollback complet de transition_order. product_id reste non-null
      // (FK satisfaite), donc on teste bien le rollback et non le skip de ligne.
      const foreign = await createOwnerFixture('rollback-foreign');
      const foreignProductId = await createProduct(foreign.admin, foreign.merchantAccountId);

      // Ordre du marchand A avec une ligne matched pointant vers le produit de B.
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, foreignProductId);

      const client = await signIn(email);
      const { data: newStatus, error } = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      });

      // La RPC doit retourner une erreur (ou newStatus null si le client la propage)
      expect(error !== null || newStatus === null).toBe(true);

      // cod_status DOIT être resté A_APPELER
      const { data: orderAfter } = await admin
        .from('orders')
        .select('cod_status')
        .eq('id', orderId)
        .single();

      expect(orderAfter?.cod_status).toBe('A_APPELER');

      // Aucun stock_movement inséré (rollback complet)
      const { data: movements } = await admin
        .from('stock_movement')
        .select('id')
        .eq('order_id', orderId);

      expect(movements).toHaveLength(0);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// MULTI-LIGNES : commande à 2 produits → 2 mouvements, tout-ou-rien
// ──────────────────────────────────────────────────────────────────────────

describe('multi-lignes : 2 produits → 2 mouvements dans la même transaction', () => {
  skipIfNoServiceRole(
    'dispatch sur commande 2-produits poste 2 mouvements atomiquement',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('multi-line');
      const prodA = await createProduct(admin, merchantAccountId);
      const prodB = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, prodA, merchantAccountId, 20);
      await seedProductStock(admin, prodB, merchantAccountId, 30);

      // Créer une commande avec 2 order_line résolues. Livreur attaché dès la
      // création (unassigned → autorisé) → hérité au dispatch via coalesce
      // (contrainte 0057 orders_dispatch_requires_driver).
      const driverId = await createDriver(admin, merchantAccountId);
      const { data: order } = await admin
        .from('orders')
        .insert({
          merchant_account_id: merchantAccountId,
          order_number: `MULTI-${Date.now()}`,
          total_amount: 20000,
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

      await admin.from('order_line').insert([
        {
          merchant_account_id: merchantAccountId,
          order_id: order.id,
          product_id: prodA,
          raw_title: 'Produit A',
          qty: 2,
          match_status: 'matched',
        },
        {
          merchant_account_id: merchantAccountId,
          order_id: order.id,
          product_id: prodB,
          raw_title: 'Produit B',
          qty: 5,
          match_status: 'matched',
        },
      ]);

      const client = await signIn(email);
      // confirmer → reserve
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: order.id,
        p_call_state: 'validated',
        p_attempt_count: 1,
      });
      // programmer
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: order.id,
        p_delivery_state: 'scheduled',
      });
      // dispatch
      const { data: newStatus, error } = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: order.id,
        p_delivery_state: 'out_for_delivery',
      });

      expect(error).toBeNull();
      expect(newStatus).toBe('EN_LIVRAISON');

      // Vérifier les 2 dispatch movements
      const { data: dispatches } = await admin
        .from('stock_movement')
        .select('product_id, qty, movement_type')
        .eq('order_id', order.id)
        .eq('movement_type', 'dispatch');

      expect(dispatches).toHaveLength(2);
      const dispatchA = dispatches?.find((m) => m.product_id === prodA);
      const dispatchB = dispatches?.find((m) => m.product_id === prodB);
      expect(dispatchA?.qty).toBe(-2);
      expect(dispatchB?.qty).toBe(-5);

      // Vérifier les positions
      const { data: stockA } = await admin
        .from('product_stock')
        .select('qty_on_hand')
        .eq('product_id', prodA)
        .single();
      const { data: stockB } = await admin
        .from('product_stock')
        .select('qty_on_hand')
        .eq('product_id', prodB)
        .single();

      expect(stockA?.qty_on_hand).toBe(18); // 20 - 2
      expect(stockB?.qty_on_hand).toBe(25); // 30 - 5
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// LIGNE NON RÉSOLUE : n'empêche pas la transition
// ──────────────────────────────────────────────────────────────────────────

describe('ligne non résolue : transition réussit, aucun mouvement posté', () => {
  skipIfNoServiceRole(
    'confirmer sur commande sans order_line matched → CONFIRMEE, 0 mouvements',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('unresolved');

      // Order avec une ligne unresolved (pas de product_id)
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, null);

      const client = await signIn(email);
      const { data: newStatus, error } = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      });

      expect(error).toBeNull();
      expect(newStatus).toBe('CONFIRMEE');

      const { data: movements } = await admin
        .from('stock_movement')
        .select('id')
        .eq('order_id', orderId);

      expect(movements).toHaveLength(0);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// IDEMPOTENCE : post_stock_movement rejoué = no-op
// ──────────────────────────────────────────────────────────────────────────

describe('idempotence post_stock_movement', () => {
  skipIfNoServiceRole(
    'même idempotency_key → second appel retourne null, position inchangée',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('idem');
      const productId = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 100);
      const ownerClient = await signIn(email);

      const key = `idem-test:${productId}:purchase_in`;

      // Premier appel
      const { data: id1, error: err1 } = await ownerClient.rpc('post_stock_movement', {
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'purchase_in',
        p_qty: 10,
        p_idempotency_key: key,
        p_created_by: userId,
        p_unit_cost: 6000,
      });
      expect(err1).toBeNull();
      expect(id1).not.toBeNull();

      const { data: stockAfterFirst } = await admin
        .from('product_stock')
        .select('qty_on_hand')
        .eq('product_id', productId)
        .single();
      expect(stockAfterFirst?.qty_on_hand).toBe(110);

      // Second appel avec la même clé → retourne null, position inchangée
      const { data: id2, error: err2 } = await ownerClient.rpc('post_stock_movement', {
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'purchase_in',
        p_qty: 10,
        p_idempotency_key: key,
        p_created_by: userId,
        p_unit_cost: 6000,
      });
      expect(err2).toBeNull();
      expect(id2).toBeNull(); // doublon détecté

      const { data: stockAfterSecond } = await admin
        .from('product_stock')
        .select('qty_on_hand')
        .eq('product_id', productId)
        .single();
      expect(stockAfterSecond?.qty_on_hand).toBe(110); // inchangé
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// LOT B : cycle valider → déconfirmer → revalider
//   reserve (T1) → release (T2) → reserve (T3), 3 idempotency_keys distincts
//   (transition_id neuf à chaque appel), qty_reserved revient au bon niveau
//   à chaque étape, AUCUNE déduplication parasite.
// ──────────────────────────────────────────────────────────────────────────

describe('Lot B : déconfirmer libère la réserve, le cycle ne déduplique pas', () => {
  skipIfNoServiceRole(
    'valider→déconfirmer→revalider : reserve/release/reserve, 3 clés distinctes, reserved 3→0→3',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('lotb-cycle');
      const productId = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);

      async function reserved() {
        const { data } = await admin
          .from('product_stock')
          .select('qty_on_hand, qty_reserved')
          .eq('product_id', productId)
          .single();
        return data;
      }

      // 1) valider → reserve (+3)
      const r1 = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      });
      expect(r1.error).toBeNull();
      expect(r1.data).toBe('CONFIRMEE');
      expect((await reserved())?.qty_reserved).toBe(3);

      // 2) déconfirmer → release (−3), reverse exact ; revient à to_call/unassigned
      const r2 = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'to_call',
        p_clear_scheduled_for: true,
      });
      expect(r2.error).toBeNull();
      expect(r2.data).toBe('A_APPELER');
      const afterDeconfirm = await reserved();
      expect(afterDeconfirm?.qty_reserved).toBe(0); // réserve libérée
      expect(afterDeconfirm?.qty_on_hand).toBe(50); // jamais touché

      // 3) revalider → reserve (+3) à nouveau (pas de dédup, transition_id neuf)
      const r3 = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      });
      expect(r3.error).toBeNull();
      expect(r3.data).toBe('CONFIRMEE');
      expect((await reserved())?.qty_reserved).toBe(3); // revient à 3

      // Les 3 mouvements existent, dans l'ordre, avec 3 clés/transition_id distincts.
      const { data: movements } = await admin
        .from('stock_movement')
        .select('movement_type, qty, idempotency_key, transition_id')
        .eq('order_id', orderId)
        .order('created_at');

      expect(movements?.map((m) => m.movement_type)).toEqual(['reserve', 'release', 'reserve']);
      expect(movements?.map((m) => m.qty)).toEqual([3, -3, 3]);

      const keys = new Set(movements?.map((m) => m.idempotency_key));
      const transitionIds = new Set(movements?.map((m) => m.transition_id));
      expect(keys.size).toBe(3); // aucune collision → aucune déduplication parasite
      expect(transitionIds.size).toBe(3); // transition_id neuf à chaque appel
    },
  );

  skipIfNoServiceRole(
    'déconfirmer une commande PROGRAMMÉE vide scheduled_for, repasse unassigned et libère la réserve',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('lotb-prog');
      const productId = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);

      // valider → reserve (+3)
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      });
      // programmer → scheduled_for posé, delivery scheduled
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'scheduled',
        p_cash_state: 'expected',
        p_scheduled_for: '2099-05-01T12:00:00.000Z',
      });

      const programmed = await admin
        .from('orders')
        .select('scheduled_for, delivery_state')
        .eq('id', orderId)
        .single();
      expect(programmed.data?.scheduled_for).not.toBeNull();
      expect(programmed.data?.delivery_state).toBe('scheduled');

      // déconfirmer → scheduled_for vidé (0055), delivery unassigned, release (−3)
      const deconfirm = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'to_call',
        p_cash_state: 'not_due',
        p_delivery_state: 'unassigned',
        p_clear_scheduled_for: true,
      });
      expect(deconfirm.error).toBeNull();
      expect(deconfirm.data).toBe('A_APPELER');

      const after = await admin
        .from('orders')
        .select('scheduled_for, delivery_state, call_state')
        .eq('id', orderId)
        .single();
      expect(after.data?.scheduled_for).toBeNull(); // 0055 : clear respecté
      expect(after.data?.delivery_state).toBe('unassigned');
      expect(after.data?.call_state).toBe('to_call');

      const { data: stock } = await admin
        .from('product_stock')
        .select('qty_reserved')
        .eq('product_id', productId)
        .single();
      expect(stock?.qty_reserved).toBe(0); // réserve libérée
    },
  );

  skipIfNoServiceRole(
    'annuler (2 raisons) → désannuler : raisons stockées puis effacées, AUCUN mouvement au désannuler',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('lotb-desann');
      const productId = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);

      // valider → reserve (+3)
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      });

      // annuler avec 2 raisons → release (−3), cancel_reasons stocké,
      // cancel_reason legacy = 1ᵉʳ élément.
      const cancel = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'cancelled',
        p_cash_state: 'not_due',
        p_delivery_state: 'unassigned',
        p_cancel_reasons: ['prix', 'concurrence'],
      });
      expect(cancel.error).toBeNull();
      expect(cancel.data).toBe('ANNULEE');

      const { data: cancelled } = await admin
        .from('orders')
        .select('order_state, cancel_reason, cancel_reasons')
        .eq('id', orderId)
        .single();
      expect(cancelled?.order_state).toBe('cancelled');
      expect(cancelled?.cancel_reasons).toEqual(['prix', 'concurrence']);
      expect(cancelled?.cancel_reason).toBe('prix'); // legacy = 1ᵉʳ élément

      const movementsBefore = await admin
        .from('stock_movement')
        .select('id, movement_type')
        .eq('order_id', orderId);
      expect(movementsBefore.data?.map((m) => m.movement_type).sort()).toEqual([
        'release',
        'reserve',
      ]);

      // désannuler → order ouvert, raisons effacées, AUCUN nouveau mouvement.
      const desann = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'open',
        p_call_state: 'to_call',
        p_delivery_state: 'unassigned',
        p_cash_state: 'not_due',
        p_clear_cancel_reasons: true,
        p_clear_scheduled_for: true,
      });
      expect(desann.error).toBeNull();
      expect(desann.data).toBe('A_APPELER');

      const { data: reopened } = await admin
        .from('orders')
        .select('order_state, call_state, delivery_state, cancel_reason, cancel_reasons')
        .eq('id', orderId)
        .single();
      expect(reopened?.order_state).toBe('open');
      expect(reopened?.call_state).toBe('to_call');
      expect(reopened?.delivery_state).toBe('unassigned');
      expect(reopened?.cancel_reason).toBeNull();
      expect(reopened?.cancel_reasons).toBeNull();

      // Toujours exactement 2 mouvements (reserve + release) : désannuler n'en pose aucun.
      const movementsAfter = await admin
        .from('stock_movement')
        .select('id')
        .eq('order_id', orderId);
      expect(movementsAfter.data).toHaveLength(2);

      // qty_reserved resté à 0 (release l'a vidé, désannuler ne re-réserve pas).
      const { data: stock } = await admin
        .from('product_stock')
        .select('qty_on_hand, qty_reserved')
        .eq('product_id', productId)
        .single();
      expect(stock?.qty_on_hand).toBe(50);
      expect(stock?.qty_reserved).toBe(0);
    },
  );

  skipIfNoServiceRole(
    'déconfirmer indisponible après dispatch : appelé manuellement, aucun release parasite',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('lotb-dispatch');
      const productId = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);
      // valider → programmer → assigner (dispatch : −3 on_hand, reserved vidé)
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

      const before = await admin
        .from('product_stock')
        .select('qty_on_hand, qty_reserved')
        .eq('product_id', productId)
        .single();

      // Tenter « déconfirmer » alors que delivery_state = out_for_delivery :
      // la garde delivery∈{unassigned,scheduled} de la branche release ne matche
      // pas → AUCUN mouvement (le filtre TS interdit déjà l'action en amont).
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'to_call',
        p_clear_scheduled_for: true,
      });

      const after = await admin
        .from('product_stock')
        .select('qty_on_hand, qty_reserved')
        .eq('product_id', productId)
        .single();

      expect(after.data?.qty_on_hand).toBe(before.data?.qty_on_hand);
      expect(after.data?.qty_reserved).toBe(before.data?.qty_reserved);

      const { data: releases } = await admin
        .from('stock_movement')
        .select('id')
        .eq('order_id', orderId)
        .eq('movement_type', 'release');
      expect(releases).toHaveLength(0);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Phase 13.1 : désannuler POST-dispatch (REFUSÉE / annulée après dispatch)
//   → retour « À appeler » (to_call, unassigned, open), assigned_driver_id VIDÉ
//   (migration 0066, p_clear_assigned_driver), AUCUN mouvement, qty_reserved
//   inchangé. Le stock reste attribué au livreur d'origine dans le ledger (dispatch
//   conservé) : seul le pointeur assigned_driver_id de la commande est effacé.
// ──────────────────────────────────────────────────────────────────────────

describe('Phase 13.1 : désannuler post-dispatch vide le livreur sans mouvement', () => {
  skipIfNoServiceRole(
    'refuser après dispatch → désannuler : to_call/unassigned/open, livreur vidé, qty_reserved inchangé, 0 mouvement neuf',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('desann-postdispatch');
      const productId = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);

      // valider → programmer → dispatch (reserve +3, puis dispatch -3 attribué au livreur)
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

      const dispatched = await admin
        .from('orders')
        .select('assigned_driver_id, delivery_state')
        .eq('id', orderId)
        .single();
      expect(dispatched.data?.delivery_state).toBe('out_for_delivery');
      const dispatchDriverId = dispatched.data?.assigned_driver_id;
      expect(dispatchDriverId).not.toBeNull();

      // refuser post-dispatch → REFUSEE (cancelled + failed), AUCUN mouvement (stock chez livreur)
      const refused = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'cancelled',
        p_delivery_state: 'failed',
        p_call_state: 'validated',
        p_cash_state: 'not_due',
      });
      expect(refused.error).toBeNull();
      expect(refused.data).toBe('REFUSEE');

      const stockBefore = await admin
        .from('product_stock')
        .select('qty_on_hand, qty_reserved')
        .eq('product_id', productId)
        .single();
      expect(stockBefore.data?.qty_on_hand).toBe(47); // 50 - 3 (dispatch conservé)
      expect(stockBefore.data?.qty_reserved).toBe(0);

      const movementsBefore = await admin
        .from('stock_movement')
        .select('movement_type')
        .eq('order_id', orderId)
        .order('created_at');
      expect(movementsBefore.data?.map((m) => m.movement_type)).toEqual([
        'reserve',
        'dispatch',
        'order_assignment_commit',
        'order_assignment_release',
      ]);

      // désannuler post-dispatch (avec effacement du livreur)
      const desann = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'open',
        p_call_state: 'to_call',
        p_delivery_state: 'unassigned',
        p_cash_state: 'not_due',
        p_clear_cancel_reasons: true,
        p_clear_scheduled_for: true,
        p_clear_assigned_driver: true,
      });
      expect(desann.error).toBeNull();
      expect(desann.data).toBe('A_APPELER');

      const reopened = await admin
        .from('orders')
        .select('order_state, call_state, delivery_state, assigned_driver_id')
        .eq('id', orderId)
        .single();
      expect(reopened.data?.order_state).toBe('open');
      expect(reopened.data?.call_state).toBe('to_call');
      expect(reopened.data?.delivery_state).toBe('unassigned');
      // assigned_driver_id VIDÉ (le ledger garde l'attribution, pas la commande).
      expect(reopened.data?.assigned_driver_id).toBeNull();

      // AUCUN nouveau mouvement (toujours reserve + dispatch) ; qty inchangées.
      const movementsAfter = await admin
        .from('stock_movement')
        .select('movement_type, driver_id')
        .eq('order_id', orderId)
        .order('created_at');
      expect(movementsAfter.data?.map((m) => m.movement_type)).toEqual([
        'reserve',
        'dispatch',
        'order_assignment_commit',
        'order_assignment_release',
      ]);
      // Le dispatch reste attribué au livreur d'origine dans le ledger.
      const dispatchMovement = movementsAfter.data?.find((m) => m.driver_id === dispatchDriverId);
      expect(dispatchMovement).toBeTruthy();

      const stockAfter = await admin
        .from('product_stock')
        .select('qty_on_hand, qty_reserved')
        .eq('product_id', productId)
        .single();
      expect(stockAfter.data?.qty_on_hand).toBe(47); // inchangé
      expect(stockAfter.data?.qty_reserved).toBe(0); // inchangé, pas de réserve fantôme
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 0068 / 0069 : livraison depuis le lot d'avance (Option A)
//   La livraison PUISE D'ABORD dans l'avance du livreur (advance_commit, effet
//   nul sur entrepôt/main, libère la réserve de la part couverte) et ne dispatche
//   que le complément. Désannuler restaure l'avance (compensation négative).
// ──────────────────────────────────────────────────────────────────────────

const HAND_TYPES = [
  'dispatch',
  'allocate_to_courier',
  'sold',
  'courier_return',
  'courier_return_lot',
];

async function purchaseIn(
  client: SupabaseClient<Database>,
  merchantAccountId: string,
  productId: string,
  userId: string,
  qty: number,
  unitCost = 5000,
) {
  const { error } = await client.rpc('post_stock_movement', {
    p_merchant_account_id: merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'purchase_in',
    p_qty: qty,
    p_idempotency_key: `pin:${productId}:${Date.now()}:${Math.random()}`,
    p_created_by: userId,
    p_unit_cost: unitCost,
  });
  if (error) throw new Error(`purchase_in failed: ${error.message}`);
}

async function allocateToCourier(
  client: SupabaseClient<Database>,
  merchantAccountId: string,
  productId: string,
  driverId: string,
  userId: string,
  qty: number,
) {
  // allocate_to_courier : sortie entrepôt → livreur (qty négative dans le ledger).
  const { error } = await client.rpc('post_stock_movement', {
    p_merchant_account_id: merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'allocate_to_courier',
    p_qty: -qty,
    p_idempotency_key: `alloc:${productId}:${driverId}:${Date.now()}:${Math.random()}`,
    p_created_by: userId,
    p_driver_id: driverId,
  });
  if (error) throw new Error(`allocate_to_courier failed: ${error.message}`);
}

async function createOrderForDriver(
  admin: AdminClient,
  merchantAccountId: string,
  driverId: string,
  lines: Array<{ productId: string; qty: number }>,
) {
  const { data: order } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `ADV-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
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
  await admin.from('order_line').insert(
    lines.map((l) => ({
      merchant_account_id: merchantAccountId,
      order_id: order.id,
      product_id: l.productId,
      raw_title: 'Produit avance',
      qty: l.qty,
      match_status: 'matched' as const,
    })),
  );
  return order.id;
}

async function readDriverProductMovements(admin: AdminClient, productId: string, driverId: string) {
  const { data } = await admin
    .from('stock_movement')
    .select('movement_type, qty')
    .eq('product_id', productId)
    .eq('driver_id', driverId);
  return data ?? [];
}

// Stock en main dérivé du ledger (Σ −qty sur HAND_TYPES) — advance_commit EXCLU.
async function driverHand(admin: AdminClient, productId: string, driverId: string) {
  const rows = await readDriverProductMovements(admin, productId, driverId);
  return rows
    .filter((m) => HAND_TYPES.includes(m.movement_type))
    .reduce((sum, m) => sum - (m.qty ?? 0), 0);
}

// Avance disponible dérivée du ledger : (−Σ allocate) − Σ crl − Σ advance_commit.
async function advanceAvailable(admin: AdminClient, productId: string, driverId: string) {
  const rows = await readDriverProductMovements(admin, productId, driverId);
  let avail = 0;
  for (const m of rows) {
    if (m.movement_type === 'allocate_to_courier') avail += -(m.qty ?? 0);
    else if (m.movement_type === 'courier_return_lot') avail -= m.qty ?? 0;
    else if (m.movement_type === 'advance_commit') avail -= m.qty ?? 0;
  }
  return avail;
}

async function readStock(admin: AdminClient, productId: string) {
  const { data } = await admin
    .from('product_stock')
    .select('qty_on_hand, qty_reserved')
    .eq('product_id', productId)
    .single();
  return data;
}

async function readOrderAssignmentMovements(admin: AdminClient, orderId: string) {
  const { data } = await admin
    .from('stock_movement')
    .select('movement_type, qty, product_id, driver_id')
    .eq('order_id', orderId)
    .in('movement_type', ['order_assignment_commit', 'order_assignment_release'])
    .order('created_at');
  return data ?? [];
}

async function reconcileDiscrepancyFor(admin: AdminClient, productId: string) {
  const { data } = await admin.rpc('reconcile_product_stock' as 'reconcile_order_cod_status');
  return ((data as Array<{ product_id: string }> | null) ?? []).filter(
    (r) => r.product_id === productId,
  );
}

describe('0068/0069 : livraison depuis le lot d’avance', () => {
  skipIfNoServiceRole(
    'avance 6, commande 1 → advance_commit (pas de dispatch), main 5, entrepôt −6, reserved 0',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('adv-6-1');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const owner = await signIn(email);

      await purchaseIn(owner, merchantAccountId, productId, userId, 50); // entrepôt 50 (via ledger)
      await allocateToCourier(owner, merchantAccountId, productId, driverId, userId, 6); // → 44

      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId, qty: 1 },
      ]);

      const client = await signIn(email);
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      }); // reserve +1
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'scheduled',
      });
      const assign = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
      });
      expect(assign.error).toBeNull();

      // Après assign : avance couvre tout → advance_commit, AUCUN dispatch,
      // réserve libérée par advance_commit.
      const afterAssign = await readStock(admin, productId);
      expect(afterAssign?.qty_on_hand).toBe(44); // 50 − 6 (allocate), pas de dispatch
      expect(afterAssign?.qty_reserved).toBe(0); // reserve libéré par advance_commit

      const assignMovements = await admin
        .from('stock_movement')
        .select('movement_type, qty')
        .eq('order_id', orderId)
        .order('created_at');
      expect(assignMovements.data?.map((m) => m.movement_type)).toEqual([
        'reserve',
        'advance_commit',
        'order_assignment_commit',
      ]);

      // Livrer → sold
      const deliver = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'delivered',
        p_cash_state: 'collected',
        p_payment_channel: 'ESPECES',
      });
      expect(deliver.error).toBeNull();

      const final = await readStock(admin, productId);
      expect(final?.qty_on_hand).toBe(44); // sold ne touche pas l’entrepôt
      expect(final?.qty_reserved).toBe(0);

      expect(await driverHand(admin, productId, driverId)).toBe(5); // 6 avance − 1 vendu
      expect(await advanceAvailable(admin, productId, driverId)).toBe(5);

      // advance_commit & sold exclus des allowlists qty_on_hand → aucun faux écart.
      expect(await reconcileDiscrepancyFor(admin, productId)).toHaveLength(0);
    },
  );

  skipIfNoServiceRole(
    'partiel : avance 2, commande 3 → advance_commit 2 + dispatch 1, reserved 0 après assign, main 0, entrepôt −3',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('adv-2-3');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const owner = await signIn(email);

      await purchaseIn(owner, merchantAccountId, productId, userId, 50); // 50
      await allocateToCourier(owner, merchantAccountId, productId, driverId, userId, 2); // → 48

      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId, qty: 3 },
      ]);

      const client = await signIn(email);
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      }); // reserve +3
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'scheduled',
      });
      const assign = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
      });
      expect(assign.error).toBeNull();

      // Après assign : cover 2 (advance_commit libère 2) + remainder 1 (dispatch
      // libère 1) → reserved entièrement libéré.
      const afterAssign = await readStock(admin, productId);
      expect(afterAssign?.qty_on_hand).toBe(47); // 48 − 1 (dispatch du complément)
      expect(afterAssign?.qty_reserved).toBe(0); // 3 − 2 (commit) − 1 (dispatch)

      const assignMovements = await admin
        .from('stock_movement')
        .select('movement_type, qty')
        .eq('order_id', orderId)
        .order('created_at');
      expect(assignMovements.data?.map((m) => m.movement_type)).toEqual([
        'reserve',
        'advance_commit',
        'dispatch',
        'order_assignment_commit',
      ]);
      expect(assignMovements.data?.find((m) => m.movement_type === 'advance_commit')?.qty).toBe(2);
      expect(assignMovements.data?.find((m) => m.movement_type === 'dispatch')?.qty).toBe(-1);

      // Livrer → sold +3
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'delivered',
        p_cash_state: 'collected',
        p_payment_channel: 'ESPECES',
      });

      const final = await readStock(admin, productId);
      expect(final?.qty_on_hand).toBe(47);
      expect(final?.qty_reserved).toBe(0);
      expect(await driverHand(admin, productId, driverId)).toBe(0); // 2 avance + 1 dispatch − 3 vendu
      expect(await advanceAvailable(admin, productId, driverId)).toBe(0);
      expect(await reconcileDiscrepancyFor(admin, productId)).toHaveLength(0);
    },
  );

  skipIfNoServiceRole(
    'double commande successive : avance 1 → 1ʳᵉ couverte (advance_commit), 2ᵉ dispatchée (pas de double-puisage)',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('adv-double');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const owner = await signIn(email);

      await purchaseIn(owner, merchantAccountId, productId, userId, 50); // 50
      await allocateToCourier(owner, merchantAccountId, productId, driverId, userId, 1); // → 49

      const client = await signIn(email);

      async function deliverQty1(orderId: string) {
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
        await transitionRpc(client)('transition_order', {
          p_actor: userId,
          p_order_id: orderId,
          p_delivery_state: 'delivered',
          p_cash_state: 'collected',
          p_payment_channel: 'ESPECES',
        });
      }

      // Commande A : couverte par l'avance (advance_commit), AUCUN dispatch.
      const orderA = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId, qty: 1 },
      ]);
      await deliverQty1(orderA);

      const movesA = await admin
        .from('stock_movement')
        .select('movement_type')
        .eq('order_id', orderA);
      expect(movesA.data?.some((m) => m.movement_type === 'advance_commit')).toBe(true);
      expect(movesA.data?.some((m) => m.movement_type === 'dispatch')).toBe(false);
      expect(await advanceAvailable(admin, productId, driverId)).toBe(0); // 1 − 1 engagé

      // Commande B : avance épuisée → dispatch entrepôt, PAS de nouvel advance_commit
      // (l'avance n'est pas puisée deux fois).
      const orderB = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId, qty: 1 },
      ]);
      await deliverQty1(orderB);

      const movesB = await admin
        .from('stock_movement')
        .select('movement_type, qty')
        .eq('order_id', orderB);
      expect(movesB.data?.some((m) => m.movement_type === 'advance_commit')).toBe(false);
      expect(movesB.data?.find((m) => m.movement_type === 'dispatch')?.qty).toBe(-1);

      const final = await readStock(admin, productId);
      expect(final?.qty_on_hand).toBe(48); // 50 − 1 (allocate) − 1 (dispatch B)
      expect(final?.qty_reserved).toBe(0);
      expect(await driverHand(admin, productId, driverId)).toBe(0); // 1 avance + 1 dispatch − 2 vendus
      expect(await advanceAvailable(admin, productId, driverId)).toBe(0);
      expect(await reconcileDiscrepancyFor(admin, productId)).toHaveLength(0);
    },
  );

  skipIfNoServiceRole(
    'multi-produits : chaque ligne calcule son avance indépendamment',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('adv-multi');
      const prodA = await createProduct(admin, merchantAccountId);
      const prodB = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const owner = await signIn(email);

      await purchaseIn(owner, merchantAccountId, prodA, userId, 50);
      await purchaseIn(owner, merchantAccountId, prodB, userId, 50);
      // Avance sur prodA seulement (3), rien sur prodB.
      await allocateToCourier(owner, merchantAccountId, prodA, driverId, userId, 3); // A → 47

      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId: prodA, qty: 2 },
        { productId: prodB, qty: 2 },
      ]);

      const client = await signIn(email);
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

      // prodA : couvert par l'avance → advance_commit 2, aucun dispatch.
      const movesA = await admin
        .from('stock_movement')
        .select('movement_type, qty')
        .eq('order_id', orderId)
        .eq('product_id', prodA);
      expect(movesA.data?.find((m) => m.movement_type === 'advance_commit')?.qty).toBe(2);
      expect(movesA.data?.some((m) => m.movement_type === 'dispatch')).toBe(false);

      // prodB : aucune avance → dispatch 2, aucun advance_commit.
      const movesB = await admin
        .from('stock_movement')
        .select('movement_type, qty')
        .eq('order_id', orderId)
        .eq('product_id', prodB);
      expect(movesB.data?.some((m) => m.movement_type === 'advance_commit')).toBe(false);
      expect(movesB.data?.find((m) => m.movement_type === 'dispatch')?.qty).toBe(-2);

      const stockA = await readStock(admin, prodA);
      const stockB = await readStock(admin, prodB);
      expect(stockA?.qty_on_hand).toBe(47); // 50 − 3 (allocate), pas de dispatch
      expect(stockA?.qty_reserved).toBe(0);
      expect(stockB?.qty_on_hand).toBe(48); // 50 − 2 (dispatch)
      expect(stockB?.qty_reserved).toBe(0);
    },
  );

  skipIfNoServiceRole(
    'désannuler une commande couverte par l’avance → avance restaurée, AUCUNE réserve fantôme',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('adv-desann');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const owner = await signIn(email);

      await purchaseIn(owner, merchantAccountId, productId, userId, 50);
      await allocateToCourier(owner, merchantAccountId, productId, driverId, userId, 5); // → 45

      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId, qty: 2 },
      ]);

      const client = await signIn(email);
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      }); // reserve +2
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'scheduled',
      });
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
      }); // advance_commit +2 (couvre tout), reserved libéré

      const afterAssign = await readStock(admin, productId);
      expect(afterAssign?.qty_reserved).toBe(0);
      expect(await advanceAvailable(admin, productId, driverId)).toBe(3); // 5 − 2 engagé

      // refuser post-dispatch (REFUSEE : cancelled + failed) — aucun mouvement.
      const refused = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'cancelled',
        p_delivery_state: 'failed',
        p_call_state: 'validated',
        p_cash_state: 'not_due',
      });
      expect(refused.error).toBeNull();
      expect(refused.data).toBe('REFUSEE');

      // désannuler avec effacement du livreur → compensation advance_commit −2.
      const desann = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'open',
        p_call_state: 'to_call',
        p_delivery_state: 'unassigned',
        p_cash_state: 'not_due',
        p_clear_cancel_reasons: true,
        p_clear_scheduled_for: true,
        p_clear_assigned_driver: true,
      });
      expect(desann.error).toBeNull();
      expect(desann.data).toBe('A_APPELER');

      // Avance restaurée : Σ advance_commit = +2 −2 = 0 → avance dispo = 5.
      expect(await advanceAvailable(admin, productId, driverId)).toBe(5);

      // PAS de réserve fantôme : la compensation négative ne touche pas qty_reserved.
      const afterDesann = await readStock(admin, productId);
      expect(afterDesann?.qty_reserved).toBe(0);
      expect(afterDesann?.qty_on_hand).toBe(45); // 50 − 5 (allocate) ; advance_commit n’y touche pas

      // Deux advance_commit (engagement +2, compensation −2), driver d’origine.
      const commits = await admin
        .from('stock_movement')
        .select('qty, driver_id')
        .eq('order_id', orderId)
        .eq('movement_type', 'advance_commit')
        .order('created_at');
      expect(commits.data?.map((m) => m.qty)).toEqual([2, -2]);
      expect(commits.data?.every((m) => m.driver_id === driverId)).toBe(true);

      // Stock en main toujours 5 (advance_commit exclu) — rien de fantôme.
      expect(await driverHand(admin, productId, driverId)).toBe(5);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// RÉCONCILIATION : zéro écart après un parcours complet
// ──────────────────────────────────────────────────────────────────────────

describe('Lot D - mark_returned apres livraison', () => {
  skipIfNoServiceRole(
    'retour apres remise cash : courier_return restaure le stock et une reprise negative neutralise la remise',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('lotd-return');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);
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
        p_cash_state: 'expected',
      });
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
        p_assigned_driver_id: driverId,
      });
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'delivered',
        p_order_state: 'completed',
        p_cash_state: 'collected',
        p_payment_channel: 'ESPECES',
      });

      const { data: settlement } = await admin
        .from('cash_settlement')
        .insert({
          merchant_account_id: merchantAccountId,
          driver_id: driverId,
          amount_received_minor: 10000,
          method: 'ESPECES',
          note: 'Remise test retour',
          created_by: userId,
          client_request_id: randomUUID(),
        })
        .select('id')
        .single();
      if (!settlement) {
        throw new Error('cash settlement insert failed');
      }

      await admin.from('settlement_allocation').insert({
        merchant_account_id: merchantAccountId,
        settlement_id: settlement.id,
        order_id: orderId,
        allocated_minor: 10000,
      });

      const returned = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'returned',
        p_delivery_state: 'returned',
        p_cash_state: 'not_due',
      });
      expect(returned.error).toBeNull();
      expect(returned.data).toBe('REFUSEE');

      const { data: order } = await admin
        .from('orders')
        .select('order_state, delivery_state, cash_state, returned_at')
        .eq('id', orderId)
        .single();
      expect(order?.order_state).toBe('returned');
      expect(order?.delivery_state).toBe('returned');
      expect(order?.cash_state).toBe('not_due');
      expect(order?.returned_at).not.toBeNull();

      const { data: movements } = await admin
        .from('stock_movement')
        .select('movement_type, qty, driver_id')
        .eq('order_id', orderId)
        .order('created_at');
      expect(movements?.map((movement) => movement.movement_type)).toEqual([
        'reserve',
        'dispatch',
        'order_assignment_commit',
        'sold',
        'courier_return',
        'order_assignment_release',
      ]);
      expect(
        movements?.find((movement) => movement.movement_type === 'courier_return'),
      ).toMatchObject({
        driver_id: driverId,
        qty: 3,
      });
      expect(
        movements?.find((movement) => movement.movement_type === 'order_assignment_release'),
      ).toMatchObject({
        driver_id: driverId,
        qty: -3,
      });

      const { data: stock } = await admin
        .from('product_stock')
        .select('qty_on_hand, qty_reserved')
        .eq('product_id', productId)
        .single();
      expect(stock?.qty_on_hand).toBe(50);
      expect(stock?.qty_reserved).toBe(0);

      const { data: allocations } = await admin
        .from('settlement_allocation')
        .select('allocated_minor')
        .eq('order_id', orderId)
        .order('allocated_minor');
      expect(allocations?.map((allocation) => allocation.allocated_minor)).toEqual([-10000, 10000]);

      const { data: settlements } = await admin
        .from('cash_settlement')
        .select('amount_received_minor')
        .eq('merchant_account_id', merchantAccountId)
        .order('amount_received_minor');
      expect(settlements?.map((row) => row.amount_received_minor)).toEqual([-10000, 10000]);

      const secondReturn = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'returned',
        p_delivery_state: 'returned',
        p_cash_state: 'not_due',
      });
      expect(secondReturn.error?.message).toContain('illegal_return_transition');

      const { data: reversalAllocations } = await admin
        .from('settlement_allocation')
        .select('id')
        .eq('order_id', orderId)
        .lt('allocated_minor', 0);
      expect(reversalAllocations).toHaveLength(1);
    },
  );
});

describe('réconciliation zéro écart après valider→dispatch→livrer', () => {
  skipIfNoServiceRole(
    'reconcile_product_stock ne retourne aucun écart pour un produit correctement géré',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('recon');
      const productId = await createProduct(admin, merchantAccountId);
      const ownerClient = await signIn(email);
      // État initial posté via le ledger (purchase_in 40) — et NON un upsert
      // direct : ledger et projection doivent concorder pour que la
      // réconciliation ne trouve aucun écart.
      await ownerClient.rpc('post_stock_movement', {
        p_merchant_account_id: merchantAccountId,
        p_product_id: productId,
        p_movement_type: 'purchase_in',
        p_qty: 40,
        p_idempotency_key: `recon-seed:${productId}`,
        p_created_by: userId,
        p_unit_cost: 5000,
      });
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);
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
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'delivered',
        p_cash_state: 'collected',
        p_payment_channel: 'ESPECES',
      });

      // reconcile_product_stock retourne les écarts
      const { data: discrepancies, error: reconErr } = await admin.rpc(
        'reconcile_product_stock' as 'reconcile_order_cod_status',
      );
      expect(reconErr).toBeNull();

      // Filtre sur ce produit
      const productDiscrepancy = (discrepancies as Array<{ product_id: string }> | null)?.filter(
        (row) => row.product_id === productId,
      );
      expect(productDiscrepancy).toHaveLength(0);
    },
  );
});
