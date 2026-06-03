import { getMerchantAccount } from '@/lib/actions/merchant';
import { buildAuthorizeUrl, validateShopDomain } from '@/lib/shopify/oauth';
import { generateNonce, signState } from '@/lib/shopify/state';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OAUTH_STATE_COOKIE = 'shopify_oauth_state';
const STATE_MAX_AGE_SECONDS = 10 * 60;

function redirectTo(path: string, request: NextRequest) {
  return NextResponse.redirect(new URL(path, request.url));
}

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectTo('/connexion', request);
  }

  const merchantAccount = await getMerchantAccount();

  if (!merchantAccount) {
    return redirectTo('/connexion', request);
  }

  const shop = request.nextUrl.searchParams.get('shop')?.trim() ?? '';

  if (!validateShopDomain(shop)) {
    return redirectTo('/boutiques?error=invalid_shop', request);
  }

  const clientId = process.env.SHOPIFY_API_KEY;

  if (!clientId) {
    Sentry.captureMessage('Missing SHOPIFY_API_KEY', {
      level: 'error',
      tags: { route: 'shopify.install' },
    });
    return NextResponse.json({ error: 'missing_shopify_api_key' }, { status: 500 });
  }

  const requestUrl = new URL(request.url);
  const redirectUri = `${requestUrl.origin}/api/shopify/callback`;
  const nonce = generateNonce();
  const state = signState({
    nonce,
    merchantAccountId: merchantAccount.id,
    shopDomain: shop,
    exp: Date.now() + STATE_MAX_AGE_SECONDS * 1000,
  });
  const authorizeUrl = buildAuthorizeUrl({
    shop,
    clientId,
    redirectUri,
    state: nonce,
  });
  const response = NextResponse.redirect(authorizeUrl);

  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: STATE_MAX_AGE_SECONDS,
  });

  return response;
}
