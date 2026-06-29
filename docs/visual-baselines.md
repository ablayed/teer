# Baselines visuelles Playwright

Les baselines de référence sont générées uniquement sous Linux CI, en build de production (`E2E_PROD_BUILD=1`), jamais en local Windows.

## Commandes locales

- `pnpm test:e2e` : E2E fonctionnels uniquement
- `pnpm test:visual:desktop` : régression visuelle desktop (`chromium`)
- `pnpm test:visual:mobile` : régression visuelle mobile (`pixel-7`, `iphone-14`)

Ne pas lancer `--update-snapshots` en local : cela produirait des PNG `-win32` inutilisables pour la CI.

## Bootstrap Linux

Le premier bootstrap des snapshots se fait via le workflow GitHub Actions `update-visual-baselines`.

1. Ouvrir l'onglet `Actions`
2. Sélectionner `update-visual-baselines`
3. Cliquer `Run workflow`
4. Lancer le workflow sur la branche à mettre à jour

Le workflow exécute `pnpm exec playwright test tests/visual --update-snapshots` sur `ubuntu-latest`, puis commit les PNG `-linux` générés sur la branche.
