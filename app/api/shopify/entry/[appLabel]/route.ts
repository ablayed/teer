import { getShopifyAppByLabel } from '@/lib/shopify/apps';
// SHOPIFY-OAUTH-FIRST-01 / B1 — entrée `application_url` hors de l'iframe (D12, D13, D19).
//
// Pourquoi un route handler et non la page `app/shopify/embedded/[appLabel]/page.tsx` : la
// branche d'autorisation doit POSER le cookie de state avant la redirection vers Shopify, et
// Next.js 15 interdit toute écriture de cookie pendant le rendu d'un composant serveur
// (« Cookies can only be modified in a Server Action or Route Handler »,
// next/dist/server/web/spec-extension/adapters/request-cookies.js). La page se contente donc de
// transmettre la requête signée par Shopify, sans rien rendre ; toute la décision vit ici, et
// elle est reprise en entier à chaque appel — un appel direct à cette route n'en contourne
// aucune garde.
//
// Ordre :
//   1. app connue, requête Shopify vérifiée (HMAC, paramètres uniques, ±5 min, domaine) ;
//   2. classification D16a (`classify_shopify_entry`) par le client service-role — EXCEPTION
//      NOMMÉE (supabase/security/service-role-inventory.json) : la fonction est réservée à
//      `service_role` et ne rend qu'une énumération, sans locataire ni credential ;
//   3. D19 : pour une boutique installée, déchiffrement en mémoire des credentials ;
//   4. tableau D12 : arrivée (R1), erreur D15, ou autorisation — state et nonce signés SANS
//      locataire, cookie de state, 307 vers /admin/oauth/authorize. Aucun rendu avant.
// Aucune branche n'écrit en base.
import { shopifyArrivalPath } from '@/lib/shopify/arrival';
import {
  decideShopifyEntry,
  entryCredentialsReadable,
  isInstalledClassification,
  verifyShopifyEntryQuery,
} from '@/lib/shopify/entry';
import { buildAuthorizeUrl } from '@/lib/shopify/oauth';
import { type ShopifyPublicErrorCode, shopifyPublicErrorPath } from '@/lib/shopify/public-error';
import { generateNonce, signState } from '@/lib/shopify/state';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OAUTH_STATE_COOKIE = 'shopify_oauth_state';
const STATE_MAX_AGE_SECONDS = 10 * 60;

function createSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createProtectedSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function redirectTo(path: string, request: NextRequest) {
  return NextResponse.redirect(new URL(path, request.url));
}

function publicError(code: ShopifyPublicErrorCode, request: NextRequest) {
  return redirectTo(shopifyPublicErrorPath(code), request);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appLabel: string }> },
) {
  const { appLabel } = await params;
  const app = getShopifyAppByLabel(appLabel);
  if (!app) {
    return publicError('invalid_request', request);
  }

  const verified = verifyShopifyEntryQuery(request.nextUrl.searchParams, app.clientSecret);
  if (!verified.ok) {
    return publicError('invalid_request', request);
  }
  const shop = verified.shop;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return publicError('unknown', request);
  }

  const { data: classification, error: classificationError } = await admin.rpc(
    'classify_shopify_entry',
    { p_shop_domain: shop, p_client_id: app.clientId },
  );
  if (classificationError) {
    Sentry.captureMessage('shopify_entry_classification_failed', {
      level: 'error',
      tags: { route: 'shopify.entry' },
      extra: { code: classificationError.code },
    });
    return publicError('unknown', request);
  }

  let credentialsReadable = true;
  if (isInstalledClassification(classification)) {
    const { data: credentials, error: credentialsError } = await admin
      .from('shop')
      .select('access_token_encrypted, refresh_token_encrypted')
      .eq('shop_domain', shop)
      .maybeSingle();
    if (credentialsError) {
      return publicError('unknown', request);
    }
    credentialsReadable = entryCredentialsReadable(credentials, classification);
  }

  const decision = decideShopifyEntry(classification, credentialsReadable);

  if (decision.kind === 'error') {
    if (decision.code === 'credentials_unavailable') {
      // D19 — sentinelle expurgée : ni jeton, ni domaine, ni locataire. Aucun grant, aucune
      // écriture : le marchand est orienté vers le support.
      Sentry.captureMessage('shopify_entry_credentials_unreadable', {
        level: 'error',
        tags: { route: 'shopify.entry', reason: 'credentials_unreadable' },
      });
    }
    return publicError(decision.code, request);
  }

  if (decision.kind === 'arrive') {
    // R1 — aucun grant : un nouveau grant retirerait le refresh token en place.
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return redirectTo(
      shopifyArrivalPath({ hasSession: Boolean(user), syncPending: false }),
      request,
    );
  }

  const nonce = generateNonce();
  const state = signState({
    nonce,
    shopDomain: shop,
    exp: Date.now() + STATE_MAX_AGE_SECONDS * 1000,
    clientId: app.clientId,
  });
  const redirectUri = `${new URL(request.url).origin}/api/shopify/callback`;
  const response = NextResponse.redirect(
    buildAuthorizeUrl({ shop, clientId: app.clientId, redirectUri, state: nonce }),
  );
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: STATE_MAX_AGE_SECONDS,
  });
  return response;
}
