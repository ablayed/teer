// APP-03 / Lot 2 — module séparé (pas dans lib/actions/shops.ts, `'use server'`) : Next.js exige
// que tout export d'un module `'use server'` soit une fonction async ; cette fonction pure doit
// rester unitairement testable en synchrone (même raison que lib/security/post-sign-in-path.ts).
export type ShopStatusInput = {
  status: string;
  storeKind: string;
  accessTokenEncrypted: string | null;
  accessTokenExpiresAt: string | null;
};

export type ShopStatusResult = {
  status: 'connected' | 'error' | 'incomplete' | 'uninstalled';
  reason: 'token_expired' | null;
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

  if (shop.accessTokenExpiresAt && new Date(shop.accessTokenExpiresAt).getTime() <= Date.now()) {
    return { reason: 'token_expired', status: 'error' };
  }

  return { reason: null, status: 'connected' };
}
