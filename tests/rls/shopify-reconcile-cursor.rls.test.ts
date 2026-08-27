/**
 * Phase F — Lot R1, étape 2 : preuve de bout en bout, contre une vraie base, que
 * `persistBulkOrderNodes` (lib/shopify/reconcile.ts) avance `shop.last_reconciled_at` sans jamais
 * dépasser une commande dont la persistance a échoué. Complète tests/unit/shopify-reconcile-cursor
 * (fonction pure) en exerçant le chemin réel : persistance + mise à jour du curseur en base.
 *
 * Une commande en échec est forcée de façon déterministe (shopify_order_id vide → rejeté tôt par
 * persistShopifyOrder, `orders-sync.ts:629-631`), pas par une panne réseau/DB simulée.
 *
 * Mutation testée manuellement (rapportée dans le rapport de fin de lot) : en remplaçant, dans
 * `persistBulkOrderNodes`, l'appel à `computeNextReconcileCursor(...)` par `runStartedAt` codé en
 * dur (le comportement d'avant ce lot), le test "ne dépasse pas la commande en échec" passe au
 * rouge — le curseur avance malgré l'échec.
 */

import { randomUUID } from 'node:crypto';
import type { ShopifyOrderNode } from '@/lib/shopify/orders-sync';
import { persistBulkOrderNodes } from '@/lib/shopify/reconcile';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const password = 'reconcile-cursor-test-pw';
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

async function createShopFixture(initialLastReconciledAt: string | null) {
  const admin = adminClient();
  const email = `reconcile-cursor-${Date.now()}-${randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);

  const shopDomain = `reconcile-cursor-${Date.now()}-${randomUUID()}.myshopify.com`;
  const { data: shop, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: shopDomain,
      access_token_encrypted: 'dummy',
      scopes: 'read_orders',
      status: 'active',
      last_reconciled_at: initialLastReconciledAt,
    })
    .select('*')
    .single();
  if (error || !shop) throw new Error(`shop insert failed: ${error?.message}`);

  return { admin, shop };
}

// Postgres renvoie un timestamptz sous une forme différente (`+00:00`) de l'ISO 8601 envoyé
// (`.000Z`) — comparaison par instant, pas par égalité de chaîne.
async function readLastReconciledAtMs(admin: AdminClient, shopId: string) {
  const { data, error } = await admin
    .from('shop')
    .select('last_reconciled_at')
    .eq('id', shopId)
    .single();
  if (error) throw error;
  return data.last_reconciled_at ? Date.parse(data.last_reconciled_at) : null;
}

function buildOrderNode(overrides: {
  shopifyId: string; // vide ('') force un échec déterministe dans persistShopifyOrder
  updatedAt: string | null;
}): ShopifyOrderNode {
  return {
    id: overrides.shopifyId ? `gid://shopify/Order/${overrides.shopifyId}` : '',
    name: overrides.shopifyId ? `#${overrides.shopifyId}` : '#invalid',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: overrides.updatedAt,
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    note: null,
    customAttributes: null,
    currentTotalPriceSet: { shopMoney: { amount: '5000', currencyCode: 'XOF' } },
    customer: null,
    shippingAddress: null,
    lineItems: {
      edges: [
        {
          node: {
            title: 'Article test',
            sku: null,
            quantity: 1,
            originalUnitPriceSet: { shopMoney: { amount: '5000' } },
            variant: null,
            product: null,
            customAttributes: null,
          },
        },
      ],
    },
  };
}

describe('shopify reconcile — le curseur ne dépasse jamais une commande en échec', () => {
  afterEach(async () => {
    if (!serviceRoleKey || createdUserIds.length === 0) return;
    const admin = adminClient();
    for (const userId of createdUserIds.splice(0)) {
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    }
  });

  skipIfNoServiceRole(
    'toutes les commandes persistées → le curseur avance jusqu’à runStartedAt',
    async () => {
      const initialCursor = '2026-08-01T00:00:00.000Z';
      const { admin, shop } = await createShopFixture(initialCursor);
      const runStartedAt = '2026-08-27T02:00:00.000Z';

      const outcome = await persistBulkOrderNodes(
        admin,
        shop,
        [
          buildOrderNode({ shopifyId: randomUUID(), updatedAt: '2026-08-26T10:00:00Z' }),
          buildOrderNode({ shopifyId: randomUUID(), updatedAt: '2026-08-26T14:00:00Z' }),
        ],
        runStartedAt,
      );

      expect(outcome.failedCount).toBe(0);
      expect(outcome.syncedCount).toBe(2);
      // shop.last_reconciled_at revient déjà normalisé par Postgres (+00:00) après l'insert
      // initial — comparaison par instant, même raison que readLastReconciledAtMs plus bas.
      expect(Date.parse(outcome.cursorBefore ?? '')).toBe(Date.parse(initialCursor));
      expect(outcome.cursorAfter).toBe(runStartedAt);
      expect(await readLastReconciledAtMs(admin, shop.id)).toBe(Date.parse(runStartedAt));
    },
  );

  skipIfNoServiceRole(
    'central : une commande en échec au milieu du lot — le curseur ne la dépasse pas',
    async () => {
      const initialCursor = '2026-08-01T00:00:00.000Z';
      const { admin, shop } = await createShopFixture(initialCursor);
      const runStartedAt = '2026-08-27T02:00:00.000Z';
      const failureUpdatedAt = '2026-08-26T14:00:00.000Z';

      const outcome = await persistBulkOrderNodes(
        admin,
        shop,
        [
          buildOrderNode({ shopifyId: randomUUID(), updatedAt: '2026-08-26T10:00:00Z' }),
          buildOrderNode({ shopifyId: '', updatedAt: failureUpdatedAt }), // échec forcé
          buildOrderNode({ shopifyId: randomUUID(), updatedAt: '2026-08-26T18:00:00Z' }),
        ],
        runStartedAt,
      );

      expect(outcome.syncedCount).toBe(2);
      expect(outcome.failedCount).toBe(1);
      expect(outcome.cursorAfter).toBe(failureUpdatedAt);
      expect(outcome.cursorAfter).not.toBe(runStartedAt);
      expect(await readLastReconciledAtMs(admin, shop.id)).toBe(Date.parse(failureUpdatedAt));
    },
  );

  skipIfNoServiceRole(
    'plusieurs échecs dispersés → le curseur ne dépasse pas le plus ancien',
    async () => {
      const initialCursor = '2026-08-01T00:00:00.000Z';
      const { admin, shop } = await createShopFixture(initialCursor);
      const runStartedAt = '2026-08-27T02:00:00.000Z';
      const earliestFailure = '2026-08-26T11:00:00.000Z';

      const outcome = await persistBulkOrderNodes(
        admin,
        shop,
        [
          buildOrderNode({ shopifyId: randomUUID(), updatedAt: '2026-08-26T09:00:00Z' }),
          buildOrderNode({ shopifyId: '', updatedAt: earliestFailure }),
          buildOrderNode({ shopifyId: randomUUID(), updatedAt: '2026-08-26T15:00:00Z' }),
          buildOrderNode({ shopifyId: '', updatedAt: '2026-08-26T20:00:00.000Z' }),
        ],
        runStartedAt,
      );

      expect(outcome.failedCount).toBe(2);
      expect(outcome.cursorAfter).toBe(earliestFailure);
      expect(await readLastReconciledAtMs(admin, shop.id)).toBe(Date.parse(earliestFailure));
    },
  );

  skipIfNoServiceRole(
    'aucune commande à traiter → le curseur avance quand même jusqu’à runStartedAt',
    async () => {
      const initialCursor = '2026-08-01T00:00:00.000Z';
      const { admin, shop } = await createShopFixture(initialCursor);
      const runStartedAt = '2026-08-27T02:00:00.000Z';

      const outcome = await persistBulkOrderNodes(admin, shop, [], runStartedAt);

      expect(outcome.examinedCount).toBe(0);
      expect(outcome.cursorAfter).toBe(runStartedAt);
      expect(await readLastReconciledAtMs(admin, shop.id)).toBe(Date.parse(runStartedAt));
    },
  );
});
