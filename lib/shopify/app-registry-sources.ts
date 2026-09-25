// Phase 2 — Clôture : nomme les 4 apps Shopify et leurs clés d'environnement UNE SEULE FOIS,
// réutilisé par lib/shopify/apps.ts (Next, via lib/env.ts, validation Zod) ET par
// scripts/webhook-subscription-migration.mjs (script Node autonome, lit process.env
// directement — jamais lib/env.ts hors du runtime Next). Pur, zéro import.
//
// SHOPIFY-EXPIRING-TOKENS-01 — `distribution` est un FAIT DE CONFIGURATION EXTERNE (Partner /
// Dev Dashboard), jamais une qualification déduite ici. Obligatoire, sans valeur par défaut : une
// entrée qui l'omet ne satisfait pas `ShopifyAppEnvKeySpec` et fait échouer `pnpm typecheck`
// (verrou : tests/unit/shopify/app-distribution-registry.test.ts). Elle décide seule si les
// échanges de jeton demandent `expiring=1` (lib/shopify/oauth.ts). Sources, au 2026-09-25 :
//   teer-dev      custom — mention « Manage custom install link », mesurée ;
//   teer-pilote   custom — mention explicite du Dev Dashboard, relevée par le porteur ;
//   teer-marchand custom — mention « Manage custom install link » ; la correspondance entre la
//                 capture et cette app est ATTESTÉE par le porteur (la capture ne montrait pas
//                 le nom), pas mesurée ;
//   teer-koba     custom — app custom de l'organisation du marchand, mesurée ;
//   teer-public   public — mesurée.
export type ShopifyAppDistribution = 'public' | 'custom';

export type ShopifyAppEnvKeySpec = {
  readonly label: string;
  readonly clientIdKey: string;
  readonly clientSecretKey: string;
  readonly distribution: ShopifyAppDistribution;
};

export const SHOPIFY_APP_ENV_KEYS = [
  {
    label: 'teer-dev',
    clientIdKey: 'SHOPIFY_API_KEY',
    clientSecretKey: 'SHOPIFY_API_SECRET',
    distribution: 'custom',
  },
  {
    label: 'teer-pilote',
    clientIdKey: 'SHOPIFY_PILOTE_API_KEY',
    clientSecretKey: 'SHOPIFY_PILOTE_API_SECRET',
    distribution: 'custom',
  },
  {
    label: 'teer-marchand',
    clientIdKey: 'SHOPIFY_MARCHAND_API_KEY',
    clientSecretKey: 'SHOPIFY_MARCHAND_API_SECRET',
    distribution: 'custom',
  },
  {
    label: 'teer-koba',
    clientIdKey: 'SHOPIFY_KOBA_API_KEY',
    clientSecretKey: 'SHOPIFY_KOBA_API_SECRET',
    distribution: 'custom',
  },
  {
    label: 'teer-public',
    clientIdKey: 'SHOPIFY_TEER_PUBLIC_API_KEY',
    clientSecretKey: 'SHOPIFY_TEER_PUBLIC_API_SECRET',
    distribution: 'public',
  },
] as const satisfies readonly ShopifyAppEnvKeySpec[];
