// SHOPIFY-OAUTH-FIRST-01 / D17 — échec typé du rafraîchissement d'un jeton hors ligne expirant.
//
// Porte le statut HTTP et le code d'erreur Shopify, JAMAIS un jeton. Trois familles, et elles
// seules décident de la suite (lib/shopify/token.ts) :
//   - rejet DÉFINITIF : 401, `error = invalid_request`, description « requires an active
//     refresh_token » — le refresh token a été retiré (nouveau grant) ou a expiré. Seule cette
//     signature exacte marque la boutique `reauthorization_required_at` ;
//   - AUCUNE RÉPONSE (réseau, délai dépassé) : Shopify rend la même réponse au même refresh token
//     pendant une heure, un seul rejeu est donc sûr ;
//   - tout le reste (5xx, 429, autre 401…) : transitoire ou inconnu, aucune écriture.
//
// Module pur : aucune dépendance.
const DEFINITIVE_REJECTION_DESCRIPTION = 'requires an active refresh_token';

export class ShopifyTokenRefreshError extends Error {
  // `null` : aucune réponse HTTP n'a été reçue.
  readonly status: number | null;
  readonly errorCode: string | null;
  readonly description: string | null;

  constructor({
    status,
    errorCode,
    description,
  }: {
    status: number | null;
    errorCode: string | null;
    description: string | null;
  }) {
    super(`Shopify token refresh failed with status ${status ?? 'no_response'}`);
    this.name = 'ShopifyTokenRefreshError';
    this.status = status;
    this.errorCode = errorCode;
    this.description = description;
  }
}

export function isDefinitiveRefreshRejection(error: unknown): boolean {
  return (
    error instanceof ShopifyTokenRefreshError &&
    error.status === 401 &&
    error.errorCode === 'invalid_request' &&
    (error.description ?? '').includes(DEFINITIVE_REJECTION_DESCRIPTION)
  );
}

export function isRefreshWithoutResponse(error: unknown): boolean {
  return error instanceof ShopifyTokenRefreshError && error.status === null;
}
