/**
 * APP-03 / Lot 2 — correctif 3, §2 : preuve que `resolveShopActive` (lib/shopify/webhook-core.ts)
 * refuse désormais une boutique `status='active'` sans `access_token_encrypted` (rattachement
 * embarqué en attente du token exchange, `lib/shopify/embedded-link-write.ts`) — état dont ce
 * module était le seul, dans tout le dépôt, à ne pas déjà l'exclure (cf. `shop-status.ts` côté UI,
 * `lib/actions/shopify.ts#getShopConnection` côté lecture `/commandes`).
 *
 * Exerce le VRAI pipeline webhook : `resolveShopForTopic` (résolution) + `dispatchWebhookCore`
 * (dispatch), les deux fonctions réellement appelées par les deux endpoints HTTP
 * (app/api/shopify/webhooks/route.ts, app/api/shopify/ingest/[token]/route.ts) — jamais un filtre
 * réimplémenté ou mocké ici.
 *
 * Quatre garanties, testées séparément :
 * 1. Négatif — les 8 topics "actifs" (orders/*, products/*, refunds/create, bulk_operations/finish)
 *    refusent la résolution sur une boutique sans jeton (`resolveShopForTopic` renvoie `null`).
 * 2. Négatif, bout en bout — pour deux de ces topics (orders/create, products/create),
 *    `dispatchWebhookCore` avec `shop: null` n'écrit RIEN dans `orders`/`product`.
 * 3. Positif, contrôle — la même boutique, avec un jeton non nul, résout normalement ET
 *    `dispatchWebhookCore` écrit réellement une ligne (comportement inchangé pour le cas courant).
 * 4. Positif, exception nommée — `app/uninstalled` reste résolu et intégralement traité sur cette
 *    même boutique sans jeton (LENIENT_TOPICS), et son traitement nulle désormais aussi
 *    `access_token_encrypted` (second correctif de ce lot, `processAppUninstalledCore`).
 *
 * Mutation testée manuellement (rapportée dans le rapport de fin de lot, pas ici) : retirer
 * `.not('access_token_encrypted', 'is', null)` de `resolveShopActive` fait repasser le test 1 et le
 * test 2 au rouge (la boutique sans jeton redevient résolue, la commande/le produit sont écrits).
 */

import { randomUUID } from 'node:crypto';
import {
  dispatchWebhookCore,
  resolveShopForTopic,
  runResolvedWebhookEvent,
} from '@/lib/shopify/webhook-core';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const password = 'webhook-incomplete-connection-test-pw';
const createdUserIds: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

type AdminClient = SupabaseClient<Database>;

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createConfirmedUser(admin: AdminClient, email: string) {
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
  for (let i = 0; i < 20; i++) {
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

async function createShop(
  admin: AdminClient,
  merchantAccountId: string,
  accessTokenEncrypted: string | null,
) {
  const shopDomain = `webhook-incomplete-${Date.now()}-${randomUUID()}.myshopify.com`;
  const { data: shop, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: shopDomain,
      access_token_encrypted: accessTokenEncrypted,
      scopes: 'read_orders',
      status: 'active',
    })
    .select('*')
    .single();
  if (error || !shop) throw new Error(`shop insert failed: ${error?.message}`);
  return shop;
}

const ACTIVE_REQUIRED_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'orders/fulfilled',
  'products/create',
  'products/update',
  'refunds/create',
  'bulk_operations/finish',
] as const;

function buildOrderPayload(shopifyOrderId: string) {
  return {
    id: shopifyOrderId,
    name: `#${shopifyOrderId}`,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    financial_status: 'paid',
    fulfillment_status: null,
    total_price: '10000',
    currency: 'XOF',
    line_items: [{ title: 'Article test', sku: null, quantity: 1, price: '10000' }],
  };
}

function buildProductPayload(shopifyProductId: string) {
  return {
    id: shopifyProductId,
    title: 'Produit test',
    status: 'active',
    variants: [{ id: `${shopifyProductId}-v1`, title: 'Default Title', sku: null }],
  };
}

describe('resolveShopActive — connexion incomplète (access_token_encrypted null)', () => {
  afterEach(async () => {
    if (!serviceRoleKey || createdUserIds.length === 0) return;
    const admin = adminClient();
    for (const userId of createdUserIds.splice(0)) {
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    }
  });

  skipIfNoServiceRole(
    'les 8 topics actifs refusent la résolution sur une boutique sans jeton',
    async () => {
      const admin = adminClient();
      const email = `webhook-incomplete-resolve-${Date.now()}-${randomUUID()}@example.com`;
      const userId = await createConfirmedUser(admin, email);
      const merchantAccountId = await waitForMerchantAccount(admin, userId);
      const shop = await createShop(admin, merchantAccountId, null);

      for (const topic of ACTIVE_REQUIRED_TOPICS) {
        const resolved = await resolveShopForTopic(admin, topic, {
          by: 'domain',
          shopDomain: shop.shop_domain,
        });
        expect(resolved, `topic=${topic} devrait refuser la résolution`).toBeNull();
      }
    },
  );

  skipIfNoServiceRole(
    "orders/create et products/create n'écrivent rien sur une boutique sans jeton",
    async () => {
      const admin = adminClient();
      const email = `webhook-incomplete-noop-${Date.now()}-${randomUUID()}@example.com`;
      const userId = await createConfirmedUser(admin, email);
      const merchantAccountId = await waitForMerchantAccount(admin, userId);
      const shop = await createShop(admin, merchantAccountId, null);

      const shopifyOrderId = randomUUID().replace(/-/g, '').slice(0, 12);
      const shopifyProductId = randomUUID().replace(/-/g, '').slice(0, 12);

      // Miroir exact des deux routes réelles : `shop` doit passer par resolveShopForTopic avant
      // dispatchWebhookCore — jamais reconstruit ici.
      const resolvedForOrder = await resolveShopForTopic(admin, 'orders/create', {
        by: 'domain',
        shopDomain: shop.shop_domain,
      });
      await dispatchWebhookCore({
        supabase: admin,
        shop: resolvedForOrder,
        eventId: randomUUID(),
        topic: 'orders/create',
        payload: buildOrderPayload(shopifyOrderId),
        webhookId: randomUUID(),
        triggeredAt: new Date().toISOString(),
      });

      const resolvedForProduct = await resolveShopForTopic(admin, 'products/create', {
        by: 'domain',
        shopDomain: shop.shop_domain,
      });
      await dispatchWebhookCore({
        supabase: admin,
        shop: resolvedForProduct,
        eventId: randomUUID(),
        topic: 'products/create',
        payload: buildProductPayload(shopifyProductId),
        webhookId: randomUUID(),
        triggeredAt: new Date().toISOString(),
      });

      const { count: orderCount } = await admin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('shop_id', shop.id)
        .eq('shopify_order_id', shopifyOrderId);
      const { count: productCount } = await admin
        .from('product')
        .select('id', { count: 'exact', head: true })
        .eq('shop_id', shop.id)
        .eq('shopify_product_id', shopifyProductId);

      expect(orderCount ?? 0).toBe(0);
      expect(productCount ?? 0).toBe(0);
    },
  );

  skipIfNoServiceRole(
    'contrôle positif — même boutique avec un jeton non nul : résolution et écriture inchangées',
    async () => {
      const admin = adminClient();
      const email = `webhook-incomplete-control-${Date.now()}-${randomUUID()}@example.com`;
      const userId = await createConfirmedUser(admin, email);
      const merchantAccountId = await waitForMerchantAccount(admin, userId);
      const shop = await createShop(admin, merchantAccountId, 'dummy-access-token');

      const shopifyOrderId = randomUUID().replace(/-/g, '').slice(0, 12);

      const resolved = await resolveShopForTopic(admin, 'orders/create', {
        by: 'domain',
        shopDomain: shop.shop_domain,
      });
      expect(resolved).not.toBeNull();

      await dispatchWebhookCore({
        supabase: admin,
        shop: resolved,
        eventId: randomUUID(),
        topic: 'orders/create',
        payload: buildOrderPayload(shopifyOrderId),
        webhookId: randomUUID(),
        triggeredAt: new Date().toISOString(),
      });

      const { count: orderCount } = await admin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('shop_id', shop.id)
        .eq('shopify_order_id', shopifyOrderId);

      expect(orderCount ?? 0).toBe(1);
    },
  );

  skipIfNoServiceRole(
    'exception nommée — app/uninstalled reste traitable sur une boutique sans jeton, et nulle access_token_encrypted',
    async () => {
      const admin = adminClient();
      const email = `webhook-incomplete-uninstall-${Date.now()}-${randomUUID()}@example.com`;
      const userId = await createConfirmedUser(admin, email);
      const merchantAccountId = await waitForMerchantAccount(admin, userId);
      const shop = await createShop(admin, merchantAccountId, null);

      const resolved = await resolveShopForTopic(admin, 'app/uninstalled', {
        by: 'domain',
        shopDomain: shop.shop_domain,
      });
      expect(resolved).not.toBeNull();

      const eventId = randomUUID();
      await admin.from('webhook_event').insert({
        id: eventId,
        shopify_webhook_id: randomUUID(),
        topic: 'app/uninstalled',
        shop_domain: shop.shop_domain,
        shop_id: shop.id,
        merchant_account_id: merchantAccountId,
        payload: {},
        status: 'processing',
        attempt_count: 1,
        lease_until: new Date(Date.now() + 5 * 60_000).toISOString(),
      });

      await runResolvedWebhookEvent({
        supabase: admin,
        eventId,
        shop: resolved,
        topic: 'app/uninstalled',
        payload: {},
        webhookId: randomUUID(),
        triggeredAt: new Date().toISOString(),
      });

      const { data: after, error } = await admin
        .from('shop')
        .select('status, access_token_encrypted')
        .eq('id', shop.id)
        .single();
      if (error) throw error;

      expect(after.status).toBe('uninstalled');
      expect(after.access_token_encrypted).toBeNull();
    },
  );
});
