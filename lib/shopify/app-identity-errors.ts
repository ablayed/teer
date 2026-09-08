// APP-03 / Lot 2 — erreur interne stable pour la confrontation d'identité d'app côté session
// embarquée. `code` est la seule chose qu'un test ou un rapport Sentry doit lire ; jamais le
// texte de `message` (qui peut évoluer sans casser un appelant).
export class ShopifyAppIdentityMismatchError extends Error {
  readonly code = 'SHOPIFY_APP_IDENTITY_MISMATCH' as const;

  constructor() {
    super('shopify_app_identity_mismatch');
    this.name = 'ShopifyAppIdentityMismatchError';
  }
}
