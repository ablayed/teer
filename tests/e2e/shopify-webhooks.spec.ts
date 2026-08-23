import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { SHOPIFY_E2E_HMAC_SECRET } from './helpers/shopify-webhook-harness';

// Playwright charge la configuration de test dans process.env (cf. playwright.config). Le mode
// E2E_SHOPIFY_WEBHOOKS explicite impose une clé synthétique commune au serveur et au signeur.
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const apiSecret =
  process.env.E2E_SHOPIFY_WEBHOOKS === '1'
    ? SHOPIFY_E2E_HMAC_SECRET
    : (process.env.SHOPIFY_API_SECRET ?? '');
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

async function seedShop(
  admin: AdminClient,
  merchantAccountId: string,
): Promise<{ shopDomain: string; shopId: string }> {
  const shopDomain = `e2e-wh-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: shopDomain,
      access_token_encrypted: 'dummy',
      scopes: 'read_orders,read_customers,read_products',
      status: 'active',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`shop insert failed: ${error?.message ?? 'missing shop'}`);
  return { shopDomain, shopId: data.id };
}

function sign(rawBody: string, secret = apiSecret): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

async function postWebhook(
  request: import('@playwright/test').APIRequestContext,
  {
    topic,
    shopDomain,
    webhookId,
    body,
    triggeredAt,
    hmacSecret,
  }: {
    topic: string;
    shopDomain: string;
    webhookId: string;
    body: unknown;
    triggeredAt: string;
    hmacSecret?: string;
  },
) {
  const rawBody = JSON.stringify(body);
  return request.post('/api/shopify/webhooks', {
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': sign(rawBody, hmacSecret),
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
    const { shopDomain } = await seedShop(admin, merchantAccountId);
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
    const { shopDomain } = await seedShop(admin, merchantAccountId);
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
    const { shopDomain } = await seedShop(admin, merchantAccountId);
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
    const { shopDomain } = await seedShop(admin, merchantAccountId);
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

test('HMAC invalide est rejeté en 401 sans enregistrer d’événement', async ({ request }) => {
  const admin = adminClient();
  const webhookId = `wh-invalid-${Date.now()}`;
  const response = await postWebhook(request, {
    topic: 'orders/create',
    shopDomain: `absent-${Date.now()}.myshopify.com`,
    webhookId,
    body: { id: 99_999_991 },
    triggeredAt: '2026-07-23T10:00:00Z',
    hmacSecret: 'intentionally-invalid-test-secret',
  });

  expect(response.status()).toBe(401);
  const { count } = await admin
    .from('webhook_event')
    .select('id', { count: 'exact', head: true })
    .eq('shopify_webhook_id', webhookId);
  expect(count).toBe(0);
});

test('boutique absente mais HMAC valide reçoit 2xx sans mutation tenant', async ({ request }) => {
  const admin = adminClient();
  const orderId = 89_000_000 + Math.floor(Math.random() * 1_000_000);
  const webhookId = `wh-unknown-shop-${orderId}`;
  const response = await postWebhook(request, {
    topic: 'orders/create',
    shopDomain: `absent-${orderId}.myshopify.com`,
    webhookId,
    body: { id: orderId, name: `#UNKNOWN-${orderId}`, line_items: [] },
    triggeredAt: '2026-07-23T10:00:00Z',
  });

  expect(response.status()).toBe(200);
  await expect
    .poll(async () => {
      const { data } = await admin
        .from('webhook_event')
        .select('shop_id, merchant_account_id, status')
        .eq('shopify_webhook_id', webhookId)
        .maybeSingle();
      return data;
    })
    .toMatchObject({ merchant_account_id: null, shop_id: null, status: 'done' });
  const { count } = await admin
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('shopify_order_id', String(orderId));
  expect(count).toBe(0);
});

test('webhooks GDPR data_request, customers/redact et shop/redact exécutent les traitements attendus', async ({
  request,
}) => {
  const admin = adminClient();
  const { userId, merchantAccountId } = await createMerchant(admin);
  try {
    const { shopDomain, shopId } = await seedShop(admin, merchantAccountId);
    const orderId = 88_000_000 + Math.floor(Math.random() * 1_000_000);
    const customerId = String(77_000_000 + Math.floor(Math.random() * 1_000_000));
    const orderBody = {
      id: orderId,
      name: `#GDPR-${orderId}`,
      created_at: '2026-07-23T09:00:00Z',
      updated_at: '2026-07-23T09:00:00Z',
      total_price: '15000',
      currency: 'XOF',
      customer: { id: customerId, first_name: 'Awa', last_name: 'Diop', phone: '+221770000099' },
      shipping_address: { address1: 'Rue GDPR', city: 'Dakar', name: 'Awa Diop' },
      line_items: [{ title: 'Sac', quantity: 1, price: '15000' }],
    };
    expect(
      (
        await postWebhook(request, {
          topic: 'orders/create',
          shopDomain,
          webhookId: `wh-gdpr-order-${orderId}`,
          body: orderBody,
          triggeredAt: '2026-07-23T09:00:01Z',
        })
      ).status(),
    ).toBe(200);
    await waitForOrder(admin, merchantAccountId, String(orderId));

    const dataRequestId = `wh-gdpr-data-${orderId}`;
    expect(
      (
        await postWebhook(request, {
          topic: 'customers/data_request',
          shopDomain,
          webhookId: dataRequestId,
          body: { shop_domain: shopDomain, customer: { id: customerId } },
          triggeredAt: '2026-07-23T09:01:00Z',
        })
      ).status(),
    ).toBe(200);
    await expect
      .poll(async () => {
        const { data } = await admin
          .from('audit_log')
          .select('action')
          .eq('merchant_account_id', merchantAccountId)
          .eq('action', 'gdpr.customers/data_request')
          .eq('resource_id', shopId)
          .maybeSingle();
        return data?.action ?? '';
      })
      .toBe('gdpr.customers/data_request');

    expect(
      (
        await postWebhook(request, {
          topic: 'customers/redact',
          shopDomain,
          webhookId: `wh-gdpr-customer-${orderId}`,
          body: { shop_domain: shopDomain, customer: { id: customerId } },
          triggeredAt: '2026-07-23T09:02:00Z',
        })
      ).status(),
    ).toBe(200);
    await expect
      .poll(async () => {
        const { data } = await admin
          .from('customer')
          .select('full_name, phone')
          .eq('merchant_account_id', merchantAccountId)
          .eq('shopify_customer_id', customerId)
          .maybeSingle();
        return data;
      })
      .toMatchObject({ full_name: '[client supprimé]', phone: null });

    expect(
      (
        await postWebhook(request, {
          topic: 'shop/redact',
          shopDomain,
          webhookId: `wh-gdpr-shop-${orderId}`,
          body: { shop_domain: shopDomain },
          triggeredAt: '2026-07-23T09:03:00Z',
        })
      ).status(),
    ).toBe(200);
    await expect
      .poll(async () => {
        const { data } = await admin
          .from('audit_log')
          .select('action')
          .eq('merchant_account_id', merchantAccountId)
          .eq('action', 'gdpr.shop/redact')
          .eq('resource_id', shopId)
          .maybeSingle();
        return data?.action ?? '';
      })
      .toBe('gdpr.shop/redact');
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});

test('app/uninstalled désactive uniquement la boutique concernée', async ({ request }) => {
  const admin = adminClient();
  const { userId, merchantAccountId } = await createMerchant(admin);
  try {
    const { shopDomain, shopId } = await seedShop(admin, merchantAccountId);
    expect(
      (
        await postWebhook(request, {
          topic: 'app/uninstalled',
          shopDomain,
          webhookId: `wh-uninstalled-${shopId}`,
          body: { shop_domain: shopDomain },
          triggeredAt: '2026-07-23T10:00:00Z',
        })
      ).status(),
    ).toBe(200);
    await expect
      .poll(async () => {
        const { data } = await admin.from('shop').select('status').eq('id', shopId).maybeSingle();
        return data?.status ?? '';
      })
      .toBe('uninstalled');
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});

// --- Incident cross-tenant resolveShopDomain (2026-08-23) --------------------------------------
// x-shopify-hmac-sha256 ne couvre que le corps brut, jamais x-shopify-shop-domain. Toutes les
// boutiques semées par ce fichier retombent sur l'app par défaut du harness E2E (aucune ne
// définit shopify_client_id) — exactement la condition « même app, secret partagé » qui rend
// l'attaque possible en production (cf. lib/shopify/apps.ts, teer-dev = app publique par défaut).
// Le corps est signé pour la boutique ATTAQUANTE (C) ; le header prétend être la boutique
// VICTIME (A). Avant le correctif, resolveShopDomain préférait le header → la victime était
// affectée. Après : refus avant toute écriture, sur les 4 topics dont le corps porte l'identité.

async function waitForTerminalWebhookEvent(
  admin: AdminClient,
  webhookId: string,
): Promise<{ status: string; last_error_code: string | null }> {
  let row: { status: string; last_error_code: string | null } | null = null;
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('webhook_event')
          .select('status, last_error_code')
          .eq('shopify_webhook_id', webhookId)
          .maybeSingle();
        row = data as typeof row;
        return row?.status ?? '';
      },
      { timeout: 15_000, intervals: [200, 400, 800] },
    )
    .toBe('terminal');
  if (!row) throw new Error(`webhook_event introuvable pour ${webhookId}`);
  return row;
}

test.describe('incident cross-tenant resolveShopDomain — rejeu forgé refusé sans mutation', () => {
  test('app/uninstalled : corps signé C, en-tête forgé A, même app → refus, shop A intacte', async ({
    request,
  }) => {
    const admin = adminClient();
    const victim = await createMerchant(admin);
    const attacker = await createMerchant(admin);
    try {
      const { shopDomain: shopDomainA, shopId: shopIdA } = await seedShop(
        admin,
        victim.merchantAccountId,
      );
      const { shopDomain: shopDomainC } = await seedShop(admin, attacker.merchantAccountId);

      const before = await admin
        .from('shop')
        .select('status, uninstalled_at, refresh_token_encrypted')
        .eq('id', shopIdA)
        .single();
      expect(before.data).toMatchObject({ status: 'active', uninstalled_at: null });
      const tokenBefore = before.data?.refresh_token_encrypted ?? null;

      const webhookId = `wh-forged-uninstall-${shopIdA}`;
      const res = await postWebhook(request, {
        topic: 'app/uninstalled',
        shopDomain: shopDomainA, // en-tête forgé : domaine de la VICTIME
        webhookId,
        body: { shop_domain: shopDomainC }, // corps réellement signé pour l'ATTAQUANT
        triggeredAt: '2026-08-23T10:00:00Z',
      });
      // La réponse HTTP est toujours 2xx (traitement dans after()) : ne rien en déduire.
      expect(res.status()).toBe(200);

      const event = await waitForTerminalWebhookEvent(admin, webhookId);
      expect(event.last_error_code).toBe('shopify_uninstall_shop_domain_mismatch');

      const after = await admin
        .from('shop')
        .select('status, uninstalled_at, refresh_token_encrypted')
        .eq('id', shopIdA)
        .single();
      expect(after.data?.status).toBe('active');
      expect(after.data?.uninstalled_at).toBeNull();
      expect(after.data?.refresh_token_encrypted).toBe(tokenBefore);

      const { count: auditCount } = await admin
        .from('audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', victim.merchantAccountId)
        .eq('action', 'shopify.app_uninstalled');
      expect(auditCount).toBe(0);
    } finally {
      await admin.auth.admin.deleteUser(victim.userId);
      await admin.auth.admin.deleteUser(attacker.userId);
    }
  });

  test('customers/data_request : corps signé C, en-tête forgé A → refus, zéro artefact DSAR chez A', async ({
    request,
  }) => {
    const admin = adminClient();
    const victim = await createMerchant(admin);
    const attacker = await createMerchant(admin);
    try {
      const { shopDomain: shopDomainA } = await seedShop(admin, victim.merchantAccountId);
      const { shopDomain: shopDomainC } = await seedShop(admin, attacker.merchantAccountId);
      const attackerCustomerId = String(70_000_000 + Math.floor(Math.random() * 1_000_000));

      const webhookId = `wh-forged-data-request-${attackerCustomerId}`;
      const res = await postWebhook(request, {
        topic: 'customers/data_request',
        shopDomain: shopDomainA,
        webhookId,
        body: { shop_domain: shopDomainC, customer: { id: attackerCustomerId } },
        triggeredAt: '2026-08-23T10:01:00Z',
      });
      expect(res.status()).toBe(200);

      const event = await waitForTerminalWebhookEvent(admin, webhookId);
      expect(event.last_error_code).toBe('gdpr_shop_domain_mismatch');

      const { count: artifactCount } = await admin
        .from('shopify_dsar_artifact')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', victim.merchantAccountId);
      expect(artifactCount).toBe(0);

      // Second facteur : le pré-audit PCD (avant dispatcher) ne doit pas non plus avoir écrit
      // sous le tenant victime — c'est la garde `isGdprSignedTopic` du correctif qui le prouve.
      const { count: pcdAuditCount } = await admin
        .from('pcd_access_audit')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', victim.merchantAccountId);
      expect(pcdAuditCount).toBe(0);

      const { data: storageList } = await admin.storage
        .from('shopify-dsar')
        .list(victim.merchantAccountId);
      expect(storageList ?? []).toHaveLength(0);
    } finally {
      await admin.auth.admin.deleteUser(victim.userId);
      await admin.auth.admin.deleteUser(attacker.userId);
    }
  });

  test('customers/redact : corps signé C, en-tête forgé A → refus, client A inchangé même si l’ID coïncide', async ({
    request,
  }) => {
    const admin = adminClient();
    const victim = await createMerchant(admin);
    const attacker = await createMerchant(admin);
    try {
      const { shopDomain: shopDomainA } = await seedShop(admin, victim.merchantAccountId);
      const { shopDomain: shopDomainC } = await seedShop(admin, attacker.merchantAccountId);

      // Pire cas : l'ID client visé par le corps de l'attaquant coïncide avec un client réel
      // de la victime — si le correctif échouait, c'est CE client qui serait redacted.
      const sharedCustomerId = String(71_000_000 + Math.floor(Math.random() * 1_000_000));
      const { data: seededCustomer, error: seedError } = await admin
        .from('customer')
        .insert({
          merchant_account_id: victim.merchantAccountId,
          shopify_customer_id: sharedCustomerId,
          full_name: 'Client Victime',
          phone: '+221770000123',
        })
        .select('id, full_name, phone')
        .single();
      if (seedError || !seededCustomer) {
        throw new Error(`customer fixture insert failed: ${seedError?.message ?? 'missing row'}`);
      }

      const webhookId = `wh-forged-customers-redact-${sharedCustomerId}`;
      const res = await postWebhook(request, {
        topic: 'customers/redact',
        shopDomain: shopDomainA,
        webhookId,
        body: { shop_domain: shopDomainC, customer: { id: sharedCustomerId } },
        triggeredAt: '2026-08-23T10:02:00Z',
      });
      expect(res.status()).toBe(200);

      const event = await waitForTerminalWebhookEvent(admin, webhookId);
      expect(event.last_error_code).toBe('gdpr_shop_domain_mismatch');

      const { data: customerAfter } = await admin
        .from('customer')
        .select('full_name, phone')
        .eq('id', seededCustomer.id)
        .single();
      expect(customerAfter).toMatchObject({ full_name: 'Client Victime', phone: '+221770000123' });
    } finally {
      await admin.auth.admin.deleteUser(victim.userId);
      await admin.auth.admin.deleteUser(attacker.userId);
    }
  });

  test('shop/redact : corps signé C, en-tête forgé A → refus, client/commande/adresse A intacts', async ({
    request,
  }) => {
    const admin = adminClient();
    const victim = await createMerchant(admin);
    const attacker = await createMerchant(admin);
    try {
      const { shopDomain: shopDomainA, shopId: shopIdA } = await seedShop(
        admin,
        victim.merchantAccountId,
      );
      const { shopDomain: shopDomainC } = await seedShop(admin, attacker.merchantAccountId);

      // Commande + client réels côté victime, créés via le vrai chemin orders/create (pas un
      // insert direct) pour retomber sur exactement l'état qu'un shop/redact réussi rédigerait.
      const orderId = 72_000_000 + Math.floor(Math.random() * 1_000_000);
      const customerId = String(73_000_000 + Math.floor(Math.random() * 1_000_000));
      const orderBody = {
        id: orderId,
        name: `#FORGED-${orderId}`,
        created_at: '2026-08-23T09:00:00Z',
        updated_at: '2026-08-23T09:00:00Z',
        total_price: '15000',
        currency: 'XOF',
        customer: { id: customerId, first_name: 'Bou', last_name: 'Fall', phone: '+221770000456' },
        shipping_address: { address1: 'Rue Victime', city: 'Dakar', name: 'Bou Fall' },
        line_items: [{ title: 'Sac', quantity: 1, price: '15000' }],
      };
      expect(
        (
          await postWebhook(request, {
            topic: 'orders/create',
            shopDomain: shopDomainA,
            webhookId: `wh-forged-order-seed-${orderId}`,
            body: orderBody,
            triggeredAt: '2026-08-23T09:00:01Z',
          })
        ).status(),
      ).toBe(200);
      const seededOrder = await waitForOrder(admin, victim.merchantAccountId, String(orderId));

      const { data: seededCustomer } = await admin
        .from('customer')
        .select('id, full_name, phone')
        .eq('merchant_account_id', victim.merchantAccountId)
        .eq('shopify_customer_id', customerId)
        .single();
      expect(seededCustomer).toMatchObject({ full_name: 'Bou Fall', phone: '+221770000456' });

      const { data: seededAddress, error: addressError } = await admin
        .from('delivery_address')
        .insert({
          merchant_account_id: victim.merchantAccountId,
          order_id: seededOrder.id,
          quartier_commune: 'Plateau',
          telephone_principal: '+221770000456',
        })
        .select('id')
        .single();
      if (addressError || !seededAddress) {
        throw new Error(`delivery_address fixture insert failed: ${addressError?.message ?? ''}`);
      }

      const webhookId = `wh-forged-shop-redact-${shopIdA}`;
      const res = await postWebhook(request, {
        topic: 'shop/redact',
        shopDomain: shopDomainA,
        webhookId,
        body: { shop_domain: shopDomainC },
        triggeredAt: '2026-08-23T10:03:00Z',
      });
      expect(res.status()).toBe(200);

      const event = await waitForTerminalWebhookEvent(admin, webhookId);
      expect(event.last_error_code).toBe('gdpr_shop_domain_mismatch');

      const { data: customerAfter } = await admin
        .from('customer')
        .select('full_name, phone')
        .eq('id', seededCustomer?.id)
        .single();
      expect(customerAfter).toMatchObject({ full_name: 'Bou Fall', phone: '+221770000456' });

      const { data: orderAfter } = await admin
        .from('orders')
        .select('shipping_address, note')
        .eq('id', seededOrder.id)
        .single();
      expect(orderAfter?.shipping_address).not.toBeNull();

      const { count: addressCount } = await admin
        .from('delivery_address')
        .select('id', { count: 'exact', head: true })
        .eq('id', seededAddress.id);
      expect(addressCount).toBe(1);

      const { count: gdprAuditCount } = await admin
        .from('audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', victim.merchantAccountId)
        .eq('action', 'gdpr.shop/redact');
      expect(gdprAuditCount).toBe(0);
    } finally {
      await admin.auth.admin.deleteUser(victim.userId);
      await admin.auth.admin.deleteUser(attacker.userId);
    }
  });
});
