/**
 * Phase F — Lot R1, étape 1 : preuve de la déduplication de `persistShopifyOrder`
 * (lib/shopify/orders-sync.ts), seul chemin d'écriture partagé par la réconciliation
 * nocturne (`lib/shopify/reconcile.ts`) et le fallback bulk_operations/finish.
 *
 * Deux garanties distinctes, testées séparément :
 *
 * 1. Garde applicative (SELECT existant par (merchant_account_id, shopify_order_id) → UPDATE,
 *    sinon INSERT, `orders-sync.ts:633-701`) : un rejeu séquentiel du même `shopify_order_id`
 *    ne crée jamais une deuxième ligne.
 * 2. Filet base (index unique `orders_shop_shopify_order_unique_idx` sur
 *    `(shop_id, shopify_order_id)`, migration `0037`) : si deux exécutions concurrentes
 *    (cron + webhook bulk_operations/finish sur la même boutique) passent toutes les deux le
 *    SELECT avant qu'aucune n'ait inséré, la contrainte empêche la ligne en double — la seconde
 *    échoue proprement (`ok:false`), elle ne duplique pas.
 *
 * Mutation testée manuellement (pas par le harnais) : en retirant temporairement la branche
 * `if (existingOrder) { ... } else { insert }` de `persistShopifyOrder` pour ne garder que
 * l'insert, le test 1 passe au rouge (le deuxième appel remonte `ok:false` — violation de
 * contrainte — au lieu de `ok:true` avec mise à jour). Résultat à consigner dans le rapport de
 * fin de lot, pas dans ce fichier.
 */

import { randomUUID } from 'node:crypto';
import { persistShopifyOrder } from '@/lib/shopify/orders-sync';
import type { ShopifyOrderNode } from '@/lib/shopify/orders-sync';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const password = 'reconcile-dedup-test-pw';
const createdUserIds: string[] = [];

// Convention du projet (tests/rls/*) : sauté seulement en l'absence d'infrastructure locale
// (pas de stack Supabase disponible), jamais en l'absence de données de test — celles-ci sont
// créées par le test lui-même dans chaque `it`.
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

async function createShopFixture() {
  const admin = adminClient();
  const email = `reconcile-dedup-${Date.now()}-${randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);

  const shopDomain = `reconcile-dedup-${Date.now()}-${randomUUID()}.myshopify.com`;
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

  return { admin, merchantAccountId, shopId: shop.id };
}

// Nœud minimal, sans client (évite la résolution/fusion client — hors périmètre de ce test).
function buildOrderNode(overrides: Partial<ShopifyOrderNode> & { shopifyOrderId: string }) {
  const { shopifyOrderId, ...rest } = overrides;
  const node: ShopifyOrderNode = {
    id: `gid://shopify/Order/${shopifyOrderId}`,
    name: `#${shopifyOrderId}`,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    note: null,
    customAttributes: null,
    currentTotalPriceSet: { shopMoney: { amount: '10000', currencyCode: 'XOF' } },
    customer: null,
    shippingAddress: null,
    lineItems: {
      edges: [
        {
          node: {
            title: 'Article test',
            sku: null,
            quantity: 1,
            originalUnitPriceSet: { shopMoney: { amount: '10000' } },
            variant: null,
            product: null,
            customAttributes: null,
          },
        },
      ],
    },
    ...rest,
  };
  return node;
}

async function countOrdersForShopifyId(admin: AdminClient, shopId: string, shopifyOrderId: string) {
  const { count, error } = await admin
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('shop_id', shopId)
    .eq('shopify_order_id', shopifyOrderId);
  if (error) throw error;
  return count ?? 0;
}

describe('shopify reconcile — déduplication de persistShopifyOrder', () => {
  afterEach(async () => {
    if (!serviceRoleKey || createdUserIds.length === 0) return;
    const admin = adminClient();
    for (const userId of createdUserIds.splice(0)) {
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    }
  });

  skipIfNoServiceRole(
    'un rejeu séquentiel du même shopify_order_id met à jour au lieu de dupliquer',
    async () => {
      const { admin, merchantAccountId, shopId } = await createShopFixture();
      const shopifyOrderId = randomUUID().replace(/-/g, '').slice(0, 12);

      const first = await persistShopifyOrder({
        merchantAccountId,
        shopId,
        supabaseServiceClient: admin,
        orderNode: buildOrderNode({ shopifyOrderId }),
      });
      expect(first.ok).toBe(true);
      expect(await countOrdersForShopifyId(admin, shopId, shopifyOrderId)).toBe(1);

      // Rejeu : même commande, updatedAt postérieur (simule un deuxième passage du cron qui
      // revoit la même commande dans sa fenêtre bulk).
      const second = await persistShopifyOrder({
        merchantAccountId,
        shopId,
        supabaseServiceClient: admin,
        orderNode: buildOrderNode({
          shopifyOrderId,
          updatedAt: '2026-08-01T01:00:00Z',
          displayFulfillmentStatus: 'FULFILLED',
        }),
      });
      expect(second.ok).toBe(true);
      expect(await countOrdersForShopifyId(admin, shopId, shopifyOrderId)).toBe(1);

      // Contrôle positif : une commande réellement nouvelle est bien insérée (le test ne serait
      // pas vert par accident si persistShopifyOrder refusait silencieusement tout insert).
      const otherShopifyOrderId = randomUUID().replace(/-/g, '').slice(0, 12);
      const third = await persistShopifyOrder({
        merchantAccountId,
        shopId,
        supabaseServiceClient: admin,
        orderNode: buildOrderNode({ shopifyOrderId: otherShopifyOrderId }),
      });
      expect(third.ok).toBe(true);
      expect(await countOrdersForShopifyId(admin, shopId, otherShopifyOrderId)).toBe(1);
      expect(await countOrdersForShopifyId(admin, shopId, shopifyOrderId)).toBe(1);
    },
  );

  skipIfNoServiceRole(
    "deux persistances concurrentes du même shopify_order_id jamais vu ne créent qu'une ligne",
    async () => {
      const { admin, shopId, merchantAccountId } = await createShopFixture();
      const shopifyOrderId = randomUUID().replace(/-/g, '').slice(0, 12);

      const [a, b] = await Promise.all([
        persistShopifyOrder({
          merchantAccountId,
          shopId,
          supabaseServiceClient: admin,
          orderNode: buildOrderNode({ shopifyOrderId }),
        }),
        persistShopifyOrder({
          merchantAccountId,
          shopId,
          supabaseServiceClient: admin,
          orderNode: buildOrderNode({ shopifyOrderId }),
        }),
      ]);

      // Invariant central : quelle que soit l'interposition réelle des deux appels, jamais
      // deux lignes. Le filet est l'index unique (shop_id, shopify_order_id), pas ce test.
      expect(await countOrdersForShopifyId(admin, shopId, shopifyOrderId)).toBe(1);
      // Au moins l'un des deux appels doit réussir — sinon la commande ne serait tout
      // simplement jamais écrite, ce qui n'est pas le comportement attendu de la course.
      expect([a.ok, b.ok].some(Boolean)).toBe(true);
    },
  );
});
