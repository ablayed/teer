import { randomUUID } from 'node:crypto';
import { type ShopifyOrderNode, persistShopifyOrder } from '@/lib/shopify/orders-sync';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// 0165 — import Shopify : commande et lignes écrites ensemble, lignes manquantes réparables.
//
// Contrat verrouillé ici, par le VRAI `persistShopifyOrder` contre le vrai PostgREST :
//   1. une commande n'est jamais créée sans ses lignes : si les lignes ne s'écrivent pas, rien
//      n'est écrit, et le réimport la reprend en entier ;
//   2. une commande présente et sans lignes est réparée par un réimport de la MÊME charge
//      (même `updatedAt`), que la garde de date écartait auparavant ;
//   3. la réparation n'écrit que des lignes : aucun mouvement de stock, aucune ligne en double,
//      et elle est refusée dès qu'une transition a pu toucher au stock.
//
// Mutations attendues, chacune devant rougir un test nommé ci-dessous :
//   * rendre « stale » avant de regarder les lignes        → « réimport réparateur » ;
//   * retirer la garde d'état de repair_shopify_order_lines → « commande confirmée » ;
//   * retirer la garde « déjà des lignes »                  → « rejouer la réparation ».

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'shopify-order-atomic-lines-pw';
const createdUserIds: string[] = [];
const run = serviceRoleKey ? it : it.skip;

type AdminClient = SupabaseClient<Database>;
type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
const rpc = (client: AdminClient) => client.rpc.bind(client) as unknown as Rpc;

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function fixture() {
  const admin = adminClient();
  const email = `atomic-lines-${Date.now()}-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
  });
  if (error || !data.user) throw error ?? new Error('user');
  createdUserIds.push(data.user.id);
  let merchantAccountId = '';
  for (let i = 0; i < 30 && !merchantAccountId; i++) {
    const account = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', data.user.id)
      .maybeSingle();
    merchantAccountId = account.data?.id ?? '';
    if (!merchantAccountId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Boutique Shopify distincte de la boutique par défaut du compte : une ligne qui hériterait
  // de la boutique par défaut, et non de celle de sa commande, se verrait ici.
  const shop = await admin
    .from('shop')
    .insert({
      access_token_encrypted: 'dummy',
      merchant_account_id: merchantAccountId,
      scopes: 'read_orders',
      shop_domain: `atomic-lines-${Date.now()}-${randomUUID()}.myshopify.com`,
      status: 'active',
    })
    .select('id')
    .single();
  if (shop.error || !shop.data) throw shop.error ?? new Error('shop');
  const variantId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const product = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shop.data.id,
      shopify_variant_id: variantId,
      title: 'Produit rapproché',
      unit_cost: 100,
    })
    .select('id')
    .single();
  if (product.error || !product.data) throw product.error ?? new Error('product');
  // Un produit du MÊME compte, dans son autre boutique (la boutique par défaut).
  const defaultShop = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('is_default', true)
    .single();
  if (defaultShop.error || !defaultShop.data) throw defaultShop.error ?? new Error('default shop');
  const elsewhere = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: defaultShop.data.id,
      title: 'Produit de l autre boutique',
      unit_cost: 100,
    })
    .select('id')
    .single();
  if (elsewhere.error || !elsewhere.data) throw elsewhere.error ?? new Error('product elsewhere');
  return {
    otherShopProductId: elsewhere.data.id,
    admin,
    email,
    merchantAccountId,
    productId: product.data.id,
    shopId: shop.data.id,
    variantId,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function orderNode(f: Fixture, shopifyOrderId: string, quantity = 2): ShopifyOrderNode {
  const line = (title: string, qty: number, variant: string | null) => ({
    node: {
      customAttributes: null,
      originalUnitPriceSet: { shopMoney: { amount: '5000' } },
      product: null,
      quantity: qty,
      sku: null,
      title,
      variant: variant ? { id: `gid://shopify/ProductVariant/${variant}` } : null,
    },
  });
  return {
    cancelledAt: null,
    createdAt: '2026-08-01T00:00:00Z',
    currentTotalPriceSet: { shopMoney: { amount: '15000', currencyCode: 'XOF' } },
    customAttributes: null,
    customer: null,
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    id: `gid://shopify/Order/${shopifyOrderId}`,
    lineItems: {
      edges: [line('Produit rapproché', quantity, f.variantId), line('Article inconnu', 1, null)],
    },
    name: `#${shopifyOrderId}`,
    note: null,
    shippingAddress: null,
    updatedAt: '2026-08-01T00:00:00Z',
  } as ShopifyOrderNode;
}

const persist = (f: Fixture, node: ShopifyOrderNode) =>
  persistShopifyOrder({
    merchantAccountId: f.merchantAccountId,
    orderNode: node,
    shopId: f.shopId,
    supabaseServiceClient: f.admin,
  });

async function state(f: Fixture, shopifyOrderId: string) {
  const orders = await f.admin
    .from('orders')
    .select('id, shopify_updated_at, updated_at, total_amount')
    .eq('shop_id', f.shopId)
    .eq('shopify_order_id', shopifyOrderId);
  if (orders.error) throw orders.error;
  const order = orders.data?.[0] ?? null;
  if (!order) return { lines: [], movements: 0, order: null, orders: orders.data?.length ?? 0 };
  const lines = await f.admin
    .from('order_line')
    .select('product_id, qty, match_status, shop_id, raw_title')
    .eq('order_id', order.id)
    .order('raw_title');
  if (lines.error) throw lines.error;
  const movements = await f.admin
    .from('stock_movement')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', order.id);
  if (movements.error) throw movements.error;
  return {
    lines: lines.data ?? [],
    movements: movements.count ?? 0,
    order,
    orders: orders.data?.length ?? 0,
  };
}

/** Reproduit l'état laissé par l'ancien import : l'en-tête existe, les lignes n'ont jamais été écrites. */
async function dropLines(f: Fixture, orderId: string) {
  const { error } = await f.admin.from('order_line').delete().eq('order_id', orderId);
  if (error) throw error;
}

const EXPECTED_LINES = (f: Fixture) => [
  {
    match_status: 'unresolved',
    product_id: null,
    qty: 1,
    raw_title: 'Article inconnu',
    shop_id: f.shopId,
  },
  {
    match_status: 'matched',
    product_id: f.productId,
    qty: 2,
    raw_title: 'Produit rapproché',
    shop_id: f.shopId,
  },
];

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  await Promise.all(createdUserIds.splice(0).map((id) => admin.auth.admin.deleteUser(id)));
});

describe('0165 — import Shopify : commande et lignes atomiques', () => {
  run(
    'création : la commande et ses lignes sont écrites ensemble, dans la boutique de la commande',
    async () => {
      const f = await fixture();
      const id = `${Date.now()}1`;

      expect(await persist(f, orderNode(f, id))).toEqual({ ok: true });

      const after = await state(f, id);
      expect(after.orders).toBe(1);
      expect(after.lines).toEqual(EXPECTED_LINES(f));
      expect(after.movements).toBe(0);
    },
  );

  run(
    'échec d écriture des lignes : aucune commande n est créée, et le réimport l importe entière',
    async () => {
      const f = await fixture();
      const id = `${Date.now()}2`;

      // Échec simulé : une quantité non entière fait échouer l'écriture de la ligne.
      const failed = await persist(f, orderNode(f, id, 1.5));
      expect(failed.ok).toBe(false);
      expect(failed.error).toContain('invalid_shopify_order_line');
      expect((await state(f, id)).orders).toBe(0);

      // Même commande, même `updatedAt` : aucune garde de date ne l'écarte, elle n'existe pas.
      expect(await persist(f, orderNode(f, id))).toEqual({ ok: true });
      const after = await state(f, id);
      expect(after.orders).toBe(1);
      expect(after.lines).toEqual(EXPECTED_LINES(f));
    },
  );

  run(
    'réimport réparateur : commande présente sans lignes, même updatedAt → lignes reconstruites, rien d autre',
    async () => {
      const f = await fixture();
      const id = `${Date.now()}3`;
      expect(await persist(f, orderNode(f, id))).toEqual({ ok: true });
      const created = await state(f, id);
      if (!created.order) throw new Error('order');
      await dropLines(f, created.order.id);
      expect((await state(f, id)).lines).toEqual([]);

      expect(await persist(f, orderNode(f, id))).toEqual({
        lines: 'repaired',
        ok: true,
        skipped: 'stale',
      });

      const repaired = await state(f, id);
      expect(repaired.lines).toEqual(EXPECTED_LINES(f));
      // Seules des lignes ont été écrites : ni la commande, ni le stock.
      expect(repaired.order).toEqual(created.order);
      expect(repaired.movements).toBe(0);
      const stock = await f.admin
        .from('product_stock')
        .select('qty_on_hand, qty_reserved')
        .eq('product_id', f.productId);
      for (const row of stock.data ?? []) {
        expect(row.qty_reserved).toBe(0);
      }
    },
  );

  run(
    'rejouer la réparation, seule ou en concurrence, n ajoute aucune ligne ni aucun mouvement',
    async () => {
      const f = await fixture();
      const id = `${Date.now()}4`;
      expect(await persist(f, orderNode(f, id))).toEqual({ ok: true });
      const created = await state(f, id);
      if (!created.order) throw new Error('order');
      await dropLines(f, created.order.id);

      // Deux réimports simultanés de la même charge.
      const results = await Promise.all([
        persist(f, orderNode(f, id)),
        persist(f, orderNode(f, id)),
      ]);
      for (const result of results) expect(result.ok).toBe(true);
      expect((await state(f, id)).lines).toEqual(EXPECTED_LINES(f));

      // Passage suivant : la commande porte ses lignes, la garde de date l'écarte de nouveau.
      expect(await persist(f, orderNode(f, id))).toEqual({ ok: true, skipped: 'stale' });

      // Appel direct de la primitive sur une commande qui porte déjà ses lignes : 0, sans effet.
      const direct = await rpc(f.admin)('repair_shopify_order_lines', {
        p_lines: [{ match_status: 'unresolved', quantity: 9, raw_title: 'Ligne en trop' }],
        p_order_id: created.order.id,
      });
      expect(direct.error).toBeNull();
      expect(direct.data).toBe(0);

      const after = await state(f, id);
      expect(after.lines).toEqual(EXPECTED_LINES(f));
      expect(after.movements).toBe(0);
    },
  );

  const lockedStates = [
    ['confirmée', { call_state: 'validated' }],
    ['assignée', { call_state: 'validated', cash_state: 'expected', delivery_state: 'assigned' }],
    ['annulée', { order_state: 'cancelled' }],
    ['au panier modifié localement', { cart_locally_modified_at: '2026-08-02T00:00:00Z' }],
  ] as const;

  run.each(lockedStates)(
    'commande %s sans lignes : le réimport ne lui écrit aucune ligne et la signale',
    async (_label, patch) => {
      const f = await fixture();
      const id = `${Date.now()}5`;
      expect(await persist(f, orderNode(f, id))).toEqual({ ok: true });
      const created = await state(f, id);
      if (!created.order) throw new Error('order');
      await dropLines(f, created.order.id);
      // Une commande assignée porte un livreur (contrainte de la table).
      let driverPatch = {};
      if ('delivery_state' in patch) {
        const driver = await f.admin
          .from('driver')
          .insert({
            full_name: 'Livreur',
            merchant_account_id: f.merchantAccountId,
            phone: `+22177${String(Date.now()).slice(-7)}`,
          })
          .select('id')
          .single();
        if (driver.error || !driver.data) throw driver.error ?? new Error('driver');
        driverPatch = { assigned_driver_id: driver.data.id };
      }
      const moved = await f.admin
        .from('orders')
        .update({ ...patch, ...driverPatch })
        .eq('id', created.order.id);
      expect(moved.error).toBeNull();

      // Ni échec (le curseur de réconciliation serait bloqué), ni réparation.
      expect(await persist(f, orderNode(f, id))).toEqual({
        lines: 'missing',
        ok: true,
        skipped: 'stale',
      });
      const after = await state(f, id);
      expect(after.lines).toEqual([]);
      expect(after.movements).toBe(0);

      // La primitive refuse d'elle-même, sous verrou : la garde ne repose pas sur l'appelant.
      const direct = await rpc(f.admin)('repair_shopify_order_lines', {
        p_lines: [{ match_status: 'unresolved', quantity: 1, raw_title: 'Ligne' }],
        p_order_id: created.order.id,
      });
      expect(direct.error).toMatchObject({
        code: '22023',
        message: 'shopify_order_lines_not_repairable',
      });
      expect((await state(f, id)).lines).toEqual([]);
    },
  );

  run('une charge plus ancienne ne répare rien : la garde hors-ordre tient', async () => {
    const f = await fixture();
    const id = `${Date.now()}6`;
    expect(await persist(f, orderNode(f, id))).toEqual({ ok: true });
    const created = await state(f, id);
    if (!created.order) throw new Error('order');
    await dropLines(f, created.order.id);

    const older = { ...orderNode(f, id), updatedAt: '2026-07-01T00:00:00Z' };
    expect(await persist(f, older)).toEqual({ lines: 'missing', ok: true, skipped: 'stale' });
    expect((await state(f, id)).lines).toEqual([]);
  });

  run(
    'une ligne rapprochée à un produit d une autre boutique du même compte est refusée, et rien n est écrit',
    async () => {
      const f = await fixture();
      const created = await rpc(f.admin)('create_shopify_order_with_lines', {
        p_lines: [
          {
            match_status: 'matched',
            product_id: f.otherShopProductId,
            quantity: 1,
            raw_title: 'Produit étranger',
          },
        ],
        p_order: {
          call_state: 'to_call',
          cash_state: 'not_due',
          created_at_shopify: '2026-08-01T00:00:00Z',
          currency: 'XOF',
          customer_id: null,
          delivery_state: 'unassigned',
          financial_status: 'PENDING',
          fulfillment_status: 'UNFULFILLED',
          items_summary: [{ quantity: 1, title: 'Produit étranger' }],
          merchant_account_id: f.merchantAccountId,
          order_number: '#X',
          order_state: 'open',
          shipping_address: null,
          shop_id: f.shopId,
          shopify_cancelled_at: null,
          shopify_financial_status: 'PENDING',
          shopify_fulfillment_status: 'UNFULFILLED',
          shopify_line_item_attributes: null,
          shopify_order_attributes: null,
          shopify_order_id: '777',
          shopify_updated_at: '2026-08-01T00:00:00Z',
          total_amount: 5000,
        },
      });
      expect(created.error).toMatchObject({ code: '22023', message: 'invalid_shopify_order_line' });
      expect((await state(f, '777')).orders).toBe(0);
    },
  );

  run('les deux primitives ne sont exécutables que par le rôle de service', async () => {
    const f = await fixture();
    const anon = createClient<Database>(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const session = createClient<Database>(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signedIn = await session.auth.signInWithPassword({ email: f.email, password });
    expect(signedIn.error).toBeNull();

    for (const client of [anon, session]) {
      const repair = await rpc(client)('repair_shopify_order_lines', {
        p_lines: [],
        p_order_id: randomUUID(),
      });
      expect(repair.error?.code).toBe('42501');
      const create = await rpc(client)('create_shopify_order_with_lines', {
        p_lines: [],
        p_order: {},
      });
      expect(create.error?.code).toBe('42501');
    }
  });
});
