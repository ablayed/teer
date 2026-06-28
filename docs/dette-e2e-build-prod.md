# Dette E2E - bascule `test-e2e` dev -> build-prod

> Statut : lot termine le 2026-06-28 apres validation finale Decision B.
> Branche de revue initiale : `infra/e2e-build-prod`.
> Branche de cleanup post-validation : `cleanup/e2e-retire-post-validation`.
> SHA final du lot sur `main` : `e45e6b1`.

## Objectif du lot

Faire tourner le job CI `test-e2e` sur un vrai build de production (`next build` puis `next start`)
au lieu de `pnpm dev`, sur les trois cibles Playwright :

- `chromium`
- `pixel-7`
- `iphone-14` (WebKit)

Le but etait de supprimer la classe de flakiness causee par la compilation Next.js `dev` a la demande
sous charge CI. En build-prod, les routes sont compilees avant les specs : plus de cold-compile pendant
un test.

## Ce qui est ferme

- `test-e2e` passe en build-prod : `supabase start`, `supabase db reset --local`, bake
  `.env.production` / `.env.test`, `pnpm build`, purge de `.next/cache`, puis Playwright sert via
  `next start`.
- `NEXT_PUBLIC_DISABLE_UIR=1` est injecte avant `next build`, donc bake dans le bundle middleware/edge
  de test.
- La CSP de production reste inchangee hors build de test : `upgrade-insecure-requests` reste present
  sans flag et absent uniquement avec `NEXT_PUBLIC_DISABLE_UIR=1`.
- Les trois cibles E2E tournent en shards separes via matrix par projet, `fail-fast: false`.
- Les rapports Playwright CI sont emis en `blob` puis fusionnes en rapport HTML unique.
- `workers: 1`, `fullyParallel: false`, `trace: on-first-retry` et `retries: 1` restent en transition
  jusqu'a la preuve statistique.
- Les waits `networkidle` ont ete supprimes des specs E2E.
- Les sleeps de polling ont ete convertis en `expect.poll`.
- Les `fill()` numeriques controles identifies ont ete remplaces par `pressSequentially()` avec garde
  `toHaveValue()` avant soumission.
- Les flakes UI observes en validation stage (a) ont ete corriges a la source :
  - `orders-pagination-verify` : attente de l'effet observable plutot que `waitForURL` debounce ;
  - `shop-filter` : attente de la liste filtree plutot que l'URL fragile.

## Validation CI

Dernier run CI sharde vert :

- Run : `28130690556`
- SHA : `6cbdabd`
- `test-e2e (chromium)` : vert
- `test-e2e (pixel-7)` : vert
- `test-e2e (iphone-14)` : vert
- `merge-e2e-reports` : vert

Validation finale zero-flake sur `main` :

- Workflow : `.github/workflows/e2e-zero-flake.yml`
- Parametres : `repeat-each=25`, `retries=0`, `workers=1`, `fail-on-flaky-tests`
- Cibles : `chromium`, `pixel-7`, `iphone-14`
- Resultat : 3 x 25 vert, aucune cible en echec ; cleanup merge ensuite sur `main` via `e45e6b1`

Validations intermediaires importantes :

- Stage (a) `chromium + pixel-7` : deux runs consecutifs verts avant WebKit.
- Stage (b) `iphone-14` seul : vert, preuve que le flag UIR est bake avant `next build`.
- Sharding trois cibles : vert avec rapport HTML fusionne.

## Hors scope explicite

### Auth `storageState`

La suppression des 13 helpers `signIn` est sortie de ce lot.

Raison : ces helpers ne sont pas une duplication simple. Ils creent des utilisateurs distincts a roles
variables et tenants differents pour tester l'isolation, les permissions et les invitations. Un
`storageState` global detruirait cette couverture.

Dette separee : `docs/dette-auth-storageState.md`.

### Retrait des filets

Retrait effectif post-validation :

- `.github/workflows/e2e-prod.yml` supprime dans `c5935fb`
- `tests/e2e/global-setup.ts` et sa reference `globalSetup` supprimes dans `4817800`

Restent inchanges dans ce lot :

- `retries: 1`
- `trace: on-first-retry`

## Protocole zero-flake

Le workflow manuel `.github/workflows/e2e-zero-flake.yml` est ajoute au repo. Il execute une cible avec :

```bash
pnpm exec playwright test --project=<cible> --repeat-each=<25|50> --retries=0 --fail-on-flaky-tests --workers=1
```

Limite GitHub Actions : un nouveau `workflow_dispatch` n'est declenchable depuis l'UI qu'une fois le
workflow present sur la branche par defaut. Il sera donc utilisable apres merge sur `main`.

Critere de sortie applique :

- repeat-each 25 vert sur `chromium`, `pixel-7`, `iphone-14` ;
- validation humaine de la decision B ;
- retrait de `e2e-prod.yml` et du warm-up.

## Ne pas toucher

- `assertLocalSupabase`.
- La CSP de production hors flag de test deja merge.
- Le tag `backup/tangled-stack-2026-06-23`.
- `stash@{0}` ("heure de livraison").
