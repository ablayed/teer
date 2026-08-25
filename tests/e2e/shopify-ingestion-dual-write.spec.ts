import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';

// Phase 2 / Lot L2 — preuve #7 (mapping + idempotence) via le canal HTTP réel, pas un appel direct
// de fonction : store_connection est seedée directement (comme le fait la migration 0142 pour une
// boutique préexistante), le webhook orders/create réel produit les mêmes écritures orders/orders
// que le chemin legacy PLUS ingestion_event + external_ref + orders.store_connection_id — sans
// bascule de lecture, webhook_event reste écrite à l'identique en parallèle.
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const hasSupabaseAdmin = Boolean(supabaseUrl && serviceRoleKey);

const KOBA_CLIENT_ID = process.env.SHOPIFY_KOBA_API_KEY ?? '';
const KOBA_SECRET = process.env.SHOPIFY_KOBA_API_SECRET ?? '';
const hasKobaEnv = Boolean(KOBA_CLIENT_ID && KOBA_SECRET);

// Nécessaire uniquement au test de désaccord d'app ci-dessous (store_connection.platform_app_id
// délibérément différent de shop.shopify_client_id) — une seconde app enregistrée distincte de
// teer-koba, jamais utilisée pour signer.
const PILOTE_CLIENT_ID = process.env.SHOPIFY_PILOTE_API_KEY ?? '';
const hasPiloteEnv = Boolean(PILOTE_CLIENT_ID);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createMerchant(admin: AdminClient) {
  const email = `e2e+l2-dualwrite-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

// Seed manuel de shop + store_connection — reproduit ce que fait la migration 0142 pour une
// boutique préexistante (et désormais le callback OAuth pour une nouvelle install, hors du chemin
// de ce test). C'est délibérément DIRECT (pas via /api/shopify/callback, hors périmètre HTTP de ce
// test) : la seule chose exercée via HTTP réel est le webhook lui-même.
async function seedConnectedShop(admin: AdminClient, merchantAccountId: string) {
  const shopDomain = `e2e-l2-dualwrite-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
  const { data: shop, error: shopError } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: shopDomain,
      access_token_encrypted: 'dummy',
      scopes: 'read_orders,read_customers,read_products',
      status: 'active',
      shopify_client_id: KOBA_CLIENT_ID,
    })
    .select('id')
    .single();
  if (shopError || !shop) throw new Error(`shop insert failed: ${shopError?.message}`);

  const { data: connection, error: connectionError } = await admin
    .from('store_connection')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shop.id,
      platform: 'shopify',
      external_identifier: shopDomain,
      platform_app_id: KOBA_CLIENT_ID,
      status: 'active',
    })
    .select('id')
    .single();
  if (connectionError || !connection)
    throw new Error(`store_connection insert failed: ${connectionError?.message}`);

  return { shopDomain, shopId: shop.id, storeConnectionId: connection.id };
}

function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

async function postOrderWebhook(
  request: import('@playwright/test').APIRequestContext,
  { shopDomain, webhookId, orderId }: { shopDomain: string; webhookId: string; orderId: number },
) {
  const body = {
    id: orderId,
    name: `#L2-${orderId}`,
    created_at: '2026-08-25T09:00:00Z',
    updated_at: '2026-08-25T09:00:00Z',
    total_price: '12000',
    currency: 'XOF',
    customer: { id: 90_500_001, first_name: 'L2', last_name: 'Test', phone: '+221770000111' },
    shipping_address: { address1: 'Rue L2', city: 'Dakar', name: 'L2 Test' },
    line_items: [{ title: 'Sac L2', quantity: 1, price: '12000' }],
  };
  const rawBody = JSON.stringify(body);
  return request.post('/api/shopify/webhooks', {
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': sign(rawBody, KOBA_SECRET),
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': shopDomain,
      'x-shopify-webhook-id': webhookId,
      'x-shopify-triggered-at': '2026-08-25T09:00:01Z',
    },
    data: rawBody,
  });
}

test.setTimeout(60_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes');
test.skip(!hasKobaEnv, 'SHOPIFY_KOBA_API_KEY/SECRET manquants (voir playwright.config.ts)');

test('orders/create réel produit orders + ingestion_event + external_ref(order) + store_connection_id, en plus de webhook_event', async ({
  request,
}) => {
  const admin = adminClient();
  const { userId, merchantAccountId } = await createMerchant(admin);
  try {
    const { shopDomain, shopId, storeConnectionId } = await seedConnectedShop(
      admin,
      merchantAccountId,
    );
    const orderId = 96_000_000 + Math.floor(Math.random() * 1_000_000);
    const webhookId = `wh-l2-dualwrite-${orderId}`;

    const res = await postOrderWebhook(request, { shopDomain, webhookId, orderId });
    expect(res.status()).toBe(200);

    let orderRow: { id: string; store_connection_id: string | null } | null = null;
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from('orders')
            .select('id, store_connection_id')
            .eq('merchant_account_id', merchantAccountId)
            .eq('shop_id', shopId)
            .eq('shopify_order_id', String(orderId))
            .maybeSingle();
          orderRow = data as typeof orderRow;
          return orderRow?.id ?? '';
        },
        { timeout: 15_000, intervals: [300, 500, 1000] },
      )
      .not.toBe('');
    if (!orderRow) throw new Error('order not found');
    const orderRowId: string = (orderRow as { id: string }).id;

    // Chemin legacy inchangé : webhook_event est toujours écrite (aucune bascule de lecture).
    // La double écriture s'exécute APRÈS le persist legacy, dans le même after() — poller ici,
    // pas une lecture unique, sinon le test observe l'état transitoire "processing".
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from('webhook_event')
            .select('status')
            .eq('shopify_webhook_id', webhookId)
            .maybeSingle();
          return data?.status ?? '';
        },
        { timeout: 10_000, intervals: [200, 400, 800] },
      )
      .toBe('done');

    // Double écriture : ingestion_event.
    let ingestionEvent: {
      resource_kind: string | null;
      resource_external_id: string | null;
      store_connection_id: string | null;
    } | null = null;
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from('ingestion_event')
            .select('resource_kind, resource_external_id, store_connection_id')
            .eq('delivery_id', webhookId)
            .maybeSingle();
          ingestionEvent = data as typeof ingestionEvent;
          return ingestionEvent ? 'found' : '';
        },
        { timeout: 10_000, intervals: [200, 400, 800] },
      )
      .toBe('found');
    expect(ingestionEvent).toMatchObject({
      resource_kind: 'order',
      resource_external_id: String(orderId),
      store_connection_id: storeConnectionId,
    });

    // Double écriture : external_ref(order).
    const { data: ref } = await admin
      .from('external_ref')
      .select('entity_id')
      .eq('store_connection_id', storeConnectionId)
      .eq('entity_type', 'order')
      .eq('external_id', String(orderId))
      .maybeSingle();
    expect(ref?.entity_id).toBe(orderRowId);

    // orders.store_connection_id posée : relue ICI, pas depuis le snapshot capturé plus haut
    // (setOrderStoreConnectionIfMissing s'exécute APRÈS l'apparition de la ligne orders, dans le
    // même after() — un ancien snapshot serait structurellement en course avec cette écriture).
    const { data: orderAfterDualWrite } = await admin
      .from('orders')
      .select('store_connection_id')
      .eq('id', orderRowId)
      .single();
    expect(orderAfterDualWrite?.store_connection_id).toBe(storeConnectionId);

    // Idempotence : rejeu du même webhook_id ne produit rien de nouveau.
    const res2 = await postOrderWebhook(request, { shopDomain, webhookId, orderId });
    expect(res2.status()).toBe(200);
    const { count: ingestionCountAfterReplay } = await admin
      .from('ingestion_event')
      .select('id', { count: 'exact', head: true })
      .eq('delivery_id', webhookId);
    expect(ingestionCountAfterReplay).toBe(1);
    const { count: refCountAfterReplay } = await admin
      .from('external_ref')
      .select('id', { count: 'exact', head: true })
      .eq('store_connection_id', storeConnectionId)
      .eq('entity_type', 'order')
      .eq('external_id', String(orderId));
    expect(refCountAfterReplay).toBe(1);
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});

test('boutique sans store_connection (connexion inconnue) : orders reste écrite comme avant, aucune écriture ingestion_event/external_ref', async ({
  request,
}) => {
  const admin = adminClient();
  const { userId, merchantAccountId } = await createMerchant(admin);
  try {
    const shopDomain = `e2e-l2-unknownconn-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
    const { error: shopError, data: shop } = await admin
      .from('shop')
      .insert({
        merchant_account_id: merchantAccountId,
        shop_domain: shopDomain,
        access_token_encrypted: 'dummy',
        scopes: 'read_orders,read_customers,read_products',
        status: 'active',
        shopify_client_id: KOBA_CLIENT_ID,
      })
      .select('id')
      .single();
    if (shopError || !shop) throw new Error(`shop insert failed: ${shopError?.message}`);
    // Volontairement AUCUNE ligne store_connection pour cette boutique.

    const orderId = 97_000_000 + Math.floor(Math.random() * 1_000_000);
    const webhookId = `wh-l2-unknownconn-${orderId}`;
    const res = await postOrderWebhook(request, { shopDomain, webhookId, orderId });
    expect(res.status()).toBe(200);

    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from('orders')
            .select('id')
            .eq('merchant_account_id', merchantAccountId)
            .eq('shop_id', shop.id)
            .eq('shopify_order_id', String(orderId))
            .maybeSingle();
          return data?.id ?? '';
        },
        { timeout: 15_000, intervals: [300, 500, 1000] },
      )
      .not.toBe('');

    const { count: ingestionCount } = await admin
      .from('ingestion_event')
      .select('id', { count: 'exact', head: true })
      .eq('delivery_id', webhookId);
    expect(ingestionCount).toBe(0);
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});

// Preuve #3 (recoupement d'app) via le canal HTTP réel — pas seulement l'unitaire de
// resolve-connection.test.ts. Scénario réel, pas artificiel : une store_connection dont
// platform_app_id a divergé de shop.shopify_client_id (ex. réinstallation sous une autre app sans
// mise à jour de la connexion existante). Le HMAC est routé et validé via shop.shopify_client_id
// (teer-koba, chemin legacy inchangé) — la commande est donc créée normalement. Le recoupement
// d'app, lui, compare l'app qui a VALIDÉ (teer-koba) au platform_app_id enregistré sur la
// store_connection trouvée (teer-pilote, volontairement divergent) → refus de la double écriture
// uniquement, avant toute écriture ingestion_event/external_ref.
test("désaccord d'app : store_connection.platform_app_id divergent de l'app ayant validé le HMAC → double écriture refusée, chemin legacy intact", async ({
  request,
}) => {
  // Skip scopé à CE test uniquement — un test.skip() en tête de fichier skipperait tout le
  // fichier, pas seulement ce cas (contrairement à hasSupabaseAdmin/hasKobaEnv ci-dessus, qui
  // conditionnent réellement tous les tests du fichier).
  test.skip(!hasPiloteEnv, 'SHOPIFY_PILOTE_API_KEY manquant (voir playwright.config.ts)');
  const admin = adminClient();
  const { userId, merchantAccountId } = await createMerchant(admin);
  try {
    const shopDomain = `e2e-l2-appmismatch-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
    const { data: shop, error: shopError } = await admin
      .from('shop')
      .insert({
        merchant_account_id: merchantAccountId,
        shop_domain: shopDomain,
        access_token_encrypted: 'dummy',
        scopes: 'read_orders,read_customers,read_products',
        status: 'active',
        // La boutique pointe vers teer-koba : c'est CE secret qui doit signer le HMAC pour que le
        // chemin legacy (inchangé par ce lot) accepte la requête.
        shopify_client_id: KOBA_CLIENT_ID,
      })
      .select('id')
      .single();
    if (shopError || !shop) throw new Error(`shop insert failed: ${shopError?.message}`);

    const { data: connection, error: connectionError } = await admin
      .from('store_connection')
      .insert({
        merchant_account_id: merchantAccountId,
        shop_id: shop.id,
        platform: 'shopify',
        external_identifier: shopDomain,
        // Volontairement DIVERGENT de shop.shopify_client_id (teer-koba) — c'est le cas que le
        // recoupement d'app doit intercepter.
        platform_app_id: PILOTE_CLIENT_ID,
        status: 'active',
      })
      .select('id')
      .single();
    if (connectionError || !connection)
      throw new Error(`store_connection insert failed: ${connectionError?.message}`);

    const orderId = 98_000_000 + Math.floor(Math.random() * 1_000_000);
    const webhookId = `wh-l2-appmismatch-${orderId}`;
    const res = await postOrderWebhook(request, { shopDomain, webhookId, orderId });
    // Chemin legacy INCHANGÉ : le HMAC est validé via shop.shopify_client_id (teer-koba), donc
    // signé avec KOBA_SECRET ici → 200, la commande est créée normalement.
    expect(res.status()).toBe(200);

    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from('orders')
            .select('id')
            .eq('merchant_account_id', merchantAccountId)
            .eq('shop_id', shop.id)
            .eq('shopify_order_id', String(orderId))
            .maybeSingle();
          return data?.id ?? '';
        },
        { timeout: 15_000, intervals: [300, 500, 1000] },
      )
      .not.toBe('');

    // Double écriture refusée : ni ingestion_event ni external_ref, malgré le succès du chemin
    // legacy. Lu après un court délai déterministe (le webhook_event terminal implique que
    // handleOrderWebhook — dual-write compris — a fini de s'exécuter dans le même after()).
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from('webhook_event')
            .select('status')
            .eq('shopify_webhook_id', webhookId)
            .maybeSingle();
          return data?.status ?? '';
        },
        { timeout: 10_000, intervals: [200, 400, 800] },
      )
      .toBe('done');

    const { count: ingestionCount } = await admin
      .from('ingestion_event')
      .select('id', { count: 'exact', head: true })
      .eq('delivery_id', webhookId);
    expect(ingestionCount).toBe(0);

    const { count: refCount } = await admin
      .from('external_ref')
      .select('id', { count: 'exact', head: true })
      .eq('store_connection_id', connection.id)
      .eq('entity_type', 'order')
      .eq('external_id', String(orderId));
    expect(refCount).toBe(0);
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});
