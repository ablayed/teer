// APP-03 / Lot 2 — module séparé (pas dans lib/actions/shops.ts, `'use server'`) : Next.js exige
// que tout export d'un module `'use server'` soit une fonction async ; cette fonction pure doit
// rester unitairement testable en synchrone (même raison que lib/security/post-sign-in-path.ts).
export type ShopStatusInput = {
  status: string;
  storeKind: string;
  accessTokenEncrypted: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenEncrypted: string | null;
  refreshTokenExpiresAt: string | null;
  // SHOPIFY-OAUTH-FIRST-01 / D17 — posé par la seule signature exacte du rejet définitif du
  // refresh (lib/shopify/token.ts), remis à NULL par une persistance fencée réussie.
  reauthorizationRequiredAt?: string | null;
};

export type ShopStatusResult = {
  status: 'connected' | 'error' | 'incomplete' | 'uninstalled';
  reason: 'token_expired' | 'reauthorization_required' | null;
};

export function shopStatus(shop: ShopStatusInput): ShopStatusResult {
  if (shop.status === 'uninstalled') {
    return { reason: null, status: 'uninstalled' };
  }

  // Rattachement embarqué (APP-03/Lot 2) : `status='active'` sans `accessTokenEncrypted` est un
  // état représentable et légitime (le token exchange n'a pas encore abouti), distinct d'une
  // boutique manuelle (`storeKind='manual'`, sans token PAR CONCEPTION — ne jamais confondre les
  // deux). « Connexion incomplète » — pas « en attente » : cet état ne distingue pas un parcours
  // interrompu d'un échange définitivement échoué, et ne doit rien promettre sur son issue.
  if (shop.storeKind === 'shopify' && !shop.accessTokenEncrypted) {
    return { reason: null, status: 'incomplete' };
  }

  // D17 — Shopify a retiré le refresh token : seule une nouvelle autorisation, lancée depuis
  // l'administration Shopify, rétablit la connexion.
  if (shop.reauthorizationRequiredAt) {
    return { reason: 'reauthorization_required', status: 'error' };
  }

  // SHOPIFY-EXPIRING-TOKENS-01 §5 — avec des jetons d'une heure, un access token échu est l'état
  // NORMAL entre deux rafraîchissements, pas une panne : le prochain accès le renouvelle
  // (lib/shopify/token.ts). L'erreur n'apparaît que si le rafraîchissement est réellement
  // impossible — aucun refresh token, ou refresh token lui-même échu.
  if (shop.accessTokenExpiresAt && new Date(shop.accessTokenExpiresAt).getTime() <= Date.now()) {
    const refreshUsable =
      Boolean(shop.refreshTokenEncrypted) &&
      (shop.refreshTokenExpiresAt === null ||
        new Date(shop.refreshTokenExpiresAt).getTime() > Date.now());
    if (!refreshUsable) {
      return { reason: 'token_expired', status: 'error' };
    }
  }

  return { reason: null, status: 'connected' };
}
