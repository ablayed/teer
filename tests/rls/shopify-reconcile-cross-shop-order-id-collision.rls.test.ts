/**
 * Phase F — Lot R1 : VÉRIFICATION (pas correction, hors périmètre de ce lot) d'un défaut signalé
 * en revue avant fusion.
 *
 * `persistShopifyOrder` (lib/shopify/orders-sync.ts:633-640) cherche la commande existante par
 * `(merchant_account_id, shopify_order_id)`. L'index unique qui protège réellement la base,
 * `orders_shop_shopify_order_unique_idx` (migration 0037), porte sur `(shop_id, shopify_order_id)`
 * — la migration ayant explicitement déplacé l'autorité de dédup du marchand vers la boutique :
 *
 *   "Les ids de commande Shopify sont uniques par boutique, pas globalement : avec le
 *    multi-boutiques la clé de dédup doit être (shop_id, shopify_order_id)."
 *   (supabase/migrations/0037_phase7a_shopify_foundation.sql:51-52)
 *
 * Le SELECT applicatif n'a jamais suivi ce déplacement. Ce test prouve la conséquence : pour un
 * marchand multi-boutiques, si deux boutiques Shopify distinctes produisent le même
 * `shopify_order_id` (le format numérique extrait de la GID, dont l'unicité globale n'est PAS
 * garantie par Shopify selon le commentaire de 0037 ci-dessus), la commande de la boutique B écrase
 * en place le contenu de la commande de la boutique A — sans jamais passer par un INSERT, donc
 * sans jamais toucher l'index unique qui aurait pu l'empêcher. Aucune ligne en double n'apparaît ;
 * c'est une corruption silencieuse, pas un doublon visible.
 *
 * Conséquence pour la Phase F : tant que ce défaut n'est pas corrigé, un rejeu massif de
 * l'historique (recul du curseur, cf. Bloc E3 du diagnostic D0-bis) est la circonstance exacte qui
 * le déclencherait sur un marchand multi-boutiques — NE PAS lancer ce rejeu avant correction.
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

describe('DÉFAUT SIGNALÉ (non corrigé dans ce lot) — collision shopify_order_id entre deux boutiques du même marchand', () => {
  afterEach(async () => {
    if (!serviceRoleKey || createdUserIds.length === 0) return;
    const admin = adminClient();
    for (const userId of createdUserIds.splice(0)) {
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    }
  });

  skipIfNoServiceRole(
    'la commande de la boutique B écrase silencieusement la commande de la boutique A quand le même shopify_order_id apparaît sur les deux',
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
        // traitée comme périmée) masque la question testée ici, qui est la portée du SELECT de
        // dédup, pas la garde hors-ordre.
        orderNode: buildOrderNode(collidingShopifyOrderId, '999999', '2026-08-01T01:00:00Z'),
      });
      // ok:true — persistShopifyOrder ne remonte AUCUNE erreur ici : c'est bien une corruption
      // silencieuse, pas un échec visible.
      expect(resultB.ok).toBe(true);

      const { data: rows, error } = await admin
        .from('orders')
        .select('id, shop_id, total_amount')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shopify_order_id', collidingShopifyOrderId);
      if (error) throw error;

      // Le défaut, en une phrase : une seule ligne existe (pas de doublon — l'index unique
      // (shop_id, shopify_order_id) n'a jamais été consulté puisqu'aucun INSERT n'a eu lieu pour
      // B), elle reste rattachée à la boutique A, mais son contenu est celui de la boutique B.
      expect(rows).toHaveLength(1);
      expect(rows?.[0]?.shop_id).toBe(shopAId);
      expect(Number(rows?.[0]?.total_amount)).toBe(999999);
    },
  );
});
