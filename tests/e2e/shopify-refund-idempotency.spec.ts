import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';

// Phase 2 — idempotence métier de refunds/create (précondition de la bascule L3, migration 0144).
//
// Diagnostic (rapport de session dédié) : `refunds/create` était le SEUL topic webhook Shopify
// sans filet d'idempotence métier — un `insert` inconditionnel dans `audit_log`, sans clé de
// déduplication ni select préalable. Deux `delivery_id` distincts pour le MÊME remboursement
// (le scénario exact d'une bascule d'abonnement mal séquencée — une déclaration app-level et un
// abonnement Admin API livrant tous deux le même événement) produisaient deux lignes.
//
// Ce fichier prouve la garde par le vrai canal HTTP (`/api/shopify/webhooks`, HMAC calculé sur le
// corps brut) — jamais par appel direct de `record_shopify_refund_receipt`.

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
): Promise<{ userId: string; merchantAccountId: string }> {
  const email = `e2e+refund-idem-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

// Boutique rattachée à teer-koba (shopify_client_id) + store_connection correspondante — sans les
// deux, resolveShopConnection() renvoie null et le repli non-gardé s'applique (comportement voulu
// pour cette autre situation, testé séparément — pas l'objet de ce fichier).
async function seedConnectedShop(
  admin: AdminClient,
  merchantAccountId: string,
  label: string,
): Promise<{ shopId: string; shopDomain: string; storeConnectionId: string }> {
  const shopDomain = `e2e-refund-idem-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`;
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
    })
    .select('id')
    .single();
  if (connectionError || !connection) {
    throw new Error(`store_connection insert failed: ${connectionError?.message}`);
  }

  return { shopId: shop.id, shopDomain, storeConnectionId: connection.id };
}

async function seedOrder(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  shopifyOrderId: string,
): Promise<string> {
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      shopify_order_id: shopifyOrderId,
      order_number: `refund-idem-${shopifyOrderId}`,
      total_amount: 15000,
      currency: 'XOF',
      cod_status: 'LIVREE',
      order_state: 'open',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`order insert failed: ${error?.message}`);
  return data.id;
}

function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

async function postRefundWebhook(
  request: import('@playwright/test').APIRequestContext,
  {
    shopDomain,
    webhookId,
    body,
  }: {
    shopDomain: string;
    webhookId: string;
    body: unknown;
  },
) {
  const rawBody = JSON.stringify(body);
  return request.post('/api/shopify/webhooks', {
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': sign(rawBody, KOBA_SECRET),
      'x-shopify-topic': 'refunds/create',
      'x-shopify-shop-domain': shopDomain,
      'x-shopify-webhook-id': webhookId,
      'x-shopify-triggered-at': '2026-08-26T09:00:00Z',
    },
    data: rawBody,
  });
}

function refundBody(refundId: number, orderId: string, amount = '15000.00') {
  return {
    id: refundId,
    order_id: orderId,
    created_at: '2026-08-26T09:00:00Z',
    transactions: [
      {
        amount,
        gateway: 'wave',
        kind: 'refund',
        status: 'success',
      },
    ],
  };
}

async function countRefundAuditRows(
  admin: AdminClient,
  merchantAccountId: string,
): Promise<number> {
  const { data } = await admin
    .from('audit_log')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('action', 'shopify.refund_received');
  // Aucune colonne dédiée pour l'id du remboursement dans audit_log (piste d'audit, pas la source
  // de vérité de l'idempotence — celle-ci vit dans store_connection_resource_receipt). On ne peut
  // donc pas filtrer côté requête par id de remboursement ; on compare tout le payload retourné
  // par le webhook_event correspondant. Plus simple et suffisant ici : compter le total de lignes
  // pour ce tenant et laisser chaque test contrôler qu'il seed un tenant dédié (déjà le cas,
  // createMerchant() par test) pour que "toutes les lignes du tenant" == "toutes les lignes pour
  // CE remboursement" quand un seul remboursement y a été posté.
  return (data ?? []).length;
}

test.setTimeout(90_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes');
test.skip(!hasKobaEnv, 'SHOPIFY_KOBA_API_KEY/SECRET manquants — voir ci.yml (test-e2e-phase1)');

// --- Contrôle positif — OBLIGATOIRE, écrit en premier -------------------------------------------

test('contrôle positif : un remboursement produit une écriture audit + met à jour financial_status', async ({
  request,
}) => {
  const admin = adminClient();
  const merchant = await createMerchant(admin);
  try {
    const { shopId, shopDomain } = await seedConnectedShop(
      admin,
      merchant.merchantAccountId,
      'positive',
    );
    const shopifyOrderId = String(80_000_000 + Math.floor(Math.random() * 1_000_000));
    const orderId = await seedOrder(admin, merchant.merchantAccountId, shopId, shopifyOrderId);
    const refundId = 70_000_000 + Math.floor(Math.random() * 1_000_000);

    const res = await postRefundWebhook(request, {
      shopDomain,
      webhookId: `wh-refund-positive-${refundId}`,
      body: refundBody(refundId, shopifyOrderId),
    });
    expect(res.status()).toBe(200);

    await expect
      .poll(async () => countRefundAuditRows(admin, merchant.merchantAccountId), {
        timeout: 10_000,
        intervals: [300, 500, 1000],
      })
      .toBe(1);

    const { data: orderAfter } = await admin
      .from('orders')
      .select('financial_status, shopify_financial_status')
      .eq('id', orderId)
      .single();
    expect(orderAfter?.financial_status).toBe('partially_refunded');
    expect(orderAfter?.shopify_financial_status).toBe('partially_refunded');
  } finally {
    await admin.auth.admin.deleteUser(merchant.userId);
  }
});

// --- Preuve #1 : même remboursement, deux delivery_id distincts → une seule écriture ------------

test('preuve #1 : même remboursement livré deux fois (delivery_id différents) → une seule écriture métier', async ({
  request,
}) => {
  const admin = adminClient();
  const merchant = await createMerchant(admin);
  try {
    const { shopId, shopDomain } = await seedConnectedShop(
      admin,
      merchant.merchantAccountId,
      'dup-delivery',
    );
    const shopifyOrderId = String(81_000_000 + Math.floor(Math.random() * 1_000_000));
    await seedOrder(admin, merchant.merchantAccountId, shopId, shopifyOrderId);
    const refundId = 71_000_000 + Math.floor(Math.random() * 1_000_000);
    const body = refundBody(refundId, shopifyOrderId);

    const res1 = await postRefundWebhook(request, {
      shopDomain,
      webhookId: `wh-refund-dup-a-${refundId}`,
      body,
    });
    expect(res1.status()).toBe(200);

    await expect
      .poll(async () => countRefundAuditRows(admin, merchant.merchantAccountId), {
        timeout: 10_000,
        intervals: [300, 500, 1000],
      })
      .toBe(1);

    // Deuxième livraison : MÊME remboursement (même `id`), delivery_id DIFFÉRENT — le scénario
    // exact de la bascule (déclaration app-level + abonnement Admin API livrant tous deux le même
    // événement, chacun avec sa propre identité de livraison).
    const res2 = await postRefundWebhook(request, {
      shopDomain,
      webhookId: `wh-refund-dup-b-${refundId}`,
      body,
    });
    expect(res2.status()).toBe(200);

    // Attente courte pour laisser une éventuelle (mauvaise) seconde écriture apparaître avant de
    // conclure — un poll qui s'arrête au premier match ne prouverait rien ici.
    await new Promise((r) => setTimeout(r, 1500));
    const count = await countRefundAuditRows(admin, merchant.merchantAccountId);
    expect(count).toBe(1);
  } finally {
    await admin.auth.admin.deleteUser(merchant.userId);
  }
});

// --- Preuve #2 : deux remboursements distincts sur la même commande → deux écritures ------------
// Contrôle positif de la spécificité de la garde : sans lui, une garde trop large (clée par
// exemple sur order_id seul) passerait pour un succès à la preuve #1 tout en cassant ce cas.

test('preuve #2 : deux remboursements partiels distincts sur la même commande → deux écritures', async ({
  request,
}) => {
  const admin = adminClient();
  const merchant = await createMerchant(admin);
  try {
    const { shopId, shopDomain } = await seedConnectedShop(
      admin,
      merchant.merchantAccountId,
      'two-refunds',
    );
    const shopifyOrderId = String(82_000_000 + Math.floor(Math.random() * 1_000_000));
    await seedOrder(admin, merchant.merchantAccountId, shopId, shopifyOrderId);
    const refundIdA = 72_000_000 + Math.floor(Math.random() * 1_000_000);
    const refundIdB = refundIdA + 1;

    const resA = await postRefundWebhook(request, {
      shopDomain,
      webhookId: `wh-refund-two-a-${refundIdA}`,
      body: refundBody(refundIdA, shopifyOrderId, '5000.00'),
    });
    expect(resA.status()).toBe(200);

    const resB = await postRefundWebhook(request, {
      shopDomain,
      webhookId: `wh-refund-two-b-${refundIdB}`,
      body: refundBody(refundIdB, shopifyOrderId, '3000.00'),
    });
    expect(resB.status()).toBe(200);

    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from('audit_log')
            .select('id')
            .eq('merchant_account_id', merchant.merchantAccountId)
            .eq('action', 'shopify.refund_received');
          return data?.length ?? 0;
        },
        { timeout: 10_000, intervals: [300, 500, 1000] },
      )
      .toBe(2);
  } finally {
    await admin.auth.admin.deleteUser(merchant.userId);
  }
});

// --- Preuve #3 : rejeu d'un delivery_id identique → aucune écriture supplémentaire --------------
// Comportement existant (déduplication au niveau webhook_event, AVANT handleRefundWebhook),
// non-régression — pas le mécanisme livré par ce lot, mais un rejeu à ce niveau ne doit toujours
// produire aucune écriture supplémentaire après ce lot non plus.

test('preuve #3 (non-régression) : rejeu du même delivery_id → aucune écriture supplémentaire', async ({
  request,
}) => {
  const admin = adminClient();
  const merchant = await createMerchant(admin);
  try {
    const { shopId, shopDomain } = await seedConnectedShop(
      admin,
      merchant.merchantAccountId,
      'replay',
    );
    const shopifyOrderId = String(83_000_000 + Math.floor(Math.random() * 1_000_000));
    await seedOrder(admin, merchant.merchantAccountId, shopId, shopifyOrderId);
    const refundId = 73_000_000 + Math.floor(Math.random() * 1_000_000);
    const webhookId = `wh-refund-replay-${refundId}`;
    const body = refundBody(refundId, shopifyOrderId);

    const res1 = await postRefundWebhook(request, { shopDomain, webhookId, body });
    expect(res1.status()).toBe(200);
    await expect
      .poll(async () => countRefundAuditRows(admin, merchant.merchantAccountId), {
        timeout: 10_000,
        intervals: [300, 500, 1000],
      })
      .toBe(1);

    const res2 = await postRefundWebhook(request, { shopDomain, webhookId, body });
    expect(res2.status()).toBe(200);

    await new Promise((r) => setTimeout(r, 1000));
    const count = await countRefundAuditRows(admin, merchant.merchantAccountId);
    expect(count).toBe(1);
  } finally {
    await admin.auth.admin.deleteUser(merchant.userId);
  }
});

// --- Preuve #4 : sûreté en concurrence ------------------------------------------------------

test('preuve #4 : deux livraisons du même remboursement en parallèle → une seule écriture', async ({
  request,
}) => {
  const admin = adminClient();
  const merchant = await createMerchant(admin);
  try {
    const { shopId, shopDomain } = await seedConnectedShop(
      admin,
      merchant.merchantAccountId,
      'concurrent',
    );
    const shopifyOrderId = String(84_000_000 + Math.floor(Math.random() * 1_000_000));
    await seedOrder(admin, merchant.merchantAccountId, shopId, shopifyOrderId);
    const refundId = 74_000_000 + Math.floor(Math.random() * 1_000_000);
    const body = refundBody(refundId, shopifyOrderId);

    // Deux requêtes HTTP réellement concurrentes, delivery_id distincts. La garde
    // (contrainte unique + `on conflict do nothing` en base) est ce qui rend ce test possible :
    // un `select` applicatif préalable laisserait une course où les deux requêtes verraient
    // "pas encore inséré" avant que l'une des deux n'insère.
    const [res1, res2] = await Promise.all([
      postRefundWebhook(request, {
        shopDomain,
        webhookId: `wh-refund-concurrent-a-${refundId}`,
        body,
      }),
      postRefundWebhook(request, {
        shopDomain,
        webhookId: `wh-refund-concurrent-b-${refundId}`,
        body,
      }),
    ]);
    expect(res1.status()).toBe(200);
    expect(res2.status()).toBe(200);

    await new Promise((r) => setTimeout(r, 1500));
    const count = await countRefundAuditRows(admin, merchant.merchantAccountId);
    expect(count).toBe(1);
  } finally {
    await admin.auth.admin.deleteUser(merchant.userId);
  }
});
