// SHOPIFY-OAUTH-FIRST-01 / D15 — surface d'erreur publique du parcours Shopify sans session.
//
// Énumération FERMÉE : seul un de ces codes transite par l'URL (`/shopify/erreur?code=…`). La
// page affiche un message fixe, choisi côté serveur à partir du code ; aucun texte ne vient de
// la requête, et aucun code ne porte de domaine, de locataire ou d'identifiant d'app. Un code
// inconnu est lu comme `unknown`.
//
// Module pur (ni lib/env, ni client Supabase) : importable par les route handlers, les actions
// et les suites RLS.
export const SHOPIFY_PUBLIC_ERROR_CODES = [
  'invalid_request',
  'other_app',
  'credentials_unavailable',
  'connection_in_progress',
  'ticket_invalid',
  'refused',
  'forbidden',
  'unknown',
] as const;

export type ShopifyPublicErrorCode = (typeof SHOPIFY_PUBLIC_ERROR_CODES)[number];

export const SHOPIFY_PUBLIC_ERROR_PATH = '/shopify/erreur';

export function isShopifyPublicErrorCode(value: unknown): value is ShopifyPublicErrorCode {
  return (
    typeof value === 'string' && (SHOPIFY_PUBLIC_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function parseShopifyPublicErrorCode(value: unknown): ShopifyPublicErrorCode {
  return isShopifyPublicErrorCode(value) ? value : 'unknown';
}

export function shopifyPublicErrorPath(code: ShopifyPublicErrorCode): string {
  return `${SHOPIFY_PUBLIC_ERROR_PATH}?code=${code}`;
}
