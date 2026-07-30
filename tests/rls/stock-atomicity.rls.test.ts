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

// 0116 — membre non-owner du MÊME tenant, pour tester le RBAC en base (policy
// orders_update) et pas seulement le catalogue TS. Le compte marchand créé
// automatiquement pour ce nouvel utilisateur est supprimé : on ne veut qu'un membre.
async function addMember(
  admin: AdminClient,
  merchantAccountId: string,
  role: 'agent' | 'manager' | 'owner',
) {
  const email = `atomicity-member-${role}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);

  await admin.from('merchant_account').delete().eq('owner_user_id', userId);

  const { error } = await admin.from('merchant_member').insert({
    merchant_account_id: merchantAccountId,
    role,
    user_id: userId,
  });
  if (error) throw error;

  return { email, userId };
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = `atomicity-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
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
  // 0116 — « Invalider » : demande explicite, jamais déduite des dimensions.
  p_invalidate_delivered?: boolean;
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
        .order('created_at')
        .order('movement_type')
        .order('id');

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
      .order('created_at')
      .order('movement_type')
      .order('id');

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
        .order('created_at')
        .order('movement_type')
        .order('id');

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
        .order('created_at')
        .order('movement_type')
        .order('id');
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
        .order('created_at')
        .order('movement_type')
        .order('id');
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
    .order('created_at')
    .order('movement_type')
    .order('id');
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
      await allocateToCourier(owner, merchantAccountId, productId, driverId, userId, 6); // ledger-only (0093) : entrepôt reste 50

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
      expect(afterAssign?.qty_on_hand).toBe(50); // allocate ne mute plus qty_on_hand (0093), pas de dispatch
      expect(afterAssign?.qty_reserved).toBe(0); // reserve libéré par advance_commit

      const assignMovements = await admin
        .from('stock_movement')
        .select('movement_type, qty')
        .eq('order_id', orderId)
        .order('created_at')
        .order('movement_type')
        .order('id');
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
      expect(final?.qty_on_hand).toBe(50); // sold ne touche pas l’entrepôt ; allocate non plus (0093)
      expect(final?.qty_reserved).toBe(0);

      expect(await driverHand(admin, productId, driverId)).toBe(5); // 6 avance − 1 vendu
      expect(await advanceAvailable(admin, productId, driverId)).toBe(5);

      // advance_commit, sold, et désormais allocate_to_courier/courier_return_lot (0094)
      // exclus des allowlists qty_on_hand → aucun faux écart.
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
      await allocateToCourier(owner, merchantAccountId, productId, driverId, userId, 2); // ledger-only (0093) : reste 50

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
      expect(afterAssign?.qty_on_hand).toBe(49); // 50 − 1 (dispatch du complément) ; allocate ne compte plus (0093)
      expect(afterAssign?.qty_reserved).toBe(0); // 3 − 2 (commit) − 1 (dispatch)

      const assignMovements = await admin
        .from('stock_movement')
        .select('movement_type, qty')
        .eq('order_id', orderId)
        .order('created_at')
        .order('movement_type')
        .order('id');
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
      expect(final?.qty_on_hand).toBe(49); // allocate ne mute plus qty_on_hand (0093)
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
      await allocateToCourier(owner, merchantAccountId, productId, driverId, userId, 1); // ledger-only (0093) : reste 50

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
      expect(final?.qty_on_hand).toBe(49); // 50 − 1 (dispatch B) ; allocate ne compte plus (0093)
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
      await allocateToCourier(owner, merchantAccountId, prodA, driverId, userId, 3); // ledger-only (0093) : A reste 50

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
      expect(stockA?.qty_on_hand).toBe(50); // allocate ne mute plus qty_on_hand (0093), pas de dispatch
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
      await allocateToCourier(owner, merchantAccountId, productId, driverId, userId, 5); // ledger-only (0093) : reste 50

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
      expect(afterDesann?.qty_on_hand).toBe(50); // allocate ne mute plus qty_on_hand (0093) ; advance_commit n’y touche pas non plus

      // Deux advance_commit (engagement +2, compensation −2), driver d’origine.
      const commits = await admin
        .from('stock_movement')
        .select('qty, driver_id')
        .eq('order_id', orderId)
        .eq('movement_type', 'advance_commit')
        .order('created_at')
        .order('movement_type')
        .order('id');
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
        .order('created_at')
        .order('movement_type')
        .order('id');
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

describe('Refuser → Reprogrammer : reprogrammer libère le stock engagé côté livreur', () => {
  skipIfNoServiceRole(
    'reprogrammer poste order_assignment_release, qty_on_hand inchangé (pas de courier_return), driver vidé, retour à Programmée avec la nouvelle date',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('reprogram-release');
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
      const assign = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
      });
      expect(assign.error).toBeNull();

      const { data: stockBeforeReprogram } = await admin
        .from('product_stock')
        .select('qty_on_hand')
        .eq('product_id', productId)
        .single();

      const newScheduledFor = '2099-06-01T09:00:00.000Z';
      const reprogrammed = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_cash_state: 'expected',
        p_delivery_state: 'scheduled',
        p_scheduled_for: newScheduledFor,
        p_clear_assigned_driver: true,
      });
      expect(reprogrammed.error).toBeNull();
      expect(reprogrammed.data).toBe('PROGRAMMEE');

      const { data: order } = await admin
        .from('orders')
        .select('order_state, delivery_state, assigned_driver_id, scheduled_for')
        .eq('id', orderId)
        .single();
      expect(order?.order_state).toBe('open');
      expect(order?.delivery_state).toBe('scheduled');
      expect(order?.assigned_driver_id).toBeNull();
      expect(new Date(order?.scheduled_for ?? '').toISOString()).toBe(newScheduledFor);

      const assignmentMoves = await readOrderAssignmentMovements(admin, orderId);
      expect(assignmentMoves).toHaveLength(2);
      expect(assignmentMoves[0]).toMatchObject({
        movement_type: 'order_assignment_commit',
        driver_id: driverId,
        product_id: productId,
        qty: 3,
      });
      expect(assignmentMoves[1]).toMatchObject({
        movement_type: 'order_assignment_release',
        driver_id: driverId,
        product_id: productId,
        qty: -3,
      });

      // Stock physique inchangé : release ne libère que le ledger de
      // disponibilité, jamais un courier_return (le livreur garde le colis
      // en attendant la nouvelle tentative — cf. audit Phase A).
      const { data: stockAfterReprogram } = await admin
        .from('product_stock')
        .select('qty_on_hand')
        .eq('product_id', productId)
        .single();
      expect(stockAfterReprogram?.qty_on_hand).toBe(stockBeforeReprogram?.qty_on_hand);

      const { data: movements } = await admin
        .from('stock_movement')
        .select('movement_type')
        .eq('order_id', orderId);
      expect(movements?.some((m) => m.movement_type === 'courier_return')).toBe(false);
    },
  );

  skipIfNoServiceRole(
    'garde anti-sur-libération : rejouer le même delta après reprogrammer ne poste aucun second release',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture(
        'reprogram-no-double-release',
      );
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const owner = await signIn(email);
      await purchaseIn(owner, merchantAccountId, productId, userId, 50);

      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
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
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
      });

      const firstReprogram = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_cash_state: 'expected',
        p_delivery_state: 'scheduled',
        p_scheduled_for: '2099-06-01T09:00:00.000Z',
        p_clear_assigned_driver: true,
      });
      expect(firstReprogram.error).toBeNull();

      const movesAfterFirst = await readOrderAssignmentMovements(admin, orderId);
      expect(
        movesAfterFirst.filter((m) => m.movement_type === 'order_assignment_release'),
      ).toHaveLength(1);

      // Rejoue le même paramètre p_delivery_state='scheduled' (simule un retry naïf).
      // v_order.delivery_state est désormais 'scheduled' (déjà reprogrammée) — le
      // déclencheur delta assigned/out_for_delivery→scheduled ne matche plus DU TOUT
      // (le bloc entier est sauté), ce qui est la première ligne de défense contre la
      // double libération. Le filtre net_open > 0 de la boucle reste la seconde ligne
      // de défense, inchangée, pour tout autre chemin qui retenterait le même delta.
      const secondCall = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'scheduled',
      });
      expect(secondCall.error).toBeNull();

      const movesAfterSecond = await readOrderAssignmentMovements(admin, orderId);
      expect(
        movesAfterSecond.filter((m) => m.movement_type === 'order_assignment_release'),
      ).toHaveLength(1);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 0116 — « Invalider une commande » : LIVREE revient à « À appeler ».
//
// À NE PAS CONFONDRE avec « Marquer retournée » (bloc « Lot D » ci-dessus), qui reste
// inchangée : elle enregistre un RETOUR réel (REFUSEE, courier_return, reprise de cash).
// « Invalider » dit que la livraison n'a jamais eu lieu — la contre-passation de stock se
// fait par NÉGATION EXACTE des mouvements réellement posés (dérivée du ledger), jamais par
// un courier_return.
// ──────────────────────────────────────────────────────────────────────────

// Parcours complet À appeler → … → LIVREE, via le VRAI chemin transition_order (jamais un
// insert direct : seule la RPC poste les mouvements de stock qu'on veut ensuite contre-passer).
async function driveOrderToDelivered(
  client: SupabaseClient<Database>,
  userId: string,
  orderId: string,
  driverId: string,
) {
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_call_state: 'validated',
    p_cash_state: 'expected',
    p_delivery_state: 'scheduled',
  });
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'assigned',
    p_assigned_driver_id: driverId,
  });
  const delivered = await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'delivered',
    p_order_state: 'completed',
    p_cash_state: 'collected',
    p_payment_channel: 'ESPECES',
  });
  expect(delivered.error).toBeNull();
  expect(delivered.data).toBe('LIVREE');
}

// Le patch exact que buildTransitionDimensionPatch('invalider', …) envoie à la RPC.
function invalidateArgs(userId: string, orderId: string): TransitionOrderArgs {
  return {
    p_actor: userId,
    p_order_id: orderId,
    p_call_state: 'to_call',
    p_cash_state: 'not_due',
    p_delivery_state: 'unassigned',
    p_order_state: 'open',
    p_clear_assigned_driver: true,
    p_clear_cancel_reasons: true,
    p_clear_scheduled_for: true,
    p_invalidate_delivered: true,
  };
}

function movementNetByType(rows: Array<{ movement_type: string; qty: number | null }>) {
  const byType = new Map<string, number>();
  for (const row of rows) {
    byType.set(row.movement_type, (byType.get(row.movement_type) ?? 0) + (row.qty ?? 0));
  }
  return byType;
}

describe('0116 - Invalider une commande livree', () => {
  skipIfNoServiceRole(
    'remet les 4 dimensions a « A appeler », efface les 2 dates et restitue le stock',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('invalidate-full');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);
      await driveOrderToDelivered(client, userId, orderId, driverId);

      // Etat livre : les deux dates de 0114 sont posees, le stock est parti.
      const { data: beforeOrder } = await admin
        .from('orders')
        .select('cash_collected_at, call_confirmed_at, cash_collectable_minor')
        .eq('id', orderId)
        .single();
      expect(beforeOrder?.cash_collected_at).not.toBeNull();
      expect(beforeOrder?.call_confirmed_at).not.toBeNull();
      expect(beforeOrder?.cash_collectable_minor).toBe(10000);
      expect(await readStock(admin, productId)).toMatchObject({ qty_on_hand: 47 });

      const invalidated = await transitionRpc(client)(
        'transition_order',
        invalidateArgs(userId, orderId),
      );
      expect(invalidated.error).toBeNull();
      expect(invalidated.data).toBe('A_APPELER');

      const { data: order } = await admin
        .from('orders')
        .select(
          'cod_status, order_state, call_state, delivery_state, cash_state, assigned_driver_id, scheduled_for, cash_collected_at, call_confirmed_at, payment_channel_at_delivery, cash_collectable_minor',
        )
        .eq('id', orderId)
        .single();
      // Les 4 dimensions exactement a leur valeur initiale.
      expect(order?.order_state).toBe('open');
      expect(order?.call_state).toBe('to_call');
      expect(order?.delivery_state).toBe('unassigned');
      expect(order?.cash_state).toBe('not_due');
      expect(order?.cod_status).toBe('A_APPELER');
      expect(order?.assigned_driver_id).toBeNull();
      expect(order?.scheduled_for).toBeNull();
      // Les deux dates de 0114 remises a NULL : c'est ce qui fait sortir la commande des
      // fenetres du CA encaisse, des Livraisons par produit et du P&L.
      expect(order?.cash_collected_at).toBeNull();
      expect(order?.call_confirmed_at).toBeNull();
      // Plus aucun montant encaissable fantome sur une commande « jamais livree ».
      expect(order?.payment_channel_at_delivery).toBeNull();
      expect(order?.cash_collectable_minor).toBe(0);

      // Stock central restitue a l'identique, reserve remise a zero.
      expect(await readStock(admin, productId)).toMatchObject({
        qty_on_hand: 50,
        qty_reserved: 0,
      });

      // Contre-passation par negation exacte : chaque type pose a son oppose, et AUCUN
      // courier_return n'est emis (aucun retour n'a eu lieu — cf. lib/ia/finance-data.ts,
      // qui lit ce type comme un signal de retour).
      const { data: movements } = await admin
        .from('stock_movement')
        .select('movement_type, qty, driver_id')
        .eq('order_id', orderId);
      const net = movementNetByType(movements ?? []);
      expect(net.get('dispatch')).toBe(0);
      expect(net.get('sold')).toBe(0);
      expect(net.get('order_assignment_commit')).toBe(3);
      expect(net.get('order_assignment_release')).toBe(-3);
      expect(net.has('courier_return')).toBe(false);

      // Le livreur ne detient plus rien et n'a plus aucun engagement ouvert.
      expect(await driverHand(admin, productId, driverId)).toBe(0);
      const assignmentNet = (await readOrderAssignmentMovements(admin, orderId)).reduce(
        (sum, m) => sum + (m.qty ?? 0),
        0,
      );
      expect(assignmentNet).toBe(0);

      // L'invalidation n'introduit AUCUNE derive ledger↔product_stock : l'ecart de
      // reconciliation reste exactement celui de la fixture (seedProductStock ecrit
      // qty_on_hand=50 en direct, sans purchase_in — cet ecart de 50 preexiste au test).
      expect(await reconcileDiscrepancyFor(admin, productId)).toMatchObject([{ delta: 50 }]);
    },
  );

  skipIfNoServiceRole(
    'cascade bundle : les composants sont restitues, jamais le bundle lui-meme',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('invalidate-bundle');
      const bundleId = await createProduct(admin, merchantAccountId);
      const componentAId = await createProduct(admin, merchantAccountId);
      const componentBId = await createProduct(admin, merchantAccountId);
      await admin.from('product').update({ is_bundle: true }).eq('id', bundleId);
      await admin.from('product_bundle_component').insert([
        {
          merchant_account_id: merchantAccountId,
          bundle_product_id: bundleId,
          component_product_id: componentAId,
          quantity: 2,
        },
        {
          merchant_account_id: merchantAccountId,
          bundle_product_id: bundleId,
          component_product_id: componentBId,
          quantity: 1,
        },
      ]);
      await seedProductStock(admin, componentAId, merchantAccountId, 50);
      await seedProductStock(admin, componentBId, merchantAccountId, 50);

      const driverId = await createDriver(admin, merchantAccountId);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, bundleId);

      const client = await signIn(email);
      await driveOrderToDelivered(client, userId, orderId, driverId);

      // qty=3 sur la ligne bundle → 6 de A et 3 de B partis du stock central.
      expect(await readStock(admin, componentAId)).toMatchObject({ qty_on_hand: 44 });
      expect(await readStock(admin, componentBId)).toMatchObject({ qty_on_hand: 47 });

      const invalidated = await transitionRpc(client)(
        'transition_order',
        invalidateArgs(userId, orderId),
      );
      expect(invalidated.error).toBeNull();

      expect(await readStock(admin, componentAId)).toMatchObject({
        qty_on_hand: 50,
        qty_reserved: 0,
      });
      expect(await readStock(admin, componentBId)).toMatchObject({
        qty_on_hand: 50,
        qty_reserved: 0,
      });
      expect(await driverHand(admin, componentAId, driverId)).toBe(0);
      expect(await driverHand(admin, componentBId, driverId)).toBe(0);

      // Aucun mouvement PHYSIQUE ni de vente au niveau du bundle : la cascade de 0108
      // resout en composants a l'aller comme au retour, y compris pour la contre-passation.
      // Seul `reserve` reste au niveau du bundle — 0108 ne le cascade volontairement pas
      // (dette documentee, anterieure a ce lot) ; c'est aussi pourquoi la contre-passation
      // ne contre-passe pas `reserve` mais neutralise l'effet reserve du dispatch par un
      // `release` appaire, au niveau composant, la ou le dispatch a reellement eu lieu.
      const { data: bundleMovements } = await admin
        .from('stock_movement')
        .select('movement_type')
        .eq('order_id', orderId)
        .eq('product_id', bundleId);
      expect(bundleMovements?.map((m) => m.movement_type)).toEqual(['reserve']);
    },
  );

  skipIfNoServiceRole(
    'cash deja remis : invalidation refusee, la commande reste livree intacte',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('invalidate-remitted');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);
      await driveOrderToDelivered(client, userId, orderId, driverId);

      // Le livreur a verse : cash_settlement + settlement_allocation existent desormais.
      const { data: settlement } = await admin
        .from('cash_settlement')
        .insert({
          merchant_account_id: merchantAccountId,
          driver_id: driverId,
          amount_received_minor: 10000,
          method: 'ESPECES',
          note: 'Remise test invalidation',
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
      await admin.from('orders').update({ cash_state: 'remitted' }).eq('id', orderId);

      const refused = await transitionRpc(client)(
        'transition_order',
        invalidateArgs(userId, orderId),
      );
      expect(refused.error?.message).toContain('invalid_invalidate_cash_settled');

      // Refus AVANT toute ecriture : ni dimensions, ni dates, ni stock ne bougent.
      const { data: order } = await admin
        .from('orders')
        .select('cod_status, order_state, delivery_state, cash_state, cash_collected_at')
        .eq('id', orderId)
        .single();
      expect(order?.cod_status).toBe('LIVREE');
      expect(order?.order_state).toBe('completed');
      expect(order?.delivery_state).toBe('delivered');
      expect(order?.cash_state).toBe('remitted');
      expect(order?.cash_collected_at).not.toBeNull();
      expect(await readStock(admin, productId)).toMatchObject({ qty_on_hand: 47 });

      // Meme refus pour un ecart de caisse (discrepancy).
      await admin.from('orders').update({ cash_state: 'discrepancy' }).eq('id', orderId);
      const refusedDiscrepancy = await transitionRpc(client)(
        'transition_order',
        invalidateArgs(userId, orderId),
      );
      expect(refusedDiscrepancy.error?.message).toContain('invalid_invalidate_cash_settled');

      // Cas AUTORISE a l'inverse : cash encore chez le livreur, aucun versement enregistre.
      await admin.from('orders').update({ cash_state: 'collected' }).eq('id', orderId);
      const allowed = await transitionRpc(client)(
        'transition_order',
        invalidateArgs(userId, orderId),
      );
      expect(allowed.error).toBeNull();
      expect(allowed.data).toBe('A_APPELER');
    },
  );

  skipIfNoServiceRole(
    "p_invalidate_delivered est refusee sur une commande qui n'est pas livree",
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('invalidate-illegal');
      const productId = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);
      const refused = await transitionRpc(client)(
        'transition_order',
        invalidateArgs(userId, orderId),
      );
      expect(refused.error?.message).toContain('illegal_invalidation');

      const { data: order } = await admin
        .from('orders')
        .select('cod_status, call_state')
        .eq('id', orderId)
        .single();
      expect(order?.cod_status).toBe('A_APPELER');
      expect(order?.call_state).toBe('to_call');
    },
  );

  skipIfNoServiceRole('RBAC : un agent ne peut pas invalider, un manager le peut', async () => {
    const { admin, email, merchantAccountId, userId } = await createOwnerFixture('invalidate-rbac');
    const productId = await createProduct(admin, merchantAccountId);
    const driverId = await createDriver(admin, merchantAccountId);
    await seedProductStock(admin, productId, merchantAccountId, 50);
    const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

    const ownerClient = await signIn(email);
    await driveOrderToDelivered(ownerClient, userId, orderId, driverId);

    // L'agent est bloque en base, pas seulement dans le catalogue TS : la policy
    // orders_update borne son WITH CHECK aux cod_status TENTEE/CONFIRMEE/PROGRAMMEE/
    // EN_LIVRAISON — A_APPELER n'en fait pas partie.
    const agent = await addMember(admin, merchantAccountId, 'agent');
    const agentClient = await signIn(agent.email);
    const agentAttempt = await transitionRpc(agentClient)(
      'transition_order',
      invalidateArgs(agent.userId, orderId),
    );
    expect(agentAttempt.error).not.toBeNull();

    const { data: stillDelivered } = await admin
      .from('orders')
      .select('cod_status')
      .eq('id', orderId)
      .single();
    expect(stillDelivered?.cod_status).toBe('LIVREE');

    const manager = await addMember(admin, merchantAccountId, 'manager');
    const managerClient = await signIn(manager.email);
    const managerAttempt = await transitionRpc(managerClient)(
      'transition_order',
      invalidateArgs(manager.userId, orderId),
    );
    expect(managerAttempt.error).toBeNull();
    expect(managerAttempt.data).toBe('A_APPELER');
  });

  skipIfNoServiceRole(
    "n'ecrit AUCUNE ligne audit_log — exception deliberee a la convention du projet",
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('invalidate-audit');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 50);
      const orderId = await createOrderWithLine(admin, merchantAccountId, userId, productId);

      const client = await signIn(email);
      await driveOrderToDelivered(client, userId, orderId, driverId);

      const invalidated = await transitionRpc(client)(
        'transition_order',
        invalidateArgs(userId, orderId),
      );
      expect(invalidated.error).toBeNull();

      // Preuve d'absence, lue en service-role (donc sans filtre RLS qui pourrait masquer
      // une ligne) : zero trace d'audit pour cette commande, sur tout le parcours.
      const { data: auditRows } = await admin
        .from('audit_log')
        .select('id, action')
        .eq('merchant_account_id', merchantAccountId)
        .eq('resource_id', orderId);
      expect(auditRows).toEqual([]);

      // Ni AUCUNE ligne order_state_transition : l'invalidation est la seule branche de
      // transition_order qui ne pose pas son historique. Les transitions des vies
      // ANTERIEURES de la commande restent, elles, intactes — seule l'invalidation
      // elle-meme n'apparait nulle part.
      const { data: transitions } = await admin
        .from('order_state_transition')
        .select('to_status')
        .eq('order_id', orderId)
        .order('created_at');
      // driveOrderToDelivered pose validated+scheduled dans le MEME appel : la premiere
      // transition est donc PROGRAMMEE, pas CONFIRMEE.
      expect(transitions?.map((t) => t.to_status)).toEqual([
        'PROGRAMMEE',
        'EN_LIVRAISON',
        'LIVREE',
      ]);
      expect(transitions?.some((t) => t.to_status === 'A_APPELER')).toBe(false);

      // Les mouvements de compensation portent donc transition_id = NULL : la colonne est
      // une FK vers order_state_transition(id), un UUID fantome la violerait.
      const { data: compensations } = await admin
        .from('stock_movement')
        .select('movement_type, qty, transition_id')
        .eq('order_id', orderId)
        .in('movement_type', ['dispatch', 'sold'])
        .order('created_at');
      const reversals = (compensations ?? []).filter((m) =>
        m.movement_type === 'dispatch' ? (m.qty ?? 0) > 0 : (m.qty ?? 0) < 0,
      );
      expect(reversals).toHaveLength(2);
      for (const movement of reversals) {
        expect(movement.transition_id).toBeNull();
      }
    },
  );

  skipIfNoServiceRole(
    'rejeu : un second appel identique echoue en illegal_invalidation, sans double compensation',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('invalidate-replay');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const owner = await signIn(email);
      await purchaseIn(owner, merchantAccountId, productId, userId, 50);
      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId, qty: 3 },
      ]);
      await driveOrderToDelivered(owner, userId, orderId, driverId);

      const first = await transitionRpc(owner)('transition_order', invalidateArgs(userId, orderId));
      expect(first.error).toBeNull();
      const afterFirst = await readStock(admin, productId);
      expect(afterFirst).toMatchObject({ qty_on_hand: 50, qty_reserved: 0 });

      // Rejeu (double-clic, retry reseau). Les cles d'idempotence NE protegent pas ici :
      // v_transition_id est neuf a chaque appel, donc les cles du second appel seraient
      // differentes et ne se dedupliqueraient pas. C'est la GARDE D'ETAT qui arrete le
      // rejeu, avant toute ecriture de stock.
      const replay = await transitionRpc(owner)(
        'transition_order',
        invalidateArgs(userId, orderId),
      );
      expect(replay.error?.message).toContain('illegal_invalidation');

      // Aucune double compensation : positions inchangees, et le nombre de mouvements n'a
      // pas bouge (le rejeu n'a rien ecrit du tout).
      expect(await readStock(admin, productId)).toEqual(afterFirst);
      const { count } = await admin
        .from('stock_movement')
        .select('id', { count: 'exact', head: true })
        .eq('order_id', orderId);
      const net = movementNetByType(
        (await admin.from('stock_movement').select('movement_type, qty').eq('order_id', orderId))
          .data ?? [],
      );
      expect(net.get('dispatch')).toBe(0);
      expect(net.get('sold')).toBe(0);

      // Et le rejeu n'a pas non plus posé de ligne d'historique fantome.
      const { data: transitions } = await admin
        .from('order_state_transition')
        .select('to_status')
        .eq('order_id', orderId);
      expect(transitions?.some((t) => t.to_status === 'A_APPELER')).toBe(false);

      // Deux appels concurrents : le select … for update serialise, le second relit la ligne
      // validee apres obtention du verrou et tombe donc sur la meme garde.
      const concurrentOrderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId, qty: 3 },
      ]);
      // Reference prise AVANT le dispatch de cette 2e commande (50 en stock), pour que
      // l'assertion finale prouve UNE seule contre-passation et non deux.
      const beforeConcurrent = await readStock(admin, productId);
      await driveOrderToDelivered(owner, userId, concurrentOrderId, driverId);
      const [a, b] = await Promise.all([
        transitionRpc(owner)('transition_order', invalidateArgs(userId, concurrentOrderId)),
        transitionRpc(owner)('transition_order', invalidateArgs(userId, concurrentOrderId)),
      ]);
      const outcomes = [a, b];
      expect(outcomes.filter((r) => r.error === null)).toHaveLength(1);
      expect(outcomes.filter((r) => r.error !== null)).toHaveLength(1);
      expect(outcomes.find((r) => r.error !== null)?.error?.message).toContain(
        'illegal_invalidation',
      );
      // Le dispatch de cette 2e commande est reparti puis revenu : position finale identique
      // a celle d'avant, une seule fois — pas deux.
      expect(await readStock(admin, productId)).toEqual(beforeConcurrent);
      expect(count).toBeGreaterThan(0);
    },
  );

  skipIfNoServiceRole(
    'double invalidation dans le temps : les cles des deux passages restent distinctes',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('invalidate-twice');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const owner = await signIn(email);
      await purchaseIn(owner, merchantAccountId, productId, userId, 50);
      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId, qty: 3 },
      ]);

      // Vie 1 : livree puis invalidee.
      await driveOrderToDelivered(owner, userId, orderId, driverId);
      const firstPass = await transitionRpc(owner)(
        'transition_order',
        invalidateArgs(userId, orderId),
      );
      expect(firstPass.error).toBeNull();
      const keysAfterFirst = new Set(
        (
          await admin.from('stock_movement').select('idempotency_key').eq('order_id', orderId)
        ).data?.map((m) => m.idempotency_key),
      );

      // Vie 2 : la commande est re-traitee normalement, re-livree, puis invalidee A NOUVEAU.
      // Sans UUID neuf par execution, les cles du 2e passage collisionneraient avec celles du
      // 1er : post_stock_movement dedupliquerait silencieusement et la compensation ne serait
      // JAMAIS posee — stock central durablement faux, sans aucune erreur remontee.
      await admin.from('orders').update({ assigned_driver_id: driverId }).eq('id', orderId);
      await driveOrderToDelivered(owner, userId, orderId, driverId);
      const secondPass = await transitionRpc(owner)(
        'transition_order',
        invalidateArgs(userId, orderId),
      );
      expect(secondPass.error).toBeNull();
      expect(secondPass.data).toBe('A_APPELER');

      const allKeys = (
        await admin.from('stock_movement').select('idempotency_key').eq('order_id', orderId)
      ).data?.map((m) => m.idempotency_key);
      // Aucune collision, et le 2e passage a bien ajoute ses propres mouvements.
      expect(new Set(allKeys).size).toBe(allKeys?.length);
      expect((allKeys?.length ?? 0) > keysAfterFirst.size).toBe(true);

      // Les deux allers-retours se sont annules : position finale = position de depart.
      expect(await readStock(admin, productId)).toMatchObject({
        qty_on_hand: 50,
        qty_reserved: 0,
      });
      const net = movementNetByType(
        (await admin.from('stock_movement').select('movement_type, qty').eq('order_id', orderId))
          .data ?? [],
      );
      expect(net.get('dispatch')).toBe(0);
      expect(net.get('sold')).toBe(0);
      expect(await driverHand(admin, productId, driverId)).toBe(0);
      expect(await reconcileDiscrepancyFor(admin, productId)).toHaveLength(0);

      // Toujours aucune trace des DEUX invalidations dans l'historique, alors que les deux
      // vies ont bien laisse leurs transitions normales (2 x CONFIRMEE/…/LIVREE).
      const { data: transitions } = await admin
        .from('order_state_transition')
        .select('to_status')
        .eq('order_id', orderId);
      expect(transitions?.some((t) => t.to_status === 'A_APPELER')).toBe(false);
      expect(transitions?.filter((t) => t.to_status === 'LIVREE')).toHaveLength(2);
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // Preuve NUMÉRIQUE que qty_reserved retombe à sa valeur exacte d'avant le
  // parcours — pas une déduction depuis les commentaires de 0116.
  //
  // Les deux tests ci-dessous mesurent (qty_on_hand, qty_reserved) AVANT toute
  // transition puis APRÈS invalidation et prouvent l'égalité STRICTE. Ils
  // couvrent les deux cas précis que la contre-passation par le ledger existe
  // pour traiter, et qu'un rejeu d'`order_line` aurait cassés :
  //   1. dispatch partiellement couvert par du stock d'avance (advance_commit) ;
  //   2. commande réassignée en cours de route (le stock doit revenir au bon
  //      livreur, pas à celui de la dernière assignation).
  //
  // Chaque test embarque une commande SŒUR confirmée qui immobilise 4 unités de
  // réserve pendant toute la manœuvre. Sans cette réserve de fond non nulle, la
  // valeur attendue serait 0 et un `greatest(0, …)` de post_stock_movement
  // masquerait une sur-libération : le test passerait pour une mauvaise raison.
  // ────────────────────────────────────────────────────────────────────────

  // Réserve de fond : une autre commande du même produit, confirmée et laissée
  // en l'état, dont les 4 unités réservées ne doivent jamais bouger.
  async function seedSiblingReserve(
    admin: AdminClient,
    client: SupabaseClient<Database>,
    merchantAccountId: string,
    userId: string,
    productId: string,
    qty: number,
  ) {
    const siblingDriverId = await createDriver(admin, merchantAccountId);
    const siblingOrderId = await createOrderForDriver(admin, merchantAccountId, siblingDriverId, [
      { productId, qty },
    ]);
    const confirmed = await transitionRpc(client)('transition_order', {
      p_actor: userId,
      p_order_id: siblingOrderId,
      p_call_state: 'validated',
      p_attempt_count: 1,
    });
    expect(confirmed.error).toBeNull();
    return siblingOrderId;
  }

  async function netByDriverAndType(admin: AdminClient, orderId: string) {
    const { data } = await admin
      .from('stock_movement')
      .select('movement_type, qty, driver_id')
      .eq('order_id', orderId);
    const net = new Map<string, number>();
    for (const row of data ?? []) {
      const key = `${row.movement_type}@${row.driver_id ?? 'none'}`;
      net.set(key, (net.get(key) ?? 0) + (row.qty ?? 0));
    }
    return net;
  }

  skipIfNoServiceRole(
    'avance partielle : qty_reserved et qty_on_hand reviennent a leur valeur EXACTE, avance restituee',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('invalidate-advance');
      const productId = await createProduct(admin, merchantAccountId);
      const driverId = await createDriver(admin, merchantAccountId);
      const owner = await signIn(email);

      // purchase_in (et non seedProductStock) : le ledger et product_stock restent
      // cohérents, donc l'écart de réconciliation attendu est ZÉRO à la fin.
      await purchaseIn(owner, merchantAccountId, productId, userId, 50);
      // Avance de 2 chez le livreur : la livraison puisera 2 dans l'avance et
      // dispatchera seulement 1 depuis l'entrepôt.
      await allocateToCourier(owner, merchantAccountId, productId, driverId, userId, 2);
      await seedSiblingReserve(admin, owner, merchantAccountId, userId, productId, 4);

      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId, qty: 3 },
      ]);

      // Référence : l'état AVANT toute transition de la commande cible, réserve
      // de fond incluse.
      const before = await readStock(admin, productId);
      expect(before).toMatchObject({ qty_on_hand: 50, qty_reserved: 4 });
      expect(await advanceAvailable(admin, productId, driverId)).toBe(2);

      await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      }); // reserve +3 → 7
      await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'scheduled',
      });
      await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
      });
      // advance_commit 2 (libère 2 de réserve) + dispatch 1 (libère 1, sort 1 de
      // l'entrepôt) → il ne reste que la réserve de fond.
      expect(await readStock(admin, productId)).toMatchObject({
        qty_on_hand: 49,
        qty_reserved: 4,
      });
      expect(await advanceAvailable(admin, productId, driverId)).toBe(0);

      const delivered = await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'delivered',
        p_order_state: 'completed',
        p_cash_state: 'collected',
        p_payment_channel: 'ESPECES',
      });
      expect(delivered.data).toBe('LIVREE');

      const invalidated = await transitionRpc(owner)(
        'transition_order',
        invalidateArgs(userId, orderId),
      );
      expect(invalidated.error).toBeNull();
      expect(invalidated.data).toBe('A_APPELER');

      // ÉGALITÉ STRICTE, les deux compteurs à la fois. C'est l'assertion que ce
      // test existe pour porter : la contre-passation du dispatch ré-arme la
      // réserve (+1) et le `release` apparié l'annule (−1) — si ce couplage était
      // faux, qty_reserved vaudrait 5 ici.
      expect(await readStock(admin, productId)).toEqual(before);

      // L'avance du livreur n'a jamais été consommée : elle est intégralement
      // restituée (compensation advance_commit négative, qui ne touche PAS la
      // réserve grâce au greatest(p_qty, 0) de post_stock_movement).
      expect(await advanceAvailable(admin, productId, driverId)).toBe(2);
      // Le livreur garde physiquement son lot d'avance de 2 — l'invalidation ne
      // rapatrie rien de sa main, elle défait seulement la vente.
      expect(await driverHand(admin, productId, driverId)).toBe(2);

      const net = movementNetByType(
        (await admin.from('stock_movement').select('movement_type, qty').eq('order_id', orderId))
          .data ?? [],
      );
      expect(net.get('dispatch')).toBe(0);
      expect(net.get('sold')).toBe(0);
      expect(net.get('advance_commit')).toBe(0);
      expect(net.has('courier_return')).toBe(false);

      // Aucune dérive ledger ↔ product_stock introduite par l'aller-retour.
      expect(await reconcileDiscrepancyFor(admin, productId)).toHaveLength(0);
    },
  );

  skipIfNoServiceRole(
    'reassignation en cours de route : le stock revient au bon livreur, positions a l’identique',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('invalidate-reassign');
      const productId = await createProduct(admin, merchantAccountId);
      const driverA = await createDriver(admin, merchantAccountId);
      const driverB = await createDriver(admin, merchantAccountId);
      const owner = await signIn(email);

      await purchaseIn(owner, merchantAccountId, productId, userId, 50);
      await seedSiblingReserve(admin, owner, merchantAccountId, userId, productId, 4);

      const orderId = await createOrderForDriver(admin, merchantAccountId, driverA, [
        { productId, qty: 3 },
      ]);
      const before = await readStock(admin, productId);
      expect(before).toMatchObject({ qty_on_hand: 50, qty_reserved: 4 });

      await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      });
      await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'scheduled',
      });
      await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
      });

      // Le dispatch est parti chez A, puis la commande change de livreur EN COURS
      // de livraison : reassign_from_driver (A, +3) puis reassign_to_driver (B, −3).
      const reassign = await owner.rpc('reassign_order_driver', {
        p_actor: userId,
        p_order_id: orderId,
        p_new_driver: driverB,
      });
      expect(reassign.error).toBeNull();

      const delivered = await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'delivered',
        p_order_state: 'completed',
        p_cash_state: 'collected',
        p_payment_channel: 'ESPECES',
      });
      expect(delivered.data).toBe('LIVREE');

      const invalidated = await transitionRpc(owner)(
        'transition_order',
        invalidateArgs(userId, orderId),
      );
      expect(invalidated.error).toBeNull();
      expect(invalidated.data).toBe('A_APPELER');

      // Égalité stricte malgré une chaîne de 4 types qui touchent qty_on_hand
      // (dispatch, reassign_from, reassign_to, puis leurs 3 contre-passations) et
      // la réserve de fond intacte.
      expect(await readStock(admin, productId)).toEqual(before);

      // Aucun des deux livreurs ne conserve quoi que ce soit : chaque mouvement a
      // été contre-passé SUR LE LIVREUR QUI L'AVAIT REÇU (c'est le point que le
      // rejeu d'order_line manquerait — il aurait tout imputé à B).
      const net = await netByDriverAndType(admin, orderId);
      expect(net.get(`dispatch@${driverA}`)).toBe(0);
      expect(net.get(`reassign_from_driver@${driverA}`)).toBe(0);
      expect(net.get(`reassign_to_driver@${driverB}`)).toBe(0);
      expect(net.get(`sold@${driverB}`)).toBe(0);
      expect(net.has(`reassign_from_driver@${driverB}`)).toBe(false);
      expect(net.has(`dispatch@${driverB}`)).toBe(false);
      expect(await driverHand(admin, productId, driverA)).toBe(0);
      expect(await driverHand(admin, productId, driverB)).toBe(0);

      // Engagements de disponibilité soldés des deux côtés.
      const assignmentNet = (await readOrderAssignmentMovements(admin, orderId)).reduce(
        (sum, m) => sum + (m.qty ?? 0),
        0,
      );
      expect(assignmentNet).toBe(0);
      expect(await reconcileDiscrepancyFor(admin, productId)).toHaveLength(0);
    },
  );
});
