import { encryptToken } from '@/lib/shopify/crypto';
import { exchangeCodeForToken, validateShopDomain, verifyOAuthHmac } from '@/lib/shopify/oauth';
import { syncProductsForShop } from '@/lib/shopify/products-sync';
import { verifyState } from '@/lib/shopify/state';
import type { Database } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import { createClient } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OAUTH_STATE_COOKIE = 'shopify_oauth_state';

function redirectTo(path: string, request: NextRequest) {
  const response = NextResponse.redirect(new URL(path, request.url));
  response.cookies.delete(OAUTH_STATE_COOKIE);

  return response;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required for Shopify OAuth`);
  }

  return value;
}

function createSupabaseAdminClient() {
  return createClient<Database>(
    getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const shop = searchParams.get('shop');

  try {
    const stateCookie = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
    const payload = stateCookie ? verifyState(stateCookie) : null;

    if (!payload) {
      return redirectTo('/boutiques?error=invalid_state', request);
    }

    if (!state || state !== payload.nonce) {
      return redirectTo('/boutiques?error=state_mismatch', request);
    }

    if (!shop || shop !== payload.shopDomain || !validateShopDomain(shop)) {
      return redirectTo('/boutiques?error=shop_mismatch', request);
    }

    const clientId = getRequiredEnv('SHOPIFY_API_KEY');
    const clientSecret = getRequiredEnv('SHOPIFY_API_SECRET');

    if (!verifyOAuthHmac(searchParams, clientSecret)) {
      return redirectTo('/boutiques?error=invalid_hmac', request);
    }

    if (!code) {
      return redirectTo('/boutiques?error=connection_failed', request);
    }

    const tokenResponse = await exchangeCodeForToken({
      shop,
      clientId,
      clientSecret,
      code,
    });
    const now = new Date().toISOString();
    const supabase = createSupabaseAdminClient();
    const { data: savedShop, error: shopError } = await supabase
      .from('shop')
      .upsert(
        {
          merchant_account_id: payload.merchantAccountId,
          shop_domain: shop,
          access_token_encrypted: encryptToken(tokenResponse.accessToken),
          refresh_token_encrypted: tokenResponse.refreshToken
            ? encryptToken(tokenResponse.refreshToken)
            : null,
          access_token_expires_at: tokenResponse.accessTokenExpiresAt?.toISOString() ?? null,
          refresh_token_expires_at: tokenResponse.refreshTokenExpiresAt?.toISOString() ?? null,
          scopes: tokenResponse.scope,
          status: 'active',
          uninstalled_at: null,
          updated_at: now,
        },
        // Multi-boutiques : la clé d'unicité est le domaine (un marchand peut connecter
        // plusieurs boutiques). Une reconnexion sur le même domaine remplace le couple de tokens.
        { onConflict: 'shop_domain' },
      )
      .select('id')
      .single();

    if (shopError) {
      throw shopError;
    }

    const { error: auditError } = await supabase.from('audit_log').insert({
      merchant_account_id: payload.merchantAccountId,
      actor_user_id: null,
      action: 'shopify.connected',
      resource_type: 'shop',
      resource_id: savedShop.id,
    });

    if (auditError) {
      throw auditError;
    }

    const productsSyncResult = await syncProductsForShop({
      accessToken: tokenResponse.accessToken,
      actorUserId: null,
      admin: supabase,
      merchantAccountId: payload.merchantAccountId,
      shop: {
        id: savedShop.id,
        shop_domain: shop,
      },
    });

    if (!productsSyncResult.ok) {
      Sentry.captureMessage('Shopify product sync failed after connect', {
        level: 'warning',
        extra: {
          merchantAccountId: payload.merchantAccountId,
          shopDomain: shop,
        },
        tags: { route: 'shopify.callback' },
      });
    }

    return redirectTo('/boutiques?connected=1', request);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { route: 'shopify.callback' },
    });
    return redirectTo('/boutiques?error=connection_failed', request);
  }
}
