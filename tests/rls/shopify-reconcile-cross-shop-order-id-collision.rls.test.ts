/**
 * Phase F — Lot R2 : correctif du défaut prouvé en R1.
 *
 * `persistShopifyOrder` (lib/shopify/orders-sync.ts) cherchait la commande existante par
 * `(merchant_account_id, shopify_order_id)`. L'index unique qui protège réellement la base,
 * `orders_shop_shopify_order_unique_idx` (migration 0037), porte sur `(shop_id, shopify_order_id)`
 * — la migration ayant explicitement déplacé l'autorité de dédup du marchand vers la boutique :
 *
 *   "Les ids de commande Shopify sont uniques par boutique, pas globalement : avec le
 *    multi-boutiques la clé de dédup doit être (shop_id, shopify_order_id)."
 *   (supabase/migrations/0037_phase7a_shopify_foundation.sql:51-52)
 *
 * Le SELECT applicatif ne suivait pas ce déplacement — R1 en a apporté la preuve (test rouge,
 * historique git). R2 aligne la résolution sur `(shop_id, shopify_order_id)` : ce fichier prouve
 * désormais le comportement CORRECT — deux boutiques d'un même marchand, même `shopify_order_id`,
 * produisent deux commandes distinctes, chacune rattachée à sa boutique, aucun écrasement.
 *
 * Mutation-testé (rapporté dans le rapport de fin de lot, pas dans ce fichier) : retirer le
 * `.eq('shop_id', shopId)` ajouté par R2 dans `persistShopifyOrder` fait repasser ce test au
 * rouge — c'est exactement l'état d'avant-correctif, prouvé par ce même fichier avant sa réécriture
 * (git history : `shopify-reconcile-cross-shop-order-id-collision.rls.test.ts` pré-R2).
 */

import { randomUUID } from 'node:crypto';
import { persistShopifyOrder } from '@/lib/shopify/orders-sync';
import type { ShopifyOrderNode } from '@/lib/shopify/orders-sync';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const password = 'reconcile-collision-test-pw';
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
  const shopDomain = `reconcile-collision-${Date.now()}-${randomUUID()}.myshopify.com`;
  const { data: shop, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: shopDomain,
      access_token_encrypted: 'dummy',
      scopes: 'read_orders',
      status: 'active',
    })
    .select('id')
    .single();
  if (error || !shop) throw new Error(`shop insert failed: ${error?.message}`);
  return shop.id;
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

describe('CORRIGÉ (Lot R2) — deux boutiques du même marchand, même shopify_order_id → deux commandes distinctes', () => {
  afterEach(async () => {
    if (!serviceRoleKey || createdUserIds.length === 0) return;
    const admin = adminClient();
    for (const userId of createdUserIds.splice(0)) {
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    }
  });

  skipIfNoServiceRole(
    'la commande de la boutique B est insérée séparément, la commande de la boutique A reste intacte',
    async () => {
      const admin = adminClient();
      const email = `reconcile-collision-${Date.now()}-${randomUUID()}@example.com`;
      const userId = await createConfirmedUser(admin, email);
      const merchantAccountId = await waitForMerchantAccount(admin, userId);

      const shopAId = await createShop(admin, merchantAccountId);
      const shopBId = await createShop(admin, merchantAccountId);
      const collidingShopifyOrderId = randomUUID().replace(/-/g, '').slice(0, 12);

      const resultA = await persistShopifyOrder({
        merchantAccountId,
        shopId: shopAId,
        supabaseServiceClient: admin,
        orderNode: buildOrderNode(collidingShopifyOrderId, '1000', '2026-08-01T00:00:00Z'),
      });
      expect(resultA.ok).toBe(true);

      const resultB = await persistShopifyOrder({
        merchantAccountId,
        shopId: shopBId,
        supabaseServiceClient: admin,
        // updated_at postérieur : évite que la garde hors-ordre (isStaleShopifyUpdate, égalité
        // traitée comme périmée) interfère avec la question testée ici, qui est la portée du
        // SELECT de dédup, pas la garde hors-ordre.
        orderNode: buildOrderNode(collidingShopifyOrderId, '999999', '2026-08-01T01:00:00Z'),
      });
      expect(resultB.ok).toBe(true);

      const { data: rows, error } = await admin
        .from('orders')
        .select('id, shop_id, total_amount')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shopify_order_id', collidingShopifyOrderId)
        .order('shop_id', { ascending: true });
      if (error) throw error;

      // Le correctif, en une phrase : deux lignes distinctes existent désormais (l'index unique
      // (shop_id, shopify_order_id) est bien consulté puisque B produit un INSERT, plus un
      // UPDATE) — chacune rattachée à sa propre boutique, avec son propre contenu.
      expect(rows).toHaveLength(2);
      const byShop = new Map((rows ?? []).map((row) => [row.shop_id, Number(row.total_amount)]));
      expect(byShop.get(shopAId)).toBe(1000);
      expect(byShop.get(shopBId)).toBe(999999);

      // Contrôle positif : rejouer A (même shopify_order_id, même boutique, updated_at postérieur)
      // continue de mettre à jour SA ligne, jamais d'en créer une troisième.
      const resultAReplay = await persistShopifyOrder({
        merchantAccountId,
        shopId: shopAId,
        supabaseServiceClient: admin,
        orderNode: buildOrderNode(collidingShopifyOrderId, '4242', '2026-08-01T02:00:00Z'),
      });
      expect(resultAReplay.ok).toBe(true);

      const { data: rowsAfterReplay, error: replayError } = await admin
        .from('orders')
        .select('id, shop_id, total_amount')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shopify_order_id', collidingShopifyOrderId);
      if (replayError) throw replayError;

      expect(rowsAfterReplay).toHaveLength(2);
      const byShopAfterReplay = new Map(
        (rowsAfterReplay ?? []).map((row) => [row.shop_id, Number(row.total_amount)]),
      );
      expect(byShopAfterReplay.get(shopAId)).toBe(4242);
      expect(byShopAfterReplay.get(shopBId)).toBe(999999);
    },
  );
});
