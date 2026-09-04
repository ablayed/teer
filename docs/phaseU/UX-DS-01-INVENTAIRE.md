# UX-DS-01 — Inventaire (Temps 1)

> Lecture seule. Aucun fichier de produit modifié pour produire ce rapport. Toute mesure de CSS
> généré a été faite via `VERCEL_ENV=preview pnpm build` puis inspection directe de
> `.next/static/css/*.css` (build jeté ensuite, non commité).

Branche : `phaseU/ux-ds-01-design-system`, depuis `main` @ `c74a049266e33073d32b24aad6a563325cda1366`.

---

## 1. Tokens

**Tailwind v4, `@theme` non-inline.** `tailwind.config.ts` ne porte plus de thème (juste les globs
`content`) — toute la config vit dans `app/globals.css` via `@import "tailwindcss"` + `@theme`.
Deux couches déjà en place, séparées :

- **`:root`** (globals.css:3-82) — valeurs brutes : couleurs en hex/rgba, rayons (`--radius-sm/md/lg/xl`
  = 8/12/16/20px), ombres (`--shadow-1/2`, `--shadow-warm-1/2/3`), durées (`--dur-xs/s/m/l`),
  easing (`--ease-standard`).
- **`@theme`** (globals.css:84-134) — mappe chaque `--color-X` sur `var(--X)` du `:root` (jamais une
  valeur inline). Confirmé par le CSS généré : `.text-muted{color:var(--color-muted)}`, pas de
  littéral. **C'est le point important : l'architecture est déjà runtime-switchable**, alors même
  qu'aucun mode sombre n'existe (§2). La piste « `@theme inline` fige les couleurs au build » que le
  brief demandait de vérifier est **fausse sur ce dépôt** — le risque documenté dans le brief ne
  s'applique pas ici, il n'y a nulle part de `@theme inline`.

**Nommage déjà sémantique, pas par apparence** : `--text`, `--muted`, `--accent`, `--surface`,
`--canvas`, `--border`, `--success`/`--warning`/`--danger`/`--info` (+ leurs `-subtle`/`-foreground`
quand ils existent), `--status-*` (9 tokens calqués sur `cod_status`, commentés comme
« additif uniquement, ne pas utiliser en Phase 1 Socle » — cette réserve date d'avant U1-F/UX-COD-01
et est aujourd'hui obsolète : `StatusBadge` les consomme, à vérifier en Temps 2 si le commentaire est
encore correct). Rien à renommer — le vocabulaire cible du plan (`text-secondary`, `surface-raised`,
etc.) n'existe pas nommément mais les tokens actuels remplissent déjà ces rôles.

**Couleurs : hex/rgba, jamais `oklch`.** Aucune occurrence d'`oklch(` dans `globals.css`. Aucune
librairie de contraste/couleur au `package.json` (`oklch`, `colorjs`, `culori` : 0 résultat). La
conversion + la vérification de contraste après coup (mandatée en Temps 2) demandent donc un outil à
choisir, pas seulement une réécriture de syntaxe.

**Deux tokens `-foreground` seulement aujourd'hui** : `--warning-foreground`, `--info-foreground`
(confirmé par la garde existante, §3). `muted-foreground`/`background` vus dans
`textarea.tsx`/`drawer.tsx` sont un vestige shadcn sans variable CSS Tëër réelle derrière —
la garde `foreground-token-pairing.test.ts` les exclut déjà explicitement.

**Durcissement en dur repéré** : les composants `finance/*` (`FinanceProductCostView.tsx`,
`ProfitSection.tsx`, `finances/page.tsx`) utilisent la palette Tailwind brute (`amber-*`,
`emerald-*`) plutôt que les tokens `--warning`/`--success` — c'est le même noyau de fichiers qui
porte les 3 seuls usages de `dark:` du produit (§2). Pas d'autre durcissement massif détecté ailleurs
(le reste du produit passe par les tokens `--text`/`--muted`/`--border`/`--surface`/`--canvas`).

---

## 2. Mode sombre — mesuré, pas supposé

**Verdict : le mode sombre n'existe pas comme fonctionnalité cohérente.** Preuve par le CSS
effectivement généré (`pnpm build` en `VERCEL_ENV=preview`, bundle `38474d69d8dbbf96.css`, 87 308
octets) :

- **Exactement un seul bloc `@media (prefers-color-scheme:dark)`** dans tout le CSS produit.
- Il ne contient que 5 classes utilitaires — `dark:border-amber-800/40`, `dark:bg-amber-950/30`,
  `dark:bg-amber-950/40`, `dark:bg-emerald-950/40`, et leurs variantes `color-mix` — issues des 3
  seuls fichiers source qui utilisent le variant Tailwind `dark:` (`app/(app)/finances/page.tsx`,
  `components/finance/FinanceProductCostView.tsx`, `components/finance/ProfitSection.tsx`), sur des
  couleurs Tailwind brutes (amber/emerald), pas sur les tokens sémantiques.
- **Zéro** override, dans ce bloc ou ailleurs, pour `--canvas`, `--surface`, `--text`, `--muted`,
  `--border`, `--accent`, ou l'un des 9 `--status-*`.
- Aucun `@custom-variant dark (...)` dans `globals.css` → la stratégie `dark:` de Tailwind v4 reste
  sa valeur par défaut, `@media (prefers-color-scheme: dark)` (pas de bascule par classe `.dark`).
  Confirmé : la seule occurrence de la sous-chaîne `.dark` dans le CSS généré est à l'intérieur des
  noms de classes échappés `.dark\:border-amber-800\/40` etc. — pas un sélecteur `.dark` réel.

**Conséquence concrète** : un marchand dont l'OS est en mode sombre voit aujourd'hui 3 blocs
d'avertissement Finance changer de couleur (fond/bordure ambre plus sombres) pendant que le reste de
l'écran — fond, texte, cartes, accent, badges de statut — reste figé sur ses valeurs claires. C'est
un rendu à moitié basculé, pas un mode sombre partiel utilisable.

**Ce qui EST déjà en place pour un futur mode sombre (si arbitré)** : l'architecture `@theme` non
inline (§1) signifie qu'ajouter des valeurs `:root`/`.dark` pour les tokens sémantiques suffirait —
aucune restructuration de `@theme` n'est nécessaire, contrairement à l'hypothèse du brief.

---

## 3. Composants — partagés, dupliqués, orphelins

`components/ui/` (28 fichiers) est le dossier de primitives. Pas de duplication accidentelle
détectée par nom — chaque composant a un rôle documenté et distinct. Le vrai problème n'est pas la
duplication de composants, **c'est leur sous-utilisation** : le pattern existe, mais les écrans
réimplémentent inline plutôt que de l'appeler.

### 3.1 `Amount` — le cas le plus net

`components/ui/amount.tsx` se documente lui-même comme « Seul composant du produit pour un montant en
francs CFA » (`tabular-nums lining-nums`, jamais la police display). Mesuré :

- **Appelants réels de `<Amount>` : 2** — `components/purchases/purchase-lot-detail-panel.tsx` et
  deux primitives `ui/` qui l'enveloppent (`gain-loss.tsx`, `value-state.tsx`).
- **Appelants de `formatMoney()` qui NE passent PAS par `<Amount>` : 26 fichiers** — `finances/page.tsx`,
  `tableau/page.tsx`, `clients-workspace.tsx`, `tableau-period-metrics.tsx`, 4 fichiers `drivers/`,
  6 fichiers `finance/`, `kpi/NextActionsList.tsx`, 6 fichiers `orders/`, `purchase-lots-view.tsx`,
  `stock-table.tsx`, `lib/report/document.tsx` (PDF). Chacun réimplémente à la main
  `className="font-mono ... tabular-nums"` autour du résultat de `formatMoney()`.

Concrètement : le seul composant censé garantir un rendu monétaire uniforme est contourné dans la
quasi-totalité des écrans qui affichent de l'argent. Toute dérive future (abréviation, police,
troncature) entre ces 26 sites et `Amount` est structurellement possible aujourd'hui.

### 3.2 Cartes de métrique — trois composants distincts, mais deux quasi-morts

- `components/ui/stat-card.tsx` (`StatCard`) — générique label/valeur/delta. **Utilisé nulle part en
  production** : son seul appelant est `app/(app)/dev/primitives/page.tsx` (page de démo interne).
- `components/ui/scoped-metric-card.tsx` (`ScopedMetricCard`) — ajoute la portée temporelle
  (solde à une date vs flux sur période, documenté comme distinction volontaire). **1 seul appelant
  réel** : `purchase-lot-detail-panel.tsx`.
- `components/kpi/KPICard.tsx` — animé (framer-motion), sparkline, `DefinitionToggle` intégré,
  clairement le plus riche des trois. **Seul vraiment utilisé** (`components/kpi/dashboard-kpi-refresh.tsx`),
  au Tableau.

Pendant ce temps, le pattern « nombre en gros, `font-mono tabular-nums`, sous un libellé » est
réimplémenté à la main dans `finances/page.tsx:146`, `tableau/page.tsx:238`,
`drivers/driver-cash-panel.tsx:24`, `drivers/drivers-workspace.tsx:51`,
`finance/FinanceDriverCostView.tsx:30/37/44`, `clients-workspace.tsx:115`, etc. — au moins une
dizaine de sites qui auraient pu être `StatCard` et ne le sont pas.

### 3.3 États vide/insuffisant/erreur — trio réel mais partiel

- `components/ui/empty-state.tsx` (`EmptyState`) — aucune donnée.
- `components/ui/insufficient-data-state.tsx` (`InsufficientDataState` + `hasSufficientVolume`
  pur) — volume trop faible, explicitement documenté comme **distinct** de « aucune donnée ».
- **Pas de composant d'état d'erreur partagé.** Chaque écran rend son propre message d'erreur
  (souvent la chaîne dupliquée décrite en §8).

### 3.4 Squelettes — trois composants, rôles réellement distincts (pas une duplication)

`components/ui/skeleton.tsx` (`Skeleton`/`ResourceRowSkeleton`, primitives génériques),
`components/ui/analytics-skeleton.tsx` (`AnalyticsSkeleton`, standard documenté pour le pattern
Suspense+clé de `CLAUDE.md`), `components/skeletons/route-skeleton.tsx` (fallback `loading.tsx`,
dimensions calées par route pour éviter le CLS). Les trois se justifient et se référencent
mutuellement dans leurs commentaires — **pas une dette**, à laisser tel quel.

### 3.5 Bouton partagé — un seul point de levier, mais plafonné à 44px

`components/ui/button.tsx` (`Button`, `cva`) est LE bouton du produit. Son commentaire cite
explicitement l'ancienne norme : « Cible tactile ≥ 44px (Apple HIG / WCAG 2.5.8) » — `h-11`/`min-h-11`
sur ses deux variantes de taille. Détail complet en §5.

---

## 4. États de chargement — `toMetricLoadState`

Défini dans `lib/dashboard/metric-load-state.ts` (`ReadonlyMetricResult` → `loading | error | empty |
ready`, pur, testé). **Appelants réels : 2** — `app/(app)/tableau/page.tsx` et
`lib/actions/purchases.ts`. C'est le pattern de référence livré par TB-P0, mais TB-P0 ne l'a câblé
que sur le Tableau ; `/finances`, `/livreurs`, `/analyses`, `/clients` composent leurs propres
enchaînements loading/empty/error ad hoc (souvent un simple `if (!data)` suivi d'un rendu conditionnel
sans distinguer *pourquoi* la donnée manque). Il n'y a pas de confusion active détectée entre les
trois notions sur les écrans déjà audités par TB-P0/UX-COD-01 ; le risque est ailleurs — les écrans
qui n'ont jamais reçu cette discipline n'ont tout simplement pas la distinction.

À noter, orthogonal à `toMetricLoadState` : `MoneyValueState` (`components/ui/value-state.tsx`,
`confirmed | estimated | missing`) répond à une question différente — la qualité d'**une valeur**
déjà chargée, pas l'état d'un **fetch**. Les deux patterns coexistent proprement, pas de collision.

---

## 5. Cibles tactiles — 48×48 CSS px

**Définition appliquée** : zone interactive réellement atteignable (padding/zone d'activation
compris), pas la boîte visuelle. Ceci est un inventaire par grep + lecture de code, pas une mesure
DOM — voir la limite méthodologique en fin de section.

### 5.1 Le levier central : `Button` plafonne à 44px, pas 48

`components/ui/button.tsx:10-13` :
```
default: 'h-11 px-5',        // 44px
sm: 'min-h-11 px-3 text-sm',  // 44px, commentaire cite « Apple HIG / WCAG 2.5.8 »
```
Remonter ces deux valeurs à `h-12`/`min-h-12` (48px) est le changement à plus haut effet de levier du
lot — il cascade sur tout appelant de `Button` sans autre modification. Aucune troisième taille
n'existe (pas de `xs`/`lg`).

### 5.2 Déjà à 48px : les trois écrans UX-COD-01

Confirmé par l'historique (`git log`, commit `9db04a6`, message : « 48px appliqué à chaque cible
interactive des trois écrans touchés par ce lot »). Tableau, Commandes, Fiche Commande sont donc
**hors périmètre de correction** pour ce lot — seulement audités pour cohérence si le seuil global
change de définition.

### 5.3 En dessous de 48px, hors des trois écrans déjà traités

- **Barre basse mobile, menu « Plus »** (`components/app-shell/bottom-tab-nav.tsx:147`) : les liens du
  panneau overflow sont `min-h-11` (44px), pas 48.
- **Formulaires — champs numériques `min-h-11`** (44px), à au moins 7 endroits :
  `components/products/products-catalog.tsx:141/153/248/408`, `finance/ExpenseSection.tsx:181`,
  `purchases/purchase-lot-detail-panel.tsx:669`, `purchases/product-ad-spend-form.tsx:179`,
  `finance/DriverSettlementsPanel.tsx:360`. Un champ de saisie n'est pas un bouton, mais reste une
  cible tactile au sens de la règle si l'utilisateur doit le taper précisément (marchand qui édite
  un prix sur mobile).
- **17 fichiers hors des 3 écrans déjà traités** contiennent un `<button>` brut (pas via `Button`)
  combiné à une classe de taille `h-`/`size-` à 6/7/8/9/10 quelque part dans le fichier — candidats à
  vérifier un par un en Temps 2 (la présence de la classe dans le fichier ne garantit pas qu'elle est
  posée sur le bouton lui-même) :
  `components/assistant/assistant-view.tsx`, `components/clients/clients-workspace.tsx`,
  `components/drivers/driver-cash-panel.tsx`, `components/drivers/driver-stock-table.tsx`,
  `components/finance/DriverSettlementsPanel.tsx`, `components/finance/FinanceProductCostView.tsx`,
  `components/orders/hydration-crash-recovery-banner.tsx`, `components/orders/new-order-form.tsx`,
  `components/orders/order-detail-panel.tsx` (partiellement déjà couvert par UX-COD-01 — à
  revérifier, seule la version mobile a été retravaillée), `components/products/product-detail-panel.tsx`,
  `components/products/products-catalog.tsx`, `components/purchases/purchase-lots-view.tsx`,
  `components/settings/settings-profile.tsx`, `components/shops/connect-shop-banner.tsx`,
  `components/stock/stock-table.tsx`, `components/ui/definition-card.tsx`.
- **Tables desktop** (`stock-table.tsx`, `driver-stock-table.tsx`, `FinanceProductCostView.tsx`,
  analyses/page.tsx…) : cellules d'action compactes (`px-3 py-2`/`px-4 py-3`) sans hauteur minimale
  explicite — probablement sous 48px de zone atteignable sur les icônes d'action de ligne. Exception
  légitime probable pour les liens texte de table sur ordinateur (le brief le dit explicitement :
  ne pas déformer les tableaux desktop) — à trancher case par case, pas en bloc.

### 5.4 Limite méthodologique — à assumer explicitement pour Temps 2

Le grep ne mesure ni le padding réel appliqué à l'exécution (classes conditionnelles, `cn()` avec
plusieurs branches), ni la zone d'activation étendue par un `::before`/`::after` ou un padding
négatif, ni la taille réelle rendue sur les trois largeurs cibles. **La liste ci-dessus est un
point de départ pour l'audit Temps 2, pas une preuve pixel par pixel.** La preuve elle-même (avant/
après par largeur) devra venir d'une mesure DOM réelle (Playwright `getBoundingClientRect` ou
équivalent), conformément à la section Preuve du plan.

### 5.5 Ampleur

Le périmètre restant (hors les 3 écrans déjà à 48px) touche au moins 9 domaines d'écran
(`assistant`, `clients`, `drivers`, `finance`, `orders` hors les 3 déjà faits, `products`, `purchases`,
`settings`, `shops`) et le composant `Button` partagé. Ce n'est pas trivial mais **tient dans une
seule consolidation** si le changement du composant `Button` (44→48) est traité comme le geste
principal, et les 16 fichiers candidats comme un audit ciblé plutôt qu'une réécriture large — voir
§9.

---

## 6. Chiffres alignés — montants et quantités

**Montants** : `Amount` porte déjà `tabular-nums lining-nums` (§3.1). Le problème n'est pas l'absence
de la classe mais sa **duplication manuelle** : `tabular-nums` apparaît en dur, hors de `amount.tsx`,
dans **plus de 100 emplacements** répartis sur `app/(app)/analyses/page.tsx` (23 occurrences à elle
seule), `app/(app)/finances/page.tsx`, `app/(app)/tableau/page.tsx`, `clients-workspace.tsx`,
`dashboard/*` (7 fichiers), `drivers/*` (5 fichiers), `finance/*` (8 fichiers), `kpi/KPICard.tsx`,
`marketing/*` (5 fichiers), `orders/*` (7 fichiers), `products/products-catalog.tsx`,
`purchases/*` (2 fichiers), `settings/*` (2 fichiers), `stock/stock-table.tsx`,
`ui/chart.tsx`, `ui/definition-card.tsx`. Toujours le même schéma : `font-mono ... tabular-nums`
recopié à chaque site plutôt que porté par un composant.

**Quantités — aucune primitive dédiée.** Le grep pour un composant de quantité (`Quantity`,
`formatQuantity`, `formatQty`) ne remonte que `components/orders/new-order-form.tsx` (un usage isolé,
pas un composant partagé). Les quantités (stock physique/disponible dans `driver-stock-table.tsx:245/249`,
`qty`/`Total atterri` dans `purchase-lots-view.tsx:442-446`, scores clients dans
`clients-workspace.tsx:115`) portent chacune leur propre `<span className="font-mono tabular-nums">`
recopié à la main — même défaut que les montants, mais sans même un équivalent d'`Amount` à
généraliser : c'est un composant à créer en Temps 2, pas seulement à réutiliser plus largement.

---

## 7. Vouvoiement

**La règle (docs/lexique-microcopie.md:18)** : vouvoiement obligatoire, sans exception, y compris
états vides et messages d'erreur.

**La garde existante** (`tests/unit/ui/no-tutoiement-finance-components.test.ts`) : liste blanche de
**11 fichiers** (les composants finance/purchases du Lot U1-F + F2/F2-bis), lit chaque fichier source
TSX brut et cherche des marqueurs de tutoiement via une regex à frontières Unicode (`\p{L}\p{N}_` au
lieu de `\b`, pour éviter les faux positifs sur les accents — calibrée à 0 faux positif/négatif sur
ces 11 fichiers). **Elle ne couvre ni `messages/fr.json`, ni aucun fichier hors de cette liste.**

**Violations réelles trouvées, hors du périmètre de la garde actuelle :**

1. **`messages/fr.json` — `assistant.feedback.messagePlaceholder`** (ligne 55) :
   *« Décris le problème ou ta suggestion… »* et **`assistant.feedback.successBody`** (ligne 59) :
   *« Ton retour a bien été enregistré. »* — écran réel, authentifié (page Aide / formulaire de
   feedback, `components/assistant/assistant-view.tsx`), pas de la marchandise marketing. Deux
   violations nettes de la règle « sans exception ».

2. **`messages/fr.json` — namespace `marketing.*`** (~30 chaînes) : tutoiement systématique et
   assumé dans tout le contenu marketing/landing (« Connecte ta boutique Shopify », « tes commandes
   arrivent automatiquement », « Vois où tu perds de l'argent », « Tes données t'appartiennent »,
   « Annule quand tu veux », etc.). `docs/lexique-microcopie.md` ne prévoit **aucune exception
   marketing** à la règle « sans exception » — mais le CSS porte déjà une classe `.landing` dédiée
   (globals.css:203-212) qui traite la marketing comme une surface de registre différent
   (encre/gris réchauffés). **Question de vocabulaire, pas mécanique : est-ce que le landing/marketing
   est dans le périmètre de la règle de vouvoiement, ou un registre délibérément distinct comme il
   l'est déjà visuellement ?** Remontée pour arbitrage en Temps 2 — ne pas trancher unilatéralement
   ici. Si la réponse est « hors périmètre », il faut l'écrire explicitement dans le lexique (la
   règle actuelle ne le dit pas) ; si la réponse est « dans le périmètre », c'est ~30 chaînes à
   réécrire, un chantier de contenu plus que de design system.

Aucune autre violation trouvée en dehors de ces deux poches (le reste de `fr.json` — orders, finance,
settings, onboarding, invitation, etc. — est en vouvoiement correct).

---

## 8. Lexique

**« Données indisponibles »** — déjà documenté comme dette ouverte par TB-P0
(`docs/lexique-microcopie.md:39`) : utilisé sur 8 blocs du Tableau via deux clés i18n distinctes qui
portent la même chaîne verbatim (`messages/fr.json:389` `tableau.dataUnavailable` et `:403`
`tableau.kpi.unavailable`). L'entrée du lexique pose déjà la question à trancher : faut-il distinguer
erreur réseau / erreur serveur / droit insuffisant, ou une formulation générique suffit-elle pour tout
écran futur ? **C'est une décision de vocabulaire, remontée, pas tranchée ici** — telle que l'entrée
du lexique le demande déjà.

**Autre libellé dans le même cas, plus net, non documenté avant ce rapport** — deux variantes d'un
même message générique d'erreur, désynchronisées par la ponctuation :

- *« Une erreur est survenue, réessayez. »* (virgule) — 8 occurrences :
  `invitation.accept.genericError`, `settings.team.errors.generic`, `settings.shops.errors.generic`,
  `clients.errors.list`, `finance.settlements.error`, `finance.settings.error`,
  `finance.expense.error`, `orders.address.errors.generic`.
- *« Une erreur est survenue. Réessayez. »* (point) — 6 occurrences :
  `auth.errors.generic`, `onboarding.errors.generic`, `settings.errors.generic`,
  `settings.security.password.errors.generic`, `settings.security.email.errors.generic`,
  `orders.errors.generic`.

14 clés au total pour ce qui est censé être un seul message générique, déjà fourchu en deux formes
sans qu'aucune n'ait jamais eu d'entrée de lexique — la preuve directe que « un terme employé sans
entrée dérive » (l'avertissement du plan) s'est déjà produit une fois. À statuer : une seule
formulation figée + entrée de lexique, remplaçant les deux variantes.

**Note annexe, hors lexique de registre mais utile pour Temps 2** : les libellés de statut COD
(« Livrée », « En livraison », « Confirmée », « À appeler », « Tentée »…) sont chacun redéfinis dans
5 namespaces i18n séparés (`marketing.mock.*`, `finance.status.*`, `orders.kanban.columns.*`,
`orders.status.*`, `orders.codStatus.*`) plutôt que dérivés d'une seule source. Pas une violation de
registre, mais un risque de drift si un libellé de statut change un jour — hors périmètre de ce lot
(pas une règle métier), signalé pour mémoire.

---

## 9. Ampleur et découpage proposé

**Ce que Temps 1 montre : le lot tient dans une seule consolidation, à condition de séquencer les
commits par mécanisme (déjà prescrit par le plan) et de traiter les cibles tactiles comme un audit
ciblé plutôt qu'une réécriture de tous les écrans.**

Justification par les chiffres réunis ci-dessus :

- **Tokens** : aucune restructuration requise (l'architecture `@theme` non-inline est déjà correcte) —
  travail = renommage/complément mineur + vérif contraste. Petit.
- **Mode sombre** : décision binaire (le construire ou l'écarter) — le plan dit déjà de ne pas le
  construire ici s'il n'existe pas, et il n'existe pas. **Aucun travail de consolidation**, seulement
  consigner la mesure (fait ci-dessus).
- **Cibles tactiles 48px** : 1 changement à haut effet de levier (`Button`, 2 lignes) + un audit
  d'environ 16 fichiers candidats + les champs `min-h-11` de formulaires + le menu « Plus » de la
  barre basse. C'est le plus gros morceau visuel (le plan le dit déjà), mais borné — pas des dizaines
  d'écrans indépendants, un noyau de fichiers identifié.
- **Garde de vouvoiement** : mécanique à construire une fois (scanner `messages/fr.json` en plus des
  fichiers déjà couverts), + 2 corrections de contenu immédiates (`assistant.feedback.*`) + 1
  décision à remonter (marketing).
- **Lexique** : 2 décisions à remonter (« Données indisponibles », doublon erreur générique) — pas de
  code de production à écrire avant arbitrage.
- **Chiffres alignés** : `Amount` existe déjà et n'a pas besoin de changer — le travail est
  d'y migrer les 26 sites qui le contournent, plus créer la primitive Quantité qui n'existe pas
  encore. C'est mécanique (remplacement par site) mais touche beaucoup de fichiers ; peut se faire en
  un commit par domaine (`orders`, `finance`, `drivers`, `dashboard`) si le diff s'avère trop large
  pour un seul commit lisible.
- **Shell/nav** : déjà correct structurellement (5 destinations, `/boutiques` absent) — le travail
  est l'unification du rendu des états communs, pas une refonte.

**Recommandation** : pas de découpage en lots séparés — un seul lot UX-DS-01, commits par mécanisme
comme prescrit, avec deux points d'attention à remonter avant d'écrire du code (vouvoiement marketing,
formulation « Données indisponibles »/erreur générique) et un audit de mesure réelle (Playwright) à
faire avant de fixer la liste finale des correctifs 48px — le grep de ce rapport est un point de
départ, pas la liste finale.

---

## 10. Hors périmètre confirmé

Conforme au plan — non touché par cet inventaire : Produits/Stock/Clients/Boutiques/Paramètres
au-delà de leur rôle de source de vérité pour l'audit (`UX-CAT-01`), les défauts de données
(`U0-D2`), `S5`. Le glassmorphism/scroll-driven/spring n'apparaissent nulle part dans le code
actuel — rien à retirer, juste à consigner comme écarté (fait, ci-dessus dans le plan lui-même).

---

## Arrêt

Fin du Temps 1. Ce rapport est un commit séparé ; aucune ligne de token, de composant ou de garde
n'a été écrite. Attente d'arbitrage avant Temps 2 sur :

1. Vouvoiement marketing — dans le périmètre de la règle « sans exception » ou registre délibérément
   distinct (comme `.landing` le traite déjà visuellement) ?
2. « Données indisponibles » — formulation générique conservée, ou distinction erreur réseau/serveur/
   droit insuffisant ?
3. Doublon « Une erreur est survenue{,|.} {r|R}éessayez. » — laquelle des deux devient la forme
   figée du lexique ?
4. Le commentaire « additif uniquement, ne pas utiliser en Phase 1 Socle » sur les tokens
   `--status-*` (globals.css:40-43) — obsolète maintenant que `StatusBadge` les consomme ? À confirmer
   avant d'y toucher.
