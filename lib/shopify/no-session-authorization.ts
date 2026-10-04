// SHOPIFY-OAUTH-FIRST-01 / B2 — callback OAuth sans locataire dans le state (D13, D16b).
//
// Appelé par app/api/shopify/callback/route.ts APRÈS les gardes du protocole (state, nonce,
// domaine, HMAC). Ordre, et rien d'autre :
//   1. règle de bascule d'app (`decideShopAppSwitch`), sur une lecture préalable : le cas courant
//      d'une boutique d'une autre app ne consomme aucun code Shopify ;
//   2. bail du domaine, AVANT tout appel réseau ;
//   3. échange du code ;
//   4. D16b, UNE transaction : la base choisit la branche et écrit ;
//        - branche 1 (boutique installée pour cette app) : persistance chez le propriétaire résolu
//          EN BASE et audit `shopify.connected` dans la transaction — aucun audit ici ;
//        - branche 2 (tout le reste) : attente créée, AUCUNE écriture dans `shop` ;
//   5. branche 1 : `store_connection` sous le même bail, libération, puis abonnements webhook et
//      synchronisation (R2) ;
//      branche 2 : libération, ticket rendu à l'appelant pour son cookie.
// R3 : le `finally` ne libère QUE le bail acquis par cette opération, avec SA génération ; après
// `lease_lost`, aucune libération n'est tentée.
//
// Module pur de toute dépendance d'environnement : importable par les suites RLS.
import { ShopifyAppSwitchRefusedError } from '@/lib/shopify/app-identity-errors';
import type { ShopifyAppDistribution } from '@/lib/shopify/app-registry-sources';
import { decideShopAppSwitch } from '@/lib/shopify/app-switch-guard';
import {
  SHOPIFY_PENDING_TTL_MS,
  generateShopifyClaimTicket,
  hashShopifyClaimTicket,
} from '@/lib/shopify/claim-ticket';
import { encryptToken } from '@/lib/shopify/crypto';
import { type TokenResponse, exchangeCodeForToken } from '@/lib/shopify/oauth';
import {
  reconcileWebhooksAfterConnect,
  syncProductsAfterConnect,
  writeStoreConnectionUnderLease,
} from '@/lib/shopify/post-connect-effects';
import type { ShopifyPublicErrorCode } from '@/lib/shopify/public-error';
import {
  acquireShopifyTokenLease,
  releaseShopifyTokenLease,
  reportShopifyTokenLeaseBusy,
  reportShopifyTokenLeaseLost,
} from '@/lib/shopify/token-lease';
import type { Database } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

export type NoSessionAuthorizationApp = {
  clientId: string;
  clientSecret: string;
  distribution: ShopifyAppDistribution;
};

export type NoSessionAuthorizationResult =
  | { kind: 'arrived'; syncPending: boolean }
  | { kind: 'pending'; ticket: string; maxAgeSeconds: number }
  | { kind: 'error'; code: ShopifyPublicErrorCode };

export type NoSessionAuthorizationDeps = {
  exchangeCode: typeof exchangeCodeForToken;
  syncProducts: typeof syncProductsAfterConnect;
  reconcileWebhooks: typeof reconcileWebhooksAfterConnect;
};

const defaultDeps: NoSessionAuthorizationDeps = {
  exchangeCode: exchangeCodeForToken,
  syncProducts: syncProductsAfterConnect,
  reconcileWebhooks: reconcileWebhooksAfterConnect,
};

function reportNoSessionFailure(reason: string): void {
  Sentry.captureMessage('shopify_no_session_authorization_failed', {
    level: 'warning',
    tags: { module: 'shopify.no-session-authorization', reason },
  });
}

export async function performNoSessionAuthorization(
  admin: AdminClient,
  input: { shopDomain: string; app: NoSessionAuthorizationApp; code: string },
  deps: NoSessionAuthorizationDeps = defaultDeps,
): Promise<NoSessionAuthorizationResult> {
  const { shopDomain, app } = input;

  // (1) Règle de bascule d'app, avant tout appel Shopify. La décision qui fait foi reste celle de
  // D16b, sous verrou.
  const { data: existingShop, error: existingShopError } = await admin
    .from('shop')
    .select('shopify_client_id')
    .eq('shop_domain', shopDomain)
    .maybeSingle();
  if (existingShopError) {
    reportNoSessionFailure('shop_read_failed');
    return { kind: 'error', code: 'unknown' };
  }
  if (decideShopAppSwitch(existingShop, app.clientId).kind === 'refuse') {
    Sentry.captureException(new ShopifyAppSwitchRefusedError(), {
      tags: { route: 'shopify.callback', reason: 'app_switch_refused', mode: 'no_session' },
    });
    return { kind: 'error', code: 'other_app' };
  }

  // (2) Bail, avant le réseau.
  const lease = await acquireShopifyTokenLease(admin, shopDomain);
  if (!lease.ok) {
    if (lease.reason === 'lease_held') {
      reportShopifyTokenLeaseBusy('authorization_code');
      return { kind: 'error', code: 'connection_in_progress' };
    }
    return { kind: 'error', code: 'unknown' };
  }

  let leaseHeld = true;
  let branchOne: { shopId: string } | null = null;
  let syncPending = false;

  try {
    // (3) Échange du code.
    let tokens: TokenResponse;
    try {
      tokens = await deps.exchangeCode({
        shop: shopDomain,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        code: input.code,
        distribution: app.distribution,
      });
    } catch {
      reportNoSessionFailure('code_exchange_failed');
      return { kind: 'error', code: 'unknown' };
    }

    // (4) D16b.
    const ticket = generateShopifyClaimTicket();
    const ticketHash = hashShopifyClaimTicket(ticket);
    if (!ticketHash) {
      return { kind: 'error', code: 'unknown' };
    }
    const { data, error } = await admin.rpc('decide_and_write_shopify_authorization', {
      p_shop_domain: shopDomain,
      p_client_id: app.clientId,
      p_generation: lease.generation,
      p_access_token_encrypted: encryptToken(tokens.accessToken),
      // Les types générés ne portent pas la nullabilité des arguments SQL : NULL est accepté.
      p_refresh_token_encrypted: (tokens.refreshToken
        ? encryptToken(tokens.refreshToken)
        : null) as string,
      p_access_token_expires_at: (tokens.accessTokenExpiresAt?.toISOString() ?? null) as string,
      p_refresh_token_expires_at: (tokens.refreshTokenExpiresAt?.toISOString() ?? null) as string,
      p_scopes: tokens.scope,
      p_ticket_hash: ticketHash,
      p_pending_expires_at: new Date(Date.now() + SHOPIFY_PENDING_TTL_MS).toISOString(),
    });
    if (error) {
      reportNoSessionFailure('decide_and_write_rpc_failed');
      return { kind: 'error', code: 'unknown' };
    }

    const verdict = data?.[0];
    if (verdict?.outcome === 'lease_lost') {
      // Le bail a été repris : il n'est plus à nous, aucune libération (R3).
      leaseHeld = false;
      reportShopifyTokenLeaseLost('authorization_code');
      return { kind: 'error', code: 'connection_in_progress' };
    }
    if (verdict?.outcome === 'app_switch_refused') {
      return { kind: 'error', code: 'other_app' };
    }

    if (verdict?.branch === 'branch_2' && verdict.outcome === 'pending_created') {
      return {
        kind: 'pending',
        ticket,
        maxAgeSeconds: Math.floor(SHOPIFY_PENDING_TTL_MS / 1000),
      };
    }

    if (
      verdict?.branch === 'branch_1' &&
      verdict.outcome === 'updated' &&
      verdict.shop_id &&
      verdict.merchant_account_id
    ) {
      // (5) Branche 1 : store_connection sous le même bail (R2 : un échec n'est qu'observé).
      const connectionWritten = await writeStoreConnectionUnderLease(admin, {
        shopDomain,
        generation: lease.generation,
        merchantAccountId: verdict.merchant_account_id,
        clientId: app.clientId,
      });
      syncPending = !connectionWritten;
      branchOne = { shopId: verdict.shop_id };
    } else {
      reportNoSessionFailure(`verdict_${verdict?.outcome ?? 'missing'}`);
      return { kind: 'error', code: 'unknown' };
    }
  } finally {
    if (leaseHeld) {
      await releaseShopifyTokenLease(admin, shopDomain, lease.generation);
    }
  }

  if (!branchOne) {
    return { kind: 'error', code: 'unknown' };
  }

  // Branche 1, bail des jetons libéré : abonnements webhook (E1), puis synchronisation des
  // produits. Chacun au moins une fois (R2) : un échec n'est qu'observé.
  const webhooksReconciled = await deps.reconcileWebhooks(admin, {
    shopId: branchOne.shopId,
    app,
  });
  const synced = await deps.syncProducts(admin, {
    shopId: branchOne.shopId,
    app,
    actorUserId: null,
  });
  return { kind: 'arrived', syncPending: syncPending || !webhooksReconciled || !synced };
}
