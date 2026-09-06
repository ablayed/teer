import { createHmac } from 'node:crypto';
import { generateWebhookToken } from '@/lib/ingestion/webhook-token';
import { expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';

// Phase 2 — Verrou 0 : preuve de parité entre l'endpoint legacy (app/api/shopify/webhooks) et
// l'endpoint à URL opaque (app/api/shopify/ingest/[token]) après extraction du cœur partagé
// (lib/shopify/webhook-core.ts). Compare des LIGNES, pas des descriptions : pour chaque topic
// dispatché, le MÊME payload signé est envoyé aux deux endpoints (deux boutiques fraîches,
// deux tenants distincts), et l'état résultant est comparé champ par champ — seuls les
// identifiants générés et les horodatages sont exclus de la comparaison.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const hasSupabaseAdmin = Boolean(supabaseUrl && serviceRoleKey);

const KOBA_CLIENT_ID = process.env.SHOPIFY_KOBA_API_KEY ?? '';
const KOBA_SECRET = process.env.SHOPIFY_KOBA_API_SECRET ?? '';
const hasKobaEnv = Boolean(KOBA_CLIENT_ID && KOBA_SECRET);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createMerchant(
  admin: AdminClient,
  label: string,
): Promise<{ userId: string; merchantAccountId: string }> {
  const email = `e2e+parity-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  label: string,
): Promise<{ shopId: string; shopDomain: string }> {
  const shopDomain = `e2e-parity-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
  const { data, error } = await admin
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
  if (error || !data) throw new Error(`shop insert failed: ${error?.message}`);
  return { shopId: data.id, shopDomain };
}

// Uniquement pour le chemin opaque : store_connection + jeton d'URL. Le chemin legacy n'a besoin
// que du shop (identité par en-tête).
async function seedConnectionAndToken(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  shopDomain: string,
): Promise<{ storeConnectionId: string; rawToken: string }> {
  const { data: connection, error } = await admin
    .from('store_connection')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      platform: 'shopify',
      external_identifier: shopDomain,
      platform_app_id: KOBA_CLIENT_ID,
    })
    .select('id')
    .single();
  if (error || !connection) throw new Error(`store_connection insert failed: ${error?.message}`);

  const token = generateWebhookToken();
  const { error: tokenError } = await admin.from('store_connection_webhook_token').insert({
    store_connection_id: connection.id,
    public_id: token.publicId,
    secret_hash: token.secretHash,
  });
  if (tokenError) throw new Error(`token insert failed: ${tokenError.message}`);

  return { storeConnectionId: connection.id, rawToken: token.raw };
}

// Legacy n'a pas besoin d'un jeton (identité par en-tête), mais la double-écriture L2
// (dualWriteOrderWebhook -> resolveShopConnection) exige une store_connection résolvable pour
// écrire ingestion_event — sans elle, resolveShopConnection renvoie null et le dual-write est
// silencieusement sauté (comportement voulu par ailleurs, mais pas ce qu'on veut comparer ici).
async function seedLegacyStoreConnection(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  shopDomain: string,
): Promise<void> {
  const { error } = await admin.from('store_connection').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    platform: 'shopify',
    external_identifier: shopDomain,
    platform_app_id: KOBA_CLIENT_ID,
  });
  if (error) throw new Error(`store_connection insert failed (legacy): ${error.message}`);
}

function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

async function postLegacy(
  request: import('@playwright/test').APIRequestContext,
  { topic, shopDomain, webhookId, body, triggeredAt }: PostArgs & { shopDomain: string },
) {
  const rawBody = JSON.stringify(body);
  return request.post('/api/shopify/webhooks', {
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': sign(rawBody, KOBA_SECRET),
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': shopDomain,
      'x-shopify-webhook-id': webhookId,
      'x-shopify-triggered-at': triggeredAt,
    },
    data: rawBody,
  });
}

type PostArgs = { topic: string; webhookId: string; body: unknown; triggeredAt: string };

async function postOpaque(
  request: import('@playwright/test').APIRequestContext,
  { topic, token, webhookId, body, triggeredAt }: PostArgs & { token: string },
) {
  const rawBody = JSON.stringify(body);
  return request.post(`/api/shopify/ingest/${encodeURIComponent(token)}`, {
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': sign(rawBody, KOBA_SECRET),
      'x-shopify-topic': topic,
      'x-shopify-webhook-id': webhookId,
      'x-shopify-triggered-at': triggeredAt,
    },
    data: rawBody,
  });
}

async function waitForWebhookEventDone(admin: AdminClient, webhookId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('webhook_event')
          .select('status')
          .eq('shopify_webhook_id', webhookId)
          .maybeSingle();
        return data?.status ?? null;
      },
      { timeout: 15_000, intervals: [300, 500, 1000] },
    )
    .toBe('done');
}

type OrderSnapshot = {
  delivery_state: string;
  cod_status: string;
  total_amount: number;
  currency: string;
  shopify_financial_status: string | null;
  shopify_fulfillment_status: string | null;
  // La note du payload REST est stockée dans shopify_order_attributes.note (JSON), PAS dans
  // orders.note (colonne distincte — la note d'équipe libre, jamais écrite par la sync Shopify,
  // cf. CLAUDE.md « Note libre sur la commande »). Comparer le blob JSON entier, pas un flat.
  shopify_order_attributes: unknown;
};

async function waitForOrderSnapshot(
  admin: AdminClient,
  merchantAccountId: string,
  shopifyOrderId: string,
): Promise<OrderSnapshot> {
  let row: OrderSnapshot | null = null;
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('orders')
          .select(
            'delivery_state, cod_status, total_amount, currency, shopify_financial_status, shopify_fulfillment_status, shopify_order_attributes',
          )
          .eq('merchant_account_id', merchantAccountId)
          .eq('shopify_order_id', shopifyOrderId)
          .maybeSingle();
        row = data as OrderSnapshot | null;
        return row !== null;
      },
      { timeout: 15_000, intervals: [300, 500, 1000] },
    )
    .toBe(true);
  if (!row) throw new Error(`order ${shopifyOrderId} not found`);
  return row;
}

// product n'a PAS de colonne `status` (trouvé en debug local : 42703 column does not exist) —
// la colonne réelle est `is_active` (booléen). Note pré-existante, hors périmètre de ce lot :
// mapShopifyVariantToProductInsert (lib/shopify/products-sync.ts) normalise désormais
// les statuts GraphQL et REST avant la comparaison : `active` et `ACTIVE` sont actifs,
// tandis que `draft` et `archived` restent inactifs.
type ProductSnapshot = { title: string; is_active: boolean };

type ProductIdentitySnapshot = {
  id: string;
  is_active: boolean;
  shopify_variant_id: string | null;
};

async function waitForProductSnapshot(
  admin: AdminClient,
  merchantAccountId: string,
  shopifyProductId: string,
): Promise<ProductSnapshot> {
  let row: ProductSnapshot | null = null;
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('product')
          .select('title, is_active')
          .eq('merchant_account_id', merchantAccountId)
          .eq('shopify_product_id', shopifyProductId)
          .maybeSingle();
        row = data as ProductSnapshot | null;
        return row !== null;
      },
      { timeout: 15_000, intervals: [300, 500, 1000] },
    )
    .toBe(true);
  if (!row) throw new Error(`product ${shopifyProductId} not found`);
  return row;
}

async function waitForProductIdentity(
  admin: AdminClient,
  merchantAccountId: string,
  shopifyProductId: string,
): Promise<ProductIdentitySnapshot> {
  let row: ProductIdentitySnapshot | null = null;
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('product')
          .select('id, is_active, shopify_variant_id')
          .eq('merchant_account_id', merchantAccountId)
          .eq('shopify_product_id', shopifyProductId)
          .maybeSingle();
        row = data as ProductIdentitySnapshot | null;
        return row !== null;
      },
      { timeout: 15_000, intervals: [300, 500, 1000] },
    )
    .toBe(true);
  if (!row) throw new Error(`product ${shopifyProductId} not found`);
  return row;
}

function orderBody(orderId: number, overrides: Record<string, unknown> = {}) {
  return {
    id: orderId,
    name: `#PARITY-${orderId}`,
    created_at: '2026-08-26T09:00:00Z',
    updated_at: '2026-08-26T09:00:00Z',
    financial_status: 'paid',
    fulfillment_status: null,
    note: 'note de parité',
    note_attributes: [{ name: 'canal', value: 'parite' }],
    total_price: '15000.00',
    currency: 'XOF',
    customer: {
      id: 555_000_001,
      first_name: 'Awa',
      last_name: 'Ndiaye',
      phone: '+221771234567',
    },
    shipping_address: {
      address1: 'Rue 12',
      city: 'Dakar',
      country: 'Senegal',
      name: 'Awa Ndiaye',
      phone: '+221771234567',
    },
    line_items: [
      {
        title: 'Produit parité',
        sku: 'SKU-PARITY',
        quantity: 2,
        price: '7500.00',
      },
    ],
    ...overrides,
  };
}

function productBody(productId: number, status = 'active') {
  return {
    id: productId,
    title: 'Produit de parité',
    status,
    variants: [{ id: productId * 10 + 1, title: 'Default', sku: 'SKU-PARITY-PROD' }],
  };
}

function refundBody(refundId: number, orderId: string) {
  return {
    id: refundId,
    order_id: orderId,
    created_at: '2026-08-26T09:00:00Z',
    transactions: [{ amount: '15000.00', gateway: 'wave', kind: 'refund', status: 'success' }],
  };
}

test.setTimeout(120_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes');
test.skip(!hasKobaEnv, 'SHOPIFY_KOBA_API_KEY/SECRET manquants — voir ci.yml (test-e2e-phase1)');

// ── Parité — un topic par test, deux tenants frais, même payload ──────────────────────────────

test('parité orders/create : même commande créée à l’identique sur les deux chemins', async ({
  request,
}) => {
  const admin = adminClient();
  const legacyMerchant = await createMerchant(admin, 'orders-create-legacy');
  const opaqueMerchant = await createMerchant(admin, 'orders-create-opaque');
  try {
    const legacyShop = await seedShop(admin, legacyMerchant.merchantAccountId, 'oc-legacy');
    const opaqueShop = await seedShop(admin, opaqueMerchant.merchantAccountId, 'oc-opaque');
    await seedLegacyStoreConnection(
      admin,
      legacyMerchant.merchantAccountId,
      legacyShop.shopId,
      legacyShop.shopDomain,
    );
    const { rawToken } = await seedConnectionAndToken(
      admin,
      opaqueMerchant.merchantAccountId,
      opaqueShop.shopId,
      opaqueShop.shopDomain,
    );

    const orderId = 90_100_000 + Math.floor(Math.random() * 100_000);
    const body = orderBody(orderId);

    const legacyRes = await postLegacy(request, {
      topic: 'orders/create',
      shopDomain: legacyShop.shopDomain,
      webhookId: `wh-parity-oc-legacy-${orderId}`,
      body,
      triggeredAt: '2026-08-26T09:00:01Z',
    });
    expect(legacyRes.status()).toBe(200);
    await waitForWebhookEventDone(admin, `wh-parity-oc-legacy-${orderId}`);

    const opaqueRes = await postOpaque(request, {
      topic: 'orders/create',
      token: rawToken,
      webhookId: `wh-parity-oc-opaque-${orderId}`,
      body,
      triggeredAt: '2026-08-26T09:00:01Z',
    });
    expect(opaqueRes.status()).toBe(200);
    await waitForWebhookEventDone(admin, `wh-parity-oc-opaque-${orderId}`);

    const legacyOrder = await waitForOrderSnapshot(
      admin,
      legacyMerchant.merchantAccountId,
      String(orderId),
    );
    const opaqueOrder = await waitForOrderSnapshot(
      admin,
      opaqueMerchant.merchantAccountId,
      String(orderId),
    );

    // Comparaison champ par champ — jamais une description. Identifiants/horodatages exclus.
    expect(opaqueOrder).toEqual(legacyOrder);

    // webhook_event ET ingestion_event alimentés de façon identique sur les deux chemins —
    // c'est exactement l'objet du Verrou 0 (webhook_event redevient autoritaire des deux côtés).
    const { data: legacyIngestion } = await admin
      .from('ingestion_event')
      .select('topic, resource_kind, status')
      .eq('merchant_account_id', legacyMerchant.merchantAccountId)
      .eq('delivery_id', `wh-parity-oc-legacy-${orderId}`)
      .maybeSingle();
    const { data: opaqueIngestion } = await admin
      .from('ingestion_event')
      .select('topic, resource_kind, status')
      .eq('merchant_account_id', opaqueMerchant.merchantAccountId)
      .eq('delivery_id', `wh-parity-oc-opaque-${orderId}`)
      .maybeSingle();
    expect(opaqueIngestion).toEqual(legacyIngestion);
  } finally {
    await admin.auth.admin.deleteUser(legacyMerchant.userId);
    await admin.auth.admin.deleteUser(opaqueMerchant.userId);
  }
});

for (const topic of ['orders/updated', 'orders/cancelled', 'orders/fulfilled'] as const) {
  test(`parité ${topic} : même mutation appliquée à l’identique sur les deux chemins`, async ({
    request,
  }) => {
    const admin = adminClient();
    const legacyMerchant = await createMerchant(admin, `${topic.replace('/', '-')}-legacy`);
    const opaqueMerchant = await createMerchant(admin, `${topic.replace('/', '-')}-opaque`);
    try {
      const legacyShop = await seedShop(admin, legacyMerchant.merchantAccountId, 'u-legacy');
      const opaqueShop = await seedShop(admin, opaqueMerchant.merchantAccountId, 'u-opaque');
      const { rawToken } = await seedConnectionAndToken(
        admin,
        opaqueMerchant.merchantAccountId,
        opaqueShop.shopId,
        opaqueShop.shopDomain,
      );

      const orderId = 90_200_000 + Math.floor(Math.random() * 100_000);
      const createBody = orderBody(orderId);

      // Étape 1 — création identique sur les deux tenants (même payload, updated_at initial).
      await postLegacy(request, {
        topic: 'orders/create',
        shopDomain: legacyShop.shopDomain,
        webhookId: `wh-parity-${topic}-create-legacy-${orderId}`,
        body: createBody,
        triggeredAt: '2026-08-26T09:00:01Z',
      });
      await waitForWebhookEventDone(admin, `wh-parity-${topic}-create-legacy-${orderId}`);
      await postOpaque(request, {
        topic: 'orders/create',
        token: rawToken,
        webhookId: `wh-parity-${topic}-create-opaque-${orderId}`,
        body: createBody,
        triggeredAt: '2026-08-26T09:00:01Z',
      });
      await waitForWebhookEventDone(admin, `wh-parity-${topic}-create-opaque-${orderId}`);

      // Étape 2 — le topic sous test, updated_at postérieur (jamais périmé par la garde hors-ordre).
      const mutationOverrides: Record<string, unknown> =
        topic === 'orders/cancelled'
          ? { cancelled_at: '2026-08-26T10:00:00Z', financial_status: 'refunded' }
          : topic === 'orders/fulfilled'
            ? { fulfillment_status: 'fulfilled' }
            : { note: 'note mise à jour' };
      const mutationBody = orderBody(orderId, {
        updated_at: '2026-08-26T10:00:00Z',
        ...mutationOverrides,
      });

      const legacyRes = await postLegacy(request, {
        topic,
        shopDomain: legacyShop.shopDomain,
        webhookId: `wh-parity-${topic}-legacy-${orderId}`,
        body: mutationBody,
        triggeredAt: '2026-08-26T10:00:01Z',
      });
      expect(legacyRes.status()).toBe(200);
      await waitForWebhookEventDone(admin, `wh-parity-${topic}-legacy-${orderId}`);

      const opaqueRes = await postOpaque(request, {
        topic,
        token: rawToken,
        webhookId: `wh-parity-${topic}-opaque-${orderId}`,
        body: mutationBody,
        triggeredAt: '2026-08-26T10:00:01Z',
      });
      expect(opaqueRes.status()).toBe(200);
      await waitForWebhookEventDone(admin, `wh-parity-${topic}-opaque-${orderId}`);

      const legacyOrder = await waitForOrderSnapshot(
        admin,
        legacyMerchant.merchantAccountId,
        String(orderId),
      );
      const opaqueOrder = await waitForOrderSnapshot(
        admin,
        opaqueMerchant.merchantAccountId,
        String(orderId),
      );
      expect(opaqueOrder).toEqual(legacyOrder);
    } finally {
      await admin.auth.admin.deleteUser(legacyMerchant.userId);
      await admin.auth.admin.deleteUser(opaqueMerchant.userId);
    }
  });
}

for (const topic of ['products/create', 'products/update'] as const) {
  test(`parité ${topic} : même produit persisté à l’identique sur les deux chemins`, async ({
    request,
  }) => {
    const admin = adminClient();
    const legacyMerchant = await createMerchant(admin, `${topic.replace('/', '-')}-legacy`);
    const opaqueMerchant = await createMerchant(admin, `${topic.replace('/', '-')}-opaque`);
    try {
      const legacyShop = await seedShop(admin, legacyMerchant.merchantAccountId, 'p-legacy');
      const opaqueShop = await seedShop(admin, opaqueMerchant.merchantAccountId, 'p-opaque');
      const { rawToken } = await seedConnectionAndToken(
        admin,
        opaqueMerchant.merchantAccountId,
        opaqueShop.shopId,
        opaqueShop.shopDomain,
      );

      const productId = 90_300_000 + Math.floor(Math.random() * 100_000);
      const body = productBody(productId);

      const legacyRes = await postLegacy(request, {
        topic,
        shopDomain: legacyShop.shopDomain,
        webhookId: `wh-parity-${topic}-legacy-${productId}`,
        body,
        triggeredAt: '2026-08-26T09:00:01Z',
      });
      expect(legacyRes.status()).toBe(200);
      await waitForWebhookEventDone(admin, `wh-parity-${topic}-legacy-${productId}`);

      const opaqueRes = await postOpaque(request, {
        topic,
        token: rawToken,
        webhookId: `wh-parity-${topic}-opaque-${productId}`,
        body,
        triggeredAt: '2026-08-26T09:00:01Z',
      });
      expect(opaqueRes.status()).toBe(200);
      await waitForWebhookEventDone(admin, `wh-parity-${topic}-opaque-${productId}`);

      const legacyProduct = await waitForProductSnapshot(
        admin,
        legacyMerchant.merchantAccountId,
        String(productId),
      );
      const opaqueProduct = await waitForProductSnapshot(
        admin,
        opaqueMerchant.merchantAccountId,
        String(productId),
      );
      expect(legacyProduct.is_active).toBe(true);
      expect(opaqueProduct.is_active).toBe(true);
      expect(opaqueProduct).toEqual(legacyProduct);
    } finally {
      await admin.auth.admin.deleteUser(legacyMerchant.userId);
      await admin.auth.admin.deleteUser(opaqueMerchant.userId);
    }
  });
}

test('products/update : conserve la même ligne active après un webhook actif', async ({
  request,
}) => {
  const admin = adminClient();
  const merchant = await createMerchant(admin, 'products-update-existing');
  try {
    const shop = await seedShop(admin, merchant.merchantAccountId, 'p-update-existing');
    const { rawToken } = await seedConnectionAndToken(
      admin,
      merchant.merchantAccountId,
      shop.shopId,
      shop.shopDomain,
    );
    const productId = 90_400_000 + Math.floor(Math.random() * 100_000);
    const createId = `wh-existing-create-${productId}`;
    const updateId = `wh-existing-update-${productId}`;

    const createResponse = await postOpaque(request, {
      topic: 'products/create',
      token: rawToken,
      webhookId: createId,
      body: productBody(productId, 'active'),
      triggeredAt: '2026-08-26T09:00:01Z',
    });
    expect(createResponse.status()).toBe(200);
    await waitForWebhookEventDone(admin, createId);
    const before = await waitForProductIdentity(
      admin,
      merchant.merchantAccountId,
      String(productId),
    );
    expect(before.is_active).toBe(true);

    const updateResponse = await postOpaque(request, {
      topic: 'products/update',
      token: rawToken,
      webhookId: updateId,
      body: productBody(productId, 'active'),
      triggeredAt: '2026-08-26T09:01:01Z',
    });
    expect(updateResponse.status()).toBe(200);
    await waitForWebhookEventDone(admin, updateId);
    const after = await waitForProductIdentity(
      admin,
      merchant.merchantAccountId,
      String(productId),
    );

    expect(after.id).toBe(before.id);
    expect(after.shopify_variant_id).toBe(before.shopify_variant_id);
    expect(after.is_active).toBe(true);
  } finally {
    await admin.auth.admin.deleteUser(merchant.userId);
  }
});

for (const status of ['draft', 'archived'] as const) {
  test(`webhook products/create : ${status} reste inactif`, async ({ request }) => {
    const admin = adminClient();
    const merchant = await createMerchant(admin, `products-${status}`);
    try {
      const shop = await seedShop(admin, merchant.merchantAccountId, `p-${status}`);
      const { rawToken } = await seedConnectionAndToken(
        admin,
        merchant.merchantAccountId,
        shop.shopId,
        shop.shopDomain,
      );
      const productId = 90_500_000 + Math.floor(Math.random() * 100_000);
      const webhookId = `wh-${status}-${productId}`;

      const response = await postOpaque(request, {
        topic: 'products/create',
        token: rawToken,
        webhookId,
        body: productBody(productId, status),
        triggeredAt: '2026-08-26T09:00:01Z',
      });
      expect(response.status()).toBe(200);
      await waitForWebhookEventDone(admin, webhookId);
      const product = await waitForProductSnapshot(
        admin,
        merchant.merchantAccountId,
        String(productId),
      );
      expect(product.is_active).toBe(false);
    } finally {
      await admin.auth.admin.deleteUser(merchant.userId);
    }
  });
}

test('parité refunds/create : même remboursement met à jour financial_status à l’identique', async ({
  request,
}) => {
  const admin = adminClient();
  const legacyMerchant = await createMerchant(admin, 'refund-legacy');
  const opaqueMerchant = await createMerchant(admin, 'refund-opaque');
  try {
    const legacyShop = await seedShop(admin, legacyMerchant.merchantAccountId, 'r-legacy');
    const opaqueShop = await seedShop(admin, opaqueMerchant.merchantAccountId, 'r-opaque');
    const { rawToken } = await seedConnectionAndToken(
      admin,
      opaqueMerchant.merchantAccountId,
      opaqueShop.shopId,
      opaqueShop.shopDomain,
    );

    const orderId = 90_400_000 + Math.floor(Math.random() * 100_000);
    const createBody = orderBody(orderId);
    await postLegacy(request, {
      topic: 'orders/create',
      shopDomain: legacyShop.shopDomain,
      webhookId: `wh-parity-refund-create-legacy-${orderId}`,
      body: createBody,
      triggeredAt: '2026-08-26T09:00:01Z',
    });
    await waitForWebhookEventDone(admin, `wh-parity-refund-create-legacy-${orderId}`);
    await postOpaque(request, {
      topic: 'orders/create',
      token: rawToken,
      webhookId: `wh-parity-refund-create-opaque-${orderId}`,
      body: createBody,
      triggeredAt: '2026-08-26T09:00:01Z',
    });
    await waitForWebhookEventDone(admin, `wh-parity-refund-create-opaque-${orderId}`);

    const refundId = 90_500_000 + Math.floor(Math.random() * 100_000);
    const refBody = refundBody(refundId, String(orderId));

    await postLegacy(request, {
      topic: 'refunds/create',
      shopDomain: legacyShop.shopDomain,
      webhookId: `wh-parity-refund-legacy-${refundId}`,
      body: refBody,
      triggeredAt: '2026-08-26T10:00:01Z',
    });
    await waitForWebhookEventDone(admin, `wh-parity-refund-legacy-${refundId}`);
    await postOpaque(request, {
      topic: 'refunds/create',
      token: rawToken,
      webhookId: `wh-parity-refund-opaque-${refundId}`,
      body: refBody,
      triggeredAt: '2026-08-26T10:00:01Z',
    });
    await waitForWebhookEventDone(admin, `wh-parity-refund-opaque-${refundId}`);

    const legacyOrder = await waitForOrderSnapshot(
      admin,
      legacyMerchant.merchantAccountId,
      String(orderId),
    );
    const opaqueOrder = await waitForOrderSnapshot(
      admin,
      opaqueMerchant.merchantAccountId,
      String(orderId),
    );
    expect(legacyOrder.shopify_financial_status).toBe('partially_refunded');
    expect(opaqueOrder).toEqual(legacyOrder);
  } finally {
    await admin.auth.admin.deleteUser(legacyMerchant.userId);
    await admin.auth.admin.deleteUser(opaqueMerchant.userId);
  }
});

test('parité app/uninstalled : shop.status et store_connection.status identiques sur les deux chemins', async ({
  request,
}) => {
  const admin = adminClient();
  const legacyMerchant = await createMerchant(admin, 'uninstall-legacy');
  const opaqueMerchant = await createMerchant(admin, 'uninstall-opaque');
  try {
    const legacyShop = await seedShop(admin, legacyMerchant.merchantAccountId, 'un-legacy');
    const opaqueShop = await seedShop(admin, opaqueMerchant.merchantAccountId, 'un-opaque');
    // Legacy n'a pas besoin d'une store_connection pour app/uninstalled (le repli dual-write est
    // best-effort) — mais on en sème une identique des deux côtés pour comparer store_connection
    // à l'identique, pas seulement shop.
    const { data: legacyConnection } = await admin
      .from('store_connection')
      .insert({
        merchant_account_id: legacyMerchant.merchantAccountId,
        shop_id: legacyShop.shopId,
        platform: 'shopify',
        external_identifier: legacyShop.shopDomain,
        platform_app_id: KOBA_CLIENT_ID,
      })
      .select('id')
      .single();
    const { rawToken } = await seedConnectionAndToken(
      admin,
      opaqueMerchant.merchantAccountId,
      opaqueShop.shopId,
      opaqueShop.shopDomain,
    );

    const legacyWebhookId = `wh-parity-uninstall-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const legacyRes = await postLegacy(request, {
      topic: 'app/uninstalled',
      shopDomain: legacyShop.shopDomain,
      webhookId: legacyWebhookId,
      body: { id: 1, name: legacyShop.shopDomain, domain: legacyShop.shopDomain },
      triggeredAt: '2026-08-26T09:00:01Z',
    });
    expect(legacyRes.status()).toBe(200);
    await waitForWebhookEventDone(admin, legacyWebhookId);

    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from('shop')
            .select('status')
            .eq('id', legacyShop.shopId)
            .maybeSingle();
          return data?.status ?? null;
        },
        { timeout: 10_000, intervals: [300, 500, 1000] },
      )
      .toBe('uninstalled');

    const opaqueRes = await postOpaque(request, {
      topic: 'app/uninstalled',
      token: rawToken,
      webhookId: `wh-parity-uninstall-opaque-${Date.now()}`,
      body: { id: 1, name: opaqueShop.shopDomain, domain: opaqueShop.shopDomain },
      triggeredAt: '2026-08-26T09:00:01Z',
    });
    expect(opaqueRes.status()).toBe(200);

    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from('shop')
            .select('status')
            .eq('id', opaqueShop.shopId)
            .maybeSingle();
          return data?.status ?? null;
        },
        { timeout: 10_000, intervals: [300, 500, 1000] },
      )
      .toBe('uninstalled');

    const { data: legacyShopAfter } = await admin
      .from('shop')
      .select('status, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at')
      .eq('id', legacyShop.shopId)
      .single();
    const { data: opaqueShopAfter } = await admin
      .from('shop')
      .select('status, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at')
      .eq('id', opaqueShop.shopId)
      .single();
    expect(opaqueShopAfter).toEqual(legacyShopAfter);

    const { data: legacyConnAfter } = await admin
      .from('store_connection')
      .select('status')
      .eq('id', legacyConnection?.id)
      .single();
    const { data: opaqueConnAfter } = await admin
      .from('store_connection')
      .select('status')
      .eq('external_identifier', opaqueShop.shopDomain)
      .single();
    expect(opaqueConnAfter).toEqual(legacyConnAfter);
    expect(legacyConnAfter?.status).toBe('uninstalled');
  } finally {
    await admin.auth.admin.deleteUser(legacyMerchant.userId);
    await admin.auth.admin.deleteUser(opaqueMerchant.userId);
  }
});

// ── Idempotence par livraison sur l'endpoint opaque (webhook_event) ────────────────────────────

test("idempotence : rejeu du même delivery_id sur l'endpoint opaque ne produit rien de nouveau", async ({
  request,
}) => {
  const admin = adminClient();
  const merchant = await createMerchant(admin, 'idem-opaque');
  try {
    const shop = await seedShop(admin, merchant.merchantAccountId, 'idem');
    const { rawToken } = await seedConnectionAndToken(
      admin,
      merchant.merchantAccountId,
      shop.shopId,
      shop.shopDomain,
    );
    const orderId = 90_600_000 + Math.floor(Math.random() * 100_000);
    const webhookId = `wh-parity-idem-${orderId}`;
    const body = orderBody(orderId);

    const first = await postOpaque(request, {
      topic: 'orders/create',
      token: rawToken,
      webhookId,
      body,
      triggeredAt: '2026-08-26T09:00:01Z',
    });
    expect(first.status()).toBe(200);
    await waitForWebhookEventDone(admin, webhookId);

    const second = await postOpaque(request, {
      topic: 'orders/create',
      token: rawToken,
      webhookId,
      body,
      triggeredAt: '2026-08-26T09:00:01Z',
    });
    expect(second.status()).toBe(200);

    const { count: webhookEventCount } = await admin
      .from('webhook_event')
      .select('id', { count: 'exact', head: true })
      .eq('shopify_webhook_id', webhookId);
    expect(webhookEventCount).toBe(1);

    const { count: orderCount } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('merchant_account_id', merchant.merchantAccountId)
      .eq('shopify_order_id', String(orderId));
    expect(orderCount).toBe(1);
  } finally {
    await admin.auth.admin.deleteUser(merchant.userId);
  }
});

// ── Garde hors-ordre sur l'endpoint opaque (isStaleShopifyUpdate, partagée avec legacy) ────────

test("garde hors-ordre : un orders/updated plus ancien n'écrase pas l'état déjà appliqué (endpoint opaque)", async ({
  request,
}) => {
  const admin = adminClient();
  const merchant = await createMerchant(admin, 'stale-opaque');
  try {
    const shop = await seedShop(admin, merchant.merchantAccountId, 'stale');
    const { rawToken } = await seedConnectionAndToken(
      admin,
      merchant.merchantAccountId,
      shop.shopId,
      shop.shopDomain,
    );
    const orderId = 90_700_000 + Math.floor(Math.random() * 100_000);

    // État récent appliqué en premier (updated_at le plus tardif). shopify_fulfillment_status —
    // colonne réelle écrite directement par mapShopifyOrder, contrairement à `note` du payload
    // qui atterrit dans shopify_order_attributes (JSON), pas dans une colonne plate comparable
    // ici aussi simplement.
    const recentBody = orderBody(orderId, {
      updated_at: '2026-08-26T12:00:00Z',
      fulfillment_status: 'fulfilled',
    });
    await postOpaque(request, {
      topic: 'orders/create',
      token: rawToken,
      webhookId: `wh-parity-stale-recent-${orderId}`,
      body: recentBody,
      triggeredAt: '2026-08-26T12:00:01Z',
    });
    await waitForWebhookEventDone(admin, `wh-parity-stale-recent-${orderId}`);

    // Un événement PLUS ANCIEN (updated_at antérieur) arrive ensuite (réessai Shopify tardif) —
    // ne doit jamais écraser l'état déjà appliqué.
    const staleBody = orderBody(orderId, {
      updated_at: '2026-08-26T11:00:00Z',
      fulfillment_status: null,
    });
    const staleRes = await postOpaque(request, {
      topic: 'orders/updated',
      token: rawToken,
      webhookId: `wh-parity-stale-old-${orderId}`,
      body: staleBody,
      triggeredAt: '2026-08-26T11:00:01Z',
    });
    expect(staleRes.status()).toBe(200);
    await waitForWebhookEventDone(admin, `wh-parity-stale-old-${orderId}`);

    const { data: orderAfter } = await admin
      .from('orders')
      .select('shopify_fulfillment_status')
      .eq('merchant_account_id', merchant.merchantAccountId)
      .eq('shopify_order_id', String(orderId))
      .single();
    expect(orderAfter?.shopify_fulfillment_status).toBe('fulfilled');
  } finally {
    await admin.auth.admin.deleteUser(merchant.userId);
  }
});

// ── refunds/create idempotent sur l'endpoint opaque (migration 0144, même garde que legacy) ────
// Miroir de tests/e2e/shopify-refund-idempotency.spec.ts (preuve #1), via l'endpoint opaque —
// avant toute bascule Shopify réelle, la garde doit déjà être effective sur ce chemin aussi.

test('refunds/create : même remboursement livré deux fois (delivery_id différents) sur l’endpoint opaque → une seule écriture métier', async ({
  request,
}) => {
  const admin = adminClient();
  const merchant = await createMerchant(admin, 'refund-idem-opaque');
  try {
    const shop = await seedShop(admin, merchant.merchantAccountId, 'refund-idem');
    const { rawToken } = await seedConnectionAndToken(
      admin,
      merchant.merchantAccountId,
      shop.shopId,
      shop.shopDomain,
    );
    const orderId = 90_800_000 + Math.floor(Math.random() * 100_000);
    await postOpaque(request, {
      topic: 'orders/create',
      token: rawToken,
      webhookId: `wh-parity-refund-idem-create-${orderId}`,
      body: orderBody(orderId),
      triggeredAt: '2026-08-26T09:00:01Z',
    });
    await waitForWebhookEventDone(admin, `wh-parity-refund-idem-create-${orderId}`);

    const refundId = 90_900_000 + Math.floor(Math.random() * 100_000);
    const body = refundBody(refundId, String(orderId));

    const first = await postOpaque(request, {
      topic: 'refunds/create',
      token: rawToken,
      webhookId: `wh-parity-refund-idem-a-${refundId}`,
      body,
      triggeredAt: '2026-08-26T10:00:01Z',
    });
    expect(first.status()).toBe(200);
    await waitForWebhookEventDone(admin, `wh-parity-refund-idem-a-${refundId}`);

    // MÊME remboursement, delivery_id DIFFÉRENT (le scénario exact d'une bascule d'abonnement mal
    // séquencée) — doit être reconnu comme un rejeu métier, pas un nouveau remboursement.
    const second = await postOpaque(request, {
      topic: 'refunds/create',
      token: rawToken,
      webhookId: `wh-parity-refund-idem-b-${refundId}`,
      body,
      triggeredAt: '2026-08-26T10:00:02Z',
    });
    expect(second.status()).toBe(200);
    await waitForWebhookEventDone(admin, `wh-parity-refund-idem-b-${refundId}`);

    const { data: rows } = await admin
      .from('audit_log')
      .select('id')
      .eq('merchant_account_id', merchant.merchantAccountId)
      .eq('action', 'shopify.refund_received');
    expect(rows).toHaveLength(1);
  } finally {
    await admin.auth.admin.deleteUser(merchant.userId);
  }
});
