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

// B11 — messages FIXES, choisis côté serveur à partir du seul code. Aucun ne cite un domaine, un
// locataire ou une application. `refused` reste neutre : il ne dit pas que la boutique appartient
// à un autre espace. Vouvoiement (docs/lexique-microcopie.md).
export type ShopifyPublicErrorMessage = {
  title: string;
  body: string;
  // Orienter vers le support : seulement quand le marchand ne peut rien résoudre seul.
  contactSupport: boolean;
};

export const SHOPIFY_PUBLIC_ERROR_MESSAGES: Record<
  ShopifyPublicErrorCode,
  ShopifyPublicErrorMessage
> = {
  invalid_request: {
    title: 'Lien Shopify invalide',
    body: 'Ce lien n’est pas valide ou a expiré. Rouvrez Tëër depuis votre administration Shopify.',
    contactSupport: false,
  },
  other_app: {
    title: 'Boutique déjà associée',
    body: 'Cette boutique est déjà associée à une autre application Tëër.',
    contactSupport: true,
  },
  credentials_unavailable: {
    title: 'Connexion à vérifier',
    body: 'La connexion de cette boutique ne peut pas être vérifiée pour le moment.',
    contactSupport: true,
  },
  connection_in_progress: {
    title: 'Opération en cours',
    body: 'Une autre opération est en cours sur cette boutique. Patientez quelques instants, puis rouvrez Tëër depuis votre administration Shopify.',
    contactSupport: false,
  },
  ticket_invalid: {
    title: 'Lien de rattachement expiré',
    body: 'Ce lien de rattachement n’est plus valide. Rouvrez Tëër depuis votre administration Shopify pour recommencer.',
    contactSupport: false,
  },
  refused: {
    title: 'Rattachement impossible',
    body: 'Cette boutique ne peut pas être rattachée à votre espace.',
    contactSupport: true,
  },
  forbidden: {
    title: 'Rattachement réservé',
    body: 'Seul un propriétaire ou un gestionnaire de l’espace peut rattacher une boutique Shopify.',
    contactSupport: false,
  },
  unknown: {
    title: 'Une erreur est survenue',
    body: 'Rouvrez Tëër depuis votre administration Shopify, puis réessayez.',
    contactSupport: false,
  },
};
