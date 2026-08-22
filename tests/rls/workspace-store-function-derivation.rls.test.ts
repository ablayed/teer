/**
 * Migration 0131 — les 3 fonctions qui écrivaient sans `shop_id` dérivent désormais la
 * boutique du PARENT AUTORITAIRE, jamais de la boutique par défaut du marchand.
 *
 *   post_stock_movement   → stock_movement / product_stock   (parent = le PRODUIT)
 *   transition_order      → order_state_transition           (parent = la COMMANDE)
 *   reassign_order_driver → order_state_transition           (parent = la COMMANDE)
 *
 * Chaque scénario multi-boutiques exige DEUX choses, pas une : que la boutique écrite soit
 * bien la boutique du parent, ET qu'elle ne soit PAS la boutique par défaut. Sans la
 * seconde assertion, un tenant dont le parent vit dans la boutique par défaut rendrait le
 * test vert alors même que le repli du trigger serait encore aux commandes.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { callStockMovementEngine } from '@/tests/helpers/stock-movement-engine';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'store-derivation-rls-pw-0131';
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
  for (let i = 0; i < 20; i += 1) {
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

/** Seconde boutique, volontairement NON par défaut : c'est celle qui révèle le repli. */
async function createSecondaryShop(admin: Client, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `derivation-${Date.now()}-${randomUUID()}.internal`,
      access_token_encrypted: 'enc',
      scopes: 'read_orders',
    })
    .select('id, is_default')
    .single();
  if (error || !data) throw error ?? new Error('secondary shop insert failed');
  expect(data.is_default).toBe(false);
  return data.id;
}

async function createTenant(label: string) {
  const admin = adminClient();
  const email = `derivation-${label}-${Date.now()}-${randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  const defaultShop = await defaultShopId(admin, merchantAccountId);
  return { admin, email, userId, merchantAccountId, defaultShop };
}

async function createProduct(admin: Client, merchantAccountId: string, shopId: string | undefined) {
  const { data, error } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      title: `Prod-${Date.now()}-${randomUUID()}`,
      unit_cost: 5000,
      ...(shopId ? { shop_id: shopId } : {}),
    })
    .select('id, shop_id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return data;
}

// Gap 4 — `shopId` explicite : `driver_shop` (migration 0133) n'est plus une
// commodité, c'est l'ensemble que `reassign_order_driver`/`transition_order`
// interrogent (migration 0139) avant d'écrire `assigned_driver_id`. `null`
// crée volontairement un livreur SANS aucun rattachement.
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
    const { error: membershipError } = await admin
      .from('driver_shop')
      .insert({ merchant_account_id: merchantAccountId, shop_id: shopId, driver_id: data.id });
    if (membershipError) throw membershipError;
  }
  return data.id;
}

async function createOrder(admin: Client, merchantAccountId: string, shopId: string | undefined) {
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `DRV-${Date.now()}-${randomUUID().slice(0, 8)}`,
      total_amount: 10000,
      currency: 'XOF',
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      ...(shopId ? { shop_id: shopId } : {}),
    })
    .select('id, shop_id')
    .single();
  if (error || !data) throw error ?? new Error('order insert failed');
  return data;
}

type TransitionArgs = {
  p_order_id: string;
  p_actor: string;
  p_call_state?: string;
  p_delivery_state?: string;
  p_note?: string;
};

function transitionOrder(client: Client) {
  return client.rpc.bind(client) as unknown as (
    fn: 'transition_order',
    args: TransitionArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}

type ReassignArgs = {
  p_order_id: string;
  p_actor: string;
  p_new_driver: string;
  p_note?: string;
};

function reassignOrderDriver(client: Client) {
  return client.rpc.bind(client) as unknown as (
    fn: 'reassign_order_driver',
    args: ReassignArgs,
  ) => Promise<{ data: null; error: { message: string } | null }>;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
  createdUserIds.length = 0;
});

describe('0131 — post_stock_movement dérive la boutique du produit', () => {
  skipIfNoServiceRole(
    'un mouvement sur un produit de la boutique SECONDAIRE est attribué à cette boutique, pas à la boutique par défaut',
    async () => {
      const t = await createTenant('psm-secondary');
      const secondaryShop = await createSecondaryShop(t.admin, t.merchantAccountId);
      const product = await createProduct(t.admin, t.merchantAccountId, secondaryShop);
      expect(product.shop_id).toBe(secondaryShop);

      const key = `derivation-${randomUUID()}`;
      // 0136 : le cœur post_stock_movement vit dans `private`, non exposé par
      // PostgREST — connexion Postgres directe (identité simulée via JWT sub).
      const { data: movementId, error } = await callStockMovementEngine({
        p_merchant_account_id: t.merchantAccountId,
        p_product_id: product.id,
        p_movement_type: 'purchase_in',
        p_qty: 7,
        p_idempotency_key: key,
        p_created_by: t.userId,
      });
      expect(error).toBeNull();
      expect(movementId).toBeTruthy();

      const { data: movement } = await t.admin
        .from('stock_movement')
        .select('shop_id')
        .eq('id', movementId as string)
        .single();
      expect(movement?.shop_id).toBe(secondaryShop);
      expect(movement?.shop_id).not.toBe(t.defaultShop);

      // product_stock est créé paresseusement par la même fonction : il doit suivre le
      // MÊME parent, sinon le stock d'un produit vivrait dans une autre boutique que ses
      // mouvements.
      const { data: stock } = await t.admin
        .from('product_stock')
        .select('shop_id')
        .eq('product_id', product.id)
        .single();
      expect(stock?.shop_id).toBe(secondaryShop);
      expect(stock?.shop_id).not.toBe(t.defaultShop);
    },
  );

  skipIfNoServiceRole(
    'non-régression mono-boutique : le mouvement reste attribué à la boutique par défaut',
    async () => {
      const t = await createTenant('psm-mono');
      const product = await createProduct(t.admin, t.merchantAccountId, undefined);
      expect(product.shop_id).toBe(t.defaultShop);

      // 0136 : cœur post_stock_movement dans `private` — connexion Postgres directe.
      const { data: movementId, error } = await callStockMovementEngine({
        p_merchant_account_id: t.merchantAccountId,
        p_product_id: product.id,
        p_movement_type: 'purchase_in',
        p_qty: 4,
        p_idempotency_key: `derivation-${randomUUID()}`,
        p_created_by: t.userId,
      });
      expect(error).toBeNull();

      const { data: movement } = await t.admin
        .from('stock_movement')
        .select('shop_id')
        .eq('id', movementId as string)
        .single();
      expect(movement?.shop_id).toBe(t.defaultShop);
    },
  );

  skipIfNoServiceRole(
    'un produit ne peut pas être rattaché à la boutique d’un AUTRE marchand, même en service-role',
    async () => {
      const t = await createTenant('psm-conflict');
      const other = await createTenant('psm-conflict-other');
      const product = await createProduct(t.admin, t.merchantAccountId, undefined);

      // La garde `stock_movement_store_conflict` posée par 0131 dans post_stock_movement est
      // une défense en profondeur STRUCTURELLEMENT INATTEIGNABLE : `product.shop_id` est NOT
      // NULL et la FK composite `product_shop_tenant_fk (merchant_account_id, shop_id)`
      // interdit déjà de pointer vers la boutique d'un autre tenant, tandis que le trigger
      // `prevent_store_context_change` interdit d'en changer après coup. Ce test vérifie donc
      // la garantie RÉELLE — la base refuse la fabrication — plutôt que de simuler un état
      // que la production ne peut pas atteindre.
      const { error: updateError } = await t.admin
        .from('product')
        .update({ shop_id: other.defaultShop })
        .eq('id', product.id);
      expect(updateError).not.toBeNull();
      expect(updateError?.message ?? '').toContain('store_context_immutable');

      const { data: unchanged } = await t.admin
        .from('product')
        .select('shop_id')
        .eq('id', product.id)
        .single();
      expect(unchanged?.shop_id).toBe(t.defaultShop);
      expect(unchanged?.shop_id).not.toBe(other.defaultShop);
    },
  );

  skipIfNoServiceRole('la garde de rôle reste active pour un non-membre', async () => {
    const t = await createTenant('psm-rbac');
    const outsider = await createTenant('psm-rbac-outsider');
    const product = await createProduct(t.admin, t.merchantAccountId, undefined);

    // 0136 : cœur post_stock_movement dans `private` — connexion Postgres directe,
    // identité "outsider" simulée via JWT sub, guard testé côté cœur (current_member_role).
    const { error } = await callStockMovementEngine({
      p_merchant_account_id: t.merchantAccountId,
      p_product_id: product.id,
      p_movement_type: 'purchase_in',
      p_qty: 1,
      p_idempotency_key: `derivation-${randomUUID()}`,
      p_created_by: outsider.userId,
    });
    expect(error?.message ?? '').toContain('forbidden');
  });
});

describe('0131 — transition_order dérive la boutique de la commande', () => {
  skipIfNoServiceRole(
    'la transition d’une commande de la boutique SECONDAIRE est historisée dans cette boutique',
    async () => {
      const t = await createTenant('tro-secondary');
      const secondaryShop = await createSecondaryShop(t.admin, t.merchantAccountId);
      const order = await createOrder(t.admin, t.merchantAccountId, secondaryShop);
      expect(order.shop_id).toBe(secondaryShop);

      const client = await signIn(t.email);
      const { error } = await transitionOrder(client)('transition_order', {
        p_order_id: order.id,
        p_actor: t.userId,
        p_call_state: 'validated',
        p_note: 'derivation',
      });
      expect(error).toBeNull();

      const { data: transitions } = await t.admin
        .from('order_state_transition')
        .select('shop_id')
        .eq('order_id', order.id);
      expect(transitions?.length ?? 0).toBeGreaterThan(0);
      for (const transition of transitions ?? []) {
        expect(transition.shop_id).toBe(secondaryShop);
        expect(transition.shop_id).not.toBe(t.defaultShop);
      }
    },
  );

  skipIfNoServiceRole(
    'non-régression mono-boutique : la transition reste dans la boutique par défaut',
    async () => {
      const t = await createTenant('tro-mono');
      const order = await createOrder(t.admin, t.merchantAccountId, undefined);

      const client = await signIn(t.email);
      const { error } = await transitionOrder(client)('transition_order', {
        p_order_id: order.id,
        p_actor: t.userId,
        p_call_state: 'validated',
      });
      expect(error).toBeNull();

      const { data: transitions } = await t.admin
        .from('order_state_transition')
        .select('shop_id')
        .eq('order_id', order.id);
      expect(transitions?.length ?? 0).toBeGreaterThan(0);
      for (const transition of transitions ?? []) {
        expect(transition.shop_id).toBe(t.defaultShop);
      }
    },
  );

  skipIfNoServiceRole(
    'une commande ne peut pas être rattachée à la boutique d’un autre marchand, même en service-role',
    async () => {
      const t = await createTenant('tro-conflict');
      const other = await createTenant('tro-conflict-other');
      const order = await createOrder(t.admin, t.merchantAccountId, undefined);

      // Même raisonnement que pour le produit : la garde `order_store_conflict` de 0131 est
      // une défense en profondeur inatteignable derrière `orders_shop_tenant_fk` et
      // `prevent_store_context_change`. C'est ce refus-là qui protège réellement le tenant.
      const { error: updateError } = await t.admin
        .from('orders')
        .update({ shop_id: other.defaultShop })
        .eq('id', order.id);
      expect(updateError).not.toBeNull();
      expect(updateError?.message ?? '').toContain('store_context_immutable');

      const { data: unchanged } = await t.admin
        .from('orders')
        .select('shop_id')
        .eq('id', order.id)
        .single();
      expect(unchanged?.shop_id).toBe(t.defaultShop);
      expect(unchanged?.shop_id).not.toBe(other.defaultShop);
    },
  );
});

describe('0131 — reassign_order_driver dérive la boutique de la commande', () => {
  skipIfNoServiceRole(
    'la réassignation d’une commande de la boutique SECONDAIRE, par un livreur qui la sert, est historisée dans cette boutique',
    async () => {
      const t = await createTenant('rod-secondary');
      const secondaryShop = await createSecondaryShop(t.admin, t.merchantAccountId);
      const order = await createOrder(t.admin, t.merchantAccountId, secondaryShop);
      // Gap 4 (migration 0139) : les deux livreurs doivent être rattachés à LA
      // boutique de la commande pour que la réassignation soit légale — sans quoi
      // ce test prouverait l'inverse de l'invariant qu'il vise à démontrer (cf.
      // le test-sœur ci-dessous, qui couvre le refus).
      const firstDriver = await createDriver(t.admin, t.merchantAccountId, secondaryShop);
      const secondDriver = await createDriver(t.admin, t.merchantAccountId, secondaryShop);

      // `scheduled` suffit à rendre la réassignation légale sans exiger de mouvement de
      // stock sortant (aucune ligne dispatched), ce qui garde le test focalisé sur
      // l'attribution de boutique.
      await t.admin
        .from('orders')
        .update({ delivery_state: 'scheduled', assigned_driver_id: firstDriver })
        .eq('id', order.id);

      const client = await signIn(t.email);
      const { error } = await reassignOrderDriver(client)('reassign_order_driver', {
        p_order_id: order.id,
        p_actor: t.userId,
        p_new_driver: secondDriver,
      });
      expect(error).toBeNull();

      const { data: transitions } = await t.admin
        .from('order_state_transition')
        .select('shop_id, note')
        .eq('order_id', order.id);
      expect(transitions?.length ?? 0).toBeGreaterThan(0);
      for (const transition of transitions ?? []) {
        expect(transition.shop_id).toBe(secondaryShop);
        expect(transition.shop_id).not.toBe(t.defaultShop);
      }
    },
  );

  // Gap 4 (migration 0139) — le cas que ce fichier prouvait par erreur avant ce lot :
  // un livreur SANS AUCUN rattachement `driver_shop` ne peut plus être réassigné à
  // AUCUNE commande, y compris une commande `scheduled` (hors assigned/out_for_delivery),
  // où AUCUN mouvement de stock n'est posté et où la seule protection incidente
  // (post_stock_movement) ne s'exécute donc jamais.
  skipIfNoServiceRole(
    'un livreur sans aucun rattachement driver_shop est refusé, même sur une commande scheduled',
    async () => {
      const t = await createTenant('rod-orphan');
      const secondaryShop = await createSecondaryShop(t.admin, t.merchantAccountId);
      const order = await createOrder(t.admin, t.merchantAccountId, secondaryShop);
      const firstDriver = await createDriver(t.admin, t.merchantAccountId, secondaryShop);
      const orphanDriver = await createDriver(t.admin, t.merchantAccountId, null);

      await t.admin
        .from('orders')
        .update({ delivery_state: 'scheduled', assigned_driver_id: firstDriver })
        .eq('id', order.id);

      const { data: movementsBefore } = await t.admin
        .from('stock_movement')
        .select('id')
        .eq('order_id', order.id);

      const client = await signIn(t.email);
      const { error } = await reassignOrderDriver(client)('reassign_order_driver', {
        p_order_id: order.id,
        p_actor: t.userId,
        p_new_driver: orphanDriver,
      });
      expect(error).not.toBeNull();
      expect(error?.message ?? '').toContain('driver_not_in_store');

      const { data: unchanged } = await t.admin
        .from('orders')
        .select('assigned_driver_id, delivery_state')
        .eq('id', order.id)
        .single();
      expect(unchanged?.assigned_driver_id).toBe(firstDriver);
      expect(unchanged?.delivery_state).toBe('scheduled');

      const { data: movementsAfter } = await t.admin
        .from('stock_movement')
        .select('id')
        .eq('order_id', order.id);
      expect((movementsAfter ?? []).map((m) => m.id).sort()).toEqual(
        (movementsBefore ?? []).map((m) => m.id).sort(),
      );
    },
  );
});
