import { getMerchantAccountById, getMerchantMemberForUser } from '@/lib/actions/merchant';
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

  if (value.startsWith('/shopify/embedded')) {
    return value;
  }

  return value === '/parametres?tab=shops&connected=1' ? value : undefined;
}

function redirectTo(path: string, request: NextRequest) {
  return NextResponse.redirect(new URL(path, request.url));
}

// Modèle de app/api/shopify/embedded/install/route.ts : la connexion reprend CE point
// d'installation, reconstruit à partir de ses seuls paramètres connus.
function redirectToLogin(request: NextRequest) {
  const installUrl = new URL('/api/shopify/install', request.url);
  for (const key of ['shop', 'client_id', 'return_to']) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) installUrl.searchParams.set(key, value);
  }
  return redirectTo(
    `/connexion?redirectTo=${encodeURIComponent(installUrl.pathname + installUrl.search)}`,
    request,
  );
}

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectToLogin(request);
  }

  // SHOPIFY-OAUTH-FIRST-01 / D4 — installer une boutique est réservé à `owner` et `manager`,
  // vérifié ICI, côté serveur (même lecture que `requireRole`). Un utilisateur sans espace va
  // vers l'onboarding.
  const member = await getMerchantMemberForUser(user.id);
  if (!member) {
    return redirectTo('/onboarding', request);
  }
  if (member.role !== 'owner' && member.role !== 'manager') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const merchantAccount = await getMerchantAccountById(member.merchant_account_id);
  if (!merchantAccount) {
    return redirectTo('/onboarding', request);
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

  // SHOPIFY-OAUTH-FIRST-01 / D23, option (a) — une app PUBLIQUE ne s'installe jamais par cette
  // route. Son seul chemin est l'entrée `application_url` sans session
  // (app/api/shopify/entry/[appLabel]/route.ts), dont le grant passe par D16b sous le bail du
  // domaine. Deux grants concurrents hors du même bail retireraient l'un l'autre leur refresh
  // token. Aucun appelant légitime ne porte le `client_id` d'une app publique vers cette route
  // (relevé de l'étape 0 : seul app/api/shopify/embedded/install/route.ts l'appelle, pour les
  // apps historiques). Le refus précède toute création de state, tout cookie et toute
  // redirection OAuth.
  if (app.distribution === 'public') {
    return NextResponse.json({ error: 'app_not_installable_here' }, { status: 403 });
  }

  // Rappel de sélection, verrouillé par tests/unit/shopify-install-app-selection.test.ts :
  // un `client_id` EXPLICITE choisit l'app, un `client_id` ABSENT retombe sur l'app par défaut
  // (Teer Dev). Mesurer Teer Public exige donc de passer son `client_id` — l'omettre
  // installerait Teer Dev et produirait un faux succès.

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
