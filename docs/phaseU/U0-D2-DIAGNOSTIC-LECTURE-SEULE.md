# U0-D2 — Diagnostic lecture seule : Finances, Produits, Stock, Livreurs, Clients, Plus

## 1. Verdict

**BLOQUÉ P0** — sur cinq des six domaines, chacun isolé du reste : le cycle de vie legacy d'un
arrivage (Produits/Achats), la Valeur du stock (Stock), les graphiques Vue globale (Finances),
`/boutiques` (Plus/Boutiques) et la fiche client (Clients). Seul le domaine Livreurs ne porte aucun
P0 bloquant et peut nourrir `UX-CAT-01` sans réserve. Le détail par domaine, les preuves et les lots
proposés suivent.

Aucune requête SQL n'a été exécutée pendant ce lot (contrainte de méthode respectée) ; deux points
sont marqués `PREUVE DB INDISPONIBLE` avec une requête candidate agrégée fournie, en attente
d'exécution par le porteur.

## 2. SHA, worktree, commandes, limites

- **SHA initial et final** (lecture seule, aucun commit de code produit pendant l'audit) :
  `c6053d97ca3abe126a5f201b77d8b3af602498e5`, branche `phaseUX-COD-01/tableau-commandes-fiche`.
- **Worktree** : `?? docs/ci/` (untracked, non lié à ce lot, non touché). Aucun autre changement
  local au démarrage.
- **Commandes exécutées** : uniquement `git rev-parse`/`git status`/`git branch`, `Read`/`Grep`/`Glob`
  sur le code source et les migrations. **Aucune commande `pnpm`, aucune migration, aucun accès
  base de données direct.**
- **Méthode d'exécution** : le diagnostic a été mené par six explorations parallèles (une par
  domaine A-F), chacune produisant un rapport intermédiaire fichier:ligne, compilées ici sans
  reformulation des preuves citées.
- **Requêtes soumises au fondateur, en attente d'exécution** (aucune n'a été lancée) :
  1. Domaine C (Stock) — sur-réservation/valeurs négatives réelles :
     ```sql
     select
       count(*) filter (where qty_on_hand < 0)                as neg_on_hand,
       count(*) filter (where qty_reserved > qty_on_hand)      as over_reserved,
       min(qty_on_hand)                                        as min_on_hand,
       min(qty_on_hand - qty_reserved)                         as min_available_unclamped
     from product_stock;
     ```
  2. Domaine D (Livreurs) — volume réel de versements, pour juger de l'exposition au plafond
     `max_rows=1000` de `getAllSettlementHistory` :
     ```sql
     select count(*) as total_settlements
     from cash_settlement
     where merchant_account_id = :tenant_id;
     ```
  3. Domaine F (Plus/Boutiques) — tenants avec 2+ boutiques Shopify actives simultanément (portée
     réelle du P0 `/boutiques`) :
     ```sql
     select merchant_account_id, count(*) as active_shopify_shops
     from shop
     where store_kind = 'shopify' and status = 'active'
     group by merchant_account_id
     having count(*) > 1;
     ```
  4. Domaine F (Plus/Boutiques) — historique des déconnexions Shopify passées, avec le rôle de
     l'acteur au moment de l'action (agrégé, aucune identité individuelle) :
     ```sql
     select al.action, mm.role, count(*) as occurrences
     from audit_log al
     join merchant_member mm
       on mm.user_id = al.actor_user_id
      and mm.merchant_account_id = al.merchant_account_id
     where al.action in ('shopify.disconnected', 'shop_disconnected')
     group by al.action, mm.role;
     ```
- **Limites explicites** :
  - Le domaine A (Finances) n'a pas relu en détail `lib/actions/expenses.ts` (CRUD dépense),
    `app/(app)/finances/error.tsx`, ni la route `GET /api/rapport` — mentionnés mais non audités.
  - Le domaine D n'a pas revérifié `getDriverPerformance` au-delà d'un examen structurel (bornée
    par la fenêtre période, pas par `.range()` explicite — probable, non chiffré).
  - Le domaine F n'a pas lu `app/(app)/layout.tsx` ni le middleware posant `x-teer-store-id` —
    la cohérence de `currentStore` au niveau racine reste **probable**, pas prouvée à ce niveau
    précis (elle est en revanche prouvée dans `getRequestStoreId`).
  - Le domaine E n'a pas relu en détail `0140_close_public_execute_gaps.sql` (seule l'absence de
    redéfinition de `list_store_customer_reliability` y a été vérifiée par grep, pas par lecture
    complète du fichier).
  - Aucune vérification RLS en conditions réelles (pas de requête exécutée) sur aucun domaine — la
    lecture du SQL de policy est la seule preuve partout.

## 3. Inventaire des parcours

| Domaine | Route / entrée | Composants | Requête / action / RPC | Tables ou fonctions | Rôles / RLS | Mutation | Offline réel | Preuve |
|---|---|---|---|---|---|---|---|---|
| Finances | `/s/{id}/finances` (owner only, écran restreint sinon) | `app/(app)/finances/page.tsx`, `ProfitSection`, `FinanceProductCostView`, `FinanceDriverCostView`, `DriverSettlementsPanel`, `FinanceCharts`, `ArrivagesTabContent` | `getFinanceReportAction`/`fetchFinanceReport` (paginé), `getFinanceProductCostReportAction` (paginé), `getFinanceDriverCostReportAction` (paginé), `getFinanceChartsAction` (**non paginé, P0** — voir §8), `getPurchaseLotPageData`/`getPurchaseLotProfitability` (lecture seule) | RPC `get_finance_collected_joins`/`get_finance_returned_joins` (0087, jsonb), `finance_kpis` (0119), `get_purchase_lot_profitability` (0146), `get_driver_cash_consolidation`/`cash_aging` (0083-0085) | `requireRole('owner')` sur toute la page ; `updateProductUnitCostAction` `owner/manager` correctement scopé | `updateProductUnitCostAction` (unit_cost), `ExpenseSection` CRUD (non auditée en détail), `DriverSettlementsPanel` (versement/écart — cash, hors périmètre approfondi de ce lot) | Non testé | `lib/actions/profit.ts:62-90`, `lib/finance/report-data.ts:52-84` |
| Produits (catalogue/stock) | `/s/{id}/produits?tab=catalogue\|stock` | `ProductsPageLoader`, `ProductsCatalog`, `StockTable`, `ProductDetailPanel` | `getProductsPageData`/`loadMoreProductsAction` (paginé 25/page) | `product`, `product_stock` (lecture via client admin, scoping manuel TS) | `owner/manager/agent` ; coûts masqués pour `agent` (applicatif) | `updateProductUnitCostAction`, `createProductAction`, `saveBundleConfigurationAction`, `purchaseInAction`/`manualAdjustmentAction`/`courierReturnAction`/`setLowStockThresholdAction` (`owner/manager`) ; « Valeur totale du stock » (**P0** — voir §8) | Non testé | `lib/actions/products.ts:154-248`, `lib/actions/stock.ts:132-268` |
| Achats fournisseur (arrivages) | `/s/{id}/produits?tab=achats` (owner only, lien non rendu sinon) | `PurchaseLotsView`, `LotCard`, `CreateLotForm`, `TransportCorrector`, `PurchaseLotDetailPanel`, `ProductAdSpendForm` | `getPurchaseLotPageData`/`getProductCatalogPageData` (**non paginés**, latent), `getPurchaseLotProfitability` (jsonb, borné à un lot) | `purchase_lot`, `purchase_lot_line`, `product_ad_spend` | `owner` uniquement (onglet + toutes les actions) | `createPurchaseLotAction` (**P0** — garde boutique absente sur 5 des 6 mutations du cycle de vie legacy : `updatePurchaseLotAction`, `addPurchaseLotLineAction`, `removePurchaseLotLineAction`, `markLotInTransitAction`, `receiveLotAction` — voir §8), `correctPurchaseLotTransportAction` (RPC auditée `correct_purchase_lot_cost`, correctement gardée), `setPurchaseLotAllocationMethodAction`, `setPurchaseLotLineWeightAction`, `createProductAdSpendAction` | Poids/méthode via `useQueuedAction` (file offline) | `lib/actions/purchases.ts:75-820` |
| Livreurs — liste + stock détenu | `/s/{id}/livreurs` (owner/manager ; agent → écran refusé) | `DriversWorkspace`, `DriverStockTable`, `SettlementHistoryTable` | `getDriverStockOnHand`/`getDriverAvailableStock` (paginés via `fetchAllPostgrestRows`), `getAllSettlementHistory` (**non paginé**) | `stock_movement` (ledger, dérivation TS), `cash_settlement`, `driver_shop` | `owner/manager` | `setDriverStockAction` (owner/manager, double garde parent produit+livreur, idempotente) | Non testé | `lib/drivers/stock-on-hand.ts:65-151`, `lib/actions/drivers.ts:54-609` |
| Clients | `/s/{id}/clients` | `ClientsWorkspace`, `CustomerSheet` (drawer maison) | `listCustomersAction` (paginé RPC, mais **jamais consommé côté UI** — P0), `getCustomerAction` (RPC + `orders` `.limit(30)` + `customer` adresse) | RPC `list_store_customer_reliability`/`get_store_customer_reliability` (0132), `customer_reliability_projection`, `customer_reliability_scored` | `owner/manager/agent`, RLS `customer_select` + `is_shop_member_of` | Aucune mutation métier réelle (bouton « Demander confirmation » inerte — P0) | Non testé | `components/clients/clients-workspace.tsx`, `lib/actions/customers.ts` |
| Plus / Boutiques / Paramètres | `/s/{id}/boutiques` (**P0**), `/s/{id}/parametres` (5 onglets), `/s` (sélecteur), nav (`sidebar.tsx`, `bottom-tab-nav.tsx`) | `StoreSwitcher`, `SettingsProfile` (`profile/team/shops/security/billing`), `StoreChooser` | `getShopConnection()` **sans `shopId`** (P0), `listShopsAction`/`syncShopAction`/`disconnectShopAction` (scopés, `lib/actions/shops.ts`) | `shop`, `merchant_member` | `owner/manager` selon action ; `disconnectShopAction` legacy sans `requireRole` explicite | `disconnectShopAction` (2 implémentations divergentes — voir P0), équipe (`lib/actions/team.ts`), compte (`lib/actions/account.ts`) | Non testé | `app/(app)/boutiques/page.tsx:58`, `lib/actions/shopify.ts:21-91`, `lib/actions/shops.ts:151-186` |

## 4. Audit des métriques Finances et Livreurs

### Finances

| Écran / métrique | Libellé affiché | Nature prouvée | Formule / source | Portée temporelle | Portée visible sans interaction | `0` signifie | Écart | Décision proposée |
|---|---|---|---|---|---|---|---|---|
| Global — carte CA | « Chiffre d'affaires » | Flux (CA net période) | `netCAMinor = caMinor − deliveryFeesMinor − returnContraRevenueMinor` (`lib/finance/profit.ts:250`) ; repli SQL `finance_kpis.ca_livre` (`0119:144-147`) si l'action échoue | `cash_collected_at ∈ [from,to]` | Oui | Zéro commande encaissée (réel) | Repli non signalé à l'écran (pas de bannière « mode dégradé »), formules TS/SQL non strictement identiques | Signaler visuellement le repli plutôt que de le laisser silencieux |
| Global — carte Cash chez livreurs | « Cash chez les livreurs (toutes boutiques) » | Solde de trésorerie | `finance_kpis.cash_chez_livreurs` (`0119:154-165`) | Snapshot, **cross-boutiques** (pas de filtre `p_shop_id`) | Oui | Aucun cash en attente (réel) | Disclosed honnêtement via le libellé (`isShopFiltered`) | RAS |
| Global — carte Marge brute | « Marge brute » / « Marge brute estimée » | Rentabilité | `grossMarginMinor = netCAMinor − netCogsMinor` (`profit.ts:286`) ; repli `estimatedMarginMinor` **sans COGS** (`lib/finance/fees.ts:98-113`) | Période | Non — `DefinitionCard` (tap) | Masquée si coverage incomplète, jamais un 0 silencieux | Le repli garde le même mot « Marge » pour une formule structurellement différente (sans COGS) | Nommer explicitement l'absence de COGS dans le libellé du repli |
| Global — carte Résultat net | « Résultat net » | Rentabilité | `netProfitMinor = grossMarginMinor − expensesMinor − mobileMoneyFeesMinor` (`profit.ts:292`) | Période | Non — `DefinitionCard` | Masqué si coverage incomplète | — | RAS |
| Global — carte RTO | « Taux de refus / RTO » | Nature indéterminée (ratio) | SQL `finance_kpis.taux_refus`, fenêtré sur `created_at` — **seule métrique de la rangée sur cette base temporelle** (`0119:133-142`) | `created_at ∈ [from,to]` (≠ des autres cartes) | Non — `DefinitionCard` | `0` réel ou `decided=0` — ambigu, pas distingué visuellement | Base temporelle différente non signalée | Documenter ou aligner sur `cash_collected_at` |
| Compte de résultat simplifié | CA encaissé / Frais livraison / Retours / COGS / Marge brute / Charges / Résultat net | Rentabilité (P&L complet) | `computeFinanceReport` (`profit.ts:227-317`), sourcé RPC 0087 | `cash_collected_at`/`returned_at`, période | Montants oui ; badges qualité en `title=` (survol seul) | Ligne masquée (pas 0) si montant nul par garde `&&>0` — 0 réel et absence indissociables pour ces lignes | Badge « Marge réelle/estimée » non tap-friendly | Remplacer `title=` par `DefinitionCard`/`DefinitionToggle` déjà utilisé ailleurs sur le même écran |
| Vue produit — coûts | « Coût total (tout compris) » / « Bénéfice après pub et livraison » | Rentabilité (pilotage) | `computeFinanceProductCostReport` (`product-cost.ts:297-502`), CUMP + pub/livraison alloués période | Période | Non — `DefinitionCard` | `costMissing=true` → badge « Coût manquant », jamais 0 | Diffère volontairement de la marge globale, annoncé par bandeau permanent | RAS |
| Vue produit — colonne Publicité | « Publicité » (détail dépliable) | Rentabilité | Lit `expense`/ADS uniquement, **jamais `product_ad_spend`** (`product-cost.ts:363-365`) | Période | Derrière « Détails » | 0 si toute la pub a été saisie par arrivage après bascule | Un marchand basculé sur la saisie par arrivage voit cette colonne retomber à 0 sans explication de la source | Lire aussi `product_ad_spend` fenêtré, ou annoter la colonne |
| Vue livreur | « Coût des marchandises livrées » / « COGS unitaire moyen » | Rentabilité (informatif) | `computeFinanceDriverCostReport` (`driver-cost.ts:77-138`) | Période | Oui | 0 si aucun mouvement `sold` costé — pas de distinction 0 réel/absent (contrairement à la Vue produit) | — | Aligner sur le pattern `costMissing` de la Vue produit |
| Versements — à remettre | « À remettre » | Solde de trésorerie | RPC `get_driver_cash_consolidation` (0083), cross-boutiques | Snapshot | Oui | Livreur absent de la liste si `≤0` — pas un 0 affiché | — | RAS |
| Graphe CA encaissé/jour, CA/boutique | `charts.revenue`/`charts.shops` | Flux | `bucketRevenueByDay`/`aggregateShopRevenue` sur `.select()` **non paginé** (`lib/actions/profit.ts:62-67`) | Période | Oui (chart) | Barre à 0 = réel, **sauf au-delà de 1000 lignes, où le défaut est certain** | **P0** : défaut certain au-delà de `max_rows=1000` (aucune pagination, seul call-site non paginé du domaine) — ce qui n'est pas mesuré, c'est l'exposition réelle en production (volume de commandes par fenêtre/tenant), pas l'existence du mécanisme | Paginer (`fetchAllPages`) ou RPC `jsonb` comme le reste du domaine |
| Graphe Entonnoir COD | `charts.funnel` | Nature indéterminée (comptage) | `aggregateFunnel` sur `.select()` non paginé, fenêtré `created_at` (≠ base des 3 autres graphes) | `created_at` | Oui (chart) | Idem | Même défaut + base temporelle différente non signalée | Idem |
| Graphe Cash-aging par livreur | `charts.aging` | Solde (répartition ancienneté) | RPC `cash_aging` (0083-0085) | Snapshot | Oui, mais 3 buckets distingués **uniquement par couleur**, aucune légende visible | Barre absente si aucun cash en attente | Accessibilité couleur seule | Ajouter légende texte visible en permanence |
| Onglet Arrivages | Marge (GainLoss) / % marge par lot | Rentabilité (coût de revient par arrivage) | `assemblePurchaseLotProfitability` sur RPC `get_purchase_lot_profitability` (0146, jsonb) | Aucune (PeriodPicker masqué sur cet onglet) | Oui | `marginPctMissing` → `—`, jamais 0 % | Marge diffère encore des deux autres — annoncé explicitement (`natureArrivages`) | RAS |

### Livreurs

| Écran / métrique | Libellé affiché | Nature prouvée | Formule / source | Portée temporelle | Portée visible sans interaction | `0` signifie | Écart | Décision proposée |
|---|---|---|---|---|---|---|---|---|
| Fiche livreur — Physique en main | « Physique » | Solde (quantité) | `deriveDriverStockOnHand` — somme du ledger `stock_movement` sur les types « en main » (`lib/drivers/stock-on-hand.ts:65-84`) ; **filtré `>0` avant retour** (`lib/actions/drivers.ts:300-302`) | Cumul depuis l'origine (ledger) | Oui | Absence de ligne = 0 implicite (jamais affiché comme négatif — bloqué en écriture) | — | RAS — conforme au principe retenu pour le stock marchand |
| Fiche livreur — Disponible | « Disponible » | Solde (quantité, peut être négatif par conception) | `deriveDriverAvailableStock` = en main − engagements commande (`stock-on-hand.ts:132-151`) | Cumul depuis l'origine | Oui, `font-mono` neutre, **aucune alerte visuelle même si négatif** | Sur-engagement documenté explicitement (commentaire `stock-on-hand.ts:154-156`) | N'alimente aucune action d'écriture (`SetStockForm` s'initialise sur le physique) | RAS — pas de P0, conforme au principe retenu, mais rien ne signale visuellement l'anomalie sous-jacente |
| Versements globaux | Tableau « Versements globaux » | Écart-rapprochement / historique de flux | `getAllSettlementHistory`/`buildSettlementHistory` (`lib/actions/drivers.ts:567-609`), `.select()` **non paginé** sur `cash_settlement` | Non bornée (`order by settled_at desc`, pas de `.limit()`) | Oui | Absence de ligne = aucun versement | **Risque de troncature silencieuse** au-delà de ~1000 versements cumulés — **PREUVE DB INDISPONIBLE**, requête candidate en §2 | Paginer ou agréger côté SQL |

## 5. Audit Produits, Arrivages, Stock

**Formules stock** (`lib/actions/products.ts:212-238`, dupliquées `:435-461` et dans le code mort `lib/actions/stock.ts:338-359`, jamais appelé) :
- **Physique** (`qtyOnHand`) = `product_stock.qty_on_hand ?? 0`.
- **Engagée** (libellée « Commandé » à l'écran, ce qui ne correspond pas littéralement — c'est une quantité réservée, pas une quantité commandée au sens client) = `product_stock.qty_reserved ?? 0`.
- **Disponible** = `Math.max(0, qtyOnHand − qtyReserved)` — **plancher explicite à 0**, jamais négatif pour un produit normal.
- **Seuil bas** = `low_stock_threshold ?? 10` (défaut codé en dur).
- **Valeur** = `qtyOnHand × (product_stock.unit_cost ?? 0)` si `canSeeCost` (owner/manager), sinon `null`.

**Mécanisme des disponibilités négatives** : pour un produit normal, impossible (plancher à 0). Pour
un **bundle**, `computeBundleDerivedAvailability` (`lib/products/bundle-availability.ts:31-52`)
calcule `available = qtyOnHand − qtyReserved` **sans plancher** par composant, puis
`Math.floor(available/quantity)` — un composant en déficit produit une valeur négative
(`floor(-1/2) = -1`), **très probablement la source des −1/−31/−42/−5 observés par le passé**.
Rendu sans aucune alerte visuelle (texte neutre, identique à une valeur saine), mais **aucune
action de mutation stock n'est proposée sur une ligne bundle** dans ce tableau — donc, selon la
règle de classement de la mission, **pas de P0** (le négatif n'est ni présenté comme disponible
ni actionnable), seulement un défaut d'affichage à corriger (couleur/alerte manquante).

**« Valeur totale du stock » — P0, pas un défaut d'affichage.** Deux mécanismes cumulés produisent
un chiffre faux, pas seulement mal présenté :
1. `unit_cost ?? 0` alimente directement l'agrégat — un coût jamais saisi (0 par convention projet)
   et un coût réellement nul produisent exactement le même montant affiché. C'est une violation
   directe du contrat « manquant ≠ zéro » du CLAUDE.md — le même contrat qui a justifié le lot
   `TB-P0` en entier sur le Tableau. Aucun indicateur « coût inconnu » trouvé sur cet écran.
2. **Bug d'agrégat client prouvé** : `totalValue`/`lowStockCount` sont recalculés côté React sur
   les seules lignes déjà chargées (25/page, pagination « Voir plus »), jamais sur un agrégat SQL
   complet — le total affiché **sous-évalue déjà la réalité dès qu'un catalogue dépasse 25 produits
   actifs**, avant même de toucher le plafond `max_rows=1000`.

Un marchand avec >25 produits actifs et au moins un coût jamais saisi voit un nombre qui n'est ni
une estimation prudente ni un vrai zéro : c'est un chiffre faux, affiché avec la même confiance
visuelle qu'un total exact.

**Alerte « N produits en stock bas »** : `<div>` statique, **aucun lien/filtre**, n'ouvre rien.

**Composant du tableau mobile** : `components/stock/stock-table.tsx:351`, `overflow-x-auto` simple,
**aucune classe `sticky`** sur aucune colonne — la colonne « Produit » défile avec le reste,
confirmant exactement le problème central signalé par la mission. Colonnes : Produit · En stock ·
Commandé · Disponible · Seuil alerte · Valeur (conditionnelle) · Actions. Aucune variante
carte/liste mobile.

**Chemin de saisie d'un arrivage** : atteignable en 2 clics depuis `/produits` (owner uniquement),
formulaire à une seule vue, création de produit à la volée possible sans quitter le formulaire.
**Complet pour le cas nominal** (créer → transit → recevoir). Deux dettes réelles : (1)
`updatePurchaseLotAction` existe côté serveur mais **n'a aucun appelant UI** — les champs de base
(fournisseur/référence/date/délai) sont impossibles à éditer une fois le lot créé, hors transport ;
(2) une ligne à `qty=0`/`prix=0` est acceptée silencieusement par le schéma zod, sans avertissement.

**Poids et méthode de répartition restreints au statut `reçu`** : **garde de fait, pas une garde
SQL/action explicite** — `setPurchaseLotAllocationMethodAction`/`setPurchaseLotLineWeightAction`
ne vérifient ni l'une ni l'autre `lot.status` ; la restriction vient uniquement du fait que le seul
panneau qui expose ces contrôles (`PurchaseLotDetailPanel`) n'est monté que pour les lots reçus
(pour une autre raison : la rentabilité n'a de sens qu'après réception). Rien dans le code ne
prouve que c'est un choix délibéré pour ce point précis plutôt qu'un effet de bord de composition
UI — à trancher par le porteur.

**Incohérence monétaire réelle et localisée** : `components/products/products-catalog.tsx:276,348`
affichent littéralement **« XOF »** (code ISO, via une fonction de formatage locale
`formatMinorAmount`) alors que tout le reste de l'application affiche systématiquement « F CFA »
via `formatMoney`. Seule occurrence de ce type trouvée dans tout le domaine Produits/Achats.

**Sémantique des zéros/tirets** (stock) :

| Contexte | Rendu | Sens |
|---|---|---|
| Ligne bundle, colonnes En stock/Commandé/Seuil/Valeur | `—` | Non applicable — texte explicite « géré via ses composants » |
| Ligne bundle, colonne Disponible | `—` (si `null`) | Bundle sans composant configuré — sémantique **différente** des `—` voisins de la même ligne |
| Colonne Valeur, rôle `agent` | Colonne absente | Non applicable pour ce rôle (masquage applicatif conforme RLS #9) |
| `qtyOnHand`/`qtyReserved`/`qtyAvailable` | Toujours un nombre | `0` réel et « produit jamais mouvementé » rendent identiquement — pas de distinction |

## 6. Clients

**Un score de fiabilité (0-100) EST affiché**, en fiche client (`ScoreValue`, chiffre brut) et en
liste (palier seul). Chaîne de calcul intégralement tracée et prouvée : projection invariante
`customer_reliability_projection` (migration `0132`) + décroissance temporelle appliquée en lecture
via un InitPlan scalaire non corrélé + vue `customer_reliability_scored` + RPC
`list_store_customer_reliability`/`get_store_customer_reliability`. **Le bug historique
« LIMIT après scoring »** (0128/0049, timeout 503 sur gros compte) **est corrigé et confirmé
toujours corrigé** dans le code actuel. `lib/customers/reliability.ts` (formule TS identique) n'est
jamais exécuté en production — utilisé uniquement par son test unitaire, c'est un miroir de
spécification, pas la source de vérité (qui est la vue SQL).

**Ce que le marchand comprend** : palier, conseil contextuel actionnable par palier, et trois
signaux qualitatifs explicites (« Confirme mais refuse souvent », « Difficile à joindre », « Annule
souvent »). **Ce qu'il ne voit jamais** : la méthodologie (décroissance 180 jours, pondération 70 %
livraison/30 % confirmation, seuils 75/50), ni les deux sous-scores (`delivery_score`/
`confirm_score`) qui existent pourtant dans la RPC et sont mappés côté TS mais jamais rendus dans le
JSX. Le score reste, pour sa partie chiffrée, un nombre dont le raisonnement interne est opaque —
seul le verdict qualitatif est expliqué. Décision produit à trancher dans `UX-CAT-01`, pas un bug en
soi.

**Faits vérifiables disponibles vs affichés** : `order_count`, `refused_count`, `cancelled_count`,
`delivered_lifetime` (montant) sont tous affichés. **`delivered_count` (le nombre, pas le montant)
n'est jamais affiché** — un marchand doit le déduire par calcul mental. **La date de dernière
commande n'existe nulle part** : ni dans la RPC, ni à l'écran ; le seul proxy possible (premier
élément de l'historique) est trié par `created_at_shopify` seul, qui place systématiquement les
commandes créées par appel téléphonique après toutes les commandes Shopify indépendamment de leur
date réelle (bug de tri, voir §8).

## 7. Matrice mutations / réseau / permissions

| Mutation | Objet | Risque perte/doublon | Protection observée | État UI persistant | Écart | Priorité |
|---|---|---|---|---|---|---|
| Bouton « Demander confirmation » (fiche client, tier watch) | UX/action attendue | Aucun appel réseau — ne fait rien | Aucune (ni `onClick`, ni `disabled`, ni `title`) | — | Affordance trompeuse : contraste avec les 2 boutons voisins (`risk`), correctement `disabled`+`title` « Disponible bientôt » | **P0** — action inaccessible sur une action centrale du parcours COD |
| `selectCustomer` (ouverture fiche client) | Sélection client affiché | Race condition réseau : réponse obsolète peut écraser une sélection plus récente | Aucune (pas de garde `customerId`, pas d'`AbortController`) | La fiche affichée peut appartenir au mauvais client | Donnée trompeuse dans un flux où la fiche sert à décider d'expédier en confiance ou d'exiger un acompte | **P0** |
| Liste clients (`listCustomersAction`) | Population de clients visible | Troncature silencieuse — capacité de pagination existante côté serveur (RPC + Zod jusqu'à 100), **jamais consommée par l'UI** | Aucune (pas de `limit`/`offset` envoyés, pas d'indicateur « 50 sur X ») | Client au-delà du 50e invisible en permanence | Capacité serveur vs usage client | **P0** |
| Historique de commandes en fiche client | Liste de commandes | `.limit(30)` sans indicateur de troncature ; tri `created_at_shopify` place les commandes par appel après toutes les commandes Shopify indépendamment de la date réelle | Aucune | Contradiction visible avec le compteur `orderCount` juste en dessous | Tri incorrect sur comptes mixtes Shopify+appel | **P0** |
| `disconnectShopAction` legacy (`/boutiques`) | Connexion Shopify | Déconnecte la boutique Shopify **la plus ancienne** du compte, pas celle de l'URL/écran | Filtre uniquement `merchant_account_id`+`status='active'`, aucun `shopId` | UI affiche une boutique, l'action en modifie potentiellement une autre | Régression vs la version correcte de `/parametres` → Shops (scopée `shopId` explicite) | **P0** |
| « Valeur totale du stock » (Produits/Stock) | Agrégat de valeur d'inventaire | Chiffre faux, pas une troncature — deux mécanismes cumulés (coût manquant = 0 ; agrégat calculé sur 25 lignes chargées, pas le catalogue entier) | Aucune — pas d'indicateur « coût inconnu », pas d'agrégat SQL | Affiché avec la même confiance visuelle qu'un total exact | Violation directe du contrat « manquant ≠ zéro » (même contrat que `TB-P0`) ; sous-évaluation dès 26 produits actifs | **P0** |
| `getFinanceChartsAction` (3 graphes Vue globale) | CA/jour, CA/boutique, Entonnoir COD | Troncature silencieuse au-delà de `max_rows=1000` — défaut certain, pas hypothétique | Aucune — seul call-site non paginé du domaine Finances | Totaux affichés potentiellement inférieurs au réel, sans erreur | Seul écart de pagination dans un domaine par ailleurs entièrement corrigé (Lot 5/0087) ; le doute porte sur le volume réel en production, pas sur l'existence du défaut | **P0** |
| `getAllSettlementHistory` (Versements globaux) | Historique cash | Troncature silencieuse possible au-delà de ~1000 versements | Aucune — `.select()` sans `.range()` | — | **PREUVE DB INDISPONIBLE** | P1 (probable, non confirmé) |
| `setDriverStockAction` | Stock détenu par livreur | Faible — idempotent par `clientRequestId` (UUID par clic) | Rôle `owner/manager` + double garde parent (produit+livreur confrontés à la boutique active) + garde métier chiffrée (jamais de blocage physique négatif) | `revalidatePath` serveur, pas de `router.refresh()` seul | — | RAS |
| `purchaseInAction`/`manualAdjustmentAction`/`courierReturnAction` (stock marchand) | Mouvements de stock | Idempotence par clé incluant `Date.now()` côté client — **ne protège pas un retry après échec réseau** (deux clés distinctes) | `disabled` pendant exécution protège le double-clic simple, pas le retry réseau | `revalidatePath` | Dette, pas un incident prouvé | P1 |
| `updatePurchaseLotAction`/`addPurchaseLotLineAction`/`removePurchaseLotLineAction`/`markLotInTransitAction`/`receiveLotAction` (cycle de vie legacy d'un arrivage) | Lot d'achat (dont mouvements de stock réels pour `receiveLotAction`) | **Élevé** — le lot est chargé par `id`+`merchant_account_id` seulement, jamais confronté à `shop_id` ; écriture en service-role (RLS bypassée) ; RPC `receive_purchase_lot` (0138) ne vérifie que `merchant_account_id` | **Aucune garde boutique** (`lib/actions/purchases.ts:146-328`) — seul le rôle *compte* est vérifié, jamais le rôle *boutique* | `revalidatePath` | Motif identique à l'incident 0134/0135 (identifiant client jamais confronté au parent autoritatif) ; contraste avec `correctPurchaseLotTransportAction`/`createPurchaseLotAction`, correctement gardées (`shopId` confronté en TS et en RPC) | **P0** |
| `createPurchaseLotAction`/`correctPurchaseLotTransportAction` (arrivages) | Lot d'achat | Aucun défaut trouvé | Rôle `owner`, `shopId` confronté au parent autoritatif avant écriture (TS **et** RPC pour la correction, 0147) | — | — | RAS |
| `is_driver_in_shop` (assignation/réassignation livreur) | Éligibilité livreur↔commande | Aucun — vérifié aux deux niveaux (SQL 0139 + TS) sur `order.shop_id`, jamais la boutique active de session | Garde SQL + garde TS applicative redondante | — | — | RAS |

## 8. Défauts prouvés

### P0 (bloquant)

0. **[Produits/Achats] Garde boutique absente sur 5 des 6 mutations du cycle de vie legacy d'un
   arrivage.** `updatePurchaseLotAction`, `addPurchaseLotLineAction`, `removePurchaseLotLineAction`,
   `markLotInTransitAction` et `receiveLotAction` (`lib/actions/purchases.ts:146-328`) chargent
   toutes le lot par `id`+`merchant_account_id` **seulement** — aucune ne confronte le lot à la
   boutique active de l'appelant (`shop_id`), contrairement à `correctPurchaseLotTransportAction`
   (0147, corrigée) et `createPurchaseLotAction` (gardée dès sa création). Toutes écrivent via
   `createSupabaseAdminClient()` (service-role, RLS bypassée) — le seul filtre réellement actif est
   le rôle *compte*, jamais le rôle *boutique*. `receiveLotAction` est la plus grave : elle poste de
   vrais mouvements de stock via la RPC `receive_purchase_lot` (0138), qui elle-même ne vérifie que
   `merchant_account_id`, jamais `shop_id`/`current_shop_role`. Motif identique à l'incident
   0134/0135 documenté dans CLAUDE.md : un identifiant reçu du client (`lotId`) jamais confronté au
   parent autoritatif boutique. `prouvé` sur l'absence de garde dans le code, `probable` sur
   l'exploitabilité exacte en production (aucune vérification runtime possible en lecture seule).

1. **`/boutiques` ignore l'identifiant de boutique de l'URL, en lecture comme en écriture, et
   `disconnectShopAction` legacy n'a aucun contrôle de rôle.**
   `app/(app)/boutiques/page.tsx:58` appelle `getShopConnection()` sans `shopId` ; sans paramètre,
   la fonction retourne la boutique Shopify **la plus ancienne** du compte (`lib/actions/shopify.ts:29-42`,
   commentaire du code lui-même). `disconnectShopAction` (`lib/actions/shopify.ts:51-93`) filtre
   uniquement `merchant_account_id`+`status='active'`, sans filtre boutique — le bouton
   « Déconnecter » peut couper la synchronisation Shopify d'une boutique **différente** de celle
   affichée à l'écran/URL. **De plus, `disconnectShopAction` est bâtie sur `authActionClient` seul
   (`lib/actions/shopify.ts:51`), sans aucun `requireRole`** — vérifié par lecture directe du
   fichier : aucun rôle n'est exigé pour appeler cette action destructive, contrairement à l'item de
   nav `/boutiques` lui-même (visible par tous les rôles) et à l'équivalent moderne
   (`disconnectShopAction` de `lib/actions/shops.ts:151`, `requireRole('owner')`). Un `agent` peut
   donc désinstaller la connexion Shopify du marchand. Une version correcte coexiste dans
   `/parametres` → onglet « Shops » (`lib/actions/shops.ts:151-186`, `shopId` explicite exigé et
   rôle vérifié) — preuve qu'il s'agit d'une régression, pas d'un choix. Non mesuré en base : nombre
   réel de marchands multi-boutiques Shopify actifs, et si l'action a déjà été appelée par un rôle
   non-owner (requêtes candidates en §2).
2. **Bouton « Demander confirmation » (fiche client, tier watch) totalement inerte.**
   `components/clients/clients-workspace.tsx:304-308` — aucun `onClick`, aucun `disabled`, aucun
   `title`, contrairement à ses deux voisins (`risk`) correctement traités comme non-implémentés.
3. **Liste clients plafonnée à 50 résultats, sans pagination, sans indicateur.**
   `clients-workspace.tsx:563-569` n'envoie jamais `limit`/`offset` alors que la RPC et le schéma
   d'action supportent jusqu'à 100 avec offset — capacité serveur non consommée côté UI. Troncature
   silencieuse au-delà de 50 clients.
4. **Race condition sur la sélection de fiche client.** `clients-workspace.tsx:571-586`, pas de
   garde sur `customerId` ni d'`AbortController` — une réponse réseau tardive peut afficher les
   données d'un client différent de celui actuellement sélectionné à l'écran.
5. **Historique de commandes en fiche client tronqué à 30 sans indicateur, et trié
   incorrectement pour les commandes non-Shopify.** `lib/actions/customers.ts:201-210` — tri
   `created_at_shopify` seul, `nullsFirst:false`, place systématiquement les commandes créées par
   appel après toutes les commandes Shopify indépendamment de leur date réelle. Contradiction
   visible avec le compteur `orderCount` affiché juste en dessous.
6. **[Produits/Stock] « Valeur totale du stock » — chiffre faux, pas un défaut d'affichage.**
   `unit_cost ?? 0` présente un coût jamais saisi comme un coût réellement nul (violation directe du
   contrat « manquant ≠ zéro » du CLAUDE.md, le même qui a justifié le lot `TB-P0` en entier) —
   aucun indicateur « coût inconnu » sur cet écran. En plus de cela, l'agrégat lui-même est calculé
   côté client sur les seules 25 premières lignes chargées (pagination « Voir plus »), donc
   **sous-évalué dès qu'un catalogue dépasse 25 produits actifs**, indépendamment du problème de
   coût manquant. Les deux mécanismes se cumulent : ce n'est ni une estimation prudente ni un vrai
   zéro, c'est un total faux affiché avec la même confiance visuelle qu'un total exact.

7. **[Finances] `getFinanceChartsAction` (`lib/actions/profit.ts:62-90`) — défaut certain au-delà de
   1000 lignes, exposition en production non mesurée.** Deux `.select()` fenêtrés sans `.range()`,
   seul call-site non paginé de tout le domaine Finances (le reste a été corrigé au Lot 5/0087). Le
   mécanisme de troncature `max_rows=1000` de PostgREST n'est pas hypothétique — il s'applique
   nécessairement à toute réponse dépassant 1000 lignes ; ce qui n'est **pas** mesuré ici, c'est le
   volume réel de commandes par fenêtre/tenant en production, donc la fréquence à laquelle ce défaut
   se déclenche concrètement — pas l'existence du défaut lui-même.

### P1

- Bouton « Voir commandes » (fiche/ligne client) jamais filtré par client, malgré l'intitulé —
  atterrit sur la liste globale des commandes de la boutique.
- Erreurs réseau de la liste clients non différenciées malgré 4 `errorCode` distincts renvoyés par
  le serveur (rate-limit confondu avec panne serveur).
- Sous-scores du score client (`delivery_score`/`confirm_score`) calculés et transmis, jamais
  rendus dans la fiche.
- Pas d'`AbortController` sur la recherche clients (seulement un debounce) — une réponse à une
  requête antérieure peut écraser une liste plus récente.
- `getAllSettlementHistory` (Versements globaux, Livreurs) non paginée — **PREUVE DB INDISPONIBLE**.
- Idempotence des mutations de stock marchand basée sur `Date.now()` côté client — ne protège pas
  un retry après échec réseau (dette, pas d'incident prouvé).
- Colonne « Publicité » de la Vue produit Finances ne lit que le registre `expense`/ADS legacy,
  jamais `product_ad_spend` — retombe à 0 sans explication pour un marchand basculé sur la saisie
  par arrivage.
- Badges de qualité de marge (Finances, `ProfitSection`) expliqués en `title=` (survol souris
  seul), incohérent avec le pattern `DefinitionCard` (tap) utilisé partout ailleurs sur le même
  écran.
- Graphe « Cash-aging par livreur » distingue ses 3 buckets uniquement par couleur, sans légende
  visible.
- `SettlementHistoryTable` (Versements globaux, Livreurs) sans aucune variante responsive
  (contrairement aux deux autres tableaux de la même page) — seule la colonne « Date » reste
  identifiable au scroll mobile.
- `updatePurchaseLotAction` sans appelant UI — édition des champs de base d'un arrivage impossible
  une fois créé, hors transport.
- Ligne d'arrivage à `qty=0`/`prix=0` acceptée silencieusement (Zod n'interdit pas 0).
- Incohérence monétaire réelle : « XOF » (code ISO) affiché à 2 endroits (`products-catalog.tsx:276,348`)
  contre « F CFA » partout ailleurs.
- Poids/méthode de répartition d'un arrivage restreints au statut `reçu` sans garde SQL/action
  explicite — effet de bord de composition UI, pas une garde documentée pour ce point précis.
- « Coût/u atterri » (carte liste arrivage, figé à la réception, toujours au prorata valeur) peut
  diverger du « Coût de revient rendu » (fiche arrivage, recalculé selon la méthode active) si la
  méthode de répartition est changée après réception — architecturalement assumé pour le calcul de
  marge, mais jamais signalé à l'écran pour la carte liste.

### P2

- Étiquette de colonne « Commandé » (Stock) rend en réalité `qty_reserved` (réservé), pas une
  quantité commandée au sens client — écart de libellé.
- Alerte « N produits en stock bas » : `<div>` statique non cliquable, n'ouvre pas la population
  qu'elle désigne.
- `getStockPageData` (`lib/actions/stock.ts:289-362`) est du code mort, dupliquant la logique de
  `getProductsPageData` — risque de divergence future.
- Champ `readOnly` (rôle agent) renvoyé par les deux actions Clients, jamais consommé côté UI —
  mort aujourd'hui, deviendra un piège si une vraie mutation y est un jour branchée sans le relire.
- Clé de traduction `clients.contact.tags` orpheline (jamais rendue).
- Incohérence a11y : `isProvisional` communiqué en `title` HTML sur la ligne de liste client
  (peu fiable au clavier/tactile), en texte visible en fiche.
- `CustomerSheet` (drawer maison) sans piège de focus natif ni fermeture `Échap`.
- État d'onglet de `/parametres` non porté par l'URL — pas de lien profond vers un onglet précis.

## 9. Lots autorisables (non implémentés)

0. **[Lot S3, PAS ENCORE CADRÉ] Fermeture P0 — garde boutique sur le cycle de vie legacy d'un
   arrivage.** Objectif : confronter la boutique active de l'appelant au `shop_id` du lot dans
   `updatePurchaseLotAction`, `addPurchaseLotLineAction`, `removePurchaseLotLineAction`,
   `markLotInTransitAction`, `receiveLotAction`, et potentiellement dans `receive_purchase_lot`.
   **Ce lot n'est délibérément pas encore rédigé en détail et ne doit pas être calqué sur `0147`**
   (`correct_purchase_lot_cost`) : cette dernière est appelée via le client authentifié (`auth.uid()`
   renseigné), alors que 4 des 5 actions concernées ici écrivent en service-role
   (`createSupabaseAdminClient()`, `auth.uid()` NULL) et que `receiveLotAction` appelle la RPC via le
   client authentifié — une garde naïve dans la RPC reproduirait le mécanisme exact de l'incident
   0134/0135 (garde posée là où l'appelant n'a pas d'identité). Un inventaire préalable des
   appelants de `receive_purchase_lot` et de la frontière d'identité utilisateur pour chacune des 5
   actions est en cours (livrable séparé, lecture seule, aucun correctif) avant de cadrer la
   solution et son coût de fermeture. Décision produit à trancher en parallèle, indépendamment du
   mécanisme technique : un owner ayant perdu l'accès à une boutique B mais restant owner du compte
   doit-il pouvoir continuer à créer/modifier/réceptionner un arrivage de B depuis une autre
   boutique, ou cela doit-il être bloqué comme pour la correction de transport (0147) ?
1. **Corriger `/boutiques` pour respecter le contexte boutique actif** — objectif unique : faire
   lire et écrire `getShopConnection`/`disconnectShopAction` (legacy) avec le `shopId` de l'URL,
   ou rediriger `/boutiques` vers l'onglet « Shops » déjà correct de `/parametres` et retirer la
   surface legacy. Surfaces : `app/(app)/boutiques/page.tsx`, `lib/actions/shopify.ts`. Contrat à
   préserver : aucun changement de schéma. Dépendance : aucune. Exclusion : ne pas toucher
   `lib/actions/shops.ts` (déjà correct). Critère de sortie : l'écran et l'action ciblent
   systématiquement le `shopId` de l'URL, testable par navigation entre deux boutiques Shopify
   actives du même compte.
2. **Pagination liste clients côté UI** — objectif unique : consommer la capacité de pagination
   déjà présente côté serveur (RPC + Zod). Surface : `components/clients/clients-workspace.tsx`.
   Contrat de donnée déjà en place, pas de migration. Critère de sortie : un tenant à >50 clients
   voit tous ses clients, avec indicateur de reste ou scroll infini.
3. **Fiabiliser la sélection de fiche client** — objectif unique : garde `customerId`/`AbortController`
   sur `selectCustomer`. Surface : `clients-workspace.tsx`. Critère de sortie : test de
   sélection rapide A→B ne peut plus afficher les données de A sous l'identité de B.
4. **Historique de commandes client : indicateur de troncature + tri corrigé** — objectif : signaler
   "30 sur N" et trier sur `least(created_at, created_at_shopify)` comme documenté pour les autres
   surfaces du projet. Surface : `lib/actions/customers.ts`. Critère de sortie : une commande créée
   par appel plus récente qu'une commande Shopify apparaît avant elle dans l'historique.
5. **Décision produit sur le bouton « Demander confirmation »** — implémenter le geste ou le
   désactiver honnêtement comme ses deux voisins (`disabled` + `title`). Décision produit avant
   tout, pas un simple bug technique.
6. **Pagination `getFinanceChartsAction`** — objectif unique : appliquer `fetchAllPages` ou une RPC
   `jsonb`, comme le reste du domaine Finances (Lot 5/0087). Surface :
   `lib/actions/profit.ts:62-90`. Critère de sortie : aucun `.select()` fenêtré sans `.range()`
   dans tout `lib/finance/*`/`lib/actions/profit.ts`.
7. **Pagination `getAllSettlementHistory` + `getPurchaseLotPageData`/`getProductCatalogPageData`**
   — trois call-sites non paginés à corriger dans le même geste (dette de même nature, domaines
   Livreurs et Achats). Critère de sortie : `.range()` ou RPC bornée sur les trois.
8. **Décision présentation : « manquant ≠ zéro » sur la Valeur du stock** — trancher si un
   indicateur « coût inconnu » doit distinguer un `unit_cost` jamais saisi d'un coût réellement
   nul, sur `/produits?tab=stock` et le calcul « Valeur totale ». Décision produit, pas seulement
   présentation.
9. **Refonte responsive du tableau Stock et de `SettlementHistoryTable`** — objectif : colonne
   identité (Produit / Date+Livreur) fixe ou variante carte mobile, sur le modèle déjà appliqué à
   `DriverStockTable`/tableau « Commandes assignées ». Décision de présentation à cadrer dans
   `UX-CAT-01`, ce lot ne fait qu'établir l'état actuel.

## 10. Questions au marchand

1. Quand une disponibilité de stock (produit normal ou bundle) tombe à 0 ou apparaît en négatif
   pour un bundle, qu'est-ce que vous faites concrètement à ce moment-là — vous attendez un
   réapprovisionnement, vous décochez le bundle, ou vous continuez à vendre en acceptant le
   risque de rupture ?
2. Quand vous ouvrez la fiche d'un client juste avant de confirmer sa commande COD, quelle est la
   toute première chose que vous regardez — le score chiffré, le palier, la date de sa dernière
   commande, ou le nombre de refus passés ? (Cette information n'existe actuellement nulle part à
   l'écran ni en base.)
3. Pour un arrivage, à quel moment pesez-vous réellement chaque carton/ligne — avant de cliquer
   « Marquer reçu », ou seulement après avoir physiquement réceptionné la marchandise ? La
   réponse tranche si la restriction actuelle (poids/méthode saisissables uniquement après
   réception) correspond à votre usage réel ou vous ralentit.

*(La question sur l'accès boutique retiré à un owner multi-boutiques n'est pas posée ici — `0147`
a déjà fixé le principe applicable : un identifiant reçu du client se confronte à son parent
autoritatif avant écriture. C'est un principe déjà tranché, pas une question ouverte.)*

---

## Restitution terminal

**Verdict : BLOQUÉ P0** (présent sur cinq des six domaines audités — Produits/Achats, Stock,
Finances, Plus/Boutiques, Clients. Seul le domaine Livreurs est `PASS POUR UX-CAT-01` sans
réserve ; les cinq autres peuvent nourrir `UX-CAT-01` sur toute surface non listée en défaut
ci-dessous).

**P0 trouvés : 8** (et non 7 — voir note de calcul ci-dessous) — garde boutique absente sur 5
mutations du cycle de vie legacy d'un arrivage (Produits/Achats, dont `receiveLotAction` qui poste
de vrais mouvements de stock) ; « Valeur totale du stock » présentant un coût inconnu comme un vrai
zéro, en plus d'un agrégat client incomplet dès 26 produits actifs (Stock) ; `getFinanceChartsAction`
non paginée, défaut certain au-delà de 1000 lignes (Finances) ; `/boutiques` hors-contexte boutique
en lecture et en écriture, cumulé à une absence totale de contrôle de rôle sur `disconnectShopAction`
legacy (Plus/Boutiques) ; bouton client inerte, liste clients plafonnée à 50 sans pagination UI,
race condition de sélection client, et historique client tronqué+mal trié (Clients, 4 P0).

*Note de calcul* : avant les deux reclassements demandés, le rapport comptait déjà 7 P0, dont
`getFinanceChartsAction` (alors étiqueté « probable »). Reformuler cet item ne change pas son
cardinal — il reste l'un des 7. Promouvoir la Valeur du stock de P2 à P0 ajoute nécessairement un
8ᵉ item, puisqu'elle n'était comptée dans aucun total P0 auparavant. Le compte exact après les deux
reclassements est donc 8, pas 7.

**Surfaces cartographiées : 6 domaines** (Finances, Produits/Achats, Stock, Livreurs, Clients,
Plus/Boutiques/Paramètres) — 1 route Finances, 3 sous-vues Produits/Stock/Achats, 1 route Livreurs,
1 route Clients, 3 routes Plus (Boutiques/Paramètres/`/s`) + navigation principale.

**Mutations cartographiées : 27** recensées dans la matrice §7 et les tableaux d'inventaire §3,
dont plusieurs approfondies en détail au niveau rôle/RLS/réseau/persistance sur demande explicite du
périmètre (stock livreur, arrivages, cash, boutique active, client), et 5 trouvées défectueuses
(cycle de vie legacy d'un arrivage, `/boutiques` × 2 mécanismes, sélection client, valeur du stock).

**Requêtes en attente d'exécution par le porteur : 4** — sur-réservation stock (§2), volume de
versements (§2), tenants multi-boutiques Shopify actifs et historique des déconnexions par rôle
(§8, point 2, requêtes rédigées par le domaine F, reprises ici pour mémoire).

**Lots désormais autorisables : 10**, listés en §9, aucun implémenté (le lot S3 — garde boutique sur
le cycle de vie legacy d'un arrivage — reste délibérément non cadré en détail, en attente de
l'inventaire des appelants de `receive_purchase_lot` et de la frontière d'identité utilisateur,
livré séparément).

**Diff final : uniquement `docs/phaseU/U0-D2-DIAGNOSTIC-LECTURE-SEULE.md`** (fichier créé par ce
lot). Aucun autre fichier du dépôt n'a été modifié.
