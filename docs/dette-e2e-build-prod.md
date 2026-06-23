# Dette E2E — bascule `test-e2e` dev → build-prod 3 cibles

> **Statut : EN ATTENTE.** Travail prêt sur la branche `infra/e2e-build-prod` (commit `02c60de`). À reprendre après les vagues feature commandes.

## Objectif

Faire tourner le job CI `test-e2e` (`.github/workflows/ci.yml`) sur un **vrai build de prod**
(`next build` + `next start` via `E2E_PROD_BUILD=1`) au lieu de `pnpm dev`, sur les **3 cibles**
(chromium + pixel-7 + iphone-14).

**Pourquoi :** en `next dev`, la compilation **on-demand** des routes lourdes sous charge CI rend
des specs flaky (analytics, orders-transitions…). Un build de prod précompile tout → supprime
cette classe de flake à la racine. Pattern déjà éprouvé dans `e2e-prod.yml`.

## Mécanisme prouvé (le point délicat)

`upgrade-insecure-requests` (UIR) dans la CSP **blanchit WebKit/iphone-14 sur `http://localhost`**
(Chromium exempte le loopback, WebKit non). En build de prod servi en HTTP local, ça casserait
toutes les specs iphone-14.

**Solution :** le flag `NEXT_PUBLIC_DISABLE_UIR=1`, inliné **au build** dans le bundle
middleware/edge (`lib/security/csp.ts`), fait que la CSP du build de test **n'émet pas** UIR.
En prod réelle ce flag est absent → UIR émis normalement. **CSP prod intacte vérifiée au curl.**
(Le socle de ce flag — `csp.ts` + `e2e-prod.yml` — vit sur `wip/socle-uir`, commits `b53a220`+`fbf8069`.)

## Contenu de `infra/e2e-build-prod` (commit `02c60de`)

- `.github/workflows/ci.yml` : job `test-e2e` → étapes « Bake test env » + « Build production »
  (`NEXT_PUBLIC_DISABLE_UIR=1`) + `E2E_PROD_BUILD=1`.
- `tests/e2e/qa-prelaunch.spec.ts` : `waitForOrderStatus` converti en `expect.poll` (auto-retry).
- `tests/e2e/orders-pagination-verify.spec.ts` : fix seed `assigned`→`out_for_delivery`
  (sémantique 0062 : « En cours de livraison » = `out_for_delivery` SEUL) → reverdit `e2e-prod:299`.

## Reste à faire

1. Rebaser `infra/e2e-build-prod` sur `main` à jour, **après** intégration du socle UIR (`wip/socle-uir`)
   — la bascule `ci.yml` dépend du flag `NEXT_PUBLIC_DISABLE_UIR` de `csp.ts` (sinon WebKit blanchit).
2. Pousser, mesurer la **CI 3 cibles réelle** (premier vrai verdict build-prod, jamais mesuré en CI).
3. Durcir les flakes UI résiduels révélés par le build-prod (audit `fill()` → `pressSequentially`
   sur les `<input>` numériques contrôlés sous WebKit ; cf. dette E2E (c) dans `CLAUDE.md`).
4. Une fois `test-e2e` build-prod stable sur 3 cibles : retirer `e2e-prod.yml` (devenu redondant).

## Où vit le travail (sauvegardes)

- Branche **`infra/e2e-build-prod`** (`02c60de`) — ce lot.
- Branche **`wip/socle-uir`** (`fbf8069`) — flag UIR (`csp.ts`) + bake `e2e-prod.yml`. **Prérequis** de la bascule.
- Tag **`backup/tangled-stack-2026-06-23`** (`131f7b1`) — pile entremêlée d'origine (filet complet).
- Le garde-fou `assertLocalSupabase` est **déjà sur `main`** (PR #29) — ne pas le réintroduire.
