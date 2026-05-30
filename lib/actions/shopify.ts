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
import type { Database, Tables, TablesUpdate } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';

type ShopRow = Tables<'shop'>;
type SupabaseErrorLog = {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
};
type CustomerUpdate = Pick<
  TablesUpdate<'customer'>,
  'full_name' | 'phone' | 'email' | 'shipping_address' | 'updated_at'
>;
type OrderShopifyUpdate = Pick<
  TablesUpdate<'orders'>,
  | 'order_number'
  | 'total_amount'
  | 'currency'
  | 'financial_status'
  | 'fulfillment_status'
  | 'items_summary'
  | 'shipping_address'
  | 'customer_id'
  | 'created_at_shopify'
  | 'updated_at'
>;

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
        try {
          const customerData = mapShopifyCustomer(node, merchantAccount.id);
          let customerId: string | null = null;

          if (customerData?.shopify_customer_id) {
            const { data: existingCustomer, error: customerSelectError } = await admin
              .from('customer')
              .select('id')
              .eq('merchant_account_id', merchantAccount.id)
              .eq('shopify_customer_id', customerData.shopify_customer_id)
              .maybeSingle();

            if (customerSelectError) {
              logSupabaseError('[sync] customer select failed', customerSelectError, customerData);
              throw customerSelectError;
            }

            if (existingCustomer) {
              const customerUpdate: CustomerUpdate = {
                full_name: customerData.full_name,
                phone: customerData.phone,
                email: customerData.email,
                shipping_address: customerData.shipping_address,
                updated_at: new Date().toISOString(),
              };
              const { error: customerUpdateError } = await admin
                .from('customer')
                .update(customerUpdate)
                .eq('id', existingCustomer.id);

              if (customerUpdateError) {
                logSupabaseError(
                  '[sync] customer update failed',
                  customerUpdateError,
                  customerUpdate,
                );
                throw customerUpdateError;
              }

              customerId = existingCustomer.id;
            } else {
              const { data: insertedCustomer, error: customerInsertError } = await admin
                .from('customer')
                .insert(customerData)
                .select('id')
                .single();

              if (customerInsertError) {
                logSupabaseError(
                  '[sync] customer insert failed',
                  customerInsertError,
                  customerData,
                );
                throw customerInsertError;
              }

              customerId = insertedCustomer.id;
            }
          }

          const orderData = mapShopifyOrder(node, {
            merchantAccountId: merchantAccount.id,
            shopId: shop.id,
            customerId,
          });
          const shopifyOrderId = orderData.shopify_order_id;

          if (!shopifyOrderId) {
            console.error('[sync] order missing shopify_order_id', orderData);
            throw new Error('Shopify order is missing shopify_order_id');
          }

          const { data: existingOrder, error: orderSelectError } = await admin
            .from('orders')
            .select('id, cod_status')
            .eq('merchant_account_id', merchantAccount.id)
            .eq('shopify_order_id', shopifyOrderId)
            .maybeSingle();

          if (orderSelectError) {
            logSupabaseError('[sync] order select failed', orderSelectError, orderData);
            throw orderSelectError;
          }

          if (existingOrder) {
            const orderUpdate: OrderShopifyUpdate = {
              order_number: orderData.order_number,
              total_amount: orderData.total_amount,
              currency: orderData.currency,
              financial_status: orderData.financial_status,
              fulfillment_status: orderData.fulfillment_status,
              items_summary: orderData.items_summary,
              shipping_address: orderData.shipping_address,
              customer_id: orderData.customer_id,
              created_at_shopify: orderData.created_at_shopify,
              updated_at: new Date().toISOString(),
            };
            const { error: orderUpdateError } = await admin
              .from('orders')
              .update(orderUpdate)
              .eq('id', existingOrder.id);

            if (orderUpdateError) {
              logSupabaseError('[sync] order update failed', orderUpdateError, orderUpdate);
              throw orderUpdateError;
            }
          } else {
            const { error: orderInsertError } = await admin
              .from('orders')
              .insert(orderData)
              .select('id')
              .single();

            if (orderInsertError) {
              logSupabaseError('[sync] order insert failed', orderInsertError, orderData);
              throw orderInsertError;
            }
          }

          syncedCount += 1;
        } catch (err) {
          failedCount += 1;
          syncFailures.push({ orderId: node.id, step: 'storage', error: err });
          console.error('[sync] order storage failed', err);
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
