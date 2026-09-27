import { getMerchantAccount } from '@/lib/actions/merchant';
import { getShopifyAppByLabel } from '@/lib/shopify/apps';
import { hasUsableCredentialsForApp } from '@/lib/shopify/non-embedded-credentials';
import {
  SHOPIFY_NON_EMBEDDED_INTENT_COOKIE,
  readShopifyNonEmbeddedIntentLabel,
  verifyShopifyNonEmbeddedInstallIntent,
} from '@/lib/shopify/non-embedded-install-intent';
import { validateShopDomain } from '@/lib/shopify/oauth';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SHOPS_SURFACE = '/parametres?tab=shops&connected=1';
const LOGIN_TARGET = '/connexion?redirectTo=%2Fshopify%2Finstall-entry';

function redirect(request: NextRequest, path: string, clearIntent = false) {
  const response = NextResponse.redirect(new URL(path, request.url));
  if (clearIntent) response.cookies.delete(SHOPIFY_NON_EMBEDDED_INTENT_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  const rawIntent = request.cookies.get(SHOPIFY_NON_EMBEDDED_INTENT_COOKIE)?.value;
  if (!rawIntent) {
    return NextResponse.json({ error: 'missing_install_intent' }, { status: 400 });
  }

  const appLabel = readShopifyNonEmbeddedIntentLabel(rawIntent);
  const app = getShopifyAppByLabel(appLabel);
  if (!app) {
    const response = NextResponse.json({ error: 'unknown_app_label' }, { status: 400 });
    response.cookies.delete(SHOPIFY_NON_EMBEDDED_INTENT_COOKIE);
    return response;
  }

  const intent = verifyShopifyNonEmbeddedInstallIntent(rawIntent, app.clientSecret);
  if (!intent || intent.appLabel !== app.label || !validateShopDomain(intent.shop)) {
    const response = NextResponse.json({ error: 'invalid_install_intent' }, { status: 400 });
    response.cookies.delete(SHOPIFY_NON_EMBEDDED_INTENT_COOKIE);
    return response;
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect(request, LOGIN_TARGET);

  const merchantAccount = await getMerchantAccount();
  if (!merchantAccount) return redirect(request, '/s', true);
  const normalizedShop = intent.shop.toLowerCase();

  type ExistingShop = {
    shopify_client_id: string | null;
    status: string;
    store_kind: string;
    access_token_encrypted: string | null;
    access_token_expires_at: string | null;
    refresh_token_encrypted: string | null;
    refresh_token_expires_at: string | null;
  };
  const existingShop = await (async (): Promise<ExistingShop | null> => {
    try {
      const { data, error } = await supabase
        .from('shop')
        .select(
          'shopify_client_id, status, store_kind, access_token_encrypted, access_token_expires_at, refresh_token_encrypted, refresh_token_expires_at',
        )
        .eq('merchant_account_id', merchantAccount.id)
        .eq('shop_domain', normalizedShop)
        .eq('shopify_client_id', app.clientId)
        .maybeSingle();
      return error ? null : (data as ExistingShop | null);
    } catch {
      // A failed read cannot satisfy the strict connected-shop gate; continue by OAuth.
      return null;
    }
  })();

  if (
    existingShop &&
    hasUsableCredentialsForApp(
      {
        shopifyClientId: existingShop.shopify_client_id,
        status: existingShop.status,
        storeKind: existingShop.store_kind,
        accessTokenEncrypted: existingShop.access_token_encrypted,
        accessTokenExpiresAt: existingShop.access_token_expires_at,
        refreshTokenEncrypted: existingShop.refresh_token_encrypted,
        refreshTokenExpiresAt: existingShop.refresh_token_expires_at,
      },
      app.clientId,
    )
  ) {
    return redirect(request, SHOPS_SURFACE, true);
  }

  const installUrl = new URL('/api/shopify/install', request.url);
  installUrl.searchParams.set('shop', normalizedShop);
  installUrl.searchParams.set('client_id', app.clientId);
  installUrl.searchParams.set('return_to', SHOPS_SURFACE);
  const response = NextResponse.redirect(installUrl);
  response.cookies.delete(SHOPIFY_NON_EMBEDDED_INTENT_COOKIE);
  return response;
}
