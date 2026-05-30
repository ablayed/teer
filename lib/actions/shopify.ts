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
      console.error(
        '[sync] shop lookup failed',
        JSON.stringify({
          message: shopError.message,
          code: shopError.code,
          details: shopError.details,
          hint: shopError.hint,
        }),
      );
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

      for (const { node } of edges) {
        const customerData = mapShopifyCustomer(node, merchantAccount.id);
        let customerId: string | null = null;

        if (customerData?.shopify_customer_id) {
          try {
            const { data: savedCustomer, error: customerError } = await admin
              .from('customer')
              .upsert(customerData, { onConflict: 'merchant_account_id,shopify_customer_id' })
              .select('id')
              .single();

            if (customerError) {
              console.error(
                '[sync] customer upsert failed',
                JSON.stringify({
                  message: customerError.message,
                  code: customerError.code,
                  details: customerError.details,
                  hint: customerError.hint,
                }),
                customerData,
              );
              throw customerError;
            }

            customerId = savedCustomer.id;
          } catch (err) {
            console.error('[sync] customer upsert failed', JSON.stringify(err), customerData);
            throw err;
          }
        }

        const orderData = mapShopifyOrder(node, {
          merchantAccountId: merchantAccount.id,
          shopId: shop.id,
          customerId,
        });
        try {
          const { error: orderError } = await admin
            .from('orders')
            // orderData intentionally omits cod_status; upsert updates only provided fields.
            .upsert(orderData, { onConflict: 'merchant_account_id,shopify_order_id' });

          if (orderError) {
            console.error(
              '[sync] order upsert failed',
              JSON.stringify({
                message: orderError.message,
                code: orderError.code,
                details: orderError.details,
                hint: orderError.hint,
              }),
              orderData,
            );
            throw orderError;
          }
        } catch (err) {
          console.error('[sync] order upsert failed', JSON.stringify(err), orderData);
          throw err;
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
    } catch (err) {
      console.error('[sync] sync failed', err);
      return { ok: false as const, errorCode: 'sync_failed' as const };
    }
  });
