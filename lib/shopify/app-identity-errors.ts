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

// Teer Public n'a jamais de chemin par le flux OAuth `code` legacy (/api/shopify/install) —
// seul le token exchange embarqué (App Bridge) l'installe. Refus fermé, jamais un repli vers une
// autre app du registre.
export class ShopifyPublicLegacyRouteRefusedError extends Error {
  readonly code = 'SHOPIFY_PUBLIC_LEGACY_ROUTE_REFUSED' as const;

  constructor() {
    super('shopify_public_legacy_route_refused');
    this.name = 'ShopifyPublicLegacyRouteRefusedError';
  }
}

// Bascule d'app refusée pendant le rattachement embarqué — une ligne `shop` existe déjà pour ce
// domaine sous une AUTRE app, même si le tenant demandeur correspond (cf. lib/shopify/app-switch-guard.ts).
export class ShopifyAppSwitchRefusedError extends Error {
  readonly code = 'SHOPIFY_APP_SWITCH_REFUSED' as const;

  constructor() {
    super('shopify_app_switch_refused');
    this.name = 'ShopifyAppSwitchRefusedError';
  }
}
