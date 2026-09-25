import { ShopifyAppSwitchRefusedError } from '@/lib/shopify/app-identity-errors';
import { decideShopAppSwitch } from '@/lib/shopify/app-switch-guard';
import { getDefaultShopifyAppOrNull, getShopifyAppByClientId } from '@/lib/shopify/apps';
import { encryptToken } from '@/lib/shopify/crypto';
import { exchangeCodeForToken, validateShopDomain, verifyOAuthHmac } from '@/lib/shopify/oauth';
import { decideShopOwnership } from '@/lib/shopify/ownership-guard';
import { syncProductsForShop } from '@/lib/shopify/products-sync';
import { verifyState } from '@/lib/shopify/state';
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
  return createProtectedSupabaseClient(
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

  // Hissés hors du try pour enrichir le captureException du catch (diagnostic OAuth ; jamais le secret).
  let payload: ReturnType<typeof verifyState> = null;
  let app: ReturnType<typeof getShopifyAppByClientId> = null;

  try {
    const stateCookie = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
    payload = stateCookie ? verifyState(stateCookie) : null;

    if (!payload) {
      return redirectTo('/boutiques?error=invalid_state', request);
    }

    if (!state || state !== payload.nonce) {
      return redirectTo('/boutiques?error=state_mismatch', request);
    }

    if (!shop || shop !== payload.shopDomain || !validateShopDomain(shop)) {
      return redirectTo('/boutiques?error=shop_mismatch', request);
    }

    // Multi-app : l'app a été choisie à l'install et transportée dans le state (clientId).
    // Un state legacy sans clientId retombe sur l'app par défaut (Teer Dev).
    app = payload.clientId
      ? getShopifyAppByClientId(payload.clientId)
      : getDefaultShopifyAppOrNull();

    if (!app) {
      return redirectTo('/boutiques?error=unknown_client_id', request);
    }

    const clientId = app.clientId;
    const clientSecret = app.clientSecret;

    if (!verifyOAuthHmac(searchParams, clientSecret)) {
      return redirectTo('/boutiques?error=invalid_hmac', request);
    }

    if (!code) {
      return redirectTo('/boutiques?error=connection_failed', request);
    }

    // Garde de propriété (APP-03 / Lot 1) : lecture unique de `shop` par domaine, AVANT tout
    // échange de code et toute écriture. C'est cette seule décision qui conditionne les deux
    // écritures ci-dessous — jamais une upsert `onConflict` capable de réassigner
    // `merchant_account_id` à l'insu du tenant propriétaire. Cf. rapport APP-03 : sans cette
    // garde, une boutique dont l'écriture `store_connection` avait échoué une fois restait
    // définitivement réassignable par quiconque relançait l'installation avec le même domaine.
    const supabase = createSupabaseAdminClient();
    const { data: existingShop, error: existingShopError } = await supabase
      .from('shop')
      .select('id, merchant_account_id, shopify_client_id')
      .eq('shop_domain', shop)
      .maybeSingle();

    if (existingShopError) {
      throw existingShopError;
    }

    const ownershipDecision = decideShopOwnership(existingShop, payload.merchantAccountId);

    if (ownershipDecision.kind === 'refuse') {
      // Refus générique, sans valeur d'identité (ni domaine, ni merchant_account_id) dans la
      // réponse HTTP — seul le code `connection_failed`, déjà émis ailleurs dans cette route,
      // est renvoyé au client. Le sentinel `shopify_ownership_guard_refused` sert de preuve
      // interne (Sentry) que c'est bien cette garde, et non une autre branche d'erreur, qui a
      // arrêté la requête — assertion reprise telle quelle par le test de mutation.
      Sentry.captureMessage('shopify_ownership_guard_refused', {
        level: 'warning',
        tags: { route: 'shopify.callback', reason: 'ownership_mismatch' },
      });
      return redirectTo('/boutiques?error=connection_failed', request);
    }

    // Garde de bascule d'app (SEC-APP-SWITCH-01) — seconde garde, distincte de la propriété.
    // `decideShopOwnership` ne confronte QUE le locataire : elle autorise l'update dès que
    // `merchant_account_id` correspond, quelle que soit l'app déjà propriétaire de la ligne. Sans
    // cette garde, une installation d'une autre app du MÊME locataire écrasait `shopify_client_id`
    // et les jetons chiffrés d'une boutique déjà rattachée (ex. KOBA). Même règle et même module
    // que le rattachement embarqué (lib/shopify/embedded-link-write.ts:156) — jamais une seconde
    // implémentation de la règle.
    //
    // ORDRE DÉLIBÉRÉ — propriété D'ABORD, bascule ensuite, l'inverse de embedded-link-write.ts.
    // Ce refus-ci porte un code d'erreur NOMMÉ et visible par l'utilisateur ; celui de la
    // propriété reste générique. Évaluer la bascule en premier révélerait à un locataire
    // étranger que ce domaine existe et porte déjà une app. Un locataire étranger doit recevoir
    // exactement la réponse d'aujourd'hui ; seul un membre du locataire propriétaire voit le
    // refus nommé.
    //
    // Posée AVANT `exchangeCodeForToken` ci-dessous : le cas courant (la ligne porte déjà une
    // autre app au moment de la lecture) ne consomme aucun code d'autorisation Shopify. Le
    // compare-and-set de l'écriture ne ferme QUE la fenêtre entre cette lecture et l'écriture.
    const appSwitchDecision = decideShopAppSwitch(existingShop, clientId);

    if (appSwitchDecision.kind === 'refuse') {
      Sentry.captureException(new ShopifyAppSwitchRefusedError(), {
        tags: { route: 'shopify.callback', reason: 'app_switch_refused' },
      });
      return redirectTo('/boutiques?error=app_switch_refused', request);
    }

    // SHOPIFY-EXPIRING-TOKENS-01 — l'échange de code est tenu SOUS BAIL (lib/shopify/token-lease.ts).
    // Acquisition AVANT l'appel Shopify : un bail tenu par une autre opération (rafraîchissement,
    // autre installation, désinstallation préemptive) arrête cette requête ici, sans consommer le
    // code auprès de Shopify et sans écrire. L'écriture est ensuite fencée par la génération :
    // `persist_shopify_credentials_fenced` (mode `authorization_code`) reprend sous verrou les
    // deux gardes lues ci-dessus (propriété, puis bascule d'app) et remplace l'ancien
    // compare-and-set applicatif — une app changée ou une propriété réassignée entre la lecture
    // et l'écriture y est toujours refusée.
    const lease = await acquireShopifyTokenLease(supabase, shop);
    if (!lease.ok) {
      if (lease.reason === 'lease_held') {
        reportShopifyTokenLeaseBusy('authorization_code');
        return redirectTo('/boutiques?error=connection_in_progress', request);
      }
      return redirectTo('/boutiques?error=connection_failed', request);
    }

    let savedShopId: string;
    let accessToken: string;

    try {
      const tokenResponse = await exchangeCodeForToken({
        shop,
        clientId,
        clientSecret,
        code,
        distribution: app.distribution,
      });
      accessToken = tokenResponse.accessToken;

      const persisted = await persistShopifyCredentialsFenced(supabase, {
        mode: 'authorization_code',
        shopDomain: shop,
        generation: lease.generation,
        merchantAccountId: payload.merchantAccountId,
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
        // Refus nommé, distinct : une autre opération a repris le bail pendant l'échange. Le
        // résultat reçu de Shopify n'est pas écrit.
        reportShopifyTokenLeaseLost('authorization_code');
        return redirectTo('/boutiques?error=connection_in_progress', request);
      }

      if (
        (persisted.outcome !== 'inserted' && persisted.outcome !== 'updated') ||
        !persisted.shopId
      ) {
        // Refus de l'écriture APRÈS l'échange (propriété réassignée, app changée, ligne créée par
        // une autre requête, échec d'écriture) : échec FERMÉ et GÉNÉRIQUE côté utilisateur, comme
        // avant ce lot — seul le refus de la garde préalable porte `app_switch_refused`
        // (docs/lexique-microcopie.md). Le verdict exact reste dans la sentinelle interne.
        Sentry.captureMessage('shopify_callback_shop_write_no_row', {
          level: 'warning',
          tags: { route: 'shopify.callback', reason: 'shop_write_no_row' },
          extra: { shopDomain: shop, outcome: persisted.outcome },
        });
        return redirectTo('/boutiques?error=connection_failed', request);
      }

      savedShopId = persisted.shopId;

      // Lot L2 : chaque install (nouvelle ou reconnexion) doit poser/rafraîchir sa
      // store_connection. Best-effort et non bloquant, en transaction DISTINCTE : un échec ici ne
      // défait jamais des credentials déjà persistés (arbitrage explicite du fondateur). La RPC
      // fencée ne réassigne jamais le locataire d'une connexion existante.
      const connectionOutcome = await writeShopifyStoreConnectionFenced(supabase, {
        shopDomain: shop,
        generation: lease.generation,
        merchantAccountId: payload.merchantAccountId,
        clientId: app.clientId,
      });

      if (connectionOutcome !== 'written') {
        Sentry.captureException(new Error('shopify_store_connection_upsert_failed'), {
          tags: { module: 'shopify.callback' },
          extra: { outcome: connectionOutcome, shopDomain: shop },
        });
      }
    } finally {
      await releaseShopifyTokenLease(supabase, shop, lease.generation);
    }

    const { error: auditError } = await supabase.from('audit_log').insert({
      merchant_account_id: payload.merchantAccountId,
      actor_user_id: null,
      action: 'shopify.connected',
      resource_type: 'shop',
      resource_id: savedShopId,
    });

    if (auditError) {
      throw auditError;
    }

    const productsSyncResult = await syncProductsForShop({
      accessToken,
      actorUserId: null,
      admin: supabase,
      merchantAccountId: payload.merchantAccountId,
      shop: {
        id: savedShopId,
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

    return redirectTo(payload.returnTo ?? '/boutiques?connected=1', request);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { route: 'shopify.callback' },
      extra: {
        shop,
        resolvedClientId: payload?.clientId ?? null,
        appLabel: app?.label ?? null,
      },
    });
    return redirectTo('/boutiques?error=connection_failed', request);
  }
}
