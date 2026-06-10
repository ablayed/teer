import { env } from '@/lib/env';
import { getShopifyAppForShop } from '@/lib/shopify/apps';
import { shopifyGraphQL } from '@/lib/shopify/graphql';
import {
  SHOPIFY_ORDERS_QUERY,
  type ShopifyOrdersResponse,
  persistShopifyOrder,
} from '@/lib/shopify/orders-sync';
import { syncProductsForShop } from '@/lib/shopify/products-sync';
import { getValidShopAccessToken } from '@/lib/shopify/token';
import type { Database, Tables } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';

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
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function logSyncError(prefix: string, error: unknown, payload?: unknown) {
  Sentry.captureException(error, {
    tags: { module: 'shopify.shop-sync' },
    extra: { payload, prefix },
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

  const accessToken = tokenResult.accessToken;

  try {
    const productsSyncResult = await syncProductsForShop({
      accessToken,
      actorUserId,
      admin,
      auditAction: 'shopify.products_synced',
      merchantAccountId,
      shop,
    });

    if (!productsSyncResult.ok) {
      return { ok: false, errorCode: 'sync_failed' };
    }

    const data = await shopifyGraphQL<ShopifyOrdersResponse>({
      accessToken,
      query: SHOPIFY_ORDERS_QUERY,
      shopDomain: shop.shop_domain,
      variables: { cursor: null },
    });

    const edges = data.orders.edges;
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
