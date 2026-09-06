'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { syncShopOrders } from '@/lib/shopify/shop-sync';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

type ShopRow = Pick<
  Tables<'shop'>,
  | 'access_token_expires_at'
  | 'id'
  | 'installed_at'
  | 'merchant_account_id'
  | 'scopes'
  | 'shop_domain'
  | 'status'
  | 'updated_at'
>;

export type ShopListItem = {
  id: string;
  domain: string;
  installedAt: string;
  lastSyncAt: string | null;
  reason: 'token_expired' | null;
  scopes: string;
  status: 'connected' | 'error' | 'uninstalled';
};

function createSupabaseAdminClient() {
  return createProtectedSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

function shopStatus(shop: ShopRow): Pick<ShopListItem, 'reason' | 'status'> {
  if (shop.status === 'uninstalled') {
    return { reason: null, status: 'uninstalled' };
  }

  if (
    shop.access_token_expires_at &&
    new Date(shop.access_token_expires_at).getTime() <= Date.now()
  ) {
    return { reason: 'token_expired', status: 'error' };
  }

  return { reason: null, status: 'connected' };
}

async function getLastSyncByShopId(
  merchantAccountId: string,
  shopIds: string[],
): Promise<Map<string, string>> {
  if (shopIds.length === 0) {
    return new Map();
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('audit_log')
    .select('resource_id, created_at')
    .eq('merchant_account_id', merchantAccountId)
    .eq('resource_type', 'shop')
    .in('resource_id', shopIds)
    .in('action', ['shop_synced', 'shopify.orders_synced'])
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  const lastSyncByShopId = new Map<string, string>();

  for (const row of data ?? []) {
    if (row.resource_id && !lastSyncByShopId.has(row.resource_id)) {
      lastSyncByShopId.set(row.resource_id, row.created_at);
    }
  }

  return lastSyncByShopId;
}

export const listShopsAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'shops.list', section: 'shops' })
  .inputSchema(z.object({}))
  .action(async ({ ctx }) => {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from('shop')
      .select(
        'id, merchant_account_id, shop_domain, scopes, status, installed_at, updated_at, access_token_expires_at',
      )
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .order('installed_at', { ascending: false });

    if (error) {
      return { ok: false as const, errorCode: 'list_failed' as const };
    }

    const shops = (data ?? []) as ShopRow[];
    const lastSyncByShopId = await getLastSyncByShopId(
      ctx.member.merchantAccountId,
      shops.map((shop) => shop.id),
    );

    return {
      ok: true as const,
      currentRole: ctx.member.role,
      shops: shops.map((shop): ShopListItem => {
        const status = shopStatus(shop);

        return {
          id: shop.id,
          domain: shop.shop_domain,
          installedAt: shop.installed_at,
          lastSyncAt: lastSyncByShopId.get(shop.id) ?? null,
          reason: status.reason,
          scopes: shop.scopes,
          status: status.status,
        };
      }),
    };
  });

export const syncShopAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'shops.sync', section: 'shops' })
  .inputSchema(z.object({ shopId: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const result = await syncShopOrders({
      actorUserId: ctx.user.id,
      auditAction: 'shop_synced',
      merchantAccountId: ctx.member.merchantAccountId,
      shopId: parsedInput.shopId,
    });

    if (!result.ok) {
      return { ok: false as const, errorCode: result.errorCode };
    }

    revalidatePath('/parametres');
    revalidatePath('/commandes');
    revalidatePath('/boutiques');

    return { ok: true as const, syncedCount: result.syncedCount };
  });

export const disconnectShopAction = requireRole('owner')
  .metadata({ actionName: 'shops.disconnect', section: 'shops' })
  .inputSchema(z.object({ shopId: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const admin = createSupabaseAdminClient();
    const { data: shop, error: shopError } = await admin
      .from('shop')
      .update({
        status: 'uninstalled',
        updated_at: new Date().toISOString(),
      })
      .eq('id', parsedInput.shopId)
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .select('id, shop_domain')
      .maybeSingle();

    if (shopError) {
      return { ok: false as const, errorCode: 'disconnect_failed' as const };
    }

    if (!shop) {
      return { ok: false as const, errorCode: 'shop_not_found' as const };
    }

    const { error: auditError } = await admin.from('audit_log').insert({
      action: 'shop_disconnected',
      actor_user_id: ctx.user.id,
      merchant_account_id: ctx.member.merchantAccountId,
      payload: { shopDomain: shop.shop_domain },
      resource_id: shop.id,
      resource_type: 'shop',
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'disconnect_failed' as const };
    }

    revalidatePath('/parametres');
    revalidatePath('/boutiques');

    return { ok: true as const };
  });
