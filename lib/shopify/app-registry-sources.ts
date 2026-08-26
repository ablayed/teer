// Phase 2 — Clôture : nomme les 4 apps Shopify et leurs clés d'environnement UNE SEULE FOIS,
// réutilisé par lib/shopify/apps.ts (Next, via lib/env.ts, validation Zod) ET par
// scripts/webhook-subscription-migration.mjs (script Node autonome, lit process.env
// directement — jamais lib/env.ts hors du runtime Next). Pur, zéro import.
export const SHOPIFY_APP_ENV_KEYS = [
  { label: 'teer-dev', clientIdKey: 'SHOPIFY_API_KEY', clientSecretKey: 'SHOPIFY_API_SECRET' },
  {
    label: 'teer-pilote',
    clientIdKey: 'SHOPIFY_PILOTE_API_KEY',
    clientSecretKey: 'SHOPIFY_PILOTE_API_SECRET',
  },
  {
    label: 'teer-marchand',
    clientIdKey: 'SHOPIFY_MARCHAND_API_KEY',
    clientSecretKey: 'SHOPIFY_MARCHAND_API_SECRET',
  },
  {
    label: 'teer-koba',
    clientIdKey: 'SHOPIFY_KOBA_API_KEY',
    clientSecretKey: 'SHOPIFY_KOBA_API_SECRET',
  },
] as const;
