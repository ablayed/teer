'use server';

import { getMerchantAccount } from '@/lib/actions/merchant';
import { authActionClient } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { decryptToken } from '@/lib/shopify/crypto';
import { shopifyGraphQL } from '@/lib/shopify/graphql';
import {
  SHOPIFY_ORDERS_QUERY,
  type ShopifyOrdersResponse,
  mapShopifyCustomer,
  mapShopifyOrder,
} from '@/lib/shopify/orders-sync';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';

type ShopRow = Tables<'shop'>;

export type ShopConnection = Pick<ShopRow, 'shop_domain' | 'scopes' | 'status' | 'installed_at'>;

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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
      return { ok: false as const, errorCode: 'sync_failed' as const };
    }

    if (!shop) {
      return { ok: false as const, errorCode: 'no_shop' as const };
    }

    let accessToken: string;
    try {
      accessToken = decryptToken(shop.access_token_encrypted);
    } catch {
      return { ok: false as const, errorCode: 'token_error' as const };
    }

    try {
      // MVP backfill: first page only. Cursor pagination can be added when the sync job grows.
      const data = await shopifyGraphQL<ShopifyOrdersResponse>({
        shopDomain: shop.shop_domain,
        accessToken,
        query: SHOPIFY_ORDERS_QUERY,
        variables: { cursor: null },
      });
      let syncedCount = 0;

      for (const { node } of data.orders.edges) {
        const customerInput = mapShopifyCustomer(node, merchantAccount.id);
        let customerId: string | null = null;

        if (customerInput?.shopify_customer_id) {
          const { data: savedCustomer, error: customerError } = await admin
            .from('customer')
            .upsert(customerInput, { onConflict: 'merchant_account_id,shopify_customer_id' })
            .select('id')
            .single();

          if (customerError) {
            throw customerError;
          }

          customerId = savedCustomer.id;
        }

        const orderInput = mapShopifyOrder(node, {
          merchantAccountId: merchantAccount.id,
          shopId: shop.id,
          customerId,
        });
        const { error: orderError } = await admin
          .from('orders')
          // orderInput intentionally omits cod_status; upsert updates only provided fields.
          .upsert(orderInput, { onConflict: 'merchant_account_id,shopify_order_id' });

        if (orderError) {
          throw orderError;
        }

        syncedCount += 1;
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
        throw auditError;
      }

      return { ok: true as const, syncedCount };
    } catch {
      return { ok: false as const, errorCode: 'sync_failed' as const };
    }
  });
