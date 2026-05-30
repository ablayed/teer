'use server';

import { getMerchantAccount } from '@/lib/actions/merchant';
import { authActionClient } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { decryptToken } from '@/lib/shopify/crypto';
import { shopifyGraphQL } from '@/lib/shopify/graphql';
import {
  SHOPIFY_ORDERS_QUERY,
  type ShopifyOrdersResponse,
  persistShopifyOrder,
} from '@/lib/shopify/orders-sync';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';

type ShopRow = Tables<'shop'>;
type SupabaseErrorLog = {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
};

export type ShopConnection = Pick<ShopRow, 'shop_domain' | 'scopes' | 'status' | 'installed_at'>;

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function logSupabaseError(prefix: string, error: SupabaseErrorLog, payload?: unknown) {
  console.error(
    prefix,
    JSON.stringify({
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    }),
    payload,
  );
}

export async function getShopConnection(): Promise<ShopConnection | null> {
  const merchantAccount = await getMerchantAccount();

  if (!merchantAccount) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('shop')
    .select('shop_domain, scopes, status, installed_at')
    .eq('merchant_account_id', merchantAccount.id)
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export const disconnectShopAction = authActionClient
  .metadata({ actionName: 'shopify.disconnect_shop', section: 'shopify' })
  .action(async ({ ctx }) => {
    const merchantAccount = await getMerchantAccount();

    if (!merchantAccount) {
      return { ok: false as const, errorCode: 'merchant_not_found' as const };
    }

    const admin = createSupabaseAdminClient();
    const { data: shop, error: shopError } = await admin
      .from('shop')
      .update({
        status: 'uninstalled',
        updated_at: new Date().toISOString(),
      })
      .eq('merchant_account_id', merchantAccount.id)
      .eq('status', 'active')
      .select('id')
      .maybeSingle();

    if (shopError) {
      return { ok: false as const, errorCode: 'disconnect_failed' as const };
    }

    if (!shop) {
      return { ok: false as const, errorCode: 'shop_not_found' as const };
    }

    const { error: auditError } = await admin.from('audit_log').insert({
      merchant_account_id: merchantAccount.id,
      actor_user_id: ctx.user.id,
      action: 'shopify.disconnected',
      resource_type: 'shop',
      resource_id: shop.id,
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'disconnect_failed' as const };
    }

    return { ok: true as const };
  });

export const syncOrdersAction = authActionClient
  .metadata({ actionName: 'shopify.sync_orders', section: 'shopify' })
  .action(async ({ ctx }) => {
    const merchantAccount = await getMerchantAccount();

    if (!merchantAccount) {
      return { ok: false as const, errorCode: 'no_shop' as const };
    }

    const admin = createSupabaseAdminClient();
    const { data: shop, error: shopError } = await admin
      .from('shop')
      .select('*')
      .eq('merchant_account_id', merchantAccount.id)
      .eq('status', 'active')
      .maybeSingle();

    if (shopError) {
      logSupabaseError('[sync] shop lookup failed', shopError);
      return { ok: false as const, errorCode: 'sync_failed' as const };
    }

    if (!shop) {
      return { ok: false as const, errorCode: 'no_shop' as const };
    }

    let accessToken: string;
    try {
      accessToken = decryptToken(shop.access_token_encrypted);
    } catch (err) {
      console.error('[sync] token decrypt failed', err);
      return { ok: false as const, errorCode: 'token_error' as const };
    }

    try {
      // MVP backfill: first page only. Cursor pagination can be added when the sync job grows.
      let data: ShopifyOrdersResponse;
      try {
        data = await shopifyGraphQL<ShopifyOrdersResponse>({
          shopDomain: shop.shop_domain,
          accessToken,
          query: SHOPIFY_ORDERS_QUERY,
          variables: { cursor: null },
        });
      } catch (err) {
        console.error('[sync] graphql failed', err);
        return { ok: false as const, errorCode: 'sync_failed' as const };
      }

      const edges = data.orders.edges;
      console.error('[sync] orders received from shopify:', edges.length);

      let syncedCount = 0;
      let failedCount = 0;
      const syncFailures: Array<{ orderId: string; step: string; error: unknown }> = [];

      for (const { node } of edges) {
        const result = await persistShopifyOrder({
          merchantAccountId: merchantAccount.id,
          orderNode: node,
          shopId: shop.id,
          supabaseServiceClient: admin,
        });

        if (result.ok) {
          syncedCount += 1;
        } else {
          const error = result.error ?? 'Unknown sync error';
          failedCount += 1;
          syncFailures.push({ orderId: node.id, step: 'storage', error });
          console.error('[sync] order storage failed', error);
        }
      }

      if (edges.length > 0 && syncedCount === 0) {
        console.error('[sync] all order storage attempts failed', {
          failedCount,
          syncFailures,
        });
        return { ok: false as const, errorCode: 'sync_failed' as const };
      }

      const { error: auditError } = await admin.from('audit_log').insert({
        merchant_account_id: merchantAccount.id,
        actor_user_id: ctx.user.id,
        action: 'shopify.orders_synced',
        resource_type: 'shop',
        resource_id: shop.id,
        payload: { syncedCount },
      });

      if (auditError) {
        logSupabaseError('[sync] audit insert failed', auditError, { syncedCount, failedCount });
      }

      return { ok: true as const, syncedCount };
    } catch (err) {
      console.error('[sync] sync failed', err);
      return { ok: false as const, errorCode: 'sync_failed' as const };
    }
  });
