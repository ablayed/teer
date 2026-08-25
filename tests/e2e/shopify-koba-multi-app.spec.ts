import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import {
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  landOnTarget,
  loginViaForm,
  waitForMerchant,
} from './helpers/auth';

// Phase 2 / Lot L0 — Harnais de non-régression Shopify / KOBA.
//
// Diagnostic d'origine (0A-bis) : « La couverture automatisée du chemin KOBA/GETGET SN est
// strictement unitaire... Zéro occurrence de "koba" dans tests/e2e/** ou tests/rls/**. Rien ne
// serait rouge en CI si un webhook était signé avec le mauvais secret, si un OAuth était routé
// vers la mauvaise app, ou en cas de retombée silencieuse sur teer-dev. » Ce fichier ferme ce
// vide, EXCLUSIVEMENT par le canal HTTP réel (Route Handler, HMAC calculé sur le corps brut,
// requêtes authentifiées par cookie de session réel) — jamais par import direct d'une fonction
// de traitement, qui n'exercerait ni la vérification de signature ni le contexte de requête.
//
// Écart constaté vs le prompt de ce lot, à consigner dans le rapport : `tests/e2e/shopify-webhooks.spec.ts`
// couvre DÉJÀ intégralement la protection de régression « topics à identité signée » (PR #143,
// describe "incident cross-tenant resolveShopDomain", 4 tests couvrant app/uninstalled,
// customers/data_request, customers/redact, shop/redact) — mais uniquement sous l'app par défaut
// (teer-dev), aucune boutique de ce fichier ne posant `shopify_client_id`. Le mécanisme testé
// (`resolveSignedShopDomain`) ne dépend d'AUCUN paramètre d'app — il compare uniquement le
// shop_domain du corps signé à celui de l'en-tête, avant toute résolution d'app/secret. Plutôt que
// de dupliquer les 4 tests existants sous teer-koba, ce fichier ajoute UN test ciblé (shop/redact)
// qui généralise cette protection à une boutique réellement rattachée à teer-koba, avec la même
// preuve rouge/vert — la couverture des 3 autres topics reste portée par le fichier existant.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const hasSupabaseAdmin = Boolean(supabaseUrl && serviceRoleKey);

// Credentials par app — lus DIRECTEMENT dans process.env au moment du test (pas une constante
// figée), pour rester la MÊME valeur que celle vue par le serveur Next au démarrage : ci.yml et
// playwright.config.ts (repli local) positionnent l'un ou l'autre AVANT le spawn du webServer,
// et ce fichier doit signer avec exactement ce que `lib/shopify/apps.ts` a chargé.
const KOBA_CLIENT_ID = process.env.SHOPIFY_KOBA_API_KEY ?? '';
const KOBA_SECRET = process.env.SHOPIFY_KOBA_API_SECRET ?? '';
const PILOTE_CLIENT_ID = process.env.SHOPIFY_PILOTE_API_KEY ?? '';
const PILOTE_SECRET = process.env.SHOPIFY_PILOTE_API_SECRET ?? '';
const DEV_CLIENT_ID = process.env.SHOPIFY_API_KEY ?? '';
const DEV_SECRET = process.env.SHOPIFY_API_SECRET ?? '';

const hasMultiAppEnv = Boolean(KOBA_CLIENT_ID && KOBA_SECRET && PILOTE_CLIENT_ID && PILOTE_SECRET);
// Le test PIN « repli silencieux sur teer-dev » n'a de sens que si teer-dev est RÉELLEMENT
// enregistré et donc réellement l'app par défaut de `createShopifyAppRegistry` (premier de
// l'ordre `teer-dev, teer-pilote, teer-marchand, teer-koba`, cf. lib/shopify/apps.ts) — sans
// SHOPIFY_API_KEY/SECRET, teer-dev ne s'enregistre pas et un AUTRE app enregistrée devient le
// défaut à sa place, rendant l'assertion sans objet plutôt que fausse.
const hasDevAppEnv = Boolean(DEV_CLIENT_ID && DEV_SECRET);

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
  const email = `e2e+koba-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

// Seed d'une boutique rattachée à une app précise via `shopify_client_id` — c'est la SEULE
// différence avec `seedShop` de shopify-webhooks.spec.ts (qui laisse toujours ce champ null,
// donc toujours sur l'app par défaut). `clientId: null` reproduit explicitement le cas de repli
// (fixture C du prompt).
async function seedShopForApp(
  admin: AdminClient,
  merchantAccountId: string,
  clientId: string | null,
  label: string,
): Promise<{ shopDomain: string; shopId: string }> {
  const shopDomain = `e2e-koba-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: shopDomain,
      access_token_encrypted: 'dummy',
      scopes: 'read_orders,read_customers,read_products',
      status: 'active',
      shopify_client_id: clientId,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`shop insert failed: ${error?.message ?? 'missing shop'}`);
  return { shopDomain, shopId: data.id };
}

function sign(rawBody: string, secret: string): string {
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
    hmacSecret: string;
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

type WebhookOrder = { id: string };

async function waitForOrder(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  shopifyOrderId: string,
): Promise<WebhookOrder> {
  let order: WebhookOrder | null = null;
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('orders')
          .select('id')
          .eq('merchant_account_id', merchantAccountId)
          .eq('shop_id', shopId)
          .eq('shopify_order_id', shopifyOrderId)
          .maybeSingle();
        order = data as typeof order;
        return order?.id ?? '';
      },
      { timeout: 15_000, intervals: [300, 500, 1000] },
    )
    .not.toBe('');
  if (!order) throw new Error(`Commande Shopify ${shopifyOrderId} introuvable (shop ${shopId})`);
  return order;
}

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

function orderBody(orderId: number, extra: Record<string, unknown> = {}) {
  return {
    id: orderId,
    name: `#KOBA-${orderId}`,
    created_at: '2026-08-24T09:00:00Z',
    updated_at: '2026-08-24T09:00:00Z',
    total_price: '15000',
    currency: 'XOF',
    customer: { id: 90_000_001, first_name: 'Koba', last_name: 'Test', phone: '+221770000000' },
    shipping_address: { address1: 'Rue Koba', city: 'Dakar', name: 'Koba Test' },
    line_items: [{ title: 'Sac', quantity: 1, price: '15000' }],
    ...extra,
  };
}

test.setTimeout(90_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour le harnais KOBA');
test.skip(
  !hasMultiAppEnv,
  'SHOPIFY_KOBA_API_KEY/SECRET et SHOPIFY_PILOTE_API_KEY/SECRET manquants — voir playwright.config.ts (repli local) ou ci.yml (job test-e2e-phase1)',
);

// --- Contrôle positif — OBLIGATOIRE, écrit en premier ------------------------------------------
// Sans lui, tous les tests négatifs ci-dessous passeraient au vert même si l'adaptateur multi-app
// était entièrement cassé (registre toujours vide, HMAC jamais vérifié pour de bonnes raisons).

test('contrôle positif : orders/create signé teer-koba pour la boutique A → 2xx et écriture réelle dans le ledger de A', async ({
  request,
}) => {
  const admin = adminClient();
  const { userId, merchantAccountId } = await createMerchant(admin);
  try {
    const { shopDomain, shopId } = await seedShopForApp(
      admin,
      merchantAccountId,
      KOBA_CLIENT_ID,
      'shopA',
    );
    const orderId = 91_000_000 + Math.floor(Math.random() * 1_000_000);
    const webhookId = `wh-koba-positive-${orderId}`;

    const res = await postWebhook(request, {
      topic: 'orders/create',
      shopDomain,
      webhookId,
      body: orderBody(orderId),
      triggeredAt: '2026-08-24T09:00:01Z',
      hmacSecret: KOBA_SECRET,
    });
    expect(res.status()).toBe(200);

    const order = await waitForOrder(admin, merchantAccountId, shopId, String(orderId));
    expect(order.id).toBeTruthy();
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});

// --- Isolation des secrets -----------------------------------------------------------------

test('isolation des secrets : même payload signé teer-pilote pour la boutique A (teer-koba) → 401, aucune mutation', async ({
  request,
}) => {
  const admin = adminClient();
  const { userId, merchantAccountId } = await createMerchant(admin);
  try {
    const { shopDomain, shopId } = await seedShopForApp(
      admin,
      merchantAccountId,
      KOBA_CLIENT_ID,
      'shopA-isolation',
    );
    const orderId = 92_000_000 + Math.floor(Math.random() * 1_000_000);
    const webhookId = `wh-koba-isolation-${orderId}`;

    const res = await postWebhook(request, {
      topic: 'orders/create',
      shopDomain,
      webhookId,
      body: orderBody(orderId),
      triggeredAt: '2026-08-24T09:01:00Z',
      hmacSecret: PILOTE_SECRET, // mauvais secret pour cette boutique (elle est sous teer-koba)
    });
    expect(res.status()).toBe(401);

    // Absence de mutation vérifiée par lecture, pas seulement par le code de statut : le 401 est
    // renvoyé AVANT tout traitement asynchrone (synchronement, avant recordWebhookReceipt), donc
    // aucune ligne webhook_event ni orders ne peut exister pour cet id — vérifié, pas supposé.
    const { count: eventCount } = await admin
      .from('webhook_event')
      .select('id', { count: 'exact', head: true })
      .eq('shopify_webhook_id', webhookId);
    expect(eventCount).toBe(0);

    const { count: orderCount } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId)
      .eq('shopify_order_id', String(orderId));
    expect(orderCount).toBe(0);
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});

// --- Routage OAuth par app -----------------------------------------------------------------
//
// LIMITE : ceci prouve la décision de routage (le state signé et l'URL d'autorisation portent le
// client_id de teer-koba, jamais celui de teer-dev) et la construction du state signé — PAS un
// OAuth réel contre Shopify. La preuve de bout en bout exige une boutique réelle et le Partner
// Dashboard ; elle reste le critère de sortie de la Phase 2, pas de ce lot.

test('routage OAuth : install pour une boutique rattachée à teer-koba produit une URL et un state signé portant le client_id de teer-koba', async ({
  page,
}) => {
  const admin = adminClient();
  const email = e2eEmail('koba-oauth');
  const userId = await createConfirmedUser(admin, email);
  try {
    await waitForMerchant(admin, userId);
    await loginViaForm(page, email, e2ePassword, '/boutiques');
    await landOnTarget(page, '/boutiques');

    const shopDomain = `e2e-koba-oauth-${Date.now()}.myshopify.com`;
    const response = await page.request.get(
      `/api/shopify/install?shop=${encodeURIComponent(shopDomain)}&client_id=${encodeURIComponent(KOBA_CLIENT_ID)}&return_to=${encodeURIComponent('/shopify/embedded')}`,
      { maxRedirects: 0 },
    );

    // NextResponse.redirect() émet un 307 (temporary redirect) par défaut, pas un 302.
    expect(response.status()).toBe(307);
    const location = response.headers().location ?? '';
    expect(location).toContain(`client_id=${KOBA_CLIENT_ID}`);
    // Jamais l'app par défaut (teer-dev) — c'est la régression que ce test épingle.
    const devClientId = process.env.SHOPIFY_API_KEY ?? '';
    if (devClientId) {
      expect(location).not.toContain(`client_id=${devClientId}`);
    }

    const setCookieHeader = response.headers()['set-cookie'] ?? '';
    const stateMatch = setCookieHeader.match(/shopify_oauth_state=([^;]+)/);
    expect(stateMatch).not.toBeNull();
    const stateToken = decodeURIComponent(stateMatch?.[1] ?? '');
    const [base64Payload] = stateToken.split('.');
    const statePayload = JSON.parse(Buffer.from(base64Payload, 'base64url').toString('utf8')) as {
      clientId?: string;
    };
    expect(statePayload.clientId).toBe(KOBA_CLIENT_ID);
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});

// --- Comportements ouverts — épinglés, JAMAIS corrigés ici --------------------------------------

test.describe('comportements ouverts épinglés (protection de non-régression, pas un correctif)', () => {
  test("PIN — repli silencieux sur teer-dev pour shopify_client_id NULL (DÉCISION L2 : le chemin legacy N'EST PAS inversé, seule la double écriture est refusée — voir corps du test)", async ({
    request,
  }) => {
    test.skip(
      !hasDevAppEnv,
      'SHOPIFY_API_KEY/SECRET manquants localement — sans eux teer-dev ne devient pas le défaut réel (voir hasDevAppEnv). Toujours présents en CI (ci.yml, test-e2e-phase1).',
    );
    // Justification consignée, corrigée après coup : le titre de ce test annonçait "À INVERSER
    // PAR LE LOT L2 : une connexion inconnue doit devenir un refus". Le Lot L2 (branche
    // phase2/lot-l2-platform-connector) a tranché l'INVERSE, délibérément : inverser le repli
    // aurait changé le comportement OBSERVABLE du webhook (200 → 401/silence) pour toute boutique
    // réelle sans shopify_client_id enregistré, un changement à plus large rayon que celui promis
    // par le prompt du lot ("aucune modification de la résolution boutique des webhooks"). Casser
    // une ingestion de commande réelle en production pour fermer un repli n'était pas justifiable
    // sans décision produit explicite. Le repli synchrone reste donc TEL QUEL, épinglé comme
    // avant — mais la double écriture (ingestion_event/external_ref, lib/ingestion/
    // shopify-dual-write.ts) refuse bien cette boutique : aucune store_connection n'existe pour
    // elle (jamais créée hors du backfill 0142 ou du callback OAuth), donc
    // resolveConnectionForWebhook renvoie 'unknown_connection'. C'est la seule inversion réelle
    // livrée par L2 pour ce scénario, vérifiée ci-dessous plutôt qu'affirmée.
    const admin = adminClient();
    const { userId, merchantAccountId } = await createMerchant(admin);
    try {
      // Fixture C du prompt : shopify_client_id NULL, même tenant que d'autres boutiques.
      const { shopDomain, shopId } = await seedShopForApp(admin, merchantAccountId, null, 'shopC');
      const orderId = 93_000_000 + Math.floor(Math.random() * 1_000_000);

      // (a) signé avec le secret de l'app par défaut (teer-dev) → verifie et écrit — preuve du
      // repli, pas d'une coïncidence : la boutique n'a AUCUNE app enregistrée. Comportement
      // INCHANGÉ par L2.
      const webhookIdDefault = `wh-koba-fallback-ok-${orderId}`;
      const resDefault = await postWebhook(request, {
        topic: 'orders/create',
        shopDomain,
        webhookId: webhookIdDefault,
        body: orderBody(orderId),
        triggeredAt: '2026-08-24T09:02:00Z',
        hmacSecret: DEV_SECRET,
      });
      expect(resDefault.status()).toBe(200);
      await waitForOrder(admin, merchantAccountId, shopId, String(orderId));

      // Décision L2, vérifiée : le chemin legacy réussit (ci-dessus) MAIS la double écriture est
      // refusée — aucune ligne ingestion_event pour ce webhook, connexion inconnue.
      await expect
        .poll(
          async () => {
            const { data } = await admin
              .from('webhook_event')
              .select('status')
              .eq('shopify_webhook_id', webhookIdDefault)
              .maybeSingle();
            return data?.status ?? '';
          },
          { timeout: 10_000, intervals: [200, 400, 800] },
        )
        .toBe('done');
      const { count: ingestionCount } = await admin
        .from('ingestion_event')
        .select('id', { count: 'exact', head: true })
        .eq('delivery_id', webhookIdDefault);
      expect(ingestionCount).toBe(0);

      // (b) signé avec un AUTRE secret enregistré (teer-koba) → échoue quand même : la boutique
      // n'est pas « ouverte à tout secret », elle est bien liée SPÉCIFIQUEMENT à teer-dev par le
      // repli, comportement actuel que ce test fige. INCHANGÉ par L2 (le recoupement d'app de L2
      // vit APRÈS la vérification HMAC synchrone, jamais à sa place).
      const orderId2 = orderId + 1;
      const resOther = await postWebhook(request, {
        topic: 'orders/create',
        shopDomain,
        webhookId: `wh-koba-fallback-other-${orderId2}`,
        body: orderBody(orderId2),
        triggeredAt: '2026-08-24T09:02:01Z',
        hmacSecret: KOBA_SECRET,
      });
      expect(resOther.status()).toBe(401);
    } finally {
      await admin.auth.admin.deleteUser(userId);
    }
  });

  test('PIN — x-shopify-shop-domain fait autorité sur orders/create même si le corps porte un shop_domain contradictoire (À INVERSER PAR LE LOT L3 : résolution par URL opaque)', async ({
    request,
  }) => {
    const admin = adminClient();
    const victim = await createMerchant(admin);
    const attacker = await createMerchant(admin);
    try {
      const { shopDomain: shopDomainA, shopId: shopIdA } = await seedShopForApp(
        admin,
        victim.merchantAccountId,
        KOBA_CLIENT_ID,
        'header-authority-A',
      );
      const { shopDomain: shopDomainB } = await seedShopForApp(
        admin,
        attacker.merchantAccountId,
        PILOTE_CLIENT_ID,
        'header-authority-B',
      );
      const orderId = 94_000_000 + Math.floor(Math.random() * 1_000_000);

      // orders/create ne porte structurellement aucun shop_domain dans un vrai payload Shopify
      // (cf. incident 2026-08-23) — on en ajoute un ARTIFICIELLEMENT ici, avec une valeur
      // CONTRADICTOIRE (boutique B), pour prouver que resolveShopDomain (non signé, contrairement
      // à resolveSignedShopDomain des topics GDPR) ignore le corps et retient l'en-tête (boutique
      // A) sans même le comparer. Header et HMAC désignent A (teer-koba) de façon cohérente.
      const res = await postWebhook(request, {
        topic: 'orders/create',
        shopDomain: shopDomainA,
        webhookId: `wh-koba-header-authority-${orderId}`,
        body: orderBody(orderId, { shop_domain: shopDomainB }),
        triggeredAt: '2026-08-24T09:03:00Z',
        hmacSecret: KOBA_SECRET,
      });
      expect(res.status()).toBe(200);

      // Preuve positive : la commande atterrit chez A (l'en-tête), pas chez B (le corps).
      await waitForOrder(admin, victim.merchantAccountId, shopIdA, String(orderId));
      const { count: orderCountB } = await admin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', attacker.merchantAccountId)
        .eq('shopify_order_id', String(orderId));
      expect(orderCountB).toBe(0);
    } finally {
      await admin.auth.admin.deleteUser(victim.userId);
      await admin.auth.admin.deleteUser(attacker.userId);
    }
  });
});

// --- Topics à identité signée — généralisation de la protection PR #143 à teer-koba -------------
//
// tests/e2e/shopify-webhooks.spec.ts couvre déjà les 4 topics (app/uninstalled,
// customers/data_request, customers/redact, shop/redact) sous l'app par défaut. Le mécanisme
// (`resolveSignedShopDomain`) ne dépend d'aucune app — ce test unique généralise la preuve à une
// boutique réellement rattachée à teer-koba, sans dupliquer les 3 autres topics déjà couverts.

test('shop/redact : corps signé pour B (teer-pilote), en-tête forgé vers A (teer-koba) → refus avant écriture', async ({
  request,
}) => {
  const admin = adminClient();
  const victim = await createMerchant(admin);
  const attacker = await createMerchant(admin);
  try {
    const { shopDomain: shopDomainA, shopId: shopIdA } = await seedShopForApp(
      admin,
      victim.merchantAccountId,
      KOBA_CLIENT_ID,
      'shop-redact-A',
    );
    const { shopDomain: shopDomainB } = await seedShopForApp(
      admin,
      attacker.merchantAccountId,
      PILOTE_CLIENT_ID,
      'shop-redact-B',
    );

    // Client réel côté victime (A), pour prouver qu'il survit intact si le correctif tient.
    const sharedCustomerId = String(95_000_000 + Math.floor(Math.random() * 1_000_000));
    const { data: seededCustomer, error: seedError } = await admin
      .from('customer')
      .insert({
        merchant_account_id: victim.merchantAccountId,
        shopify_customer_id: sharedCustomerId,
        full_name: 'Client Koba Victime',
        phone: '+221770000321',
      })
      .select('id, full_name, phone')
      .single();
    if (seedError || !seededCustomer) {
      throw new Error(`customer fixture insert failed: ${seedError?.message ?? 'missing row'}`);
    }

    const webhookId = `wh-koba-forged-shop-redact-${shopIdA}`;
    const res = await postWebhook(request, {
      topic: 'shop/redact',
      shopDomain: shopDomainA, // en-tête forgé : boutique VICTIME (teer-koba)
      webhookId,
      body: { shop_domain: shopDomainB }, // corps réellement signé pour l'ATTAQUANT (teer-pilote)
      triggeredAt: '2026-08-24T10:00:00Z',
      hmacSecret: KOBA_SECRET, // le HMAC est routé sur l'app de l'en-tête (A → teer-koba)
    });
    // La réponse HTTP est toujours 2xx (traitement dans after()) : ne rien en déduire du statut.
    expect(res.status()).toBe(200);

    const event = await waitForTerminalWebhookEvent(admin, webhookId);
    expect(event.last_error_code).toBe('gdpr_shop_domain_mismatch');

    const { data: customerAfter } = await admin
      .from('customer')
      .select('full_name, phone')
      .eq('id', seededCustomer.id)
      .single();
    expect(customerAfter).toMatchObject({
      full_name: 'Client Koba Victime',
      phone: '+221770000321',
    });

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
