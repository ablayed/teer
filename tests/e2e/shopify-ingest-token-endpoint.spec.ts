import { createHmac } from 'node:crypto';
import { generateWebhookToken, hashWebhookTokenSecret } from '@/lib/ingestion/webhook-token';
import { expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';

// Phase 2 / Lot L3 (périmètre réduit) — endpoint webhook à URL opaque par installation
// (app/api/shopify/ingest/[token]/route.ts).
//
// Portée exacte de ce fichier (cf. rapport de session) : identité/routage du NOUVEL endpoint
// uniquement — via le canal HTTP réel, jamais un appel direct de fonction. Le PIN L0 sur
// l'autorité de l'en-tête du chemin LEGACY (tests/e2e/shopify-koba-multi-app.spec.ts, « À
// INVERSER PAR LE LOT L3 ») reste TEL QUEL et vert : il documente l'ancien endpoint, qui n'est
// pas touché par ce lot (aucune bascule d'abonnements, décision explicite du porteur). Ce fichier
// est le nouveau PIN, sur le nouvel endpoint, à côté de l'ancien — pas un remplacement.
//
// Aucun abonnement Shopify réel ne pointe vers ce endpoint (bascule = lot séparé, hors périmètre) :
// ce fichier ne prouve donc AUCUNE régression pilote (rien à régresser), seulement les propriétés
// d'identité que ce lot livre.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const hasSupabaseAdmin = Boolean(supabaseUrl && serviceRoleKey);

const KOBA_CLIENT_ID = process.env.SHOPIFY_KOBA_API_KEY ?? '';
const KOBA_SECRET = process.env.SHOPIFY_KOBA_API_SECRET ?? '';
const PILOTE_CLIENT_ID = process.env.SHOPIFY_PILOTE_API_KEY ?? '';
const PILOTE_SECRET = process.env.SHOPIFY_PILOTE_API_SECRET ?? '';

const hasMultiAppEnv = Boolean(KOBA_CLIENT_ID && KOBA_SECRET && PILOTE_CLIENT_ID && PILOTE_SECRET);

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
  const email = `e2e+l3-ingest-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

async function seedConnection(
  admin: AdminClient,
  merchantAccountId: string,
  platformAppId: string,
  label: string,
): Promise<{ shopId: string; storeConnectionId: string; externalIdentifier: string }> {
  const externalIdentifier = `e2e-l3-ingest-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
  const { data: shop, error: shopError } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: externalIdentifier,
      access_token_encrypted: 'dummy',
      scopes: 'read_orders,read_customers,read_products',
      status: 'active',
      shopify_client_id: platformAppId,
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
      external_identifier: externalIdentifier,
      platform_app_id: platformAppId,
    })
    .select('id')
    .single();
  if (connectionError || !connection) {
    throw new Error(`store_connection insert failed: ${connectionError?.message}`);
  }

  return { shopId: shop.id, storeConnectionId: connection.id, externalIdentifier };
}

async function issueToken(admin: AdminClient, storeConnectionId: string): Promise<string> {
  const token = generateWebhookToken();
  const { error } = await admin.from('store_connection_webhook_token').insert({
    store_connection_id: storeConnectionId,
    public_id: token.publicId,
    secret_hash: token.secretHash,
  });
  if (error) throw new Error(`token insert failed: ${error.message}`);
  return token.raw;
}

function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

async function postIngest(
  request: import('@playwright/test').APIRequestContext,
  {
    token,
    topic,
    body,
    webhookId,
    hmacSecret,
    shopDomainHeader,
  }: {
    token: string;
    topic: string;
    body: unknown;
    webhookId: string;
    hmacSecret: string | null;
    shopDomainHeader?: string;
  },
) {
  const rawBody = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-shopify-topic': topic,
    'x-shopify-webhook-id': webhookId,
    'x-shopify-triggered-at': '2026-08-25T09:00:00Z',
  };
  if (hmacSecret !== null) {
    headers['x-shopify-hmac-sha256'] = sign(rawBody, hmacSecret);
  }
  if (shopDomainHeader) {
    headers['x-shopify-shop-domain'] = shopDomainHeader;
  }
  return request.post(`/api/shopify/ingest/${encodeURIComponent(token)}`, {
    headers,
    data: rawBody,
  });
}

function orderBody(orderId: number) {
  return {
    id: orderId,
    name: `#L3-${orderId}`,
    created_at: '2026-08-25T09:00:00Z',
    updated_at: '2026-08-25T09:00:00Z',
    total_price: '15000',
    currency: 'XOF',
  };
}

async function waitForIngestionEvent(
  admin: AdminClient,
  deliveryId: string,
): Promise<{ shop_id: string; merchant_account_id: string } | null> {
  let row: { shop_id: string; merchant_account_id: string } | null = null;
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('ingestion_event')
          .select('shop_id, merchant_account_id')
          .eq('delivery_id', deliveryId)
          .maybeSingle();
        row = data as typeof row;
        return row !== null;
      },
      { timeout: 10_000, intervals: [200, 400, 800] },
    )
    .toBe(true);
  return row;
}

test.setTimeout(90_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes');
test.skip(
  !hasMultiAppEnv,
  'SHOPIFY_KOBA_API_KEY/SECRET et SHOPIFY_PILOTE_API_KEY/SECRET manquants — voir ci.yml (test-e2e-phase1)',
);

// --- Contrôle positif — preuve #2 (routage à app égale), OBLIGATOIRE, écrit en premier ---------

test('preuve #2 : même corps signé, deux jetons de deux connexions sous la MÊME app → deux boutiques distinctes, jamais ailleurs', async ({
  request,
}) => {
  const admin = adminClient();
  const merchantA = await createMerchant(admin);
  const merchantB = await createMerchant(admin);
  try {
    const connA = await seedConnection(admin, merchantA.merchantAccountId, KOBA_CLIENT_ID, 'a');
    const connB = await seedConnection(admin, merchantB.merchantAccountId, KOBA_CLIENT_ID, 'b');
    const tokenA = await issueToken(admin, connA.storeConnectionId);
    const tokenB = await issueToken(admin, connB.storeConnectionId);

    const orderId = 96_000_000 + Math.floor(Math.random() * 1_000_000);
    const body = orderBody(orderId);

    const resA = await postIngest(request, {
      token: tokenA,
      topic: 'orders/create',
      body,
      webhookId: `wh-l3-route-a-${orderId}`,
      hmacSecret: KOBA_SECRET,
    });
    expect(resA.status()).toBe(200);
    const rowA = await waitForIngestionEvent(admin, `wh-l3-route-a-${orderId}`);
    expect(rowA?.shop_id).toBe(connA.shopId);
    expect(rowA?.merchant_account_id).toBe(merchantA.merchantAccountId);

    const resB = await postIngest(request, {
      token: tokenB,
      topic: 'orders/create',
      body,
      webhookId: `wh-l3-route-b-${orderId}`,
      hmacSecret: KOBA_SECRET,
    });
    expect(resB.status()).toBe(200);
    const rowB = await waitForIngestionEvent(admin, `wh-l3-route-b-${orderId}`);
    expect(rowB?.shop_id).toBe(connB.shopId);
    expect(rowB?.merchant_account_id).toBe(merchantB.merchantAccountId);

    // Jamais l'inverse : la commande de A n'a jamais atterri chez B, et réciproquement.
    expect(rowA?.shop_id).not.toBe(connB.shopId);
  } finally {
    await admin.auth.admin.deleteUser(merchantA.userId);
    await admin.auth.admin.deleteUser(merchantB.userId);
  }
});

// --- Preuve #3 : désaccord app/jeton --------------------------------------------------------

test("preuve #3 : jeton d'une connexion sous teer-koba, corps signé par teer-pilote → refus, aucune écriture", async ({
  request,
}) => {
  const admin = adminClient();
  const merchant = await createMerchant(admin);
  try {
    const conn = await seedConnection(
      admin,
      merchant.merchantAccountId,
      KOBA_CLIENT_ID,
      'mismatch',
    );
    const token = await issueToken(admin, conn.storeConnectionId);
    const orderId = 97_000_000 + Math.floor(Math.random() * 1_000_000);
    const webhookId = `wh-l3-app-mismatch-${orderId}`;

    const res = await postIngest(request, {
      token,
      topic: 'orders/create',
      body: orderBody(orderId),
      webhookId,
      hmacSecret: PILOTE_SECRET, // signe correctement pour teer-pilote, pas teer-koba
    });
    expect(res.status()).toBe(401);
    const body = await res.body();
    expect(body.length).toBe(0);

    const { count } = await admin
      .from('ingestion_event')
      .select('id', { count: 'exact', head: true })
      .eq('delivery_id', webhookId);
    expect(count).toBe(0);
  } finally {
    await admin.auth.admin.deleteUser(merchant.userId);
  }
});

// --- Preuve #1 : un en-tête forgé n'a plus d'effet ------------------------------------------

test('preuve #1 : webhook correctement signé pour A, en-tête shop-domain forgé vers B → refus, aucune écriture', async ({
  request,
}) => {
  const admin = adminClient();
  const merchantA = await createMerchant(admin);
  const merchantB = await createMerchant(admin);
  try {
    const connA = await seedConnection(admin, merchantA.merchantAccountId, KOBA_CLIENT_ID, 'hdr-a');
    const connB = await seedConnection(admin, merchantB.merchantAccountId, KOBA_CLIENT_ID, 'hdr-b');
    const tokenA = await issueToken(admin, connA.storeConnectionId);
    const orderId = 98_000_000 + Math.floor(Math.random() * 1_000_000);
    const webhookId = `wh-l3-header-forged-${orderId}`;

    const res = await postIngest(request, {
      token: tokenA, // identité RÉELLE : connexion A
      topic: 'orders/create',
      body: orderBody(orderId),
      webhookId,
      hmacSecret: KOBA_SECRET, // signature correcte pour A (même app)
      shopDomainHeader: connB.externalIdentifier, // en-tête forgé : boutique B
    });
    expect(res.status()).toBe(401);

    const { count } = await admin
      .from('ingestion_event')
      .select('id', { count: 'exact', head: true })
      .eq('delivery_id', webhookId);
    expect(count).toBe(0);
  } finally {
    await admin.auth.admin.deleteUser(merchantA.userId);
    await admin.auth.admin.deleteUser(merchantB.userId);
  }
});

// --- Preuve #4 : six causes de refus, une seule réponse externe -----------------------------

test.describe('preuve #4 : six causes de refus, une seule réponse externe (401, corps vide)', () => {
  test('jeton malformé (pas de séparateur)', async ({ request }) => {
    const res = await postIngest(request, {
      token: 'not-a-valid-token-at-all',
      topic: 'orders/create',
      body: orderBody(1),
      webhookId: `wh-l3-cause-malformed-${Date.now()}`,
      hmacSecret: KOBA_SECRET,
    });
    expect(res.status()).toBe(401);
    expect((await res.body()).length).toBe(0);
  });

  test('jeton inconnu (public_id jamais émis)', async ({ request }) => {
    const unissued = generateWebhookToken();
    const res = await postIngest(request, {
      token: unissued.raw,
      topic: 'orders/create',
      body: orderBody(2),
      webhookId: `wh-l3-cause-unknown-${Date.now()}`,
      hmacSecret: KOBA_SECRET,
    });
    expect(res.status()).toBe(401);
    expect((await res.body()).length).toBe(0);
  });

  test('mauvais secret (public_id réel, secret différent)', async ({ request }) => {
    const admin = adminClient();
    const merchant = await createMerchant(admin);
    try {
      const conn = await seedConnection(
        admin,
        merchant.merchantAccountId,
        KOBA_CLIENT_ID,
        'wrong-secret',
      );
      const token = await issueToken(admin, conn.storeConnectionId);
      const [publicId] = token.split('.');
      const wrongSecret = generateWebhookToken().secret;

      const res = await postIngest(request, {
        token: `${publicId}.${wrongSecret}`,
        topic: 'orders/create',
        body: orderBody(3),
        webhookId: `wh-l3-cause-wrong-secret-${Date.now()}`,
        hmacSecret: KOBA_SECRET,
      });
      expect(res.status()).toBe(401);
      expect((await res.body()).length).toBe(0);
    } finally {
      await admin.auth.admin.deleteUser(merchant.userId);
    }
  });

  test('HMAC invalide (bon jeton, corps non signé par aucune app enregistrée)', async ({
    request,
  }) => {
    const admin = adminClient();
    const merchant = await createMerchant(admin);
    try {
      const conn = await seedConnection(
        admin,
        merchant.merchantAccountId,
        KOBA_CLIENT_ID,
        'bad-hmac',
      );
      const token = await issueToken(admin, conn.storeConnectionId);

      const res = await postIngest(request, {
        token,
        topic: 'orders/create',
        body: orderBody(4),
        webhookId: `wh-l3-cause-bad-hmac-${Date.now()}`,
        hmacSecret: 'not-a-registered-app-secret',
      });
      expect(res.status()).toBe(401);
      expect((await res.body()).length).toBe(0);
    } finally {
      await admin.auth.admin.deleteUser(merchant.userId);
    }
  });

  test('en-tête divergent (couvert en détail par la preuve #1 ci-dessus) — même réponse', async ({
    request,
  }) => {
    const admin = adminClient();
    const merchant = await createMerchant(admin);
    try {
      const conn = await seedConnection(
        admin,
        merchant.merchantAccountId,
        KOBA_CLIENT_ID,
        'hdr-cause',
      );
      const token = await issueToken(admin, conn.storeConnectionId);
      const res = await postIngest(request, {
        token,
        topic: 'orders/create',
        body: orderBody(5),
        webhookId: `wh-l3-cause-header-${Date.now()}`,
        hmacSecret: KOBA_SECRET,
        shopDomainHeader: 'totalement-different.myshopify.com',
      });
      expect(res.status()).toBe(401);
      expect((await res.body()).length).toBe(0);
    } finally {
      await admin.auth.admin.deleteUser(merchant.userId);
    }
  });

  test('jeton révoqué (secret expiré → même verdict) via manipulation directe du registre', async ({
    request,
  }) => {
    const admin = adminClient();
    const merchant = await createMerchant(admin);
    try {
      const conn = await seedConnection(
        admin,
        merchant.merchantAccountId,
        KOBA_CLIENT_ID,
        'revoked',
      );
      const token = generateWebhookToken();
      const { error } = await admin.from('store_connection_webhook_token').insert({
        store_connection_id: conn.storeConnectionId,
        public_id: token.publicId,
        secret_hash: token.secretHash,
        revoked_at: new Date().toISOString(),
      });
      if (error) throw error;

      const res = await postIngest(request, {
        token: token.raw,
        topic: 'orders/create',
        body: orderBody(6),
        webhookId: `wh-l3-cause-revoked-${Date.now()}`,
        hmacSecret: KOBA_SECRET,
      });
      expect(res.status()).toBe(401);
      expect((await res.body()).length).toBe(0);
    } finally {
      await admin.auth.admin.deleteUser(merchant.userId);
    }
  });
});

// --- Preuve #7 : rotation ---------------------------------------------------------------------

test.describe('preuve #7 : rotation — fenêtre bornée, jamais deux secrets valides indéfiniment', () => {
  test('ancien secret encore accepté pendant la fenêtre de grâce, refusé après échéance', async ({
    request,
  }) => {
    const admin = adminClient();
    const merchant = await createMerchant(admin);
    try {
      const conn = await seedConnection(
        admin,
        merchant.merchantAccountId,
        KOBA_CLIENT_ID,
        'rotate',
      );
      const oldToken = generateWebhookToken();
      const newToken = generateWebhookToken();

      // État "juste après rotation" : même public_id, nouveau secret courant, ancien secret en
      // fenêtre de grâce ouverte (60s) — même forme que produirait scripts/l3-generate-webhook-token.mjs.
      const { error: insertError } = await admin.from('store_connection_webhook_token').insert({
        store_connection_id: conn.storeConnectionId,
        public_id: oldToken.publicId,
        secret_hash: newToken.secretHash,
        previous_secret_hash: oldToken.secretHash,
        previous_secret_expires_at: new Date(Date.now() + 60_000).toISOString(),
        rotated_at: new Date().toISOString(),
      });
      if (insertError) throw insertError;

      const orderId = 99_000_000 + Math.floor(Math.random() * 1_000_000);

      // Ancien secret, encore dans la fenêtre → accepté.
      const resOld = await postIngest(request, {
        token: `${oldToken.publicId}.${oldToken.secret}`,
        topic: 'orders/create',
        body: orderBody(orderId),
        webhookId: `wh-l3-rotate-old-open-${orderId}`,
        hmacSecret: KOBA_SECRET,
      });
      expect(resOld.status()).toBe(200);
      await waitForIngestionEvent(admin, `wh-l3-rotate-old-open-${orderId}`);

      // Nouveau secret courant → accepté aussi (jamais un XOR, les deux coexistent pendant la fenêtre).
      const resNew = await postIngest(request, {
        token: `${oldToken.publicId}.${newToken.secret}`,
        topic: 'orders/create',
        body: orderBody(orderId + 1),
        webhookId: `wh-l3-rotate-new-${orderId}`,
        hmacSecret: KOBA_SECRET,
      });
      expect(resNew.status()).toBe(200);

      // Fenêtre expirée (mise à jour directe, pour ne pas attendre 60s réels dans le test) →
      // l'ancien secret cesse d'être accepté.
      await admin
        .from('store_connection_webhook_token')
        .update({ previous_secret_expires_at: new Date(Date.now() - 1_000).toISOString() })
        .eq('public_id', oldToken.publicId);

      const resExpired = await postIngest(request, {
        token: `${oldToken.publicId}.${oldToken.secret}`,
        topic: 'orders/create',
        body: orderBody(orderId + 2),
        webhookId: `wh-l3-rotate-old-expired-${orderId}`,
        hmacSecret: KOBA_SECRET,
      });
      expect(resExpired.status()).toBe(401);

      const { count } = await admin
        .from('ingestion_event')
        .select('id', { count: 'exact', head: true })
        .eq('delivery_id', `wh-l3-rotate-old-expired-${orderId}`);
      expect(count).toBe(0);
    } finally {
      await admin.auth.admin.deleteUser(merchant.userId);
    }
  });
});
