import {
  getDefaultShopifyAppOrNull,
  getShopifyAppByLabel,
  isKnownShopifyAppLabel,
} from '@/lib/shopify/apps';
import { selectEmbeddedInstallApp } from '@/lib/shopify/embedded-install-selection';
import { validateShopDomain } from '@/lib/shopify/oauth';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function redirectToLogin(
  request: NextRequest,
  shop: string,
  host: string,
  appLabel: string | null,
) {
  const installUrl = new URL('/api/shopify/embedded/install', request.url);
  installUrl.searchParams.set('shop', shop);
  if (host) installUrl.searchParams.set('host', host);
  if (appLabel) installUrl.searchParams.set('app_label', appLabel);
  return NextResponse.redirect(
    new URL(
      `/connexion?redirectTo=${encodeURIComponent(installUrl.pathname + installUrl.search)}`,
      request.url,
    ),
  );
}

export async function GET(request: NextRequest) {
  const shop = request.nextUrl.searchParams.get('shop')?.trim().toLowerCase() ?? '';
  const host = request.nextUrl.searchParams.get('host')?.trim() ?? '';
  const appLabel = request.nextUrl.searchParams.get('app_label')?.trim() || null;

  if (!validateShopDomain(shop)) {
    return NextResponse.json({ error: 'invalid_shop' }, { status: 400 });
  }

  let selectedApp = null;
  if (appLabel) {
    const selection = selectEmbeddedInstallApp(appLabel, {
      getDefault: getDefaultShopifyAppOrNull,
      getByLabel: (label) => getShopifyAppByLabel(label),
      hasLabel: (label) => isKnownShopifyAppLabel(label),
    });
    if (selection.kind === 'unknown_label') {
      return NextResponse.json({ error: 'unknown_shopify_app' }, { status: 400 });
    }
    if (selection.kind === 'missing_credentials' || !selection.app) {
      return NextResponse.json({ error: 'missing_shopify_app' }, { status: 503 });
    }
    selectedApp = selection.app;
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectToLogin(request, shop, host, appLabel);
  }

  const returnTo = appLabel
    ? `/shopify/embedded/${encodeURIComponent(appLabel)}${host ? `?host=${encodeURIComponent(host)}` : ''}`
    : `/shopify/embedded${host ? `?host=${encodeURIComponent(host)}` : ''}`;
  const installUrl = new URL('/api/shopify/install', request.url);
  installUrl.searchParams.set('shop', shop);
  installUrl.searchParams.set('return_to', returnTo);
  if (selectedApp) installUrl.searchParams.set('client_id', selectedApp.clientId);

  return NextResponse.redirect(installUrl);
}
