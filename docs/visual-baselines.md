# Baselines visuelles Playwright

Les baselines de référence sont générées uniquement sous Linux CI, en build de production (`E2E_PROD_BUILD=1`), jamais en local Windows.

## Commandes locales

- `pnpm test:e2e` : E2E fonctionnels uniquement
- `pnpm test:visual:desktop` : régression visuelle desktop (`chromium`)
- `pnpm test:visual:mobile` : régression visuelle mobile (`pixel-7`, `iphone-14`)

Ne pas lancer `--update-snapshots` en local : cela produirait des PNG `-win32` inutilisables pour la CI.

## Bootstrap Linux (toutes les baselines)

Le premier bootstrap des snapshots se fait via le workflow GitHub Actions `update-visual-baselines`.

1. Ouvrir l'onglet `Actions`
2. Sélectionner `update-visual-baselines`
3. Cliquer `Run workflow`
4. Lancer le workflow sur la branche à mettre à jour

Le workflow exécute `pnpm exec playwright test tests/visual --update-snapshots` sur `ubuntu-latest`, puis commit les PNG `-linux` générés sur la branche.

## Rebase ciblé d'une seule section (usage courant pendant les migrations)

Pendant une migration écran par écran, il ne faut **jamais** utiliser `scope=sections` pour rebaser une seule section — cela régénérerait les 6 baselines et écraserait les 5 autres qui servent de filet de non-régression.

Utiliser à la place le champ **`test_filter`** :

1. `Actions → update-visual-baselines → Run workflow`
2. Laisser `scope` sur sa valeur par défaut (`primitives`)
3. Renseigner `test_filter` avec le nom exact du test, ex. `clients`
4. Lancer

Cela exécute uniquement `sections.visual.spec.ts --grep "clients"` sur les 3 projets (`chromium`, `pixel-7`, `iphone-14`), et ne touche pas aux 5 autres baselines.

### Valeurs valides de `test_filter` (noms de tests de `sections.visual.spec.ts`)

| Valeur | Baseline(s) régénérée(s) |
|---|---|
| `clients` | `clients-linux.png` (× 3 projets) |
| `commandes-liste` | `commandes-liste-linux.png` (× 3) |
| `commandes-detail` | `commandes-detail-linux.png` (× 3) |
| `livreurs` | `livreurs-linux.png` (× 3) |
| `produits` | `produits-linux.png` (× 3) |
| `tableau` | `tableau-linux.png` (× 3) |

`test_filter` accepte n'importe quelle expression `--grep` Playwright (regex). Ex. `commandes` matcherait `commandes-liste` et `commandes-detail`.

### Règle d'or

> Ne jamais utiliser `scope=sections` (ni `scope=all`) pour rebaser un seul écran.
> Toujours utiliser `test_filter=<nom>` pour un rebase ciblé.

## Vérification avant rebase

Avant de déclencher `--update-snapshots`, vérifier manuellement le diff visuel :

```bash
# Diff d'un test seul (sans rebase)
pnpm exec playwright test tests/visual/sections.visual.spec.ts -t "clients" --project=chromium

# Vérification 0 diff sur les 5 autres sections
pnpm exec playwright test tests/visual/sections.visual.spec.ts --grep-invert "clients" --project=chromium

# Primitives (doit toujours être 0 diff)
pnpm exec playwright test tests/visual/primitives.visual.spec.ts --project=chromium
```
