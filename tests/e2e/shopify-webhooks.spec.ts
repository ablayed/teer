import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';

// Playwright charge .env.test dans process.env (cf. playwright.config). Le serveur dev verifie
// l'HMAC avec process.env.SHOPIFY_API_SECRET ; on signe avec la meme valeur (?? '').
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const apiSecret = process.env.SHOPIFY_API_SECRET ?? '';
const hasSupabaseAdmin = Boolean(supabaseUrl && serviceRoleKey);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createMerchant(
  admin: AdminClient,
): Promise<{ userId: string; merchantAccountId: string }> {
  const email = `e2e+wh-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: 'Mot-de-passe-e2e-2026!',
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('user not created');
  const userId = data.user.id;
  let merchantAccountId = '';
  await expect
    .poll(
      async () => {
        const { data: member } = await admin
          .from('merchant_member')
          .select('merchant_account_id')
          .eq('user_id', userId)
          .limit(1)
          .maybeSingle();
        merchantAccountId = (member?.merchant_account_id as string | undefined) ?? '';
        return merchantAccountId;
      },
      { timeout: 10_000, intervals: [150, 300, 500] },
    )
    .not.toBe('');
  return { userId, merchantAccountId };
}

async function seedShop(admin: AdminClient, merchantAccountId: string): Promise<string> {
  const shopDomain = `e2e-wh-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
  const { error } = await admin.from('shop').insert({
    merchant_account_id: merchantAccountId,
    shop_domain: shopDomain,
    access_token_encrypted: 'dummy',
    scopes: 'read_orders,read_customers,read_products',
    status: 'active',
  });
  if (error) throw new Error(`shop insert failed: ${error.message}`);
  return shopDomain;
}

function sign(rawBody: string): string {
  return createHmac('sha256', apiSecret).update(rawBody, 'utf8').digest('base64');
}

async function postWebhook(
  request: import('@playwright/test').APIRequestContext,
  {
    topic,
    shopDomain,
    webhookId,
    body,
    triggeredAt,
  }: { topic: string; shopDomain: string; webhookId: string; body: unknown; triggeredAt: string },
) {
  const rawBody = JSON.stringify(body);
  return request.post('/api/shopify/webhooks', {
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': sign(rawBody),
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': shopDomain,
      'x-shopify-webhook-id': webhookId,
      'x-shopify-triggered-at': triggeredAt,
    },
    data: rawBody,
  });
}

type WebhookOrder = {
  id: string;
  delivery_state: string;
  shopify_fulfillment_status: string | null;
};

async function waitForOrder(
  admin: AdminClient,
  merchantAccountId: string,
  shopifyOrderId: string,
): Promise<WebhookOrder> {
  let order: WebhookOrder | null = null;
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('orders')
          .select('id, delivery_state, shopify_fulfillment_status')
          .eq('merchant_account_id', merchantAccountId)
          .eq('shopify_order_id', shopifyOrderId)
          .maybeSingle();
        order = data as typeof order;
        return order?.id ?? '';
      },
      { timeout: 15_000, intervals: [300, 500, 1000] },
    )
    .not.toBe('');
  if (!order) {
    throw new Error(`Commande Shopify ${shopifyOrderId} introuvable`);
  }
  return order;
}

type WebhookOrderAttributes = {
  shopify_line_item_attributes: unknown;
  shopify_order_attributes: unknown;
};

async function pollOrderAttributes(
  admin: AdminClient,
  merchantAccountId: string,
  shopifyOrderId: string,
  predicate: (row: WebhookOrderAttributes | null) => boolean,
): Promise<WebhookOrderAttributes | null> {
  let latest: WebhookOrderAttributes | null = null;
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('orders')
          .select('shopify_order_attributes, shopify_line_item_attributes')
          .eq('merchant_account_id', merchantAccountId)
          .eq('shopify_order_id', shopifyOrderId)
          .maybeSingle();
        latest = data as WebhookOrderAttributes | null;
        return predicate(latest);
      },
      { timeout: 15_000, intervals: [300, 500, 1000] },
    )
    .toBe(true);
  return latest;
}

test.setTimeout(90_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E webhooks Shopify');

test('webhook orders/create crée la commande ; rejeu (même webhook-id) → pas de doublon', async ({
  request,
}) => {
  const admin = adminClient();
  const { userId, merchantAccountId } = await createMerchant(admin);
  try {
    const shopDomain = await seedShop(admin, merchantAccountId);
    const orderId = 80_000_000 + Math.floor(Math.random() * 1_000_000);
    const shopifyOrderId = String(orderId);
    const webhookId = `wh-create-${orderId}`;
    const body = {
      id: orderId,
      name: `#E2E-${orderId}`,
      created_at: '2026-06-01T09:00:00Z',
      updated_at: '2026-06-01T09:00:00Z',
      financial_status: 'pending',
      fulfillment_status: null,
      total_price: '15000',
      currency: 'XOF',
      customer: {
        id: 9_000_001,
        first_name: 'Awa',
        last_name: 'Diop',
        phone: '+221770000000',
        email: 'awa@example.com',
      },
      shipping_address: {
        address1: 'Rue 1',
        city: 'Dakar',
        phone: '+221770000000',
        name: 'Awa Diop',
      },
      line_items: [
        { title: 'Sac', sku: 'SAC-1', quantity: 2, price: '5000', variant_id: 44, product_id: 33 },
      ],
    };

    const res1 = await postWebhook(request, {
      topic: 'orders/create',
      shopDomain,
      webhookId,
      body,
      triggeredAt: '2026-06-01T09:00:01Z',
    });
    expect(res1.status()).toBe(200);

    const order = await waitForOrder(admin, merchantAccountId, shopifyOrderId);
    expect(order).not.toBeNull();

    // Rejeu identique (même webhook-id) → duplicate → aucun second effet.
    const res2 = await postWebhook(request, {
      topic: 'orders/create',
      shopDomain,
      webhookId,
      body,
      triggeredAt: '2026-06-01T09:00:01Z',
    });
    expect(res2.status()).toBe(200);

    // Un seul effet #1 : aucune commande en double.
    await expect
      .poll(
        async () => {
          const { count } = await admin
            .from('orders')
            .select('id', { count: 'exact', head: true })
            .eq('merchant_account_id', merchantAccountId)
            .eq('shopify_order_id', shopifyOrderId);
          return count;
        },
        { timeout: 10_000, intervals: [300, 500, 1000] },
      )
      .toBe(1);

    // Un seul effet #2 : le registre de dédup (webhook_event) ne contient qu'UNE ligne pour ce
    // webhook-id, malgré les deux POST → la dédup par X-Shopify-Webhook-Id a bien rejeté le rejeu.
    const { count: eventCount } = await admin
      .from('webhook_event')
      .select('id', { count: 'exact', head: true })
      .eq('shopify_webhook_id', webhookId);
    expect(eventCount).toBe(1);

    // Un seul effet #3 : pas de double stock. L'ingestion webhook n'écrit JAMAIS les 4 dimensions
    // et ne poste donc aucun mouvement de stock — un rejeu ne peut rien doubler côté stock/cash.
    const { count: stockCount } = await admin
      .from('stock_movement')
      .select('id', { count: 'exact', head: true })
      .eq('order_id', order?.id ?? '');
    expect(stockCount).toBe(0);
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});

test("webhook orders/fulfilled n'altère pas delivery_state (miroir de canal uniquement)", async ({
  request,
}) => {
  const admin = adminClient();
  const { userId, merchantAccountId } = await createMerchant(admin);
  try {
    const shopDomain = await seedShop(admin, merchantAccountId);
    const orderId = 80_000_000 + Math.floor(Math.random() * 1_000_000);
    const shopifyOrderId = String(orderId);
    const baseBody = {
      id: orderId,
      name: `#E2E-${orderId}`,
      created_at: '2026-06-01T09:00:00Z',
      updated_at: '2026-06-01T09:00:00Z',
      financial_status: 'pending',
      fulfillment_status: null,
      total_price: '15000',
      currency: 'XOF',
      customer: {
        id: 9_000_002,
        first_name: 'Bou',
        last_name: 'Fall',
        phone: '+221770000001',
        email: 'bou@example.com',
      },
      shipping_address: { address1: 'Rue 2', city: 'Dakar', name: 'Bou Fall' },
      line_items: [
        { title: 'Sac', sku: 'SAC-1', quantity: 1, price: '15000', variant_id: 44, product_id: 33 },
      ],
    };

    const createRes = await postWebhook(request, {
      topic: 'orders/create',
      shopDomain,
      webhookId: `wh-create-${orderId}`,
      body: baseBody,
      triggeredAt: '2026-06-01T09:00:01Z',
    });
    expect(createRes.status()).toBe(200);
    const created = await waitForOrder(admin, merchantAccountId, shopifyOrderId);
    expect(created).not.toBeNull();
    expect(created?.delivery_state).toBe('unassigned');

    // orders/fulfilled : updated_at plus recent + fulfillment_status fulfilled.
    await postWebhook(request, {
      topic: 'orders/fulfilled',
      shopDomain,
      webhookId: `wh-fulfilled-${orderId}`,
      body: { ...baseBody, updated_at: '2026-06-01T10:00:00Z', fulfillment_status: 'fulfilled' },
      triggeredAt: '2026-06-01T10:00:01Z',
    });

    // Eventuel: le miroir passe a fulfilled SANS toucher delivery_state.
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from('orders')
            .select('delivery_state, shopify_fulfillment_status')
            .eq('merchant_account_id', merchantAccountId)
            .eq('shopify_order_id', shopifyOrderId)
            .maybeSingle();
          const row = data as {
            delivery_state: string;
            shopify_fulfillment_status: string | null;
          } | null;
          // delivery_state ne doit JAMAIS bouger, quel que soit l'instant.
          expect(row?.delivery_state).toBe('unassigned');
          return row?.shopify_fulfillment_status ?? null;
        },
        { timeout: 15_000, intervals: [300, 500, 1000] },
      )
      .toBe('fulfilled');
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});

test('webhook orders/create sans note/attributs → colonnes JSONB null (pas de section vide)', async ({
  request,
}) => {
  const admin = adminClient();
  const { userId, merchantAccountId } = await createMerchant(admin);
  try {
    const shopDomain = await seedShop(admin, merchantAccountId);
    const orderId = 80_000_000 + Math.floor(Math.random() * 1_000_000);
    const shopifyOrderId = String(orderId);
    const body = {
      id: orderId,
      name: `#E2E-${orderId}`,
      created_at: '2026-06-01T09:00:00Z',
      updated_at: '2026-06-01T09:00:00Z',
      financial_status: 'pending',
      fulfillment_status: null,
      total_price: '15000',
      currency: 'XOF',
      customer: {
        id: 9_000_003,
        first_name: 'Modou',
        last_name: 'Ndao',
        phone: '+221770000003',
        email: 'modou@example.com',
      },
      shipping_address: { address1: 'Rue 3', city: 'Dakar', name: 'Modou Ndao' },
      line_items: [
        { title: 'Sac', sku: 'SAC-1', quantity: 1, price: '15000', variant_id: 44, product_id: 33 },
      ],
    };

    const res = await postWebhook(request, {
      topic: 'orders/create',
      shopDomain,
      webhookId: `wh-create-${orderId}`,
      body,
      triggeredAt: '2026-06-01T09:00:01Z',
    });
    expect(res.status()).toBe(200);
    await waitForOrder(admin, merchantAccountId, shopifyOrderId);

    const row = await pollOrderAttributes(
      admin,
      merchantAccountId,
      shopifyOrderId,
      (r) => r !== null,
    );
    expect(row?.shopify_order_attributes).toBeNull();
    expect(row?.shopify_line_item_attributes).toBeNull();
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});

test('webhook orders/create capture note + customAttributes commande et ligne ; orders/updated ajoute une note apres coup', async ({
  request,
}) => {
  const admin = adminClient();
  const { userId, merchantAccountId } = await createMerchant(admin);
  try {
    const shopDomain = await seedShop(admin, merchantAccountId);
    const orderId = 80_000_000 + Math.floor(Math.random() * 1_000_000);
    const shopifyOrderId = String(orderId);
    const baseBody = {
      id: orderId,
      name: `#E2E-${orderId}`,
      created_at: '2026-06-01T09:00:00Z',
      updated_at: '2026-06-01T09:00:00Z',
      financial_status: 'pending',
      fulfillment_status: null,
      total_price: '15000',
      currency: 'XOF',
      customer: {
        id: 9_000_004,
        first_name: 'Aida',
        last_name: 'Ba',
        phone: '+221770000004',
        email: 'aida@example.com',
      },
      shipping_address: { address1: 'Rue 4', city: 'Dakar', name: 'Aida Ba' },
      line_items: [
        {
          title: 'Sac',
          sku: 'SAC-1',
          quantity: 1,
          price: '15000',
          variant_id: 44,
          product_id: 33,
          properties: [{ name: 'couleur', value: 'Rouge' }],
        },
      ],
    };

    // Création : note absente, note_attributes présent (commande), properties présent (ligne).
    const createRes = await postWebhook(request, {
      topic: 'orders/create',
      shopDomain,
      webhookId: `wh-create-${orderId}`,
      body: {
        ...baseBody,
        note_attributes: [{ name: 'disponibilite_livraison', value: 'Apres 18h' }],
      },
      triggeredAt: '2026-06-01T09:00:01Z',
    });
    expect(createRes.status()).toBe(200);
    await waitForOrder(admin, merchantAccountId, shopifyOrderId);

    const created = await pollOrderAttributes(
      admin,
      merchantAccountId,
      shopifyOrderId,
      (r) => r?.shopify_order_attributes !== null,
    );
    expect(created?.shopify_order_attributes).toEqual({
      note: null,
      attributes: [{ key: 'disponibilite_livraison', value: 'Apres 18h' }],
    });
    expect(created?.shopify_line_item_attributes).toEqual([
      { title: 'Sac', attributes: [{ key: 'couleur', value: 'Rouge' }] },
    ]);

    // orders/updated : note ajoutée après coup (updated_at plus récent) → même chemin de
    // persistance que la création, aucun nouveau mécanisme de sync nécessaire.
    await postWebhook(request, {
      topic: 'orders/updated',
      shopDomain,
      webhookId: `wh-updated-${orderId}`,
      body: {
        ...baseBody,
        updated_at: '2026-06-01T10:00:00Z',
        note: 'Note ajoutée après coup',
        note_attributes: [{ name: 'disponibilite_livraison', value: 'Apres 18h' }],
      },
      triggeredAt: '2026-06-01T10:00:01Z',
    });

    const updated = await pollOrderAttributes(admin, merchantAccountId, shopifyOrderId, (r) =>
      Boolean((r?.shopify_order_attributes as { note?: string } | null)?.note),
    );
    expect(updated?.shopify_order_attributes).toEqual({
      note: 'Note ajoutée après coup',
      attributes: [{ key: 'disponibilite_livraison', value: 'Apres 18h' }],
    });
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});
