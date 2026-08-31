// S2 — attribution non falsifiable sur transition_order (migration 0148).
//
// Défaut prouvé par reproduction (S2-D, stack locale) : `p_actor` n'était jamais confronté à
// auth.uid() dans le corps SQL. Un appel PostgREST direct avec la session de A et p_actor = B
// (B n'étant même pas membre de la boutique de A) réussissait, et order_state_transition,
// purchase_lot_line_allocation et stock_movement portaient tous B comme acteur.
//
// Cette suite prouve le comportement APRÈS 0148 (l'état RED d'avant correctif est une preuve
// historique, ponctuelle, documentée dans docs/phaseU/S2-ACTOR-ATTRIBUTION-FIX.md — une suite
// durable tourne toujours contre le schéma courant, donc toujours avec 0148 déjà appliquée).

import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 's2-actor-guard-rls-pw';
const createdUserIds: string[] = [];
const createdMerchantAccountIds: string[] = [];

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
  for (let i = 0; i < 30; i++) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id as string;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('merchant_account not found after 30 retries');
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
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = `s2guard-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  createdMerchantAccountIds.push(merchantAccountId);
  const shopId = await waitForDefaultShop(admin, merchantAccountId);
  return { admin, email, merchantAccountId, shopId, userId };
}

async function createOutsider(admin: AdminClient, label: string) {
  // Un second tenant, sans aucune relation avec le premier — jamais un simple membre :
  // le défaut original était exploitable même par un utilisateur totalement étranger à la
  // boutique de la commande, cf. reproduction S2-D.
  const email = `s2guard-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  createdMerchantAccountIds.push(merchantAccountId);
  return userId;
}

async function createDriver(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { data } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: `Livreur-S2Guard-${Date.now()}`,
      phone: '+221770000002',
    })
    .select('id')
    .single();
  if (!data) throw new Error('driver insert failed');
  await admin
    .from('driver_shop')
    .insert({ merchant_account_id: merchantAccountId, shop_id: shopId, driver_id: data.id });
  return data.id as string;
}

async function createProduct(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { data } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      title: `Prod-S2Guard-${Date.now()}`,
      unit_cost: 0,
    })
    .select('id')
    .single();
  if (!data) throw new Error('product insert failed');
  return data.id as string;
}

async function createOrderWithLine(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  driverId: string,
  productId: string,
) {
  const { data: order } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      order_number: `S2G-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      total_amount: 5000,
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
      raw_title: 'Produit S2Guard',
      qty: 1,
      match_status: 'matched',
    })
    .select('id')
    .single();
  if (!line) throw new Error('order_line insert failed');

  return order.id as string;
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
};

function transitionRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'transition_order',
    args: TransitionOrderArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}

async function advanceToDispatch(
  client: SupabaseClient<Database>,
  actorUserId: string,
  orderId: string,
) {
  const rpc = transitionRpc(client);
  let r = await rpc('transition_order', {
    p_actor: actorUserId,
    p_order_id: orderId,
    p_call_state: 'validated',
    p_attempt_count: 1,
  });
  if (r.error) throw new Error(`confirmer failed: ${r.error.message}`);
  r = await rpc('transition_order', {
    p_actor: actorUserId,
    p_order_id: orderId,
    p_delivery_state: 'scheduled',
  });
  if (r.error) throw new Error(`programmer failed: ${r.error.message}`);
  r = await rpc('transition_order', {
    p_actor: actorUserId,
    p_order_id: orderId,
    p_delivery_state: 'out_for_delivery',
  });
  if (r.error) throw new Error(`dispatch failed: ${r.error.message}`);
}

async function orderSnapshot(admin: AdminClient, orderId: string) {
  const { data: order } = await admin
    .from('orders')
    .select('order_state,delivery_state,cash_state,cod_status')
    .eq('id', orderId)
    .maybeSingle();
  const { data: transitions } = await admin
    .from('order_state_transition')
    .select('id,actor_user_id,to_status')
    .eq('order_id', orderId);
  return { order, transitionCount: (transitions ?? []).length };
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  // order_state_transition.actor_user_id et stock_movement.created_by référencent auth.users
  // SANS ON DELETE CASCADE (contrairement à merchant_account.owner_user_id, qui cascade jusqu'à
  // orders/order_line) — ces deux tables + audit_log (account.created, posé par le trigger de
  // provisioning) doivent être nettoyées explicitement avant deleteUser, sinon GoTrue répond
  // « Database error deleting user » (violation de contrainte non-cascade, vérifiée en direct).
  if (createdUserIds.length) {
    await admin.from('order_state_transition').delete().in('actor_user_id', createdUserIds);
    await admin.from('stock_movement').delete().in('created_by', createdUserIds);
    await admin.from('purchase_lot_line_allocation').delete().in('created_by', createdUserIds);
    await admin.from('audit_log').delete().in('actor_user_id', createdUserIds);
  }
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
  createdMerchantAccountIds.length = 0;
});

describe('transition_order — attribution non falsifiable (S2, migration 0148)', () => {
  skipIfNoServiceRole(
    'refuse un p_actor différent de auth.uid() et ne pose AUCUNE écriture',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } = await createOwnerFixture('green');
      const outsiderId = await createOutsider(admin, 'green-outsider');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const driverId = await createDriver(admin, merchantAccountId, shopId);
      const orderId = await createOrderWithLine(
        admin,
        merchantAccountId,
        shopId,
        driverId,
        productId,
      );

      await advanceToDispatch(owner, userId, orderId);
      const before = await orderSnapshot(admin, orderId);

      const forged = await transitionRpc(owner)('transition_order', {
        p_actor: outsiderId, // forgé : outsider n'est même pas membre de cette boutique
        p_order_id: orderId,
        p_delivery_state: 'delivered',
        p_order_state: 'completed',
        p_cash_state: 'collected',
        p_payment_channel: 'ESPECES',
      });

      expect(forged.error).not.toBeNull();
      expect(forged.error?.message).toContain('forbidden');

      const after = await orderSnapshot(admin, orderId);
      expect(after.order).toEqual(before.order);
      expect(after.transitionCount).toBe(before.transitionCount);
    },
  );

  skipIfNoServiceRole(
    'contrôle positif — p_actor = auth.uid() réussit et attribue le vrai acteur',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('positive');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const driverId = await createDriver(admin, merchantAccountId, shopId);
      const orderId = await createOrderWithLine(
        admin,
        merchantAccountId,
        shopId,
        driverId,
        productId,
      );

      await advanceToDispatch(owner, userId, orderId);

      const legit = await transitionRpc(owner)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'delivered',
        p_order_state: 'completed',
        p_cash_state: 'collected',
        p_payment_channel: 'ESPECES',
      });

      expect(legit.error).toBeNull();
      expect(legit.data).toBe('LIVREE');

      const { data: transition } = await admin
        .from('order_state_transition')
        .select('actor_user_id')
        .eq('order_id', orderId)
        .eq('to_status', 'LIVREE')
        .single();
      expect(transition?.actor_user_id).toBe(userId);
    },
  );

  skipIfNoServiceRole(
    'sans session (auth.uid() nul) — refusé même via une clé service-role', // aucun appelant système n'existe aujourd'hui (S2-D §3)
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('nosession');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const driverId = await createDriver(admin, merchantAccountId, shopId);
      const orderId = await createOrderWithLine(
        admin,
        merchantAccountId,
        shopId,
        driverId,
        productId,
      );

      await advanceToDispatch(owner, userId, orderId);
      const before = await orderSnapshot(admin, orderId);

      // Client service-role : bypass RLS, mais PAS ce garde-fou — aucun JWT utilisateur, donc
      // auth.uid() est nul côté PostgREST, quel que soit p_actor fourni.
      const noSession = await transitionRpc(admin)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'delivered',
        p_order_state: 'completed',
        p_cash_state: 'collected',
        p_payment_channel: 'ESPECES',
      });

      expect(noSession.error).not.toBeNull();
      expect(noSession.error?.message).toContain('forbidden');

      const after = await orderSnapshot(admin, orderId);
      expect(after.order).toEqual(before.order);
      expect(after.transitionCount).toBe(before.transitionCount);
    },
  );
});
