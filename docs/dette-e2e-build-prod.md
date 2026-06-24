# Dette E2E - bascule `test-e2e` dev -> build-prod

> Statut : point d'arret propre du lot `infra/e2e-build-prod`.
> Branche : `infra/e2e-build-prod`.
> Dernier etat fonctionnel connu : stage (a) chromium + pixel-7 presque vert, residus UI bornes.

## Objectif

Faire tourner le job CI `test-e2e` sur un vrai build de production (`next build` puis `next start`)
au lieu de `pnpm dev`, sur les 3 cibles Playwright (`chromium`, `pixel-7`, `iphone-14`).

Le but est de supprimer la classe de flake causee par la compilation Next.js `dev` a la demande sous
charge CI. En build-prod, les routes sont precompilees avant les specs : plus de cold-compile pendant
un test.

## Acquis deja prouves

- Base locale realignee sur `origin/main`.
- Tag rollback `pre-e2e-prod-switch` pose sur `e9e50355540da8c9c23b44eeed492ace223cf228`.
- PR #32 (`wip/socle-uir`) mergee : `NEXT_PUBLIC_DISABLE_UIR=1` neutralise seulement
  `upgrade-insecure-requests` pour le build de test.
- Preuve CSP faite au curl : UIR present sans flag, absent avec `NEXT_PUBLIC_DISABLE_UIR=1`, reste de
  la CSP identique.
- `infra/e2e-build-prod` rebase sur `origin/main`.
- `.github/workflows/ci.yml` bascule `test-e2e` vers build-prod :
  `supabase start`, `supabase db reset --local`, bake `.env.production` / `.env.test`, `pnpm build`
  avec `NEXT_PUBLIC_DISABLE_UIR=1`, purge de `.next/cache`, puis Playwright via `next start`.
- `tests/e2e/qa-prelaunch.spec.ts` : poll DB converti en `expect.poll`.
- `tests/e2e/orders-pagination-verify.spec.ts` :
  - seed chips aligne sur la semantique migrations 0061/0062 (`assigned` dans `Programmer`) ;
  - time-bomb date supprimee : seed relatif a `today.getTime()` ;
  - fuseau seed/test confirme identique (`Africa/Dakar`).

## Etat CI actuel

Le workflow porte encore volontairement le marqueur temporaire de validation stage (a) :

```bash
pnpm test:e2e --project=chromium --project=pixel-7
```

Ce mode doit rester tant que les flakes UI residuels ne sont pas corriges et que stage (a) n'a pas donne
2 runs verts consecutifs.

## Residus exacts a reprendre

### Flakes UI observes en stage (a)

| Spec | Ligne | Cible observee | Signature | Hypothese a verifier par trace |
| --- | ---: | --- | --- | --- |
| `tests/e2e/orders-pagination-verify.spec.ts` | 344 | chromium/pixel-7 stage (a) | `page.waitForURL(/[?&]q=zzznomatch/)` pend jusqu'a 90s | attente URL debounce fragile ; attendre l'effet observable `Aucune commande pour "zzznomatch"` et `article` count 0 |
| `tests/e2e/shop-filter.spec.ts` | 268 | `pixel-7` | `page.waitForURL(...period=today...)` pend, chromium passe | attente URL fragile ou tap mobile manque ; verifier le click target dans la trace, puis attendre la liste filtree |

### Stock de durcissement encore present

- `networkidle` dans les helpers `signIn` et quelques tests : a supprimer au profit d'un element post-login
  ou de l'effet attendu.
- `waitForTimeout` / `setTimeout` fixes : a convertir en assertions web-first, `expect.poll` ou `toPass`
  selon le cas.
- Helpers `signIn` dupliques : a remplacer par un projet `setup` + `storageState`.
- `fill()` sur inputs numeriques controles : remplacer seulement les cas sensibles par
  `pressSequentially()` + garde `toHaveValue` avant submit.

## Critere de reprise

1. Tirer d'abord les traces des deux flakes UI connus avant de coder.
2. Corriger les waits d'URL fragiles par attente de l'effet observable, sans timeout artificiel ni sleep.
3. Garder stage (a) `chromium` + `pixel-7` jusqu'a 2 runs CI consecutifs verts.
4. Ensuite seulement lancer `iphone-14` seul, puis les 3 cibles ensemble en sharding par projet.
5. Ne supprimer `e2e-prod.yml` et le warm-up `globalSetup` qu'apres validation humaine explicite.

## Ne pas toucher

- `assertLocalSupabase`.
- La CSP de production hors flag de test deja merge.
- Le tag `backup/tangled-stack-2026-06-23`.
- `stash@{0}` ("heure de livraison").
