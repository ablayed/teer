/**
 * Phase F — Lot R2 : correctif du second emplacement du même défaut, identifié en revue avant
 * fusion de R1 et étendu dans ce lot sur demande explicite (même motif, même clé, même correctif,
 * un seul test peut couvrir les deux — décision consignée dans le rapport de fin de lot).
 *
 * `processRefundCore` (lib/shopify/webhook-core.ts) rattachait un remboursement à une commande
 * locale en cherchant par `(merchant_account_id, shopify_order_id)` — même défaut que
 * `persistShopifyOrder`. Pour un marchand multi-boutiques, un `shopify_order_id` identique sur
 * deux boutiques distinctes pouvait faire rattacher le remboursement (et la mise à jour de
 * `financial_status` qui en découle) à la commande de la MAUVAISE boutique — de l'argent imputé au
 * mauvais tenant.
 *
 * Ce test est DISTINCT de `shopify-reconcile-cross-shop-order-id-collision.rls.test.ts` (qui
 * couvre `persistShopifyOrder`) : il prouve la même correction sur `processRefundCore`
 * spécifiquement, en passant par `dispatchWebhookCore` (le point d'entrée réel, `shop` déjà
 * résolu par l'appelant — jamais un domaine/jeton reconstruit ici).
 *
 * Mutation-testé (rapporté dans le rapport de fin de lot, pas dans ce fichier) : retirer le
 * `.eq('shop_id', shop.id)` ajouté par R2 dans `processRefundCore` fait repasser ce test au rouge.
 * Manifestation exacte observée (le correctif de `persistShopifyOrder` étant déjà en place dans ce
 * lot, les deux commandes A/B coexistent réellement en base — voir le fichier collision) :
 * `.maybeSingle()` sur une résolution non scopée par boutique trouve DEUX lignes au lieu d'une et
 * lève une erreur Postgrest, que `processRefundCore` traduit en `shopify_refund_order_lookup_failed`
 * — le remboursement échoue entièrement (classé retryable, jamais silencieusement perdu, mais
 * jamais traité non plus) plutôt que d'être mal attribué. C'est une preuve différente, mais
 * équivalente, du même défaut de portée : sans le correctif, `processRefundCore` est structurellement
 * incapable de traiter un remboursement dès qu'un compte marchand a deux boutiques partageant un
 * `shopify_order_id`.
 *
 * Idempotence des remboursements (migration 0144, `record_shopify_refund_receipt`) : clé
 * `(store_connection_id, resource_kind, external_id)`, indépendante de `local_order_id` — ce lot ne
 * touche ni la fonction SQL ni les arguments de l'appel RPC, seulement la résolution TS en amont
 * qui alimente `p_local_order_id`. Ce test exerce volontairement le chemin SANS `store_connection`
 * (aucune ligne créée pour les boutiques du test) — la branche de repli non gardée décrite dans
 * `CLAUDE.md` — pour isoler la question testée ici (portée du SELECT de résolution de commande) de
 * la mécanique d'idempotence, déjà couverte indépendamment par `tests/e2e/shopify-refund-
 * idempotency.spec.ts`, non affectée par ce diff.
 */

import { randomUUID } from 'node:crypto';
import { persistShopifyOrder } from '@/lib/shopify/orders-sync';
import type { ShopifyOrderNode } from '@/lib/shopify/orders-sync';
import { dispatchWebhookCore } from '@/lib/shopify/webhook-core';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const password = 'refund-shop-scope-test-pw';
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

async function createShop(admin: AdminClient, merchantAccountId: string) {
  const shopDomain = `refund-shop-scope-${Date.now()}-${randomUUID()}.myshopify.com`;
  const { data: shop, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: shopDomain,
      access_token_encrypted: 'dummy',
      scopes: 'read_orders',
      status: 'active',
    })
    .select('*')
    .single();
  if (error || !shop) throw new Error(`shop insert failed: ${error?.message}`);
  return shop;
}

function buildOrderNode(
  shopifyOrderId: string,
  totalAmount: string,
  updatedAt: string,
): ShopifyOrderNode {
  return {
    id: `gid://shopify/Order/${shopifyOrderId}`,
    name: `#${shopifyOrderId}`,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt,
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    note: null,
    customAttributes: null,
    currentTotalPriceSet: { shopMoney: { amount: totalAmount, currencyCode: 'XOF' } },
    customer: null,
    shippingAddress: null,
    lineItems: {
      edges: [
        {
          node: {
            title: 'Article test',
            sku: null,
            quantity: 1,
            originalUnitPriceSet: { shopMoney: { amount: totalAmount } },
            variant: null,
            product: null,
            customAttributes: null,
          },
        },
      ],
    },
  };
}

function buildRefundPayload(shopifyOrderId: string) {
  return {
    id: randomUUID().replace(/-/g, '').slice(0, 10),
    order_id: shopifyOrderId,
    transactions: [
      {
        kind: 'refund',
        status: 'success',
        gateway: 'bogus', // ni cash/cod/manual/especes → non cash-like → shouldUpdateFinancialStatus=true
        amount: '500',
      },
    ],
  };
}

describe('CORRIGÉ (Lot R2) — processRefundCore résout la commande par (shop_id, shopify_order_id)', () => {
  afterEach(async () => {
    if (!serviceRoleKey || createdUserIds.length === 0) return;
    const admin = adminClient();
    for (const userId of createdUserIds.splice(0)) {
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    }
  });

  skipIfNoServiceRole(
    'un remboursement livré pour la boutique B ne touche jamais la commande homonyme de la boutique A',
    async () => {
      const admin = adminClient();
      const email = `refund-shop-scope-${Date.now()}-${randomUUID()}@example.com`;
      const userId = await createConfirmedUser(admin, email);
      const merchantAccountId = await waitForMerchantAccount(admin, userId);

      const shopA = await createShop(admin, merchantAccountId);
      const shopB = await createShop(admin, merchantAccountId);
      const collidingShopifyOrderId = randomUUID().replace(/-/g, '').slice(0, 12);

      // Deux commandes distinctes, même shopify_order_id, une par boutique (comportement corrigé
      // de persistShopifyOrder — voir shopify-reconcile-cross-shop-order-id-collision).
      const resultA = await persistShopifyOrder({
        merchantAccountId,
        shopId: shopA.id,
        supabaseServiceClient: admin,
        orderNode: buildOrderNode(collidingShopifyOrderId, '1000', '2026-08-01T00:00:00Z'),
      });
      expect(resultA.ok).toBe(true);

      const resultB = await persistShopifyOrder({
        merchantAccountId,
        shopId: shopB.id,
        supabaseServiceClient: admin,
        orderNode: buildOrderNode(collidingShopifyOrderId, '999999', '2026-08-01T01:00:00Z'),
      });
      expect(resultB.ok).toBe(true);

      const { data: before, error: beforeError } = await admin
        .from('orders')
        .select('id, shop_id, financial_status')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shopify_order_id', collidingShopifyOrderId);
      if (beforeError) throw beforeError;
      expect(before).toHaveLength(2);
      const orderAId = before?.find((o) => o.shop_id === shopA.id)?.id;
      const orderBId = before?.find((o) => o.shop_id === shopB.id)?.id;
      expect(orderAId).toBeDefined();
      expect(orderBId).toBeDefined();

      // Remboursement livré pour la boutique B — shop déjà résolu par l'appelant (comme le fait
      // dispatchWebhookCore en production, jamais un domaine/jeton reconstruit ici).
      await dispatchWebhookCore({
        supabase: admin,
        shop: shopB,
        eventId: randomUUID(),
        topic: 'refunds/create',
        payload: buildRefundPayload(collidingShopifyOrderId),
        webhookId: randomUUID(),
        triggeredAt: new Date().toISOString(),
      });

      const { data: after, error: afterError } = await admin
        .from('orders')
        .select('id, shop_id, financial_status')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shopify_order_id', collidingShopifyOrderId);
      if (afterError) throw afterError;

      const afterA = after?.find((o) => o.id === orderAId);
      const afterB = after?.find((o) => o.id === orderBId);

      // Le correctif, en une phrase : seule la commande de la boutique B (celle qui a réellement
      // émis le remboursement) est modifiée ; la commande de la boutique A reste intacte.
      expect(afterB?.financial_status).toBe('partially_refunded');
      expect(afterA?.financial_status).not.toBe('partially_refunded');
    },
  );
});
