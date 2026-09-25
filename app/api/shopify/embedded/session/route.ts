import { ShopifyAppIdentityMismatchError } from '@/lib/shopify/app-identity-errors';
import { type ShopifyAppConfig, getShopifyAppByClientId } from '@/lib/shopify/apps';
import { encryptToken } from '@/lib/shopify/crypto';
import { buildShopifyEmbeddedAppUrl, decodeShopifyEmbeddedHost } from '@/lib/shopify/embedded-host';
import { signEmbeddedLinkIntent } from '@/lib/shopify/embedded-link-intent';
import { exchangeIdTokenForOfflineToken } from '@/lib/shopify/oauth';
import {
  extractShopifySessionAudience,
  verifyShopifySessionToken,
} from '@/lib/shopify/session-token';
import {
  acquireShopifyTokenLease,
  persistShopifyCredentialsFenced,
  releaseShopifyTokenLease,
  reportShopifyTokenLeaseBusy,
  reportShopifyTokenLeaseLost,
  writeShopifyStoreConnectionFenced,
} from '@/lib/shopify/token-lease';
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

  // Le nouveau parcours de continuation (jeton signé + retour top-level) n'a de sens QUE pour
  // Teer Public — c'est le seul chemin sans `/api/shopify/install` (refusé pour Teer Public,
  // cf. app/api/shopify/install/route.ts). Les apps historiques gardent leur lien legacy
  // inchangé (rendu côté client). La continuation n'est émise que si `host` est en plus présent
  // ET valide — sans elle, aucune destination Shopify Admin n'est constructible en fin de
  // parcours (cf. buildShopifyEmbeddedAppUrl) ; le client doit alors afficher un état fermé,
  // jamais un repli vers le lien legacy que ce lot retire précisément pour Teer Public.
  const notConfiguredResponse = () => {
    const rawHost = request.nextUrl.searchParams.get('host');
    const loginUrl =
      app.label === 'teer-public' && rawHost && decodeShopifyEmbeddedHost(rawHost)
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
      appLabel: app.label,
      ...(loginUrl ? { loginUrl } : {}),
    });
  };

  if (!shop) {
    return notConfiguredResponse();
  }

  // `shopify_client_id` NULL signifie « aucune app rattachée », JAMAIS « une autre app ». C'est
  // exactement l'état que produit la libération d'identité par le propriétaire
  // (lib/shopify/app-release-write.ts : shop.shopify_client_id → NULL, store_connection
  // .platform_app_id → NULL, status → 'uninstalled', credentials NULL) — état que le rattachement
  // sait déjà accueillir (`decideShopAppSwitch` renvoie `ok` sur NULL, et
  // `performShopifyEmbeddedLink` écrit avec un prédicat `.is('shopify_client_id', null)`
  // explicite). Le traiter comme une divergence rendait toute boutique libérée irrattachable :
  // les deux gardes divergeaient sur le même état. La boutique repart donc de l'état qui INVITE
  // au rattachement, exactement comme une boutique inconnue — le parcours qui suit reste gardé
  // par le rôle marchand, la bascule d'app et la propriété par tenant, jamais par cette réponse.
  // Motif projet : `is distinct from` plutôt que `<>` — un NULL n'est pas une valeur discordante.
  if (shop.shopify_client_id === null) {
    return notConfiguredResponse();
  }

  // Confrontation stricte : l'app ayant vérifié l'ID token (`app.clientId`) doit être
  // exactement celle enregistrée sur la boutique. AUCUN repli implicite vers une app "par
  // défaut" — une boutique portant le client_id d'une AUTRE app est un désaccord, jamais une
  // présomption. Divergence → jamais `ready`, jamais `not_configured` (aucun lien d'installation
  // offert), aucune identité historique (label, client_id, tenant, domaine) dans la réponse
  // publique ; seule une capture Sentry interne porte un code stable (jamais déduit du texte de
  // message). C'est la protection contre l'écrasement des credentials d'une app historique
  // (ex. KOBA) — le cas NULL traité juste au-dessus ne l'affaiblit pas.
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
  shopify_client_id: string | null;
};

async function completeCredentialsLink(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  shop: LinkableShopRow,
  app: Pick<ShopifyAppConfig, 'clientId' | 'clientSecret' | 'distribution'>,
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
  // SHOPIFY-EXPIRING-TOKENS-01 — échange par ID token SOUS BAIL (lib/shopify/token-lease.ts).
  // Acquisition AVANT l'appel Shopify : un bail tenu arrête l'échange ici, sans appel sortant ;
  // la surface répond `link_retry`, exactement comme pour un échec d'échange. L'écriture passe par
  // `persist_shopify_credentials_fenced` (mode `token_exchange`) : génération courante, locataire
  // et app STRICTE (NULL compris), sous verrou — les prédicats de l'ancienne mise à jour.
  const lease = await acquireShopifyTokenLease(admin, shopDomain);
  if (!lease.ok) {
    if (lease.reason === 'lease_held') {
      reportShopifyTokenLeaseBusy('token_exchange');
    }
    return { ok: false };
  }

  try {
    let tokenResponse: Awaited<ReturnType<typeof exchangeIdTokenForOfflineToken>>;
    try {
      tokenResponse = await exchangeIdTokenForOfflineToken({
        shop: shopDomain,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        idToken,
        distribution: app.distribution,
      });
    } catch (tokenExchangeError) {
      Sentry.captureException(tokenExchangeError, {
        tags: { route: 'shopify.embedded.session', reason: 'token_exchange_failed' },
      });
      return { ok: false };
    }

    const persisted = await persistShopifyCredentialsFenced(admin, {
      mode: 'token_exchange',
      shopDomain,
      generation: lease.generation,
      merchantAccountId: shop.merchant_account_id,
      clientId: app.clientId,
      accessTokenEncrypted: encryptToken(tokenResponse.accessToken),
      refreshTokenEncrypted: tokenResponse.refreshToken
        ? encryptToken(tokenResponse.refreshToken)
        : null,
      accessTokenExpiresAt: tokenResponse.accessTokenExpiresAt?.toISOString() ?? null,
      refreshTokenExpiresAt: tokenResponse.refreshTokenExpiresAt?.toISOString() ?? null,
      scopes: tokenResponse.scope,
    });

    if (persisted.outcome === 'lease_lost') {
      reportShopifyTokenLeaseLost('token_exchange');
      return { ok: false };
    }

    if (persisted.outcome !== 'updated' || persisted.shopId !== shop.id) {
      Sentry.captureException(new Error('shopify_credentials_persist_failed'), {
        tags: { route: 'shopify.embedded.session', reason: 'credentials_persist_failed' },
        extra: { outcome: persisted.outcome },
      });
      return { ok: false };
    }

    // Best-effort et non bloquant, en transaction distincte, même discipline que le callback
    // OAuth : un échec ici ne fait jamais régresser des credentials déjà persistés.
    const connectionOutcome = await writeShopifyStoreConnectionFenced(admin, {
      shopDomain,
      generation: lease.generation,
      merchantAccountId: shop.merchant_account_id,
      clientId: app.clientId,
    });

    if (connectionOutcome !== 'written') {
      Sentry.captureException(new Error('shopify_store_connection_upsert_failed'), {
        tags: { route: 'shopify.embedded.session' },
        extra: { outcome: connectionOutcome },
      });
    }
  } finally {
    await releaseShopifyTokenLease(admin, shopDomain, lease.generation);
  }

  const { data: updatedShop, error: readError } = await admin
    .from('shop')
    .select('shop_domain, installed_at, updated_at, last_reconciled_at')
    .eq('id', shop.id)
    .single();

  if (readError || !updatedShop) {
    Sentry.captureException(readError ?? new Error('shopify_credentials_readback_failed'), {
      tags: { route: 'shopify.embedded.session', reason: 'credentials_readback_failed' },
    });
    return { ok: false };
  }

  return { ok: true, shop: updatedShop };
}
