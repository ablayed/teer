/**
 * Tests d'atomicité du module stock (Phase 3b, migration 0029).
 *
 * Principe vérifié : transition_order + post_stock_movement commitent
 * ensemble. Un échec dans post_stock_movement rollback la transition entière.
 * Un succès commite les deux sans aucun écart.
 */

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

      // reserve (+3) + dispatch (-3)
      expect(movements).toHaveLength(2);
      const dispatch = movements?.find((m) => m.movement_type === 'dispatch');
      expect(dispatch?.qty).toBe(-3);
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
    'annuler post-dispatch : aucun mouvement automatique (stock chez livreur)',
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
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'cancelled',
        p_cash_state: 'not_due',
      });

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
        .select('movement_type')
        .eq('order_id', orderId);

      const hasReturn = movements?.some((m) => m.movement_type === 'courier_return');
      expect(hasReturn).toBe(false);
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

      // Créer une commande avec 2 order_line résolues
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
      const { admin, merchantAccountId, userId } = await createOwnerFixture('idem');
      const productId = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, 100);

      const key = `idem-test:${productId}:purchase_in`;

      // Premier appel
      const { data: id1, error: err1 } = await admin.rpc('post_stock_movement', {
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
      const { data: id2, error: err2 } = await admin.rpc('post_stock_movement', {
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
// RÉCONCILIATION : zéro écart après un parcours complet
// ──────────────────────────────────────────────────────────────────────────

describe('réconciliation zéro écart après valider→dispatch→livrer', () => {
  skipIfNoServiceRole(
    'reconcile_product_stock ne retourne aucun écart pour un produit correctement géré',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('recon');
      const productId = await createProduct(admin, merchantAccountId);
      // État initial posté via le ledger (purchase_in 40) — et NON un upsert
      // direct : ledger et projection doivent concorder pour que la
      // réconciliation ne trouve aucun écart.
      await admin.rpc('post_stock_movement', {
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
