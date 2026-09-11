'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { resolveShopContext } from '@/lib/ingestion/resolve-shop-context';
import type { Database } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import { normalizeWooCommerceIdentity } from '@/lib/woocommerce/url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const intentLifetimeMs = 10 * 60 * 1000;

const createIntentSchema = z.object({
  shopId: z.string().uuid(),
  shopUrl: z.string().trim().min(1).max(2048),
});

function createSupabaseAdminClient() {
  return createProtectedSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function secureCallbackUrl(): URL | null {
  try {
    const url = new URL('/api/woocommerce/callback', env.NEXT_PUBLIC_APP_URL);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function buildWooCommerceAuthorizeUrl(
  identity: string,
  intentId: string,
  callbackUrl: URL,
): string {
  const url = new URL('wc-auth/v1/authorize', `${identity.replace(/\/+$/, '')}/`);
  url.searchParams.set('app_name', 'Tëër');
  url.searchParams.set('scope', 'read_write');
  url.searchParams.set('user_id', intentId);
  url.searchParams.set('return_url', new URL('/parametres', env.NEXT_PUBLIC_APP_URL).toString());
  url.searchParams.set('callback_url', callbackUrl.toString());
  return url.toString();
}

export const createWooCommerceConnectionIntentAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'woocommerce.connection_intent.create', section: 'shops' })
  .inputSchema(createIntentSchema)
  .action(async ({ ctx, parsedInput }) => {
    let externalIdentifier: string;
    try {
      externalIdentifier = normalizeWooCommerceIdentity(parsedInput.shopUrl);
    } catch {
      return { ok: false as const, errorCode: 'invalid_shop_url' as const };
    }

    // This resolution intentionally uses the authenticated user's client. It proves the caller's
    // shop scope before a service-role client is created for the service-role-only intent table.
    const userClient = ctx.supabase as unknown as SupabaseClient<Database>;
    const resolved = await resolveShopContext(userClient, {
      merchantAccountId: ctx.member.merchantAccountId,
      shopId: parsedInput.shopId,
    });
    if (!resolved.ok) {
      return { ok: false as const, errorCode: 'shop_not_found' as const };
    }

    const { data: shop, error: shopError } = await userClient
      .from('shop')
      .select('store_kind')
      .eq('id', resolved.context.shopId)
      .eq('merchant_account_id', resolved.context.merchantAccountId)
      .maybeSingle();
    if (shopError || !shop || shop.store_kind !== 'woocommerce') {
      return { ok: false as const, errorCode: 'shop_not_woocommerce' as const };
    }

    const callbackUrl = secureCallbackUrl();
    if (!callbackUrl) {
      return { ok: false as const, errorCode: 'callback_url_not_secure' as const };
    }

    const expiresAt = new Date(Date.now() + intentLifetimeMs).toISOString();
    const admin = createSupabaseAdminClient();
    const { data: intent, error: intentError } = await admin
      .from('store_connection_intent')
      .insert({
        merchant_account_id: resolved.context.merchantAccountId,
        shop_id: resolved.context.shopId,
        platform: 'woocommerce',
        external_identifier: externalIdentifier,
        created_by_member_id: ctx.member.id,
        expires_at: expiresAt,
      })
      .select('id, expires_at')
      .single();

    if (intentError || !intent) {
      return { ok: false as const, errorCode: 'intent_creation_failed' as const };
    }

    return {
      ok: true as const,
      authorizeUrl: buildWooCommerceAuthorizeUrl(externalIdentifier, intent.id, callbackUrl),
      expiresAt: intent.expires_at,
    };
  });

export type WooCommerceConnectionIntentResult = Awaited<
  ReturnType<typeof createWooCommerceConnectionIntentAction>
>;
