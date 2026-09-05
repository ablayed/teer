# UX-DS-01 — Rapport final

PR [#186](https://github.com/ablayed/teer/pull/186), branche `phaseU/ux-ds-01-design-system` depuis `main` @ `c74a049266e33073d32b24aad6a563325cda1366`.

---

## 1. Inventaire (Temps 1)

Rendu séparément dans `docs/phaseU/UX-DS-01-INVENTAIRE.md` (commit `c54845a`), lecture seule. Conclusion : le lot tient dans une seule consolidation, à condition de traiter les cibles tactiles comme un audit ciblé plutôt qu'une réécriture de tous les écrans — confirmé par l'exécution : 64 fichiers, +928/−470, aucune découpe nécessaire.

## 2. Mesure du thème (dark mode)

Mesuré sur le CSS **effectivement généré** (`VERCEL_ENV=preview pnpm build`, inspection directe du bundle), pas supposé : un seul bloc `@media (prefers-color-scheme:dark)` dans tout le produit, couvrant 3 fichiers finance sur des couleurs Tailwind brutes, zéro token sémantique. Décision du fondateur : retiré plutôt que complété (commit `4665d00`) — un rendu à moitié basculé est pire qu'aucun mode sombre. Devient une entrée de dette, pas un lot.

## 3. Zones sous 48px et exceptions

`components/ui/button.tsx` (44px, commentaire citant l'ancien standard Apple HIG/WCAG 2.5.8) porté à 48×48 CSS px réels, généralisé à 43 fichiers hors des trois écrans déjà traités par `UX-COD-01` (commit `3bf857e`). Exceptions versionnées et justifiées dans ce même commit : contrôles compacts desktop déjà distingués par un `md:min-h-9`/`md:min-h-10` existant (préservés tels quels), icônes décoratives `h-11 w-11` (non interactives), code mort (`call-log-dialog.tsx`/`call-log-form.tsx`), et un décalage skeleton/réalité trouvé et corrigé au passage (`commandes/loading.tsx`, chips à 44px alors que les vraies chips étaient déjà à 48px depuis `UX-COD-01`).

## 4. Décisions prises et remontées

Quatre décisions initiales du rapport d'inventaire, arbitrées par le fondateur avant le Temps 2 :

1. **Vouvoiement marketing** : hors périmètre (registre de vente délibérément distinct du produit).
2. **« Données indisponibles »** : formulation générique conservée, pas de distinction par type d'erreur (commit `6c5904b`).
3. **Doublon « Une erreur est survenue{,|.} Réessayez. »** : unifié sur la forme au point (commit `6c5904b`).
4. **Commentaire `--status-*`** : vérifié par lecture de code (pas supposé) — vrai consommateur `components/orders/cod-status-badge.tsx`, pas `StatusBadge` comme l'inventaire l'avait supposé à tort ; commentaire corrigé en conséquence (commit `4665d00`, correction de l'erreur documentée en `e6437e7`).

Six arbitrages de consolidation, tous exécutés :

- **Mode sombre** : retiré (§2).
- **`Button`** : 48×48 px, exceptions auditées (§3).
- **Montants** : migrés vers `<Amount>`, découpés en commits par domaine dès que le diff devenait illisible (§5).
- **Primitive de quantité** : **non construite** — seulement 2 sites réels trouvés (stock physique/disponible, `driver-stock-table.tsx`), volume insuffisant.
- **`StatCard`** : supprimé, zéro appelant en production vérifié avant suppression (commit `e7103be`).
- **Vouvoiement + lexique** : garde généralisée, 3 violations réelles corrigées, dont une conjugaison verbale que le détecteur pronom/possessif de l'inventaire avait manquée (commits `8fa0d8e`, `6c5904b`).

## 5. Migration des montants — détail

~90 sites JSX migrés vers `<Amount>`, domaine par domaine, chaque commit vert (typecheck/biome/tests ciblés) avant le suivant :

| Commit | Domaine | Fichiers | Notes |
|---|---|---|---|
| `834e9ec` | orders/ | 7 | props `currency` mortes supprimées avec leurs appelants (formatMoney les ignorait déjà) |
| `a089bf4` | drivers/ | 4 | 3 sites n'avaient jamais eu tabular-nums — vrai gain d'alignement |
| `7ac40de` | finance/ | 8 | `DefinitionCard.value` élargi à `ReactNode`, préservé générique (%, comptes) |
| `4299d33` | dashboard/clients/kpi/stock/purchases | 6 | `NextActionViewItem.total` (string pré-formatée) remplacé par `totalMinor: number` |

**Exceptions documentées, non migrées** (chacune au commit correspondant) : tooltips de graphes Recharts (formatter retourne une chaîne par convention de la lib), interpolations `next-intl` `t(key, {amount: ...})` (exige une chaîne, pas un ReactNode), `lib/report/document.tsx` (générateur PDF react-pdf, cible de rendu différente — jamais touché), et **un montant héros non migré** : `app/(app)/finances/page.tsx:470-472`, « Cash chez les livreurs », rendu en `font-display italic text-5xl/6xl` — contredit l'invariant documenté d'`Amount` (« jamais la police display, jamais l'italique »). Conséquence précise, vérifiée : `tests/e2e/lot-u1f-tabular-nums.spec.ts` sélectionne ses cibles via `[data-testid="amount"]`, attribut posé uniquement par `Amount` — ce montant est donc structurellement invisible à la garde de troncature, sur toute largeur. Ni corrigé ni masqué : remonté ici comme décision de vocabulaire de marque, pas une mienne à trancher.

## 6. Garde de vouvoiement — preuve rouge/vert

`tests/unit/ui/no-tutoiement-app-text.test.ts` (commit `8fa0d8e`) : scanne `messages/fr.json` en excluant `marketing.*`. Preuve faite et non committée : violation injectée (`"editExpenses": "Modifie tes dépenses"`), garde rouge confirmée avec le diff exact attendu, violation retirée, garde verte confirmée à nouveau — `git status` propre après.

## 7. Baselines visuelles — avant/après

Générées exclusivement par CI (`update-visual-baselines.yml`, jamais localement — conforme à `CLAUDE.md`), sur la base de l'énumération exacte des échecs de la run diagnostique (§8), pas d'une régénération à l'aveugle. 16 fichiers PNG, tous `*-linux.png` (seuls probants) :

| Écran | Variantes régénérées | Avant → Après (ratio de pixels différents, run diagnostique) |
|---|---|---|
| clients | chromium, iphone-14, pixel-7 | 2 % (mobile), 2 % (desktop) |
| commandes-liste | chromium, iphone-14, pixel-7 | 4 % (mobile), 3 % (desktop) |
| finances | chromium, iphone-14, pixel-7 | 4 % (mobile), 4 % (desktop) |
| produits | chromium, iphone-14, pixel-7 | 3 % (mobile), 3 % (desktop) |
| analyses | iphone-14, pixel-7 uniquement | 2 % |
| livreurs | pixel-7 uniquement | 2 % |
| tableau | iphone-14 uniquement | 2 % |

**Ce que chaque diff montre** : dans tous les cas, la cause est la même et unique — la hauteur des cibles tactiles passées de 44 à 48px (boutons, champs, lignes de liste) redistribue verticalement le contenu de la page, décalant tout ce qui suit. Vérifié négativement : le jeu de 16 fichiers régénérés correspond exactement, fichier pour fichier, à l'énumération des échecs produite par CI sur la run diagnostique (commit `84374428`, aucun fichier de plus, aucun de moins) — pas de régénération à l'aveugle qui aurait pu transformer une vraie régression en norme.

## 8. Preuve rouge trouvée, investiguée, et non retenue comme régression

Une run diagnostique (CI `33900592606`) a fait remonter un échec en plus des 16 diffs visuels attendus : `tests/e2e/lot-f2-purchase-lot-detail.spec.ts:591` (fermeture d'un tiroir mobile Vaul par clic extérieur) sur iphone-14, dans un fichier que j'avais touché (`purchase-lot-detail-panel.tsx`, 5 éléments passés à 48px). `main` était vert à mon point de fork exact — la cause n'était donc pas préexistante à ce commit précis. Root cause non confirmée avec certitude (nécessitait une trace runtime du calcul de snap-point de vaul, hors de portée sans navigateur interactif), donc **non corrigée à l'aveugle**.

Rejouée intentionnellement sur le même arbre (CI `33904838708`, tree SHA identique à la première run) : le test est passé. Confirmé flake, pas régression — cohérent avec le commentaire du test lui-même, qui documente déjà cette interaction comme borderline-stable (« Playwright ne parvient pas à stabiliser un clic réel sur le bouton Fermer »). Aucune modification appliquée à ce fichier au-delà du changement de hauteur déjà committé.

## 9. Les deux exécutions finales distinctes, vertes au premier passage

Sur le tree final (`84374428cfb83e2f937dd1f4e8a103b7e329f470`, baselines regénérées incluses) :

| Run | Déclencheur | Statut |
|---|---|---|
| [`33908213300`](https://github.com/ablayed/teer/actions/runs/33908213300) | fermeture/réouverture PR, 2026-09-04 18:52:34 UTC | ✓ vert, 28 jobs, `test-e2e-regression (iphone-14, 2)` inclus |
| [`33909713274`](https://github.com/ablayed/teer/actions/runs/33909713274) | fermeture/réouverture PR, 2026-09-04 19:09:48 UTC | ✓ vert, 28 jobs, identique |

(Une run intermédiaire, `33907213003`, s'est déclenchée automatiquement au push du commit bot et a échoué à l'infrastructure — « likely failed because of a workflow file issue », pas un échec de test. Non comptée parmi les deux exécutions requises.)

## 10. Sanity loop local (avant CI)

`pnpm typecheck` / `pnpm lint` / `pnpm vitest run tests/unit` (137 fichiers, 1075 tests) / `pnpm test:rls` (54/55 suites, 401/401 tests — 1 suite non chargée sur un `.env.test` local incomplet, `RESEND_API_KEY` absent, sans rapport avec cette branche) / `pnpm security:acl-baseline:check` / `VERCEL_ENV=preview pnpm build` — tous verts avant le premier push.

## 11. Hors périmètre, laissé à `UX-CAT-01`

Produits/Stock/Clients/Boutiques/Paramètres au-delà de leur rôle de source de vérité pour cet audit, les défauts de données (`U0-D2`), `S5`. Non traité non plus dans ce lot : mesure de contraste formelle par paire de tokens (les tokens texte/fond n'ont pas changé de valeur dans ce lot, seules les hauteurs ont changé — aucun changement de contraste introduit, mais aucune mesure chiffrée nouvelle produite) ; parcours clavier explicite au-delà de ce que les specs E2E existantes exercent déjà (aucune régression n'aurait échappé à `test-e2e-phase1`/`test-e2e-regression`, qui interagissent au clavier/tap sur les écrans modifiés et sont restées vertes) ; `prefers-reduced-motion` non retouché dans ce lot (aucune nouvelle animation introduite).

## 12. Suite

PR #186 laissée ouverte pour revue — non fusionnée.
