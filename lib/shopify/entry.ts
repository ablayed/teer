// SHOPIFY-OAUTH-FIRST-01 / B1 — entrée `application_url` hors de l'iframe (D12, D19).
//
// Trois décisions pures, séparées du route handler pour rester mutation-testables :
//   1. `verifyShopifyEntryQuery` — la requête vient de Shopify : HMAC de l'app, paramètres
//      uniques, horodatage à ±5 min, domaine myshopify ;
//   2. `entryCredentialsReadable` — D19 : pour une boutique classée installée, les credentials
//      se déchiffrent EN MÉMOIRE. Rien n'est renvoyé ni journalisé ; seul le succès compte ;
//   3. `decideShopifyEntry` — le tableau D12 : aucun grant pour une boutique installée et
//      lisible, une erreur publique D15 pour les refus, une autorisation pour le reste.
//
// Module pur (ni lib/env, ni client Supabase).
import { decryptToken } from '@/lib/shopify/crypto';
import { validateShopDomain, verifyOAuthHmac } from '@/lib/shopify/oauth';
import type { ShopifyPublicErrorCode } from '@/lib/shopify/public-error';

export const SHOPIFY_ENTRY_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export type ShopifyEntryQueryVerification = { ok: true; shop: string } | { ok: false };

export function verifyShopifyEntryQuery(
  query: URLSearchParams,
  clientSecret: string,
  nowMs: number = Date.now(),
): ShopifyEntryQueryVerification {
  const hmac = query.getAll('hmac');
  const shopValues = query.getAll('shop');
  const timestampValues = query.getAll('timestamp');
  const shop = shopValues[0]?.trim() ?? '';
  const timestamp = Number(timestampValues[0]);
  const timestampFresh =
    Number.isSafeInteger(timestamp) &&
    Math.abs(nowMs / 1000 - timestamp) <= SHOPIFY_ENTRY_TIMESTAMP_TOLERANCE_SECONDS;

  if (
    hmac.length !== 1 ||
    shopValues.length !== 1 ||
    timestampValues.length !== 1 ||
    !timestampFresh ||
    !validateShopDomain(shop) ||
    !verifyOAuthHmac(query, clientSecret)
  ) {
    return { ok: false };
  }

  return { ok: true, shop };
}

// Valeurs rendues par `classify_shopify_entry` (0160, section 4).
export const SHOPIFY_ENTRY_CLASSIFICATIONS = [
  'invalid_input',
  'absent',
  'other_app',
  'uninstalled',
  'disconnected',
  'reauthorization_required',
  'installed_valid',
  'installed_refreshable',
] as const;

export type ShopifyEntryClassification = (typeof SHOPIFY_ENTRY_CLASSIFICATIONS)[number];

export type ShopifyEntryDecision =
  | { kind: 'arrive' }
  | { kind: 'authorize' }
  | { kind: 'error'; code: ShopifyPublicErrorCode };

export function isInstalledClassification(
  classification: unknown,
): classification is 'installed_valid' | 'installed_refreshable' {
  return classification === 'installed_valid' || classification === 'installed_refreshable';
}

type EntryCredentials = {
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
};

// D19 — modèle de l'ancienne vérification de l'entrée non embarquée (retirée par D7) : l'access
// token doit se déchiffrer ;
// pour une boutique à rafraîchir, le refresh token aussi. Toute exception vaut « illisible ».
export function entryCredentialsReadable(
  credentials: EntryCredentials | null,
  classification: 'installed_valid' | 'installed_refreshable',
): boolean {
  if (!credentials?.access_token_encrypted) {
    return false;
  }

  try {
    decryptToken(credentials.access_token_encrypted);
    if (classification === 'installed_refreshable') {
      if (!credentials.refresh_token_encrypted) {
        return false;
      }
      decryptToken(credentials.refresh_token_encrypted);
    }
    return true;
  } catch {
    return false;
  }
}

// Tableau D12. `credentialsReadable` n'est consulté que pour les deux classes installées ; une
// valeur inattendue de la classification échoue fermée (`unknown`), jamais en autorisation.
export function decideShopifyEntry(
  classification: unknown,
  credentialsReadable: boolean,
): ShopifyEntryDecision {
  switch (classification) {
    case 'installed_valid':
    case 'installed_refreshable':
      return credentialsReadable
        ? { kind: 'arrive' }
        : { kind: 'error', code: 'credentials_unavailable' };
    case 'other_app':
      return { kind: 'error', code: 'other_app' };
    case 'invalid_input':
      return { kind: 'error', code: 'invalid_request' };
    case 'absent':
    case 'uninstalled':
    case 'disconnected':
    case 'reauthorization_required':
      return { kind: 'authorize' };
    default:
      return { kind: 'error', code: 'unknown' };
  }
}
