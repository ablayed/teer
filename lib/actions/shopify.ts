'use server';

import { getMerchantAccount } from '@/lib/actions/merchant';
import { authActionClient } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { syncShopOrders } from '@/lib/shopify/shop-sync';
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

    const result = await syncShopOrders({
      actorUserId: ctx.user.id,
      merchantAccountId: merchantAccount.id,
    });

    if (!result.ok) {
      return { ok: false as const, errorCode: result.errorCode };
    }

    return { ok: true as const, syncedCount: result.syncedCount };
  });
