// Phase 2 / Lot L0 — credentials synthétiques par app, pour le harnais multi-app KOBA/PILOTE
// (tests/e2e/shopify-koba-multi-app.spec.ts). Valeurs de repli SEULEMENT : `ci.yml`
// (job `test-e2e-phase1`) positionne les mêmes chaînes littérales directement en env de step ;
// ces constantes ne servent qu'à faire marcher une exécution locale sans configuration CI,
// jamais à remplacer un secret déjà présent dans l'environnement (cf. playwright.config.ts).
// JAMAIS un vrai secret Partner Shopify — toute valeur ici est un test-only-fake-* explicite,
// délibérément imprononçable comme un vrai credential (voir CLAUDE.md, Lot L0 : un secret
// factice sans marqueur visible finit un jour remplacé par un vrai, précisément parce que la
// variable est déjà là et que « ça marche »). Tout secret réel passe par `secrets.*` en CI.
export const SHOPIFY_KOBA_CLIENT_ID_FALLBACK = 'test-only-fake-koba-client-id';
export const SHOPIFY_KOBA_HMAC_SECRET_FALLBACK = 'test-only-fake-koba-secret';
export const SHOPIFY_PILOTE_CLIENT_ID_FALLBACK = 'test-only-fake-pilote-client-id';
export const SHOPIFY_PILOTE_HMAC_SECRET_FALLBACK = 'test-only-fake-pilote-secret';
