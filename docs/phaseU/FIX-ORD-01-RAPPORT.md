# FIX-ORD-01 — navigation de la fiche Commande

Base distante vérifiée par `git fetch origin main` et `git ls-remote` :
`897272ed6532dd14638b5a083ab92c70e720b166`. Branche : `fix/ord-01`.

## Inventaire préalable

Recherche dans tous les fichiers TS/TSX de `app`, `components`, `lib` :
`pathname`, `usePathname`, `location.href`, `location.pathname`, `asPath`,
`useSelectedLayoutSegment`, puis lecture des constructeurs et de leurs appelants.
Inventaire communiqué avant toute modification applicative. Lignes ci-dessous : base `main`.

| Occurrence | Construction et conclusion |
| --- | --- |
| `components/orders/kanban/KanbanCard.tsx:22` | Ajoute `/id` au pathname complet ; fautif. Trois liens consomment ce résultat. |
| `components/orders/orders-page-loader.tsx:232` | Même concaténation dans le lien `ResourceRow` ; fautif. |
| `components/orders/order-detail-panel.tsx:330` | Retire le dernier segment pour Retour en entrée directe ; ne concatène pas d'identifiant. |
| `components/orders/orders-workspace.tsx:371` | Remplace la query du pathname courant lors du choix de vue ; à distinguer du défaut de segment. |
| `components/ui/search-input.tsx:84–85` | Remplace la query via `history.replaceState`, pas de segment ajouté. |
| `components/shops/shop-filter-persistence.tsx:40` | Ajoute une query au pathname courant ; pas de segment ajouté. |
| `components/shops/shop-filter-selector.tsx:33` | Ajoute une query à une racine explicite fournie par les pages Commandes, Tableau, Finances. |
| `components/workspace/store-switcher.tsx:142`, `store-chooser.tsx:55` | Utilisent déjà `buildStoreSwitchHref`. |
| `lib/workspace/store-switch.ts:142`, `app/s/page.tsx:60` | Entrée après connexion : chemin validé, préfixe boutique retiré avant reconstruction. |
| `components/clients/clients-workspace.tsx:477`, `components/drivers/drivers-workspace.tsx:267,287` | Liens de commande déjà construits depuis `/s/${storeId}/commandes`, indépendants du pathname. |

Les autres lectures servent au contexte, à l'état actif de navigation, à la sécurité,
au service worker ou à la télémétrie. Les persistances de période Tableau et Finances
reconstruisent déjà depuis un `storeId` explicite.
Le graphe Kanban est conservé dans le dépôt mais `KanbanBoardLoader` n'a pas
d'appelant applicatif au tip audité ; la reproduction HTTP utilise `OrdersPageLoader`.
Son gabarit de lien est néanmoins corrigé dans le même lot pour éviter sa réintroduction.

`buildOrderViewHref` (`lib/domain/order-saved-views.ts:161`) construit une URL de
**vue de liste**, avec query `vue/period/shop`, pas une fiche. Il n'est pas appelé
par les deux liens fautifs. Le correctif de fiche réutilise le parseur de préfixe
et `buildStoreSwitchHref` du module boutique existant, via `buildOrderDetailHref`.
Le chemin legacy `/commandes` reste pris en charge.

## Mécanismes établis au navigateur

Deux défauts distincts, donc deux commits prévus.

**URL : concaténation sur le pathname, pas lien relatif HTML.** Le layout Commandes
rend `children` puis `modal` (`app/(app)/commandes/layout.tsx:13–14`). À 390 px,
la branche mobile d'`OrderSideSheet` rend un `main` dans le flux, sans scrim.
La liste reste montée et réellement cliquable : le test effectue un clic Playwright
normal sur B après ouverture de A, sans `force`, dispatch artificiel ni modification
du DOM. Le changement de pathname réévalue le href de cette liste conservée et lui
ajoute un identifiant supplémentaire. Ce n'est pas un clic au travers d'un modal.

**Défilement : traitement explicite du routeur Next.** À 1280 px, instrumentation
de `HTMLElement.focus`, `scrollIntoView` et des événements scroll, avec hauteur du
document et piles d'appel. Le routeur cible le `main#main.space-y-6` du chargement
intercepté ; son `InnerScrollAndFocusHandler.handlePotentialScroll` remet scrollTop
à zéro puis appelle `scrollIntoView`, avant `focus`. Source installée :
`node_modules/next/dist/client/components/layout-router.js:210–227` (Next 15.5.18).
Le chargement utilise le gabarit `app/(app)/commandes/loading.tsx:5`.

Mesure après correction du lien seulement : position initiale 1129, hauteur 2346 ;
pendant le chargement hauteur 2852, `scrollIntoView` porte la position à 1952 ;
`focus` intervient alors que la position est **déjà 1952** ; au retrait du chargement,
la hauteur revient à 2346 et la position se borne à 1446. Une première reproduction
avant toute correction donnait 1363 → 1446 avec la même pile.

Le changement de hauteur accompagne donc le chargement et borne la position finale,
mais le saut commence par un défilement demandé par Next. Ce n'est pas un autofocus
du dialogue. Le correctif porte sur `Link.scroll` sur ordinateur uniquement ;
`ResourceRow` transmet cette option sans modifier son comportement par défaut.
Aucun changement dans `OrderSideSheet`, son rendu, son seuil viewport ou le panneau.
Aucun autofocus de dialogue supprimé ni gestionnaire de focus annulé.

## Preuve rouge / verte

Commande de reproduction :
`pnpm exec playwright test tests/e2e/orders-navigation.spec.ts --project=chromium`.
Compte et boutique synthétiques créés via les helpers E2E, Supabase local uniquement.

Rouge à 390 px, sur le **second clic vers B distinct de A** :

```text
A = 63380eca-ceff-4998-b54d-b115b56699ac
B = 5421f462-ba29-4fca-a410-7232e1e4e9ea
Premier clic :
http://localhost:3000/s/6acc6256-19eb-4c25-8d1b-913294fdad2b/commandes/63380eca-ceff-4998-b54d-b115b56699ac
Second clic, attendu :
http://localhost:3000/s/6acc6256-19eb-4c25-8d1b-913294fdad2b/commandes/5421f462-ba29-4fca-a410-7232e1e4e9ea
Second clic, reçu (HTTP 404) :
http://localhost:3000/s/6acc6256-19eb-4c25-8d1b-913294fdad2b/commandes/63380eca-ceff-4998-b54d-b115b56699ac/5421f462-ba29-4fca-a410-7232e1e4e9ea
```

Après le correctif de lien seul : mobile vert (A → B → retour A → B,
puis entrée directe/rechargement A), desktop encore rouge (1129 attendu, 1446 reçu).
Après correction du défilement : les deux cas et le test clavier existant passent
sur Chromium en développement. Le test final renforce aussi l'identité de la fiche B,
une position desktop obligatoirement non nulle et la conservation des filtres/vues.

Deux essais initiaux en développement ont échoué pendant la connexion à cause du
rechargement à chaud de la compilation à froid : ils ne constituent pas la preuve
rouge du défaut. La préparation visite la route avant connexion ; aucune relance
automatique n'est ajoutée au test.

Les URL sont comparées intégralement (origine, boutique, route, identifiant, query),
jamais par suffixe dans les assertions. Le sélecteur du deuxième lien avant le clic
utilise un suffixe pour pouvoir atteindre aussi le href défectueux et prouver le rouge.

## Validation finale

Boucle de sanité locale, sur l'arbre final (`VERCEL_ENV=preview` pour le build) :
`pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (1077 tests, dont
`order-detail-href.test.ts`), `pnpm build`, `pnpm test:rls` (401 tests
non-skipped) et `pnpm security:acl-baseline:check` — tous verts.

Un seul échec observé sur `test:rls` :
`shopify-refund-shop-scoped-order-resolution.rls.test.ts` (Zod, `RESEND_API_KEY`
manquant dans `.env.test` local). Reproduit à l'identique sur le tip `main`
(`897272e`) avant toute modification de ce lot — dette d'environnement locale
préexistante, sans rapport avec FIX-ORD-01, non présente en CI (env complet).

`orders-navigation.spec.ts` rejoué sur l'arbre final : 2/2 verts (390 px et
1280 px). `orders-detail-keyboard-a11y.spec.ts` (test clavier UX-COD-01) :
un premier passage a timeout sur la compilation à froid du dev server
(symptôme identique à celui déjà noté plus haut pour ce même lot), vert au
second passage — aucune régression du parcours clavier.

Aucune baseline visuelle modifiée.

Identifiants des deux exécutions initiales de CI à compléter après ouverture
de la PR et vérification du même arbre final sur le remote.
