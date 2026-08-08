import { getMerchantAccount } from '@/lib/actions/merchant';
import { getDefaultShopifyAppOrNull, getShopifyAppByClientId } from '@/lib/shopify/apps';
import { buildAuthorizeUrl, validateShopDomain } from '@/lib/shopify/oauth';
import { generateNonce, signState } from '@/lib/shopify/state';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OAUTH_STATE_COOKIE = 'shopify_oauth_state';
const STATE_MAX_AGE_SECONDS = 10 * 60;

function safeReturnPath(value: string | null): string | undefined {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return undefined;
  }

  return value.startsWith('/shopify/embedded') ? value : undefined;
}

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
  const returnTo = safeReturnPath(request.nextUrl.searchParams.get('return_to'));

  if (!validateShopDomain(shop)) {
    return redirectTo('/boutiques?error=invalid_shop', request);
  }

  // Multi-app : un client_id explicite (ex. install custom Teer Pilote) sélectionne l'app ;
  // sinon on retombe sur l'app par défaut (Teer Dev, rétrocompat de l'install publique).
  const requestedClientId = request.nextUrl.searchParams.get('client_id')?.trim() || null;
  const app = requestedClientId
    ? getShopifyAppByClientId(requestedClientId)
    : getDefaultShopifyAppOrNull();

  if (requestedClientId && !app) {
    // client_id fourni mais inconnu du registre → erreur propre.
    return NextResponse.json({ error: 'unknown_client_id' }, { status: 400 });
  }

  if (!app) {
    Sentry.captureMessage('No Shopify app configured', {
      level: 'error',
      tags: { route: 'shopify.install' },
    });
    return NextResponse.json({ error: 'missing_shopify_app' }, { status: 500 });
  }

  const requestUrl = new URL(request.url);
  const redirectUri = `${requestUrl.origin}/api/shopify/callback`;
  const nonce = generateNonce();
  const state = signState({
    nonce,
    merchantAccountId: merchantAccount.id,
    shopDomain: shop,
    exp: Date.now() + STATE_MAX_AGE_SECONDS * 1000,
    clientId: app.clientId,
    returnTo,
  });
  const authorizeUrl = buildAuthorizeUrl({
    shop,
    clientId: app.clientId,
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
