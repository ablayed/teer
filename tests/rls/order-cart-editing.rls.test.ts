import { type ShopifyOrderNode, persistShopifyOrder } from '@/lib/shopify/orders-sync';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'order-cart-rls-test-password';
const createdUserIds: string[] = [];
const skipIfNoServiceRole = serviceRoleKey ? it : it.skip;

type AdminClient = SupabaseClient<Database>;

type ReplaceShopifyOrderCartArgs = {
  p_order_id: string;
  p_lines: Array<{
    match_status: 'ambiguous' | 'matched' | 'unresolved';
    product_id: string | null;
    quantity: number;
    raw_shopify_product_id: string | null;
    raw_shopify_variant_id: string | null;
    raw_sku: string | null;
    raw_title: string;
  }>;
  p_order_update: Record<string, unknown>;
};

function replaceShopifyOrderCartRpc(client: { rpc: SupabaseClient<Database>['rpc'] }) {
  return client.rpc.bind(client) as unknown as (
    fn: 'replace_shopify_order_cart',
    args: ReplaceShopifyOrderCartArgs,
  ) => Promise<{ data: null; error: { message: string } | null }>;
}

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createUser(admin: AdminClient, email: string) {
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
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .maybeSingle();
    if (data?.id) return data.id;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('merchant_account not found');
}

async function signIn(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  await Promise.all(createdUserIds.splice(0).map((id) => admin.auth.admin.deleteUser(id)));
});

describe('replace_order_cart — accès et atomicité', () => {
  skipIfNoServiceRole(
    'manager remplace le panier; agent et commande assignée sont refusés',
    async () => {
      const admin = adminClient();
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const ownerEmail = `cart-owner-${suffix}@example.com`;
      const ownerId = await createUser(admin, ownerEmail);
      const merchantAccountId = await waitForMerchantAccount(admin, ownerId);

      const managerEmail = `cart-manager-${suffix}@example.com`;
      const managerId = await createUser(admin, managerEmail);
      const agentEmail = `cart-agent-${suffix}@example.com`;
      const agentId = await createUser(admin, agentEmail);
      await admin.from('merchant_account').delete().in('owner_user_id', [managerId, agentId]);
      await admin.from('merchant_member').insert([
        { merchant_account_id: merchantAccountId, role: 'manager', user_id: managerId },
        { merchant_account_id: merchantAccountId, role: 'agent', user_id: agentId },
      ]);

      const { data: product, error: productError } = await admin
        .from('product')
        .insert({
          merchant_account_id: merchantAccountId,
          title: 'Produit panier RLS',
          unit_cost: 100,
        })
        .select('id')
        .single();
      if (productError || !product) throw productError ?? new Error('product not created');

      const { data: driver, error: driverError } = await admin
        .from('driver')
        .insert({
          merchant_account_id: merchantAccountId,
          full_name: 'Livreur panier RLS',
          phone: '+221770000000',
        })
        .select('id')
        .single();
      if (driverError || !driver) throw driverError ?? new Error('driver not created');

      const { data: order, error: orderError } = await admin
        .from('orders')
        .insert({
          merchant_account_id: merchantAccountId,
          order_number: `CART-RLS-${suffix}`,
          total_amount: 100,
          currency: 'XOF',
          order_state: 'open',
          call_state: 'to_call',
          delivery_state: 'unassigned',
          cash_state: 'not_due',
          items_summary: [{ title: 'Ancien produit', quantity: 1, price: 100 }],
        })
        .select('id')
        .single();
      if (orderError || !order) throw orderError ?? new Error('order not created');

      const manager = await signIn(managerEmail);
      const managerUpdate = await manager.rpc('replace_order_cart', {
        p_order_id: order.id,
        p_lines: [{ product_id: product.id, quantity: 2, unit_price: 120 }],
      });
      expect(managerUpdate.error).toBeNull();

      const { data: updated } = await admin
        .from('orders')
        .select('total_amount, cash_collectable_minor, cart_locally_modified_at')
        .eq('id', order.id)
        .single();
      expect(updated).toMatchObject({ total_amount: 240, cash_collectable_minor: 240 });
      expect(updated?.cart_locally_modified_at).toBeTruthy();

      const { data: lines } = await admin
        .from('order_line')
        .select('product_id, qty, match_status')
        .eq('order_id', order.id);
      expect(lines).toEqual([{ product_id: product.id, qty: 2, match_status: 'matched' }]);

      const agent = await signIn(agentEmail);
      const agentUpdate = await agent.rpc('replace_order_cart', {
        p_order_id: order.id,
        p_lines: [{ product_id: product.id, quantity: 1, unit_price: 10 }],
      });
      expect(agentUpdate.error).not.toBeNull();

      const assignment = await admin
        .from('orders')
        .update({ assigned_driver_id: driver.id, delivery_state: 'assigned' })
        .eq('id', order.id)
        .select('delivery_state')
        .single();
      expect(assignment.error).toBeNull();
      expect(assignment.data?.delivery_state).toBe('assigned');
      const afterAssignment = await manager.rpc('replace_order_cart', {
        p_order_id: order.id,
        p_lines: [{ product_id: product.id, quantity: 1, unit_price: 10 }],
      });
      expect(afterAssignment.error).not.toBeNull();

      const { data: shopifyOrder, error: shopifyOrderError } = await admin
        .from('orders')
        .insert({
          merchant_account_id: merchantAccountId,
          order_number: `SHOPIFY-CART-RLS-${suffix}`,
          total_amount: 100,
          currency: 'XOF',
          order_state: 'open',
          call_state: 'to_call',
          delivery_state: 'unassigned',
          cash_state: 'not_due',
          items_summary: [{ title: 'Ancien produit Shopify', quantity: 1, price: 100 }],
          source: 'shopify',
        })
        .select('id')
        .single();
      if (shopifyOrderError || !shopifyOrder) {
        throw shopifyOrderError ?? new Error('shopify order not created');
      }

      const { error: oldLineError } = await admin.from('order_line').insert({
        merchant_account_id: merchantAccountId,
        order_id: shopifyOrder.id,
        product_id: product.id,
        raw_title: 'Ancien produit Shopify',
        qty: 1,
        match_status: 'matched',
      });
      if (oldLineError) throw oldLineError;

      const shopifyUpdate = {
        order_number: `SHOPIFY-CART-RLS-${suffix}-UPDATED`,
        total_amount: 240,
        currency: 'XOF',
        financial_status: 'PENDING',
        fulfillment_status: 'UNFULFILLED',
        shopify_financial_status: 'PENDING',
        shopify_fulfillment_status: 'UNFULFILLED',
        shopify_cancelled_at: null,
        shopify_updated_at: '2026-07-21T10:00:00Z',
        items_summary: [
          {
            title: 'Produit Shopify resolu',
            sku: 'SHOPIFY-RLS-1',
            quantity: 2,
            price: 120,
            shopify_variant_id: '444',
            shopify_product_id: '333',
          },
          { title: 'Produit Shopify inconnu', sku: 'UNKNOWN', quantity: 1, price: 50 },
        ],
        shipping_address: null,
        customer_id: null,
        created_at_shopify: '2026-07-21T09:00:00Z',
        shopify_order_attributes: null,
        shopify_line_item_attributes: null,
      };
      const shopifyLines = [
        {
          product_id: product.id,
          raw_title: 'Produit Shopify resolu',
          raw_sku: 'SHOPIFY-RLS-1',
          raw_shopify_variant_id: '444',
          raw_shopify_product_id: '333',
          quantity: 2,
          match_status: 'matched' as const,
        },
        {
          product_id: null,
          raw_title: 'Produit Shopify inconnu',
          raw_sku: 'UNKNOWN',
          raw_shopify_variant_id: null,
          raw_shopify_product_id: null,
          quantity: 1,
          match_status: 'unresolved' as const,
        },
      ];

      const serviceUpdate = await replaceShopifyOrderCartRpc(admin)('replace_shopify_order_cart', {
        p_order_id: shopifyOrder.id,
        p_lines: shopifyLines,
        p_order_update: shopifyUpdate,
      });
      expect(serviceUpdate.error).toBeNull();

      const { data: shopifyUpdated } = await admin
        .from('orders')
        .select('items_summary, total_amount, cash_collectable_minor, cart_locally_modified_at')
        .eq('id', shopifyOrder.id)
        .single();
      expect(shopifyUpdated).toMatchObject({
        total_amount: 240,
        cash_collectable_minor: 240,
        cart_locally_modified_at: null,
      });
      expect(shopifyUpdated?.items_summary).toEqual(shopifyUpdate.items_summary);

      const { data: shopifyLinesAfterUpdate } = await admin
        .from('order_line')
        .select('product_id, qty, match_status')
        .eq('order_id', shopifyOrder.id)
        .order('created_at');
      expect(shopifyLinesAfterUpdate).toEqual([
        { product_id: product.id, qty: 2, match_status: 'matched' },
        { product_id: null, qty: 1, match_status: 'unresolved' },
      ]);

      const authenticatedShopifyUpdate = await replaceShopifyOrderCartRpc(manager)(
        'replace_shopify_order_cart',
        { p_order_id: shopifyOrder.id, p_lines: shopifyLines, p_order_update: shopifyUpdate },
      );
      expect(authenticatedShopifyUpdate.error).not.toBeNull();

      await admin
        .from('orders')
        .update({ assigned_driver_id: driver.id, delivery_state: 'assigned' })
        .eq('id', shopifyOrder.id);
      const assignedShopifyUpdate = await replaceShopifyOrderCartRpc(admin)(
        'replace_shopify_order_cart',
        { p_order_id: shopifyOrder.id, p_lines: shopifyLines, p_order_update: shopifyUpdate },
      );
      expect(assignedShopifyUpdate.error).not.toBeNull();
      const { data: linesAfterAssignedAttempt } = await admin
        .from('order_line')
        .select('product_id, qty, match_status')
        .eq('order_id', shopifyOrder.id)
        .order('created_at');
      expect(linesAfterAssignedAttempt).toEqual(shopifyLinesAfterUpdate);

      await admin
        .from('orders')
        .update({
          assigned_driver_id: null,
          delivery_state: 'unassigned',
          cart_locally_modified_at: new Date().toISOString(),
        })
        .eq('id', shopifyOrder.id);
      const locallyEditedShopifyUpdate = await replaceShopifyOrderCartRpc(admin)(
        'replace_shopify_order_cart',
        { p_order_id: shopifyOrder.id, p_lines: shopifyLines, p_order_update: shopifyUpdate },
      );
      expect(locallyEditedShopifyUpdate.error).not.toBeNull();
      const { data: linesAfterLocalEditAttempt } = await admin
        .from('order_line')
        .select('product_id, qty, match_status')
        .eq('order_id', shopifyOrder.id)
        .order('created_at');
      expect(linesAfterLocalEditAttempt).toEqual(shopifyLinesAfterUpdate);
    },
  );
});

function shopifyOrderUpdate({
  shopifyOrderId,
  orderNumber,
  title,
  sku,
  variantId,
  productId,
}: {
  shopifyOrderId: string;
  orderNumber: string;
  title: string;
  sku: string;
  variantId: string;
  productId: string;
}): ShopifyOrderNode {
  return {
    id: `gid://shopify/Order/${shopifyOrderId}`,
    name: orderNumber,
    createdAt: '2026-07-21T09:00:00Z',
    updatedAt: '2026-07-21T10:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    currentTotalPriceSet: { shopMoney: { amount: '240', currencyCode: 'XOF' } },
    customer: null,
    shippingAddress: null,
    lineItems: {
      edges: [
        {
          node: {
            title,
            sku,
            quantity: 2,
            originalUnitPriceSet: { shopMoney: { amount: '120' } },
            variant: { id: `gid://shopify/ProductVariant/${variantId}` },
            product: { id: `gid://shopify/Product/${productId}` },
          },
        },
      ],
    },
  };
}

async function createPersistScenario(admin: AdminClient, suffix: string) {
  const ownerId = await createUser(admin, `persist-shopify-owner-${suffix}@example.com`);
  const merchantAccountId = await waitForMerchantAccount(admin, ownerId);
  const shopifyOrderId = `9${suffix.replace(/\D/g, '').slice(-12)}`;

  const { data: oldProduct, error: oldProductError } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      title: 'Produit Shopify avant mise a jour',
      unit_cost: 100,
      sku: `OLD-${suffix}`,
      shopify_variant_id: `old-variant-${suffix}`,
      shopify_product_id: `old-product-${suffix}`,
    })
    .select('id')
    .single();
  if (oldProductError || !oldProduct) throw oldProductError ?? new Error('old product not created');

  const { data: newProduct, error: newProductError } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      title: 'Produit Shopify apres mise a jour',
      unit_cost: 120,
      sku: `NEW-${suffix}`,
      shopify_variant_id: `new-variant-${suffix}`,
      shopify_product_id: `new-product-${suffix}`,
    })
    .select('id')
    .single();
  if (newProductError || !newProduct) throw newProductError ?? new Error('new product not created');

  const { data: driver, error: driverError } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Livreur scenario persist Shopify',
      phone: `+22177${suffix.replace(/\D/g, '').slice(-7).padStart(7, '0')}`,
    })
    .select('id')
    .single();
  if (driverError || !driver) throw driverError ?? new Error('driver not created');

  const oldItemsSummary = [{ title: 'Produit Shopify avant mise a jour', quantity: 1, price: 100 }];
  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `PERSIST-SHOPIFY-${suffix}`,
      shopify_order_id: shopifyOrderId,
      shopify_updated_at: '2026-07-21T08:00:00Z',
      source: 'shopify',
      total_amount: 100,
      currency: 'XOF',
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      items_summary: oldItemsSummary,
    })
    .select('id')
    .single();
  if (orderError || !order) throw orderError ?? new Error('shopify order not created');

  const { error: oldLineError } = await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    order_id: order.id,
    product_id: oldProduct.id,
    raw_title: 'Produit Shopify avant mise a jour',
    qty: 1,
    match_status: 'matched',
  });
  if (oldLineError) throw oldLineError;

  return {
    merchantAccountId,
    driverId: driver.id,
    newItemsSummary: [
      {
        title: 'Produit Shopify apres mise a jour',
        sku: `NEW-${suffix}`,
        quantity: 2,
        price: 120,
        shopify_variant_id: `new-variant-${suffix}`,
        shopify_product_id: `new-product-${suffix}`,
      },
    ],
    newProductId: newProduct.id,
    oldItemsSummary,
    oldProductId: oldProduct.id,
    orderId: order.id,
    orderNode: shopifyOrderUpdate({
      shopifyOrderId,
      orderNumber: `PERSIST-SHOPIFY-${suffix}-UPDATED`,
      title: 'Produit Shopify apres mise a jour',
      sku: `NEW-${suffix}`,
      variantId: `new-variant-${suffix}`,
      productId: `new-product-${suffix}`,
    }),
  };
}

describe('persistShopifyOrder — synchronisation du panier Shopify existant', () => {
  skipIfNoServiceRole('recalcule order_line pour une commande unassigned/not_due', async () => {
    const admin = adminClient();
    const scenario = await createPersistScenario(admin, `${Date.now()}-unassigned`);

    await expect(
      persistShopifyOrder({
        merchantAccountId: scenario.merchantAccountId,
        orderNode: scenario.orderNode,
        shopId: 'shop-for-persist-test',
        supabaseServiceClient: admin,
      }),
    ).resolves.toEqual({ ok: true });

    const { data: updatedOrder } = await admin
      .from('orders')
      .select('items_summary, total_amount')
      .eq('id', scenario.orderId)
      .single();
    expect(updatedOrder).toMatchObject({ total_amount: 240 });
    expect(updatedOrder?.items_summary).toEqual(scenario.newItemsSummary);

    const { data: updatedLines } = await admin
      .from('order_line')
      .select('product_id, qty, match_status')
      .eq('order_id', scenario.orderId);
    expect(updatedLines).toEqual([
      { product_id: scenario.newProductId, qty: 2, match_status: 'matched' },
    ]);
  });

  skipIfNoServiceRole('conserve order_line assignee mais ecrase le panier Shopify', async () => {
    const admin = adminClient();
    const scenario = await createPersistScenario(admin, `${Date.now()}-assigned`);
    const { data: assignedOrder, error: assignmentError } = await admin
      .from('orders')
      .update({ assigned_driver_id: scenario.driverId, delivery_state: 'assigned' })
      .eq('id', scenario.orderId)
      .select('delivery_state')
      .single();
    expect(assignmentError).toBeNull();
    expect(assignedOrder?.delivery_state).toBe('assigned');

    await expect(
      persistShopifyOrder({
        merchantAccountId: scenario.merchantAccountId,
        orderNode: scenario.orderNode,
        shopId: 'shop-for-persist-test',
        supabaseServiceClient: admin,
      }),
    ).resolves.toEqual({ ok: true });

    const { data: updatedOrder } = await admin
      .from('orders')
      .select('items_summary, total_amount')
      .eq('id', scenario.orderId)
      .single();
    expect(updatedOrder).toMatchObject({ total_amount: 240 });
    expect(updatedOrder?.items_summary).toEqual(scenario.newItemsSummary);

    const { data: unchangedLines } = await admin
      .from('order_line')
      .select('product_id, qty, match_status')
      .eq('order_id', scenario.orderId);
    expect(unchangedLines).toEqual([
      { product_id: scenario.oldProductId, qty: 1, match_status: 'matched' },
    ]);
  });

  skipIfNoServiceRole(
    'preserve le panier edite localement pour une commande unassigned/not_due',
    async () => {
      const admin = adminClient();
      const scenario = await createPersistScenario(admin, `${Date.now()}-local-edit`);
      const { data: locallyEditedOrder, error: localEditError } = await admin
        .from('orders')
        .update({ cart_locally_modified_at: '2026-07-21T09:30:00Z' })
        .eq('id', scenario.orderId)
        .select('cart_locally_modified_at')
        .single();
      expect(localEditError).toBeNull();
      expect(locallyEditedOrder?.cart_locally_modified_at).toBe('2026-07-21T09:30:00+00:00');

      await expect(
        persistShopifyOrder({
          merchantAccountId: scenario.merchantAccountId,
          orderNode: scenario.orderNode,
          shopId: 'shop-for-persist-test',
          supabaseServiceClient: admin,
        }),
      ).resolves.toEqual({ ok: true });

      const { data: unchangedOrder } = await admin
        .from('orders')
        .select('items_summary, total_amount')
        .eq('id', scenario.orderId)
        .single();
      expect(unchangedOrder).toMatchObject({ total_amount: 100 });
      expect(unchangedOrder?.items_summary).toEqual(scenario.oldItemsSummary);

      const { data: unchangedLines } = await admin
        .from('order_line')
        .select('product_id, qty, match_status')
        .eq('order_id', scenario.orderId);
      expect(unchangedLines).toEqual([
        { product_id: scenario.oldProductId, qty: 1, match_status: 'matched' },
      ]);
    },
  );
});
