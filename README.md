# Tëër

PWA Next.js 15 pour les opérations cash-on-delivery des marchands Shopify sénégalais.

Prérequis : Node 22, pnpm, Supabase CLI.

Setup : `pnpm install` -> `cp .env.example .env.local` -> remplir `.env.local` -> `supabase link --project-ref <ref>` -> `supabase db push` -> `pnpm dev`.

Scripts : `dev`, `build`, `lint`, `format`, `typecheck`, `test:unit`, `test:rls`, `test:e2e`, `db:types`.

## i18n

Les chaînes UI sont centralisées dans `messages/fr.json` et consommées via `next-intl`. L’application utilise une locale unique `fr` sans préfixe d’URL; le futur wolof sera activé par cookie.

## Avancement

W1 est terminée : i18n `next-intl`, formatters durcis et testés, AppShell responsive desktop/mobile.

Contraintes : Tous les textes UI en français. RLS FORCE sur toutes les tables tenant. Texte sur orange = #111.
