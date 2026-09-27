import { getShopifyAppByLabel } from '@/lib/shopify/apps';
import {
  SHOPIFY_NON_EMBEDDED_INTENT_COOKIE,
  SHOPIFY_NON_EMBEDDED_INTENT_TTL_SECONDS,
  readShopifyNonEmbeddedIntentLabel,
  verifyShopifyNonEmbeddedInstallIntent,
} from '@/lib/shopify/non-embedded-install-intent';
import { validateShopDomain } from '@/lib/shopify/oauth';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const rawIntent = request.nextUrl.searchParams.get('intent');
  if (!rawIntent) {
    return NextResponse.json({ error: 'invalid_install_intent' }, { status: 400 });
  }

  const appLabel = readShopifyNonEmbeddedIntentLabel(rawIntent);
  const app = getShopifyAppByLabel(appLabel);
  if (!app) {
    return NextResponse.json({ error: 'unknown_app_label' }, { status: 400 });
  }

  const intent = rawIntent
    ? verifyShopifyNonEmbeddedInstallIntent(rawIntent, app.clientSecret)
    : null;
  if (!intent || intent.appLabel !== app.label || !validateShopDomain(intent.shop)) {
    return NextResponse.json({ error: 'invalid_install_intent' }, { status: 400 });
  }

  const response = NextResponse.redirect(
    new URL('/connexion?redirectTo=%2Fshopify%2Finstall-entry', request.url),
  );
  response.cookies.set(SHOPIFY_NON_EMBEDDED_INTENT_COOKIE, rawIntent, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SHOPIFY_NON_EMBEDDED_INTENT_TTL_SECONDS,
  });
  return response;
}
