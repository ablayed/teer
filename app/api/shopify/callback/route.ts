import { ShopifyAppSwitchRefusedError } from '@/lib/shopify/app-identity-errors';
import { decideShopAppSwitch } from '@/lib/shopify/app-switch-guard';
import { getDefaultShopifyAppOrNull, getShopifyAppByClientId } from '@/lib/shopify/apps';
import { encryptToken } from '@/lib/shopify/crypto';
import { exchangeCodeForToken, validateShopDomain, verifyOAuthHmac } from '@/lib/shopify/oauth';
import { decideShopOwnership } from '@/lib/shopify/ownership-guard';
import { syncProductsForShop } from '@/lib/shopify/products-sync';
import { verifyState } from '@/lib/shopify/state';
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

    // Valeur d'app lue, normalisée : c'est l'ATTENDU du compare-and-set de l'écriture ci-dessous.
    // `null` signifie « aucune app rattachée », jamais « une autre app » — motif projet, déjà posé
    // côté SQL (gardes NULL-safe) et côté TS (app/api/shopify/embedded/session/route.ts:159-176).
    const expectedClientId = existingShop?.shopify_client_id ?? null;

    const tokenResponse = await exchangeCodeForToken({
      shop,
      clientId,
      clientSecret,
      code,
    });
    const now = new Date().toISOString();

    const shopWritePayload = {
      shop_domain: shop,
      shopify_client_id: app.clientId,
      access_token_encrypted: encryptToken(tokenResponse.accessToken),
      refresh_token_encrypted: tokenResponse.refreshToken
        ? encryptToken(tokenResponse.refreshToken)
        : null,
      access_token_expires_at: tokenResponse.accessTokenExpiresAt?.toISOString() ?? null,
      refresh_token_expires_at: tokenResponse.refreshTokenExpiresAt?.toISOString() ?? null,
      scopes: tokenResponse.scope,
      status: 'active',
      uninstalled_at: null,
      updated_at: now,
    };

    let savedShopId: string;

    if (ownershipDecision.kind === 'insert') {
      const { data: insertedShop, error: insertError } = await supabase
        .from('shop')
        .insert({ ...shopWritePayload, merchant_account_id: payload.merchantAccountId })
        .select('id')
        .single();

      if (insertError) {
        // 23505 sur `shop_domain` (contrainte shop_shop_domain_key, 0004) : une autre requête a
        // créé la ligne entre la lecture de garde et cette écriture (course). Refus fermé —
        // jamais de repli sur une upsert qui écraserait potentiellement un autre tenant.
        Sentry.captureException(insertError, {
          tags: { route: 'shopify.callback', reason: 'ownership_guard_insert_race' },
          extra: { shopDomain: shop },
        });
        return redirectTo('/boutiques?error=connection_failed', request);
      }

      savedShopId = insertedShop.id;
    } else {
      // Multi-boutiques : reconnexion sur le même domaine, même tenant déjà confirmé par la
      // garde ci-dessus. Le filtre `merchant_account_id` rend cette écriture structurellement
      // incapable de réassigner la boutique même si la propriété a changé entre la lecture de
      // garde et cet appel (fail-closed sous concurrence, pas seulement au moment de la lecture).
      //
      // Compare-and-set sur `shopify_client_id` (SEC-APP-SWITCH-01), même forme que
      // lib/shopify/app-release-write.ts:210-231 : le prédicat porte la valeur LUE, donc une app
      // changée entre la lecture de garde et cet appel ne matche plus aucune ligne. Branchement
      // `.is(col, null)` / `.eq(col, valeur)` — jamais `.or()` : une comparaison d'égalité perd
      // les NULL, et `null` est ici l'état normal d'une boutique dont l'identité a été libérée.
      let shopUpdateQuery = supabase
        .from('shop')
        .update(shopWritePayload)
        .eq('id', ownershipDecision.shopId)
        .eq('merchant_account_id', payload.merchantAccountId);
      shopUpdateQuery =
        expectedClientId === null
          ? shopUpdateQuery.is('shopify_client_id', null)
          : shopUpdateQuery.eq('shopify_client_id', expectedClientId);

      const { data: updatedShop, error: updateError } = await shopUpdateQuery
        .select('id')
        .maybeSingle();

      if (updateError) {
        Sentry.captureException(updateError, {
          tags: { route: 'shopify.callback', reason: 'ownership_guard_update_race' },
          extra: { shopDomain: shop },
        });
        return redirectTo('/boutiques?error=connection_failed', request);
      }

      if (!updatedShop) {
        // Zéro ligne modifiée — échec FERMÉ, jamais un succès silencieux. La cause n'est pas
        // attribuable : propriété réassignée, app changée concurremment, ou ligne supprimée
        // entre la lecture et l'écriture. Le refus reste donc GÉNÉRIQUE côté utilisateur —
        // l'étiqueter `app_switch_refused` affirmerait une cause non mesurée. Seule la
        // sentinelle interne, distincte de celle de la garde préalable, nomme l'événement.
        Sentry.captureMessage('shopify_callback_shop_write_no_row', {
          level: 'warning',
          tags: { route: 'shopify.callback', reason: 'shop_write_no_row' },
          extra: { shopDomain: shop },
        });
        return redirectTo('/boutiques?error=connection_failed', request);
      }

      savedShopId = updatedShop.id;
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

    // Lot L2 : chaque install (nouvelle ou reconnexion) doit poser/rafraîchir sa
    // store_connection, sinon la double écriture (ingestion_event/external_ref) reste inerte
    // pour toute boutique connectée après le backfill ponctuel de 0142 (Lot L1). Best-effort et
    // non bloquant : un échec ici ne doit jamais empêcher une connexion Shopify réelle de réussir
    // (arbitrage explicite du fondateur — rendre ce chemin bloquant est un lot distinct).
    //
    // Même discipline que ci-dessus : jamais une upsert `onConflict` capable de réassigner
    // `merchant_account_id`. `merchant_account_id` est exclu du payload de mise à jour, donc cet
    // appel ne peut structurellement pas changer le tenant propriétaire d'une ligne existante.
    const storeConnectionWritePayload = {
      shop_id: savedShopId,
      platform: 'shopify' as const,
      external_identifier: shop,
      platform_app_id: app.clientId,
      status: 'active',
      uninstalled_at: null,
    };

    const { error: insertConnectionError } = await supabase
      .from('store_connection')
      .insert({ ...storeConnectionWritePayload, merchant_account_id: payload.merchantAccountId });

    if (insertConnectionError) {
      if (insertConnectionError.code === '23505') {
        // Conflit sur (platform, external_identifier) : ligne déjà existante — reconnexion, ou
        // rattrapage d'un échec best-effort antérieur. Mise à jour guardée par le même tenant ;
        // 0 ligne affectée (ligne orpheline d'un autre tenant) est toléré en silence, comme le
        // reste de ce bloc — jamais une réassignation, jamais un blocage de la connexion.
        const { error: updateConnectionError } = await supabase
          .from('store_connection')
          .update(storeConnectionWritePayload)
          .eq('platform', 'shopify')
          .eq('external_identifier', shop)
          .eq('merchant_account_id', payload.merchantAccountId);

        if (updateConnectionError) {
          Sentry.captureException(new Error('shopify_store_connection_upsert_failed'), {
            tags: { module: 'shopify.callback' },
            extra: { message: updateConnectionError.message, shopDomain: shop },
          });
        }
      } else {
        Sentry.captureException(new Error('shopify_store_connection_upsert_failed'), {
          tags: { module: 'shopify.callback' },
          extra: { message: insertConnectionError.message, shopDomain: shop },
        });
      }
    }

    const productsSyncResult = await syncProductsForShop({
      accessToken: tokenResponse.accessToken,
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
