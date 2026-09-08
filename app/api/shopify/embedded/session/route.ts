import { ShopifyAppIdentityMismatchError } from '@/lib/shopify/app-identity-errors';
import { getShopifyAppByClientId } from '@/lib/shopify/apps';
import { encryptToken } from '@/lib/shopify/crypto';
import { buildShopifyEmbeddedAppUrl, decodeShopifyEmbeddedHost } from '@/lib/shopify/embedded-host';
import { signEmbeddedLinkIntent } from '@/lib/shopify/embedded-link-intent';
import { exchangeIdTokenForOfflineToken } from '@/lib/shopify/oauth';
import {
  extractShopifySessionAudience,
  verifyShopifySessionToken,
} from '@/lib/shopify/session-token';
import type { Database } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import * as Sentry from '@sentry/nextjs';
import { type NextRequest, NextResponse } from 'next/server';

// Durée de validité de la continuation de rattachement — le temps d'un aller-retour de login,
// rejouable (l'utilisateur peut recharger l'écran de confirmation sans relancer le parcours).
const EMBEDDED_LINK_INTENT_TTL_MS = 10 * 60 * 1000;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `process.env` direct, jamais `lib/env.ts` : ce module valide TOUTES les variables serveur au
// chargement (Zod), ce qui force un environnement de test complet pour importer ne serait-ce
// qu'une fonction pure d'un fichier qui l'importe transitivement (cf. CLAUDE.md). Même choix que
// `app/api/shopify/callback/route.ts`.
function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required for the Shopify embedded session route`);
  }

  return value;
}

function createSupabaseAdminClient() {
  return createProtectedSupabaseClient(
    getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

function bearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get('authorization');
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

function publicShopState(
  status: 'active' | 'uninstalled',
  shop: {
    shop_domain: string;
    installed_at: string;
    updated_at: string;
    last_reconciled_at: string | null;
  },
) {
  return {
    status: status === 'active' ? ('ready' as const) : ('uninstalled' as const),
    shop: {
      domain: shop.shop_domain,
      installedAt: shop.installed_at,
      lastSyncAt: shop.last_reconciled_at ?? null,
      updatedAt: shop.updated_at,
    },
    nextAction: status === 'active' ? ('open_cockpit' as const) : ('reinstall' as const),
  };
}

export async function GET(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) {
    return NextResponse.json({ error: 'missing_session_token' }, { status: 401 });
  }

  // L'audience non vérifiée sert uniquement à sélectionner les credentials candidats. La
  // signature et les claims complets sont ensuite vérifiés avant toute lecture de boutique.
  const clientId = extractShopifySessionAudience(token);
  const app = clientId ? getShopifyAppByClientId(clientId) : null;
  if (!app) {
    return NextResponse.json({ error: 'unknown_shopify_app' }, { status: 401 });
  }

  const verification = verifyShopifySessionToken(token, {
    clientId: app.clientId,
    clientSecret: app.clientSecret,
  });
  if (!verification.ok) {
    return NextResponse.json({ error: 'invalid_session_token' }, { status: 401 });
  }

  const requestedShop = request.nextUrl.searchParams.get('shop')?.trim().toLowerCase();
  if (requestedShop && requestedShop !== verification.shopDomain) {
    return NextResponse.json({ error: 'shop_mismatch' }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const { data: shop, error } = await admin
    .from('shop')
    .select(
      'id, shop_domain, shopify_client_id, status, access_token_encrypted, installed_at, updated_at, last_reconciled_at, merchant_account_id',
    )
    .eq('shop_domain', verification.shopDomain)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'shop_lookup_failed' }, { status: 500 });
  }

  if (!shop) {
    // La continuation n'est émise que si `host` est présent ET valide — sans elle, aucune
    // destination Shopify Admin n'est constructible en fin de parcours (cf. buildShopifyEmbeddedAppUrl) ;
    // on renvoie alors `not_configured` sans `loginUrl`, le client affiche un état fermé plutôt
    // que de démarrer un rattachement qui ne pourrait jamais revenir dans Shopify Admin.
    const rawHost = request.nextUrl.searchParams.get('host');
    const loginUrl =
      rawHost && decodeShopifyEmbeddedHost(rawHost)
        ? (() => {
            const intent = signEmbeddedLinkIntent({
              shopDomain: verification.shopDomain,
              clientId: app.clientId,
              host: rawHost,
              exp: Date.now() + EMBEDDED_LINK_INTENT_TTL_MS,
            });
            const continueTarget = `/shopify/embedded-link?intent=${encodeURIComponent(intent)}`;
            return `/connexion?redirectTo=${encodeURIComponent(continueTarget)}`;
          })()
        : null;

    return NextResponse.json({
      status: 'not_configured' as const,
      shop: { domain: verification.shopDomain },
      nextAction: 'associate_teer' as const,
      ...(loginUrl ? { loginUrl } : {}),
    });
  }

  // Confrontation stricte : l'app ayant vérifié l'ID token (`app.clientId`) doit être
  // exactement celle enregistrée sur la boutique. AUCUN repli implicite vers une app "par
  // défaut" quand `shopify_client_id` est absent — une boutique legacy sans client_id est un
  // désaccord, jamais une présomption Teer Dev. Divergence → jamais `ready`, aucune identité
  // historique (label, client_id, tenant) dans la réponse publique ; seule une capture Sentry
  // interne porte un code stable (jamais déduit du texte de message).
  if (shop.shopify_client_id !== app.clientId) {
    Sentry.captureException(new ShopifyAppIdentityMismatchError(), {
      tags: { route: 'shopify.embedded.session', reason: 'app_identity_mismatch' },
    });
    return NextResponse.json({ status: 'app_identity_mismatch' as const });
  }

  if (shop.status !== 'active' && shop.status !== 'uninstalled') {
    return NextResponse.json({ error: 'invalid_shop_status' }, { status: 500 });
  }

  // Deux cas déclenchent un (ré)échange de token, tous deux avec un ID token frais (celui-ci
  // même, déjà vérifié ci-dessus) et une ligne `shop` qui sait déjà à qui elle appartient —
  // rattachement/réinstallation et échange n'ont jamais à tenir dans le même aller-retour :
  //   - rattachement en attente : `status` déjà 'active', `access_token_encrypted` NULL (écrit
  //     par l'écran de confirmation, état représentable sans migration, cf. rapport de préflight) ;
  //   - réinstallation (webhook `app/uninstalled` déjà reçu, `status='uninstalled'`) : Teer Public
  //     n'a AUCUN chemin par `/api/shopify/install` (refusé, cf. app/api/shopify/install/route.ts)
  //     — la réinstallation redevient actionnable simplement en rouvrant l'app dans Shopify Admin,
  //     qui recharge cette même surface avec un nouvel ID token. L'ancien access_token_encrypted
  //     n'est jamais réutilisé : il n'est lu nulle part sur ce chemin, seulement écrasé au succès.
  if ((shop.status === 'active' && !shop.access_token_encrypted) || shop.status === 'uninstalled') {
    const linked = await completeCredentialsLink(admin, shop, app, token, verification.shopDomain);
    if (!linked.ok) {
      return NextResponse.json({
        status: 'link_retry' as const,
        shop: { domain: verification.shopDomain },
      });
    }
    return NextResponse.json(publicShopState('active', linked.shop));
  }

  return NextResponse.json(publicShopState(shop.status, shop));
}

type LinkableShopRow = {
  id: string;
  shop_domain: string;
  merchant_account_id: string;
};

async function completeCredentialsLink(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  shop: LinkableShopRow,
  app: { clientId: string; clientSecret: string },
  idToken: string,
  shopDomain: string,
): Promise<
  | {
      ok: true;
      shop: {
        shop_domain: string;
        installed_at: string;
        updated_at: string;
        last_reconciled_at: string | null;
      };
    }
  | { ok: false }
> {
  let tokenResponse: Awaited<ReturnType<typeof exchangeIdTokenForOfflineToken>>;
  try {
    tokenResponse = await exchangeIdTokenForOfflineToken({
      shop: shopDomain,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      idToken,
    });
  } catch (tokenExchangeError) {
    Sentry.captureException(tokenExchangeError, {
      tags: { route: 'shopify.embedded.session', reason: 'token_exchange_failed' },
    });
    return { ok: false };
  }

  const now = new Date().toISOString();
  const { data: updatedShop, error: updateError } = await admin
    .from('shop')
    .update({
      access_token_encrypted: encryptToken(tokenResponse.accessToken),
      refresh_token_encrypted: tokenResponse.refreshToken
        ? encryptToken(tokenResponse.refreshToken)
        : null,
      access_token_expires_at: tokenResponse.accessTokenExpiresAt?.toISOString() ?? null,
      refresh_token_expires_at: tokenResponse.refreshTokenExpiresAt?.toISOString() ?? null,
      scopes: tokenResponse.scope,
      status: 'active',
      updated_at: now,
    })
    .eq('id', shop.id)
    .select('shop_domain, installed_at, updated_at, last_reconciled_at')
    .single();

  if (updateError || !updatedShop) {
    Sentry.captureException(updateError ?? new Error('shopify_credentials_persist_failed'), {
      tags: { route: 'shopify.embedded.session', reason: 'credentials_persist_failed' },
    });
    return { ok: false };
  }

  // Best-effort et non bloquant, même discipline que le callback OAuth legacy
  // (app/api/shopify/callback/route.ts) : un échec ici ne doit jamais faire régresser une
  // connexion Shopify déjà réussie (credentials déjà persistées). merchant_account_id n'est
  // jamais dans le payload de mise à jour — seulement comme filtre WHERE, jamais réassignable.
  const storeConnectionWritePayload = {
    shop_id: shop.id,
    platform: 'shopify' as const,
    external_identifier: shop.shop_domain,
    platform_app_id: app.clientId,
    status: 'active',
    uninstalled_at: null,
  };

  const { error: insertConnectionError } = await admin
    .from('store_connection')
    .insert({ ...storeConnectionWritePayload, merchant_account_id: shop.merchant_account_id });

  if (insertConnectionError) {
    if (insertConnectionError.code === '23505') {
      const { error: updateConnectionError } = await admin
        .from('store_connection')
        .update(storeConnectionWritePayload)
        .eq('platform', 'shopify')
        .eq('external_identifier', shop.shop_domain)
        .eq('merchant_account_id', shop.merchant_account_id);

      if (updateConnectionError) {
        Sentry.captureException(new Error('shopify_store_connection_upsert_failed'), {
          tags: { route: 'shopify.embedded.session' },
          extra: { message: updateConnectionError.message },
        });
      }
    } else {
      Sentry.captureException(new Error('shopify_store_connection_upsert_failed'), {
        tags: { route: 'shopify.embedded.session' },
        extra: { message: insertConnectionError.message },
      });
    }
  }

  return { ok: true, shop: updatedShop };
}
