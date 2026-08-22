/**
 * Gap 4 (migration 0139) — `transition_order` et `reassign_order_driver` ne
 * vérifiaient l'éligibilité d'un livreur QUE par `merchant_account_id` (le tenant),
 * jamais par `driver_shop` (la boutique). La seule protection existante était
 * incidentelle : `private.post_stock_movement` refuse un `p_driver_id` absent de
 * `driver_shop`, mais ce contrôle ne s'exécute que si un mouvement de stock portant
 * ce driver_id est réellement posté — ce qui n'arrive ni pour une commande sans
 * ligne `matched`, ni pour une réassignation hors `assigned`/`out_for_delivery` (le
 * bloc de mouvement de `reassign_order_driver` est alors entièrement sauté).
 *
 * Ces tests appellent la RPC DIRECTEMENT via un client signé (jamais une Server
 * Action) : ils prouvent donc la garde SQL, incontournable même par un appel RPC
 * direct forgé hors interface. La garde TS (lib/actions/transitions.ts,
 * lib/actions/orders.ts::performReassignDriverForContext) est prouvée séparément
 * par tests/unit/orders/reassign-driver-eligibility.test.ts.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'gap4-driver-shop-eligibility-pw-0139';
const createdUserIds: string[] = [];
const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

type Client = SupabaseClient<Database>;

function adminClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createConfirmedUser(admin: Client, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('user creation failed');
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function waitForMerchantAccount(admin: Client, userId: string) {
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

async function signIn(email: string): Promise<Client> {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function defaultShopId(admin: Client, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('is_default', true)
    .single();
  if (error || !data) throw error ?? new Error('default shop not found');
  return data.id;
}

async function createSecondaryShop(admin: Client, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `gap4-gate-${Date.now()}-${randomUUID()}.internal`,
      access_token_encrypted: 'enc',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('secondary shop insert failed');
  return data.id;
}

async function createTenant(label: string) {
  const admin = adminClient();
  const email = `gap4-gate-${label}-${Date.now()}-${randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  const defaultShop = await defaultShopId(admin, merchantAccountId);
  return { admin, email, userId, merchantAccountId, defaultShop };
}

async function addAgent(admin: Client, merchantAccountId: string) {
  const email = `gap4-gate-agent-${Date.now()}-${randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  const { error } = await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role: 'agent', user_id: userId });
  if (error) throw error;
  return { email, userId };
}

// `shopId: null` crée un livreur volontairement SANS aucun rattachement.
async function createDriver(admin: Client, merchantAccountId: string, shopId: string | null) {
  const { data, error } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: `Livreur-${Date.now()}-${randomUUID().slice(0, 6)}`,
      phone: `+2217${Math.floor(Math.random() * 90000000 + 10000000)}`,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('driver insert failed');
  if (shopId) {
    const { error: memErr } = await admin
      .from('driver_shop')
      .insert({ merchant_account_id: merchantAccountId, shop_id: shopId, driver_id: data.id });
    if (memErr) throw memErr;
  }
  return data.id;
}

async function createProduct(admin: Client, merchantAccountId: string, shopId: string) {
  const { data, error } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      title: `Prod-${Date.now()}-${randomUUID().slice(0, 6)}`,
      unit_cost: 5000,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  await admin.from('product_stock').upsert(
    {
      product_id: data.id,
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      qty_on_hand: 50,
    },
    { onConflict: 'product_id' },
  );
  return data.id;
}

async function createOrderWithLine(
  admin: Client,
  merchantAccountId: string,
  shopId: string,
  productId: string,
) {
  const { data: order, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      order_number: `GAP4GATE-${Date.now()}-${randomUUID().slice(0, 6)}`,
      total_amount: 10000,
      currency: 'XOF',
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
    })
    .select('id')
    .single();
  if (error || !order) throw error ?? new Error('order insert failed');
  const { error: lineError } = await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    order_id: order.id,
    product_id: productId,
    raw_title: 'Produit test',
    qty: 3,
    match_status: 'matched',
  });
  if (lineError) throw lineError;
  return order.id;
}

type TransitionArgs = Record<string, unknown>;
function transitionRpc(client: Client) {
  return client.rpc.bind(client) as unknown as (
    fn: 'transition_order',
    args: TransitionArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}
function reassignRpc(client: Client) {
  return client.rpc.bind(client) as unknown as (
    fn: 'reassign_order_driver',
    args: { p_order_id: string; p_actor: string; p_new_driver: string; p_note?: string },
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
}

async function movementIds(admin: Client, orderId: string) {
  const { data } = await admin.from('stock_movement').select('id').eq('order_id', orderId);
  return (data ?? []).map((r) => r.id).sort();
}

async function orderSnapshot(admin: Client, orderId: string) {
  const { data } = await admin
    .from('orders')
    .select('assigned_driver_id, delivery_state, order_state, call_state, cash_state')
    .eq('id', orderId)
    .single();
  return data;
}

async function scheduleOrder(agentClient: Client, agentUserId: string, orderId: string) {
  const r = await transitionRpc(agentClient)('transition_order', {
    p_order_id: orderId,
    p_actor: agentUserId,
    p_call_state: 'validated',
    p_cash_state: 'expected',
    p_delivery_state: 'scheduled',
  });
  if (r.error) throw r.error;
}

afterAll(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
  createdUserIds.length = 0;
});

describe('Gap 4 — transition_order (action assigner) : garde SQL incontournable', () => {
  skipIfNoServiceRole(
    'contrôle positif — livreur rattaché à la boutique de la commande → succès',
    async () => {
      const t = await createTenant('assign-positive');
      const agent = await addAgent(t.admin, t.merchantAccountId);
      const driver = await createDriver(t.admin, t.merchantAccountId, t.defaultShop);
      const product = await createProduct(t.admin, t.merchantAccountId, t.defaultShop);
      const orderId = await createOrderWithLine(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        product,
      );
      const agentClient = await signIn(agent.email);
      await scheduleOrder(agentClient, agent.userId, orderId);

      const before = await movementIds(t.admin, orderId);
      const r = await transitionRpc(agentClient)('transition_order', {
        p_order_id: orderId,
        p_actor: agent.userId,
        p_call_state: 'validated',
        p_cash_state: 'expected',
        p_delivery_state: 'assigned',
        p_assigned_driver_id: driver,
      });
      expect(r.error).toBeNull();
      const after = await movementIds(t.admin, orderId);
      expect(after.length).toBeGreaterThan(before.length);
      const snap = await orderSnapshot(t.admin, orderId);
      expect(snap?.assigned_driver_id).toBe(driver);
    },
  );

  skipIfNoServiceRole(
    'livreur rattaché à une AUTRE boutique du même tenant → refus, commande et stock_movement inchangés',
    async () => {
      const t = await createTenant('assign-other-shop');
      const agent = await addAgent(t.admin, t.merchantAccountId);
      const secondaryShop = await createSecondaryShop(t.admin, t.merchantAccountId);
      const foreignDriver = await createDriver(t.admin, t.merchantAccountId, secondaryShop);
      const product = await createProduct(t.admin, t.merchantAccountId, t.defaultShop);
      const orderId = await createOrderWithLine(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        product,
      );
      const agentClient = await signIn(agent.email);
      await scheduleOrder(agentClient, agent.userId, orderId);

      const before = await orderSnapshot(t.admin, orderId);
      const beforeMovements = await movementIds(t.admin, orderId);

      const r = await transitionRpc(agentClient)('transition_order', {
        p_order_id: orderId,
        p_actor: agent.userId,
        p_call_state: 'validated',
        p_cash_state: 'expected',
        p_delivery_state: 'assigned',
        p_assigned_driver_id: foreignDriver,
      });
      expect(r.error).not.toBeNull();
      expect(r.error?.message ?? '').toContain('driver_not_in_store');

      const after = await orderSnapshot(t.admin, orderId);
      expect(after).toEqual(before);
      const afterMovements = await movementIds(t.admin, orderId);
      expect(afterMovements).toEqual(beforeMovements);
    },
  );

  skipIfNoServiceRole(
    'livreur sans aucun rattachement driver_shop → refus, commande et stock_movement inchangés',
    async () => {
      const t = await createTenant('assign-orphan');
      const agent = await addAgent(t.admin, t.merchantAccountId);
      const orphanDriver = await createDriver(t.admin, t.merchantAccountId, null);
      const product = await createProduct(t.admin, t.merchantAccountId, t.defaultShop);
      const orderId = await createOrderWithLine(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        product,
      );
      const agentClient = await signIn(agent.email);
      await scheduleOrder(agentClient, agent.userId, orderId);

      const before = await orderSnapshot(t.admin, orderId);
      const beforeMovements = await movementIds(t.admin, orderId);

      const r = await transitionRpc(agentClient)('transition_order', {
        p_order_id: orderId,
        p_actor: agent.userId,
        p_call_state: 'validated',
        p_cash_state: 'expected',
        p_delivery_state: 'assigned',
        p_assigned_driver_id: orphanDriver,
      });
      expect(r.error).not.toBeNull();
      expect(r.error?.message ?? '').toContain('driver_not_in_store');

      const after = await orderSnapshot(t.admin, orderId);
      expect(after).toEqual(before);
      const afterMovements = await movementIds(t.admin, orderId);
      expect(afterMovements).toEqual(beforeMovements);
    },
  );
});

describe('Gap 4 — reassign_order_driver : le vrai trou (hors assigned/out_for_delivery)', () => {
  skipIfNoServiceRole(
    'contrôle positif — commande scheduled, nouveau livreur rattaché → succès',
    async () => {
      const t = await createTenant('reassign-positive');
      const driverA = await createDriver(t.admin, t.merchantAccountId, t.defaultShop);
      const driverB = await createDriver(t.admin, t.merchantAccountId, t.defaultShop);
      const product = await createProduct(t.admin, t.merchantAccountId, t.defaultShop);
      const orderId = await createOrderWithLine(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        product,
      );
      await t.admin
        .from('orders')
        .update({ delivery_state: 'scheduled', assigned_driver_id: driverA })
        .eq('id', orderId);

      const ownerClient = await signIn(t.email);
      const r = await reassignRpc(ownerClient)('reassign_order_driver', {
        p_order_id: orderId,
        p_actor: t.userId,
        p_new_driver: driverB,
      });
      expect(r.error).toBeNull();
      const snap = await orderSnapshot(t.admin, orderId);
      expect(snap?.assigned_driver_id).toBe(driverB);
    },
  );

  skipIfNoServiceRole(
    "commande scheduled, nouveau livreur d'une AUTRE boutique → refus, aucune mutation (le trou réel : aucun mouvement de stock ne peut protéger ce chemin)",
    async () => {
      const t = await createTenant('reassign-other-shop');
      const secondaryShop = await createSecondaryShop(t.admin, t.merchantAccountId);
      const driverA = await createDriver(t.admin, t.merchantAccountId, t.defaultShop);
      const foreignDriver = await createDriver(t.admin, t.merchantAccountId, secondaryShop);
      const product = await createProduct(t.admin, t.merchantAccountId, t.defaultShop);
      const orderId = await createOrderWithLine(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        product,
      );
      await t.admin
        .from('orders')
        .update({ delivery_state: 'scheduled', assigned_driver_id: driverA })
        .eq('id', orderId);

      const before = await orderSnapshot(t.admin, orderId);
      const beforeMovements = await movementIds(t.admin, orderId);

      const ownerClient = await signIn(t.email);
      const r = await reassignRpc(ownerClient)('reassign_order_driver', {
        p_order_id: orderId,
        p_actor: t.userId,
        p_new_driver: foreignDriver,
      });
      expect(r.error).not.toBeNull();
      expect(r.error?.message ?? '').toContain('driver_not_in_store');

      const after = await orderSnapshot(t.admin, orderId);
      expect(after).toEqual(before);
      const afterMovements = await movementIds(t.admin, orderId);
      expect(afterMovements).toEqual(beforeMovements);
    },
  );

  skipIfNoServiceRole(
    'commande scheduled, nouveau livreur SANS rattachement → refus, aucune mutation',
    async () => {
      const t = await createTenant('reassign-orphan');
      const driverA = await createDriver(t.admin, t.merchantAccountId, t.defaultShop);
      const orphanDriver = await createDriver(t.admin, t.merchantAccountId, null);
      const product = await createProduct(t.admin, t.merchantAccountId, t.defaultShop);
      const orderId = await createOrderWithLine(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        product,
      );
      await t.admin
        .from('orders')
        .update({ delivery_state: 'scheduled', assigned_driver_id: driverA })
        .eq('id', orderId);

      const before = await orderSnapshot(t.admin, orderId);
      const beforeMovements = await movementIds(t.admin, orderId);

      const ownerClient = await signIn(t.email);
      const r = await reassignRpc(ownerClient)('reassign_order_driver', {
        p_order_id: orderId,
        p_actor: t.userId,
        p_new_driver: orphanDriver,
      });
      expect(r.error).not.toBeNull();
      expect(r.error?.message ?? '').toContain('driver_not_in_store');

      const after = await orderSnapshot(t.admin, orderId);
      expect(after).toEqual(before);
      const afterMovements = await movementIds(t.admin, orderId);
      expect(afterMovements).toEqual(beforeMovements);
    },
  );
});

describe('Gap 4 — cycle COD complet sous JWT agent : inchangé (livreur éligible)', () => {
  skipIfNoServiceRole('réservation → release (annuler avant dispatch)', async () => {
    const t = await createTenant('cycle-release');
    const agent = await addAgent(t.admin, t.merchantAccountId);
    const product = await createProduct(t.admin, t.merchantAccountId, t.defaultShop);
    const orderId = await createOrderWithLine(t.admin, t.merchantAccountId, t.defaultShop, product);
    const agentClient = await signIn(agent.email);
    await scheduleOrder(agentClient, agent.userId, orderId);

    const ownerClient = await signIn(t.email);
    const r2 = await transitionRpc(ownerClient)('transition_order', {
      p_order_id: orderId,
      p_actor: t.userId,
      p_order_state: 'cancelled',
      p_delivery_state: 'unassigned',
      p_cash_state: 'not_due',
      p_cancel_reason: 'cancelled',
    });
    expect(r2.error).toBeNull();

    const { data: types } = await t.admin
      .from('stock_movement')
      .select('movement_type')
      .eq('order_id', orderId);
    expect((types ?? []).map((x) => x.movement_type).sort()).toEqual(['release', 'reserve']);
  });

  skipIfNoServiceRole('réservation/dispatch → livraison (assigner puis livrer)', async () => {
    const t = await createTenant('cycle-deliver');
    const agent = await addAgent(t.admin, t.merchantAccountId);
    const driver = await createDriver(t.admin, t.merchantAccountId, t.defaultShop);
    const product = await createProduct(t.admin, t.merchantAccountId, t.defaultShop);
    const orderId = await createOrderWithLine(t.admin, t.merchantAccountId, t.defaultShop, product);
    const agentClient = await signIn(agent.email);
    await scheduleOrder(agentClient, agent.userId, orderId);

    const r2 = await transitionRpc(agentClient)('transition_order', {
      p_order_id: orderId,
      p_actor: agent.userId,
      p_call_state: 'validated',
      p_cash_state: 'expected',
      p_delivery_state: 'assigned',
      p_assigned_driver_id: driver,
    });
    expect(r2.error).toBeNull();

    const ownerClient = await signIn(t.email);
    const r3 = await transitionRpc(ownerClient)('transition_order', {
      p_order_id: orderId,
      p_actor: t.userId,
      p_call_state: 'validated',
      p_cash_state: 'collected',
      p_delivery_state: 'delivered',
      p_order_state: 'completed',
      p_payment_channel: 'ESPECES',
    });
    expect(r3.error).toBeNull();

    const { data: types } = await t.admin
      .from('stock_movement')
      .select('movement_type')
      .eq('order_id', orderId);
    const kinds = (types ?? []).map((x) => x.movement_type).sort();
    expect(kinds).toContain('dispatch');
    expect(kinds).toContain('sold');
    expect(kinds).toContain('order_assignment_commit');
  });

  skipIfNoServiceRole('réservation/dispatch → invalidation', async () => {
    const t = await createTenant('cycle-invalidate');
    const agent = await addAgent(t.admin, t.merchantAccountId);
    const driver = await createDriver(t.admin, t.merchantAccountId, t.defaultShop);
    const product = await createProduct(t.admin, t.merchantAccountId, t.defaultShop);
    const orderId = await createOrderWithLine(t.admin, t.merchantAccountId, t.defaultShop, product);
    const agentClient = await signIn(agent.email);
    await scheduleOrder(agentClient, agent.userId, orderId);

    await transitionRpc(agentClient)('transition_order', {
      p_order_id: orderId,
      p_actor: agent.userId,
      p_call_state: 'validated',
      p_cash_state: 'expected',
      p_delivery_state: 'assigned',
      p_assigned_driver_id: driver,
    });

    const ownerClient = await signIn(t.email);
    const r3 = await transitionRpc(ownerClient)('transition_order', {
      p_order_id: orderId,
      p_actor: t.userId,
      p_call_state: 'validated',
      p_cash_state: 'collected',
      p_delivery_state: 'delivered',
      p_order_state: 'completed',
      p_payment_channel: 'ESPECES',
    });
    expect(r3.error).toBeNull();

    const r4 = await transitionRpc(ownerClient)('transition_order', {
      p_order_id: orderId,
      p_actor: t.userId,
      p_call_state: 'to_call',
      p_cash_state: 'not_due',
      p_clear_assigned_driver: true,
      p_clear_cancel_reasons: true,
      p_clear_scheduled_for: true,
      p_delivery_state: 'unassigned',
      p_order_state: 'open',
      p_invalidate_delivered: true,
    });
    expect(r4.error).toBeNull();

    const snap = await orderSnapshot(t.admin, orderId);
    expect(snap?.order_state).toBe('open');
    expect(snap?.delivery_state).toBe('unassigned');
    expect(snap?.assigned_driver_id).toBeNull();
  });
});
