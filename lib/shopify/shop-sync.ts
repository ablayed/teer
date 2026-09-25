import { env } from '@/lib/env';
import { writePcdAccessAudit } from '@/lib/security/pcd-access-audit';
import { getShopifyAppForShop } from '@/lib/shopify/apps';
import { ShopifyGraphQLHttpError, shopifyGraphQL } from '@/lib/shopify/graphql';
import {
  SHOPIFY_ORDERS_QUERY,
  type ShopifyOrdersResponse,
  persistShopifyOrder,
} from '@/lib/shopify/orders-sync';
import { syncProductsForShop } from '@/lib/shopify/products-sync';
import { getValidShopAccessToken, runWithShopifyUnauthorizedRetry } from '@/lib/shopify/token';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

type ShopRow = Tables<'shop'>;
type SupabaseAdminClient = SupabaseClient<Database>;

type SyncShopOrdersInput = {
  actorUserId: string;
  merchantAccountId: string;
  shopId?: string;
  auditAction?: 'shop_synced' | 'shopify.orders_synced';
};

type SyncShopOrdersResult =
  | { ok: true; shopId: string; syncedCount: number }
  | { ok: false; errorCode: 'no_shop' | 'sync_failed' | 'token_error' };

function createSupabaseAdminClient() {
  return createProtectedSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

function logSyncError(prefix: string, error: unknown, _payload?: unknown) {
  Sentry.captureException(error, {
    tags: { module: 'shopify.shop-sync' },
    extra: { error_code: 'shopify_sync_failed', prefix },
  });
}

async function getShop({
  admin,
  merchantAccountId,
  shopId,
}: {
  admin: SupabaseAdminClient;
  merchantAccountId: string;
  shopId?: string;
}): Promise<ShopRow | null> {
  let query = admin
    .from('shop')
    .select('*')
    .eq('merchant_account_id', merchantAccountId)
    .eq('store_kind', 'shopify')
    .eq('status', 'active');

  if (shopId) {
    query = query.eq('id', shopId);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function syncShopOrders({
  actorUserId,
  auditAction = 'shopify.orders_synced',
  merchantAccountId,
  shopId,
}: SyncShopOrdersInput): Promise<SyncShopOrdersResult> {
  const admin = createSupabaseAdminClient();

  let shop: ShopRow | null;
  try {
    shop = await getShop({ admin, merchantAccountId, shopId });
  } catch (error) {
    logSyncError('[sync] shop lookup failed', error);
    return { ok: false, errorCode: 'sync_failed' };
  }

  if (!shop) {
    return { ok: false, errorCode: 'no_shop' };
  }

  // Multi-app : credentials de l'app ayant installé cette boutique (fallback app par défaut).
  const app = getShopifyAppForShop(shop.shopify_client_id);
  if (!app) {
    logSyncError('[sync] missing Shopify credentials', new Error('missing_shopify_credentials'));
    return { ok: false, errorCode: 'token_error' };
  }

  // Token valide avec refresh proactif (offline expirant) ; needs_reauth → re-OAuth requis.
  const tokenResult = await getValidShopAccessToken(admin, shop, app.clientId, app.clientSecret);

  if (!tokenResult.ok) {
    logSyncError('[sync] token unavailable', new Error(tokenResult.reason));
    return { ok: false, errorCode: 'token_error' };
  }

  try {
    // Un seul réessai après un 401, sur une paire plus récente (SHOPIFY-EXPIRING-TOKENS-01 §7).
    // Les deux lectures Shopify de cette synchronisation sont rejouées ensemble : leurs écritures
    // sont idempotentes (upsert produits, persistShopifyOrder).
    const data = await runWithShopifyUnauthorizedRetry(
      admin,
      shop,
      app.clientId,
      app.clientSecret,
      tokenResult.accessToken,
      async (accessToken) => {
        const productsSyncResult = await syncProductsForShop({
          accessToken,
          actorUserId,
          admin,
          auditAction: 'shopify.products_synced',
          merchantAccountId,
          shop,
        });

        if (!productsSyncResult.ok) {
          if (productsSyncResult.errorCode === 'unauthorized') {
            throw new ShopifyGraphQLHttpError(401);
          }
          return null;
        }

        return shopifyGraphQL<ShopifyOrdersResponse>({
          accessToken,
          query: SHOPIFY_ORDERS_QUERY,
          shopDomain: shop.shop_domain,
          variables: { cursor: null },
        });
      },
    );

    if (!data) {
      return { ok: false, errorCode: 'sync_failed' };
    }

    const edges = data.orders.edges;
    try {
      await writePcdAccessAudit(admin, {
        tenantId: merchantAccountId,
        shopId: shop.id,
        actorKind: 'service',
        serviceKind: 'shopify_sync',
        action: 'privileged_read',
        dataCategory: 'shopify_payload',
        purpose: 'system_processing',
        outcome: 'allowed',
        resourceType: 'shopify_payload',
        surface: 'shopify',
        metadata: { result_count: Math.min(edges.length, 500), source: 'sync' },
      });
    } catch {
      return { ok: false, errorCode: 'sync_failed' };
    }
    let syncedCount = 0;
    let failedCount = 0;
    const syncFailures: Array<{ error: unknown; orderId: string; step: string }> = [];

    for (const { node } of edges) {
      const result = await persistShopifyOrder({
        merchantAccountId,
        orderNode: node,
        shopId: shop.id,
        supabaseServiceClient: admin,
      });

      if (result.ok) {
        syncedCount += 1;
      } else {
        failedCount += 1;
        syncFailures.push({
          error: result.error ?? 'Unknown sync error',
          orderId: node.id,
          step: 'storage',
        });
      }
    }

    if (edges.length > 0 && syncedCount === 0) {
      logSyncError('[sync] all order storage attempts failed', syncFailures);
      return { ok: false, errorCode: 'sync_failed' };
    }

    const { error: auditError } = await admin.from('audit_log').insert({
      action: auditAction,
      actor_user_id: actorUserId,
      merchant_account_id: merchantAccountId,
      payload: { failedCount, syncedCount },
      resource_id: shop.id,
      resource_type: 'shop',
    });

    if (auditError) {
      logSyncError('[sync] audit insert failed', auditError, { failedCount, syncedCount });
    }

    return { ok: true, shopId: shop.id, syncedCount };
  } catch (error) {
    logSyncError('[sync] sync failed', error);
    return { ok: false, errorCode: 'sync_failed' };
  }
}
