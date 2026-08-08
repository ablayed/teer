// Accès au token Shopify d'une boutique avec refresh proactif (Phase 7a).
// Modèle offline expirant : access ~60 min + refresh ~90 j, un seul couple vivant par boutique,
// chiffré au repos. Jamais de token en clair dans les logs.

import { decryptToken, encryptToken } from '@/lib/shopify/crypto';
import { refreshAccessToken } from '@/lib/shopify/oauth';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

// Marge de sécurité : on renouvelle 5 min avant l'expiration de l'access token.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export type ShopTokenRow = {
  id: string;
  shop_domain: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
};

export type ShopAccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'needs_reauth' | 'token_error' };

const refreshInFlight = new Map<string, Promise<ShopAccessTokenResult>>();

// Renvoie un access token valide pour la boutique, en le renouvelant si nécessaire.
// - access non expirant (legacy, expires_at null) → utilisé tel quel ;
// - expirant et loin de l'expiration → utilisé tel quel ;
// - expirant et proche/échu → refresh, persistance du nouveau couple, renvoi du nouveau token ;
// - refresh absent/expiré ou refusé → needs_reauth (re-OAuth requis).
export async function getValidShopAccessToken(
  admin: SupabaseClient<Database>,
  shop: ShopTokenRow,
  clientId: string,
  clientSecret: string,
): Promise<ShopAccessTokenResult> {
  const existingRefresh = refreshInFlight.get(shop.id);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refreshPromise = getValidShopAccessTokenInternal(admin, shop, clientId, clientSecret);
  refreshInFlight.set(shop.id, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    if (refreshInFlight.get(shop.id) === refreshPromise) {
      refreshInFlight.delete(shop.id);
    }
  }
}

async function getValidShopAccessTokenInternal(
  admin: SupabaseClient<Database>,
  shop: ShopTokenRow,
  clientId: string,
  clientSecret: string,
): Promise<ShopAccessTokenResult> {
  let accessToken: string;
  try {
    accessToken = decryptToken(shop.access_token_encrypted);
  } catch {
    return { ok: false, reason: 'token_error' };
  }

  const expiresAt = shop.access_token_expires_at ? Date.parse(shop.access_token_expires_at) : null;

  // Token non expirant, ou encore valide au-delà de la marge → on l'utilise directement.
  if (expiresAt === null || expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return { ok: true, accessToken };
  }

  if (!shop.refresh_token_encrypted) {
    return { ok: false, reason: 'needs_reauth' };
  }

  const refreshExpiresAt = shop.refresh_token_expires_at
    ? Date.parse(shop.refresh_token_expires_at)
    : null;
  if (refreshExpiresAt !== null && refreshExpiresAt <= Date.now()) {
    return { ok: false, reason: 'needs_reauth' };
  }

  let refreshToken: string;
  try {
    refreshToken = decryptToken(shop.refresh_token_encrypted);
  } catch {
    return { ok: false, reason: 'token_error' };
  }

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

  // Un seul couple vivant par boutique : on remplace l'ancien couple chiffré.
  const { data, error } = await admin
    .from('shop')
    .update({
      access_token_encrypted: encryptToken(refreshed.accessToken),
      refresh_token_encrypted: refreshed.refreshToken
        ? encryptToken(refreshed.refreshToken)
        : shop.refresh_token_encrypted,
      access_token_expires_at: refreshed.accessTokenExpiresAt?.toISOString() ?? null,
      refresh_token_expires_at:
        refreshed.refreshTokenExpiresAt?.toISOString() ?? shop.refresh_token_expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq('id', shop.id)
    .eq('access_token_encrypted', shop.access_token_encrypted)
    .select('id')
    .maybeSingle();

  if (error || !data) {
    return { ok: false, reason: 'token_error' };
  }

  return { ok: true, accessToken: refreshed.accessToken };
}
