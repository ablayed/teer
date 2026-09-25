// Accès au token Shopify d'une boutique avec refresh proactif (Phase 7a).
// Modèle offline expirant : access ~60 min + refresh ~90 j, un seul couple vivant par boutique,
// chiffré au repos. Jamais de token en clair dans les logs.
//
// SHOPIFY-EXPIRING-TOKENS-01 — le rafraîchissement est SÉRIALISÉ par boutique sous le bail de
// jeton (lib/shopify/token-lease.ts, 0158) : acquisition avant l'appel réseau, écriture fencée
// (`persist_shopify_credentials_fenced`, mode `refresh`), libération. Le dédoublonnage en mémoire
// (`refreshInFlight`) reste une optimisation d'instance ; c'est le bail qui sérialise ENTRE
// instances. Quand une autre instance a la main (bail tenu, ou bail perdu en cours de route),
// l'opération relit la ligne et utilise la paire persistée par le gagnant (§6), dans une boucle
// bornée.

import { decryptToken, encryptToken } from '@/lib/shopify/crypto';
import { isShopifyUnauthorizedError } from '@/lib/shopify/graphql';
import { refreshAccessToken } from '@/lib/shopify/oauth';
import {
  acquireShopifyTokenLease,
  persistShopifyCredentialsFenced,
  releaseShopifyTokenLease,
  reportShopifyTokenLeaseBusy,
  reportShopifyTokenLeaseLost,
} from '@/lib/shopify/token-lease';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

// Marge de sécurité : on renouvelle 5 min avant l'expiration de l'access token.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Relecture après une perte (§6) : bornée, jamais une boucle illimitée. Cinq relectures à une
// seconde d'intervalle couvrent un appel au endpoint de jeton observé à 2,86 s (Test A) ; au-delà,
// l'opération rend `token_error` et le prochain appel reprendra.
export const TOKEN_REREAD_MAX_ATTEMPTS = 5;
export const TOKEN_REREAD_DELAY_MS = 1_000;

type AdminClient = SupabaseClient<Database>;

export type ShopTokenRow = {
  id: string;
  shop_domain: string;
  merchant_account_id: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
};

export type ShopAccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'needs_reauth' | 'token_error' };

export type ShopTokenOptions = {
  // Injectable pour les tests (relecture bornée sans attente réelle).
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const refreshInFlight = new Map<string, Promise<ShopAccessTokenResult>>();

// Renvoie un access token valide pour la boutique, en le renouvelant si nécessaire.
// - access non expirant (legacy, expires_at null) → utilisé tel quel ;
// - expirant et loin de l'expiration → utilisé tel quel ;
// - expirant et proche/échu → refresh sous bail, persistance fencée, renvoi du nouveau token ;
// - refresh absent/expiré ou refusé → needs_reauth (re-OAuth requis).
export async function getValidShopAccessToken(
  admin: AdminClient,
  shop: ShopTokenRow,
  clientId: string,
  clientSecret: string,
  options: ShopTokenOptions = {},
): Promise<ShopAccessTokenResult> {
  const existingRefresh = refreshInFlight.get(shop.id);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refreshPromise = getValidShopAccessTokenInternal(
    admin,
    shop,
    clientId,
    clientSecret,
    options,
  );
  refreshInFlight.set(shop.id, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    if (refreshInFlight.get(shop.id) === refreshPromise) {
      refreshInFlight.delete(shop.id);
    }
  }
}

function isFreshEnough(expiresAtIso: string | null): boolean {
  if (expiresAtIso === null) {
    return true;
  }
  return Date.parse(expiresAtIso) - Date.now() > REFRESH_BUFFER_MS;
}

async function getValidShopAccessTokenInternal(
  admin: AdminClient,
  shop: ShopTokenRow,
  clientId: string,
  clientSecret: string,
  options: ShopTokenOptions,
): Promise<ShopAccessTokenResult> {
  let accessToken: string;
  if (!shop.access_token_encrypted) {
    return { ok: false, reason: 'needs_reauth' };
  }
  try {
    accessToken = decryptToken(shop.access_token_encrypted);
  } catch {
    return { ok: false, reason: 'token_error' };
  }

  // Token non expirant, ou encore valide au-delà de la marge → on l'utilise directement.
  if (isFreshEnough(shop.access_token_expires_at)) {
    return { ok: true, accessToken };
  }

  return refreshUnderLease(admin, shop, clientId, clientSecret, options);
}

function refreshTokenUsable(shop: ShopTokenRow): boolean {
  if (!shop.refresh_token_encrypted) {
    return false;
  }
  const refreshExpiresAt = shop.refresh_token_expires_at
    ? Date.parse(shop.refresh_token_expires_at)
    : null;
  return refreshExpiresAt === null || refreshExpiresAt > Date.now();
}

// Rafraîchissement sous bail. Le perdant d'une acquisition S'ARRÊTE AVANT LE RÉSEAU : il
// n'appelle jamais Shopify, il relit la paire du gagnant.
async function refreshUnderLease(
  admin: AdminClient,
  shop: ShopTokenRow,
  clientId: string,
  clientSecret: string,
  options: ShopTokenOptions,
): Promise<ShopAccessTokenResult> {
  if (!refreshTokenUsable(shop) || !shop.refresh_token_encrypted) {
    return { ok: false, reason: 'needs_reauth' };
  }

  let refreshToken: string;
  try {
    refreshToken = decryptToken(shop.refresh_token_encrypted);
  } catch {
    return { ok: false, reason: 'token_error' };
  }

  const lease = await acquireShopifyTokenLease(admin, shop.shop_domain);
  if (!lease.ok) {
    if (lease.reason === 'lease_held') {
      reportShopifyTokenLeaseBusy('refresh');
      return rereadWinnerPair(admin, shop, options);
    }
    return { ok: false, reason: 'token_error' };
  }

  try {
    let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;
    try {
      refreshed = await refreshAccessToken({
        shop: shop.shop_domain,
        clientId,
        clientSecret,
        refreshToken,
      });
    } catch {
      // Refresh refusé (token révoqué/expiré) → re-OAuth nécessaire.
      return { ok: false, reason: 'needs_reauth' };
    }

    // Un seul couple vivant par boutique : les quatre valeurs en UNE instruction, sous génération.
    const persisted = await persistShopifyCredentialsFenced(admin, {
      mode: 'refresh',
      shopDomain: shop.shop_domain,
      generation: lease.generation,
      merchantAccountId: shop.merchant_account_id,
      clientId,
      accessTokenEncrypted: encryptToken(refreshed.accessToken),
      // NULL conserve la valeur en place (0158, mode refresh).
      refreshTokenEncrypted: refreshed.refreshToken ? encryptToken(refreshed.refreshToken) : null,
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt?.toISOString() ?? null,
      refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt?.toISOString() ?? null,
      scopes: null,
    });

    if (persisted.outcome === 'updated') {
      return { ok: true, accessToken: refreshed.accessToken };
    }

    if (persisted.outcome === 'lease_lost') {
      // Un autre détenteur a repris le bail pendant l'appel : sa paire annule la nôtre. On
      // utilise la sienne, jamais celle que nous avons reçue.
      reportShopifyTokenLeaseLost('refresh');
      return rereadWinnerPair(admin, shop, options);
    }

    return { ok: false, reason: 'token_error' };
  } finally {
    await releaseShopifyTokenLease(admin, shop.shop_domain, lease.generation);
  }
}

// §6 — relecture bornée de la ligne après une perte. Une paire est « du gagnant » si son access
// token chiffré diffère de celui avec lequel l'opération a commencé, et si elle n'est pas elle-même
// à renouveler. Boutique devenue inactive (désinstallation concurrente) : aucune paire à utiliser.
async function rereadWinnerPair(
  admin: AdminClient,
  shop: ShopTokenRow,
  options: ShopTokenOptions,
): Promise<ShopAccessTokenResult> {
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; attempt < TOKEN_REREAD_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(TOKEN_REREAD_DELAY_MS);
    }

    const { data, error } = await admin
      .from('shop')
      .select('status, access_token_encrypted, access_token_expires_at')
      .eq('id', shop.id)
      .maybeSingle();

    if (error || !data) {
      return { ok: false, reason: 'token_error' };
    }
    if (data.status !== 'active') {
      return { ok: false, reason: 'token_error' };
    }

    if (
      data.access_token_encrypted &&
      data.access_token_encrypted !== shop.access_token_encrypted &&
      isFreshEnough(data.access_token_expires_at)
    ) {
      try {
        return { ok: true, accessToken: decryptToken(data.access_token_encrypted) };
      } catch {
        return { ok: false, reason: 'token_error' };
      }
    }
  }

  return { ok: false, reason: 'token_error' };
}

// §7 — après un 401, obtenir une paire PLUS RÉCENTE que celle qui a été refusée, par l'un des
// deux moyens : la relecture de la paire écrite par une autre instance, ou le rafraîchissement de
// celle-ci. Sans l'un ou l'autre, aucun réessai. Un jeton non expirant (app custom, aucun refresh
// token) ne peut jamais être rafraîchi : pour lui, seul un jeton déjà remplacé en base permet de
// réessayer — conséquence du régime non expirant, pas un défaut.
export async function obtainFresherShopAccessToken(
  admin: AdminClient,
  shop: ShopTokenRow,
  clientId: string,
  clientSecret: string,
  rejectedAccessToken: string,
  options: ShopTokenOptions = {},
): Promise<ShopAccessTokenResult> {
  const { data, error } = await admin
    .from('shop')
    .select(
      'id, shop_domain, merchant_account_id, status, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at',
    )
    .eq('id', shop.id)
    .maybeSingle();

  if (error || !data || data.status !== 'active' || !data.access_token_encrypted) {
    return { ok: false, reason: 'token_error' };
  }

  let storedAccessToken: string;
  try {
    storedAccessToken = decryptToken(data.access_token_encrypted);
  } catch {
    return { ok: false, reason: 'token_error' };
  }

  if (storedAccessToken !== rejectedAccessToken) {
    return { ok: true, accessToken: storedAccessToken };
  }

  return refreshUnderLease(admin, data, clientId, clientSecret, options);
}

// Exécute une opération Shopify avec UN SEUL réessai après un 401, jamais une boucle (« Retry
// once, not in a loop »). Le réessai n'a lieu que si une paire plus récente a été obtenue ; sinon
// l'erreur d'origine est relancée telle quelle.
export async function runWithShopifyUnauthorizedRetry<T>(
  admin: AdminClient,
  shop: ShopTokenRow,
  clientId: string,
  clientSecret: string,
  accessToken: string,
  operation: (accessToken: string) => Promise<T>,
  options: ShopTokenOptions = {},
): Promise<T> {
  try {
    return await operation(accessToken);
  } catch (error) {
    if (!isShopifyUnauthorizedError(error)) {
      throw error;
    }

    const fresher = await obtainFresherShopAccessToken(
      admin,
      shop,
      clientId,
      clientSecret,
      accessToken,
      options,
    );
    if (!fresher.ok) {
      throw error;
    }

    return operation(fresher.accessToken);
  }
}
