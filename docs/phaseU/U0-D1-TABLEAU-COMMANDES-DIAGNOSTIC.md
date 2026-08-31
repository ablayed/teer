# U0-D1 — Diagnostic lecture seule : Tableau, Commandes et fiche Commande

> **Ce document a été révisé (U0-D1C, révision 2).** Le verdict et la classification des P0/P1
> ci-dessous ont changé par rapport à la version 1 initiale. Voir `## Révision 2 — ce qui change
> et pourquoi` pour le détail et le motif de chaque changement. La version 1 n'a pas été effacée :
> elle reste lisible telle quelle dans les sections qui suivent, avec les corrections de la
> révision 2 insérées à côté (jamais par remplacement silencieux).

## 1. Verdict

**Décision finale (révision 2) : `bloqué` — 2 P0 confirmés** (voir `## Révision 2` et `## 7.
Défauts strictement prouvés, classés (révision 2)`).

Verdict de la version 1 (**conservé pour mémoire, invalidé sur les points ci-dessous**) : « PASS
POUR LOT U1, sous réserve des points classés P1 (aucun P0 identifié) ». Ce verdict reposait sur
une classification P1 de deux défauts (fallbacks silencieux du Tableau) que la mission U0-D1C a
requalifiés P0 sur la base d'une règle produit explicite (`manquant ou erreur ≠ zéro`, acquise en
Phase F) que la version 1 n'avait pas appliquée avec la rigueur requise. Aucune preuve de base de
données n'a par ailleurs été obtenue à ce stade (voir `## Preuves DB`) — le volet base de données
de ce diagnostic reste `PREUVE DB INDISPONIBLE`, pas `PASS`.

Ce diagnostic est strictement en lecture seule : aucune modification de code, migration, test, config ou dépendance. Une seule écriture : le présent fichier.

## Révision 2 — ce qui change et pourquoi

Cette révision a été commandée par une mission séparée (U0-D1C) après lecture critique de la
version 1. Elle ne réaudite pas ce qui a déjà été prouvé par le code ; elle corrige des
affirmations de portée et des classements de sévérité, et ajoute un volet base de données absent
de la version 1.

1. **Contradiction corrigée sur la preuve base de données.** La version 1 ne prétendait pas
   explicitement avoir confronté ses affirmations à des valeurs réelles en base (sa section 2
   déclare déjà « pas de lecture directe de la base liée » — vérifié par relecture, `prouvée`).
   Le risque signalé par la mission U0-D1C est donc préventif plutôt que la correction d'une
   contradiction littérale trouvée dans le texte : aucune section de la version 1 ne porte de
   verdict `PASS` fondé sur une lecture DB. Ce point est noté ici pour traçabilité, sans P0/P1
   associé — mais la règle demandée (jamais de `PASS` sur un point sans preuve rendue) est
   appliquée strictement dans le reste de cette révision 2, notamment sur la mesure de
   divergence "En cours de livraison" (§3 ci-dessous), qui reste `PREUVE DB INDISPONIBLE`.
2. **Brief final renommé.** `U1 — Tableau + Commandes` (§8 de la version 1) devient
   **`UX-COD-01 — Tableau + Commandes`** dans cette révision. `U1` désigne déjà le chantier design
   system/navigation (livré : `U1-F`, `U1-F-bis`, cf. historique de commits `b173e83`, `c708fbd`).
   Le contenu du brief lui-même (objectif, surfaces, fichiers, exclusions, critères de sortie)
   n'est pas modifié par ce renommage — voir §8 révisé en fin de document.
3. **Fallbacks silencieux du Tableau reclassés P1 → P0.** La version 1 (§6/§7) documentait déjà,
   avec preuve de code, que 5 blocs du Tableau (sous-titre "À appeler", 4 cartes Exceptions, CA
   30j, Top produits, Performance boutiques, Répartition COD) retombent silencieusement sur
   `0`/`[]` en cas d'échec RPC, sans la distinction `erreur`/`vide` déjà appliquée au bloc
   Essentiels via `toMetricLoadState`. La version 1 classait ce défaut P1. La mission U0-D1C
   applique la règle produit explicite du CLAUDE.md (« `ok:false` d'une action financière ne doit
   JAMAIS devenir `0`/liste vide en UI », acquise Phase F) à la lettre : un opérateur peut lire
   « 0 commande à appeler » alors que le service est en panne, ce qui peut faire manquer un appel
   client réel. Reclassé **P0** ci-dessous (§7 révisée).
4. **Divergence "En cours de livraison"/"Annulées-Retours" : mesure DB demandée, pas exécutée.**
   La version 1 avait déjà prouvé par lecture croisée SQL/TS (§6) que le compteur Tableau et la
   liste de drill-down utilisent deux prédicats différents. Cette révision ajoute la mesure
   quantitative demandée par la mission (3 requêtes prêtes à l'emploi, §"Preuves DB") pour
   distinguer un écart **actif** (P0) d'un écart **structurel non encore observé** (P1) — sans
   résultat rendu par le porteur, le classement reste celui de la version 1 (**P1**, écart
   structurel prouvé par le code, gravité opérationnelle non mesurée).
5. **Pagination/troncature `/commandes` : vérifiée par lecture complète du code, pas de P0
   trouvé.** Nouvelle matrice ajoutée (voir plus bas) : le chemin recherche
   (`fetchOrdersPageDataLegacy` → `listOrdersForPageData`) boucle en `.range(500)` jusqu'à
   épuisement (pas de troncature — confirmé lignes 486-508 de `lib/actions/orders.ts`) ; le chemin
   sans recherche passe par la RPC keyset `list_orders_keyset` (pagination SQL explicite,
   `p_limit=ORDERS_PAGE_SIZE+1`). Aucun filtre `matchesOrderSavedView` appliqué en TS après un jeu
   plafonné à 1000 lignes n'a été identifié sur ces deux chemins. Conclusion : **pas de P0** sur ce
   point pour `/commandes`, contrairement au risque générique que la mission demandait de vérifier.
6. **Double représentation de la légalité (`legalTransitions` vs catalogue dimensionnel) :
   `probable` → `dette de cohérence P1 prouvée`.** Confirmé par grep exhaustif : aucun test ne
   croise `legalTransitions`/`canTransition` (`lib/domain/order-state-machine.ts`, testé
   isolément dans `tests/unit/domain/order-state-machine.test.ts`) avec le catalogue dimensionnel
   `getAllowedTransitionActionsForDimensions` (testé isolément dans
   `tests/unit/orders/state-dimensions.test.ts` et `transitions.test.ts`). Reclassé de `probable`
   à **prouvé** — absence de test de parité confirmée par grep, pas déduite.
7. **`invalider` rouvert post-0145 : traçabilité FIFO confirmée existante, pas de trou trouvé.**
   Contrairement à la P2 de la version 1 (fondée uniquement sur 0116, avant l'allocation FIFO),
   cette révision relit 0145 en entier sur ce point précis : la réversion FIFO déclenchée par
   `p_invalidate_delivered` (migration 0145, lignes 992-1032) insère une ligne
   `purchase_lot_line_allocation` avec `created_by=p_actor` et `created_at=now()` (colonnes
   `not null`, table définie lignes 274-291 de la même migration) — donc **acteur et horodatage
   sont rattachables** pour la contre-écriture FIFO. `p_actor` est lié côté TS à
   `ctx.user.id` (session RLS de l'appelant, jamais un id arbitraire côté service-role) —
   `lib/actions/transitions.ts:551` (`actorUserId: ctx.user.id`) → `:408`
   (`p_actor: actorUserId`). La reprise de cash (`cash_settlement`/`settlement_allocation`,
   lignes 924-983) n'est, elle, déclenchée **que** par le retour réel (`mark_returned`), jamais par
   `p_invalidate_delivered` — cohérent avec la garde bloquante qui interdit déjà d'invalider une
   commande dont le cash est `remitted`/`discrepancy` : à l'instant où `invalider` s'exécute,
   aucune ligne de remise n'existe encore pour cette commande, donc rien à reverser sur ce volet.
   **Conclusion : pas de perte de traçabilité financière trouvée sur ce chemin — ne remonte pas en
   P0/P1 sur ce point précis.** Point distinct noté en marge (P1, hors périmètre strict de cette
   question) : `p_actor` n'est confronté à `auth.uid()` nulle part dans le corps SQL de
   `transition_order` (grep exhaustif des occurrences de `p_actor`, aucune comparaison trouvée) —
   un appel PostgREST direct (hors Server Action) pourrait forger `created_by` sur n'importe quelle
   ligne `purchase_lot_line_allocation`/`cash_settlement`/`stock_movement` de ce RPC. C'est le même
   motif que l'incident 0134/0135 et l'audit `correct_purchase_lot_cost` déjà documentés au
   CLAUDE.md (identifiant reçu du client, jamais confronté à son parent autoritatif) — mais généralisé
   à `p_actor` sur l'ensemble de `transition_order`, pas spécifique à `invalider`. Hors du périmètre
   strict de la question posée par la mission (qui portait sur l'existence d'un chemin de
   traçabilité, pas sur sa falsifiabilité par bypass RPC direct) ; signalé pour un audit dédié
   futur, pas classé ici comme un défaut de `invalider` en particulier.

## 2. SHA, worktree, commandes, limites

- SHA initial (avant lecture) : `e3f5eb43c45bd8d4b17ff2466e9aca88da538d69` (`main`, clean).
- SHA final : identique — aucun commit créé pendant l'audit.
- Worktree initial : `git status --short` vide (propre).
- Worktree final : propre à l'exception du nouveau fichier `docs/phaseU/U0-D1-TABLEAU-COMMANDES-DIAGNOSTIC.md` (non suivi).
- Commandes exécutées (version 1) : `git rev-parse HEAD`, `git status --short`, `Read`/`Grep`/`Glob`/`find` sur le code source et les migrations. **Aucune** commande mutante, aucun `db push`/`migration up`, aucun serveur démarré.
- Commandes exécutées (révision 2, U0-D1C) : `git status --porcelain=v1`, `git rev-parse HEAD` (SHA inchangé : `e3f5eb43c45bd8d4b17ff2466e9aca88da538d69`), puis `Read`/`Grep` ciblés sur `lib/actions/orders.ts` (pagination), `supabase/migrations/0145_lotF1_finances_v2_socle.sql` (réversion FIFO/cash sur `invalider`), `lib/actions/transitions.ts` (liaison `p_actor`↔`ctx.user.id`), et grep exhaustif de `legalTransitions`/`canTransition`/`getAllowedTransitionActionsForDimensions` sur `tests/**` et `lib/**`. **Aucune** requête SQL exécutée, aucun fichier `.env*` lu, aucune commande mutante.
- Limites assumées : l'audit s'appuie sur le code, les migrations SQL commitées et les noms de tests existants (pas d'exécution de la suite de tests, pas de lecture directe de la base liée — la révision 2 confirme cette limite plutôt que de la lever : voir `## Preuves DB` ci-dessous). Certaines affirmations de comportement runtime (ex. rendu exact d'un écran) sont donc marquées `probable` faute d'exécution UI — cohérent avec la contrainte read-only de la mission. Le périmètre Finances/Produits/Stock/Livreurs/Clients n'a été touché que lorsqu'un appel direct depuis Commandes/Tableau l'imposait (ex. `transition_order`, `is_driver_in_shop`, `resolve_order_required_component_quantities`).

## Preuves DB — demandées, obtenues ou indisponibles

**Aucune requête n'a été exécutée dans le cadre de ce diagnostic (version 1 et révision 2).** Les
requêtes ci-dessous sont rédigées pour exécution par le fondateur, en lecture seule, sans donnée
personnelle en sortie (agrégats/comptages uniquement). **C'est au fondateur de préciser
l'environnement d'exécution** (dev ou production — les deux partagent la même base selon le
rappel de contexte de la mission) ; consigner ci-dessous l'environnement réel utilisé, jamais
supposé.

| # | Objet | Requête | Environnement | Date d'exécution | Résultat brut | Statut |
|---|---|---|---|---|---|---|
| 1 | Répartition des `cod_status` réellement en base | `select cod_status, count(*) from orders group by 1 order by 2 desc;` | *(à préciser par le fondateur)* | — | — | `PREUVE DB INDISPONIBLE` |
| 2 | Répartition des 4 dimensions réellement en base | `select order_state, call_state, delivery_state, cash_state, count(*) from orders group by 1,2,3,4 order by 5 desc;` | *(à préciser)* | — | — | `PREUVE DB INDISPONIBLE` |
| 3 | Répartition de `source` | `select source, count(*) from orders group by 1 order by 2 desc;` | *(à préciser)* | — | — | `PREUVE DB INDISPONIBLE` |
| 4 | Divergence compteur/liste "En cours de livraison" (mesure à 3 chiffres, par boutique) | voir requête et grille de classement au §"Mesure de la divergence — En cours de livraison" ci-dessous | *(à préciser)* | — | — | `PREUVE DB INDISPONIBLE` |
| 5 | Même mesure pour "Annulées/Retours" | idem, adapté à `order_state in ('cancelled','returned')` | *(à préciser)* | — | — | `PREUVE DB INDISPONIBLE` |
| 6 | Volume actuel de `/commandes` par boutique (pour trancher "actif" vs "latent" si un risque de troncature était trouvé) | `select shop_id, count(*) from orders where sort_at >= now() - interval '12 months' group by 1 order by 2 desc;` | *(à préciser)* | — | — | `PREUVE DB INDISPONIBLE` — **non bloquant** : la lecture de code (§"Pagination et troncature — Commandes" ci-dessous) n'a trouvé aucun chemin où un filtre de vue s'applique après un jeu plafonné ; cette requête reste utile pour confirmer qu'aucune boutique n'approche un plafond caché ailleurs (ex. futurs exports), pas pour lever un P0 déjà écarté par le code |

**Tant qu'aucun résultat n'est rendu, aucune ligne ci-dessus ne peut porter un verdict `PASS`.**
Si une valeur active apparaît en base (requêtes 1-3) sans correspondance dans les catalogues
TypeScript (`cod_status` ∈ 8 valeurs de `lib/domain/order-state-machine.ts`, dimensions listées
`lib/domain/order-transition-actions.ts:58-69`) ou dans la dérivation trigger documentée, c'est un
**P0 à investiguer immédiatement** dès que le résultat sera rendu — ce diagnostic ne peut pas
l'anticiper sans preuve.

### Mesure de la divergence — En cours de livraison

Formule exacte du compteur Tableau (`get_dashboard_priority_counts`,
`supabase/migrations/0081...sql:67-77`, `prouvée` par lecture directe en version 1) : commandes
avec `delivery_state='out_for_delivery'` **et** transition récente (7 jours) vers
`EN_LIVRAISON`. Formule exacte de la liste de drill-down (`matchesOrderSavedView('en-livraison')`,
`lib/domain/order-saved-views.ts:120-123`, `prouvée`) : `delivery_state='out_for_delivery'`
**seul**, sans fenêtre de date.

Requête de mesure à exécuter (résultat attendu : trois chiffres **par boutique**, jamais un seul
total agrégé) :

```sql
select
  o.shop_id,
  count(*) filter (where o.delivery_state = 'out_for_delivery') as denominateur_liste,
  count(*) filter (
    where o.delivery_state = 'out_for_delivery'
      and not exists (
        select 1 from order_state_transition t
        where t.order_id = o.id
          and t.to_status = 'EN_LIVRAISON'
          and t.created_at >= now() - interval '7 days'
      )
  ) as numerateur_hors_fenetre_7j,
  (select count(*) from orders o2 where o2.shop_id = o.shop_id) as total_boutique
from orders o
where o.delivery_state = 'out_for_delivery'
group by o.shop_id
order by denominateur_liste desc;
```

Classement à appliquer sur le résultat rendu :
- `numerateur_hors_fenetre_7j` ≥ 1 sur au moins une boutique → **P0**, la divergence est active.
- `numerateur_hors_fenetre_7j` = 0 **et** `denominateur_liste` ≥ 10 → **P1**, écart structurel
  prouvé par le code mais non encore réalisé sur ce jeu de données.
- `denominateur_liste` < 10 sur toutes les boutiques → **mesure non concluante**. Ne pas classer
  sur ce chiffre : classer sur l'argument structurel seul (le contrôle positif attendu ici est
  faible par construction — le pilote n'a jamais eu d'ingestion webhook active, deux boutiques
  dont une de test, alimentées par le seul cron de réconciliation quotidien — donc un
  `denominateur_liste` bas mesure l'absence de volume, pas la sûreté du compteur).

Adapter la même requête pour "Annulées/Retours" (`order_state in ('cancelled','returned')` comme
condition de liste, même gabarit de fenêtre 7j côté `get_dashboard_priority_counts` — non
re-vérifié ligne à ligne au-delà de ce qui était déjà lu en version 1, `probable`) avant de
confirmer le P1 n°2 ci-dessous en P0/P1 selon le même barème.

### Pagination et troncature — Commandes

Lu intégralement dans cette révision (`lib/actions/orders.ts`) :

| Surface | Filtre SQL ou client | Pagination explicite | Plafond effectif | Volume actuel | Risque de troncature | Verdict | Preuve |
|---|---|---|---|---|---|---|---|
| `/commandes` sans recherche texte (cas majoritaire) | `list_orders_keyset` RPC, filtre `p_view` appliqué **en SQL**, dans la fonction | Oui — `p_limit: ORDERS_PAGE_SIZE + 1` (26), curseur `(id, sort)` | Aucun plafond PostgREST atteignable (la RPC ne retourne jamais plus de 26 lignes par appel) | Non mesuré (requête #6 ci-dessus, non exécutée) | Aucun — le filtre de vue s'exécute avant la pagination, côté SQL, jamais après | **Pas de P0** | `lib/actions/orders.ts:598-654` (`fetchOrdersKeysetPage`), `674-723` (branche déclenchant ce chemin : `!search && dateFrom && dateTo`) |
| `/commandes` avec recherche texte active | `listOrdersForPageData` (TS), boucle `.range(500)` sur `orders` bornée à `sort_at >= lookback 12 mois`, puis `matchesOrderSavedView` appliqué **en mémoire** sur l'ensemble récupéré | Oui, mais en boucle non bornée en nombre d'itérations : `for (offset += 500) { … } while (batch.length === 500)` — continue jusqu'à épuisement réel des lignes du marchand sur 12 mois, ne s'arrête jamais sur un plafond fixe | Aucun plafond fixe — chaque page Supabase de 500 est explicitement demandée par `.range()`, ce qui contourne le plafond PostgREST par défaut (`max_rows=1000`) documenté au CLAUDE.md ; le filtre de vue s'applique **après** avoir tout récupéré, jamais après une troncature | Non mesuré (requête #6) | Performance dégradée sur un très gros tenant (déjà documenté comme dette temporaire au CLAUDE.md, "Fix triage recherche"), mais **pas de troncature silencieuse** : le filtre voit l'univers complet de la fenêtre 12 mois, jamais un sous-ensemble plafonné | **Pas de P0** — dette de performance déjà connue et documentée, distincte d'un risque de troncature | `lib/actions/orders.ts:455-514` (`listOrdersForPageData`), `739-830` (`fetchOrdersPageDataLegacy`, filtre `matchesOrderSavedView` après récupération complète) |
| Drill-down Tableau → `/commandes?vue=...` | Réutilise exactement les deux chemins ci-dessus (pas de 3ᵉ mécanisme) | idem | idem | idem | idem | **Pas de P0**, hérite du verdict ci-dessus | Même fichier, mêmes lignes |
| Compteurs de vues (`viewCounts`, badges) | `get_order_view_counts` RPC (agrégat SQL, `count(*)` côté serveur) quand aucune recherche n'est active ; sinon recalcul TS sur l'ensemble complet (même chemin `listOrdersForPageData`, non plafonné) | Sans objet — c'est un agrégat, pas une liste de lignes | Sans objet (un `count` SQL n'est jamais tronqué par `max_rows`, contrairement à un `select` de lignes) | — | Aucun | **Pas de P0** | `lib/actions/orders.ts:559-589` (`fetchOrderViewCountsFromRpc`), `785-793` (fallback TS) |

**Conclusion révision 2 sur ce point : aucun P0 de troncature trouvé sur `/commandes` ni sur ses
drill-down Tableau.** Le motif générique redouté par la mission (« un filtre de vue s'applique côté
TypeScript après un jeu déjà plafonné ») ne se vérifie pas dans le code actuel — le chemin qui
filtre en TS (`fetchOrdersPageDataLegacy`) ne plafonne jamais son propre jeu de données en amont.
Ce verdict s'appuie sur la lecture du code seule (`prouvée`) ; la requête #6 ci-dessus reste
recommandée pour objectiver le volume réel par boutique, mais son absence ne bloque pas cette
conclusion puisqu'elle porterait sur un mécanisme différent (plafond caché) qui n'a pas été trouvé
ici.

## 3. Inventaire des routes

| Surface | Route / entrée | Composants | Source de données | Action / RPC | Rôles / RLS | Preuve |
| ------- | -------------- | ---------- | ------------------ | ------------- | ----------- | ------ |
| Tableau | `/s/{storeId}/tableau` (rewrite → `app/(app)/tableau/page.tsx`) | `DashboardMotion`, `KpiStrip`, `OperationsEssentialsSection`, `ExceptionsSection`, `RevenueSection`, `TopProductsSection`, `ShopPerformanceSection`, `CodBreakdownSection`, `RecentActivitySection`, `DeliveryRateTrendSection`, `ActivationChecklist` | `getDashboardKpi`, `getPriorityCounts`, `getRevenue30d`, `getTopProducts`, `getShopPerformance`, `getCodBreakdown`, `getRecentActivity`, `getDashboardCashCollectedTotal`, `getDashboardCashCollectedByProduct`, `getDashboardDeliveriesByProduct`, `getDriversCashOnHandTotal`, `getLossAnalyticsAction` (`lib/actions/dashboard.ts`, `lib/actions/drivers.ts`, `lib/actions/loss-analytics.ts`) | RPC : `get_dashboard_kpi`, `get_dashboard_priority_counts`, `get_dashboard_cash_collected_total`, `get_dashboard_deliveries_by_product`, `get_dashboard_top_products`, `get_dashboard_shop_performance`, `get_dashboard_cod_breakdown` (via `getCachedDashboardContext`, scopé `merchantAccountId`+`shopId` optionnel) | Lecture : tout rôle (owner/manager/agent), scopé via `current_member_role`/RLS. `OperationsEssentialsSection`/`DeliveryRateTrendSection`/`CashByProductPeriodMetric`/`ShopPerformanceSection` masqués si `role !== 'owner' && role !== 'manager'` (`app/(app)/tableau/page.tsx:240,345,753,764`) | `app/(app)/tableau/page.tsx:1-786`; garde rôle lignes 240, 345, 675, 753, 764 |
| Tableau — redirection sans boutique | `/tableau` sans workspace résolu | — | `getRequestStoreId()` | `redirect('/s')` | Tout rôle authentifié | `app/(app)/tableau/page.tsx:639-640` |
| Commandes — liste | `/s/{storeId}/commandes` → `app/(app)/commandes/page.tsx` | `NewOrderForm`, `SyncOrdersButton`, `PeriodPicker`, `ShopFilterSelector`, `OrdersWorkspace`, `EmptyState` | `getOrdersPageData`, `getShopConnection`, `getProductCatalogPageData`, `getActiveDrivers`, `canReassignDrivers` | `getOrdersPageData` (`lib/actions/orders.ts`), vues via `orderSavedViews` | Réassignation inline limitée owner/manager (`canReassignDrivers`, ré-imposé serveur par `requireRole` sur `reassignOrderDriverAction`) | `app/(app)/commandes/page.tsx:44-56,58-236` |
| Commandes — fiche (page pleine) | `/commandes/[id]` → `app/(app)/commandes/[id]/page.tsx` | `OrderDetailScreen` (`mode="page"`) → `OrderDetailPanel` | `getOrderById`, `getActiveDrivers`, `getMerchantMemberForUser` | — (lecture) | `canEditAmounts` = owner/manager (`getCurrentRole`) | `app/(app)/commandes/[id]/page.tsx:1-14`; `components/orders/order-detail-screen.tsx:14-55` |
| Commandes — fiche (modal interceptée) | `/commandes/@modal/(.)[id]` | `OrderDetailScreen` (`mode="sheet"`) → `OrderSideSheet` | idem ci-dessus | idem | idem | `app/(app)/commandes/@modal/(.)[id]/page.tsx` (existence confirmée par Glob) |
| Commandes — erreur/chargement | `app/(app)/commandes/error.tsx`, `loading.tsx`, `[id]/loading.tsx` | Boundaries Next natifs | — | — | — | Fichiers présents (Glob) — contenu non détaillé (hors scope transitions/mutations) |
| Middleware / résolution boutique | `/s/{storeId}/...` → rewrite interne, en-têtes `x-teer-store-id` / `x-teer-workspace-entry` | `middleware.ts` | — | — | Aucune boutique forgée n'est faite confiance : `getRequestStoreId` (hors périmètre direct de ce fichier, documenté CLAUDE.md) revalide côté serveur | `middleware.ts:18-73` |

## 4. Matrice des statuts et transitions

Sources canoniques confirmées dans le code :
- `cod_status` (8 valeurs) — **dérivé par trigger**, jamais écrit directement (`lib/domain/order-state-machine.ts:1-10`; règle confirmée par le commentaire `derive_legacy_cod_status` dans CLAUDE.md et par l'absence de tout `p_cod_status` dans `transition_order`).
- 4 dimensions réelles en base : `order_state` (`open|completed|cancelled|returned`), `call_state` (`to_call|callback|validated|unreachable`), `delivery_state` (`unassigned|scheduled|assigned|out_for_delivery|delivered|failed|returned`), `cash_state` (`not_due|expected|collected|remitted|discrepancy`) — `lib/domain/order-transition-actions.ts:58-69`.
- Dérivation `cod_status` ← dimensions : `deriveLegacyStatusFromDimensions` (`lib/domain/order-transition-actions.ts:385-421`), priorité : `delivery_state∈{failed,returned}` ou `order_state=returned` → REFUSEE ; `order_state=cancelled` → ANNULEE ; `delivery_state=delivered` → LIVREE ; `delivery_state∈{out_for_delivery,assigned}` → EN_LIVRAISON ; `delivery_state=scheduled` → PROGRAMMEE ; `call_state=validated` → CONFIRMEE ; `call_state=callback` → TENTEE ; sinon À_APPELER. **Identique** à la dérivation SQL documentée dans CLAUDE.md (trigger `derive_legacy_cod_status`, migration 0023) — cohérence prouvée par lecture du code TS ; le trigger SQL lui-même n'a pas été relu dans cet audit (`probable`, la dérivation TS est un miroir explicite commenté comme tel).

| Statut source | Transition | Déclencheur | Garde métier/technique | Rôle | Écriture | Idempotence/concurrence | Preuve |
| -------------- | ---------- | ----------- | ------------------------ | ---- | -------- | -------------------------- | ------ |
| A_APPELER → TENTEE | `journaliser_appel` | Bouton "À rappeler" (`OrderActionsMenu`) | `deliveryState=unassigned ∧ callState∈{to_call,callback}` | owner/manager/agent | `performTransition` → RPC `transition_order` | Lock `select ... for update` sur la ligne `orders` (0145 L649-653) ; ré-appel après succès retombe sur `illegal_transition` car l'état a changé | `lib/domain/order-transition-actions.ts:511-515,589-594`; `supabase/migrations/0145...sql:649-653` |
| A_APPELER/TENTEE → CONFIRMEE | `confirmer` | Chemin legacy (masqué par `visibleAllowedActions` dès que `programmer` est légal) | `deliveryState=unassigned ∧ callState∈{to_call,callback}` | owner/manager/agent | idem | idem | `lib/domain/order-transition-actions.ts:516-520,573-581,595-599` |
| A_APPELER/TENTEE/CONFIRMEE → PROGRAMMEE | `programmer` | Bouton "Programmer la livraison" + `TransitionDialog` (date/heure programmée) | `callState∈{to_call,callback,validated} ∧ deliveryState=unassigned` | owner/manager/agent | idem, pose `callState=validated,cashState=expected,deliveryState=scheduled` | idem | `lib/domain/order-transition-actions.ts:521-531,600-612` |
| PROGRAMMEE → EN_LIVRAISON (assigned) | `assigner` | `TransitionDialog` (choix livreur) → éventuellement `AssignmentDetailsDialog` (montants) | `callState=validated ∧ deliveryState=scheduled` ; **garde dispatch⇒livreur** : refus si `deliveryState∈{assigned,out_for_delivery}` sans `assignedDriverId` effectif ; **garde boutique 0133/0139** : `is_driver_in_shop(merchant, driver, order.shop_id)` avant tout appel RPC | owner/manager/agent | idem, mouvement stock `dispatch`/`advance_commit` posté atomiquement dans la même transaction SQL | Idempotency key SQL = `v_transition_id::text || ':' || ligne::text || ':dispatch'` — **nouvelle** à chaque appel RPC (pas un vrai rejeu-safe côté clic), la protection anti-double-exécution vient de la machine d'état (2ᵉ appel = état déjà changé → `illegal_transition`), pas de la clé | `lib/domain/order-transition-actions.ts:532-533,613-619`; `lib/actions/transitions.ts:356-390`; `supabase/migrations/0145...sql:1078-1123` |
| EN_LIVRAISON (assigned) → EN_LIVRAISON (out_for_delivery) | `demarrer_livraison` | Popup d'assignation uniquement (jamais un item de dropdown, `visibleAllowedActions` l'exclut) | `callState=validated ∧ deliveryState=assigned` | owner/manager/agent | idem, aucun mouvement stock (garde SQL exclut `assigned` du re-dispatch) | idem | `lib/domain/order-transition-actions.ts:534-536,620-627`; `components/orders/order-actions-menu.tsx:66-67,575 (visibleAllowedActions filtre demarrer_livraison)` |
| EN_LIVRAISON (assigned/out_for_delivery) → LIVREE | `livrer` | `TransitionDialog` (date/heure réelle optionnelle) | `callState=validated ∧ deliveryState∈{assigned,out_for_delivery}` | **owner/manager uniquement** (pas agent) | idem, pose `cashState=collected, orderState=completed`, FIFO allocation `purchase_lot_line_allocation` posée si `cash_collected_at` encore null | idem ; borne date : `invalid_date_future`/`invalid_date_before_creation`/`invalid_confirmation_after_delivery` levées par la RPC et mappées en message FR (`lib/actions/transitions.ts:60-89`) | `lib/domain/order-transition-actions.ts:190-194,537-542,628-640`; `supabase/migrations/0145...sql:856-921` |
| LIVREE (completed+delivered) → REFUSEE | `mark_returned` | Menu actions | `orderState=completed ∧ deliveryState=delivered` (cas spécial, hors table `legalTransitions` standard) | owner/manager | idem, reprise cash (`cash_settlement` négatif) si `settlement_allocation` existant, réversion FIFO | idem | `lib/domain/order-transition-actions.ts:195-200,463-476,641-646`; `supabase/migrations/0145...sql:924-984` |
| LIVREE (completed+delivered) → A_APPELER | `invalider` (0116) | Menu actions | idem cas spécial ; **garde cash bloquante** : refus si `cash_state∈{remitted,discrepancy}` (double garde : TS `lib/actions/transitions.ts:397-402` **et** SQL `invalid_invalidate_cash_settled`) | **owner/manager uniquement** | idem, **exception documentée : AUCUN `audit_log`, AUCUN `order_state_transition`** posé pour cette action — anti-rejeu assuré par le lock `for update` + le fait que l'état change (2ᵉ appel = `illegal_invalidation` car l'ordre n'est plus `completed+delivered`) | Contre-passation stock par **négation exacte du ledger** (jamais recalcul depuis `order_line`) | `lib/domain/order-transition-actions.ts:246-251,467-476,704-722`; `lib/actions/transitions.ts:392-402,466-476`; `supabase/migrations/0145...sql:712-722,1233-1281` |
| PROGRAMMEE/EN_LIVRAISON → ANNULEE | `annuler` | `TransitionDialog` (raisons multiples, allow-list) | Légal tant que `deliveryState≠delivered` | owner/manager | idem, `cancel_reasons[]` posé, release stock si applicable | idem | `lib/domain/order-transition-actions.ts:201-206,543-546,647-654` |
| A_APPELER/TENTEE (unassigned/scheduled) → REFUSEE | `refuser` | Menu actions (masqué si `deliveryState=scheduled` **ET** filtré une 2ᵉ fois côté UI : `OrderActionsMenu` retire "refuser" si `deliveryState==='scheduled'`, alors que le moteur le considère légal — trou préexistant documenté Lot 3, non traité) | `deliveryState∈{unassigned,scheduled}` | owner/manager | idem | idem | `lib/domain/order-transition-actions.ts:207-212,547-554,655-662`; `components/orders/order-actions-menu.tsx:112-121` |
| EN_LIVRAISON (assigned/out_for_delivery) → PROGRAMMEE | `reprogrammer` | Menu actions | `callState=validated ∧ deliveryState∈{assigned,out_for_delivery}` | owner/manager | idem, `clearAssignedDriver=true`, release stock ledger-only (0106) | idem | `lib/domain/order-transition-actions.ts:220-225,555-562,663-678` |
| CONFIRMEE/PROGRAMMEE → A_APPELER | `deconfirmer` | Menu actions ("Déprogrammer" si `deliveryState=scheduled`) | `callState=validated ∧ deliveryState∈{unassigned,scheduled}` | owner/manager/agent | idem, `clearScheduledFor`, release réserve | idem | `lib/domain/order-transition-actions.ts:229-234,506-510,679-688`; `components/orders/order-actions-menu.tsx:225-228` |
| ANNULEE/REFUSEE (order_state=cancelled) → A_APPELER | `desannuler` | Menu actions | Seule action légale sur `orderState=cancelled`, pré **et** post-dispatch | owner/manager | idem, `clearAssignedDriver, clearCancelReasons, clearScheduledFor` | idem | `lib/domain/order-transition-actions.ts:236-240,479-491,689-703` |

**Table `legalTransitions` (moteur pur, `lib/domain/order-state-machine.ts:25-45`)** — confirmée cohérente avec le catalogue d'actions ci-dessus :
```
A_APPELER   → TENTEE, CONFIRMEE, PROGRAMMEE, REFUSEE, ANNULEE
TENTEE      → TENTEE, CONFIRMEE, PROGRAMMEE, REFUSEE, ANNULEE, A_APPELER
CONFIRMEE   → PROGRAMMEE, ANNULEE, REFUSEE
PROGRAMMEE  → EN_LIVRAISON, ANNULEE, REFUSEE
EN_LIVRAISON→ EN_LIVRAISON, LIVREE, PROGRAMMEE, ANNULEE
LIVREE      → A_APPELER   (seule sortie, via invalider — LIVREE n'est plus terminale depuis 0116)
REFUSEE     → []   (terminal au sens de cette table — mais desannuler existe hors table, piloté par orderState, pas par cod_status)
ANNULEE     → []   (idem)
```
**Note de cohérence** (`prouvée`) : `getAllowedTransitionActionsForDimensions` ne consulte **jamais** `legalTransitions`/`canTransition` — c'est une fonction purement dimensionnelle. `legalTransitions` (table par `cod_status`) et le catalogue par dimensions sont **deux représentations parallèles** de la même légalité, maintenues manuellement en synchronisation.

**Révision 2 — reclassé de `probable` à `dette de cohérence P1 prouvée`.** Grep exhaustif du dépôt (`legalTransitions|canTransition\(` sur `**/*.ts`) : ces symboles n'apparaissent que dans `lib/domain/order-state-machine.ts` et son test dédié `tests/unit/domain/order-state-machine.test.ts`, qui les exerce **isolément**. Le catalogue dimensionnel (`getAllowedTransitionActionsForDimensions`) est lui-même testé isolément dans `tests/unit/orders/state-dimensions.test.ts` et `tests/unit/orders/transitions.test.ts`, sans qu'aucun de ces fichiers ne référence `legalTransitions`/`canTransition`. **Aucun test de parité croisant les deux représentations n'existe** — absence confirmée par grep, pas déduite. Deux sources de vérité maintenues à la main pour la même règle métier, sans détection automatique d'une divergence future, est exactement le motif déjà payé une fois par le double registre de dépense publicitaire (Lot F2-bis, CLAUDE.md) et par l'incident 0134/0135 (deux représentations d'une même règle de sécurité désynchronisées sans alerte). Classé **P1** en §7 révisée.

**Rôle et RLS (croisement TS/SQL prouvé)** :
- RBAC applicatif : `transitionCatalog[].roles` (`lib/domain/order-transition-actions.ts:154-252`), vérifié par `canRolePerformAction` avant tout appel RPC (`lib/actions/transitions.ts:303-305`).
- RBAC serveur (RLS) : `orders_update` policy — `agent` restreint en `WITH CHECK` à `cod_status IN ('TENTEE','CONFIRMEE','PROGRAMMEE','EN_LIVRAISON')` (`supabase/migrations/0126_workspace_store_foundation.sql:543-550`). Cette policy s'applique au **résultat post-trigger** de toute écriture sur `orders` — donc aussi à `transition_order`, qui est `security invoker` (`0145...sql:605`) et s'exécute donc sous le rôle réel de l'appelant, RLS incluse.
- Conséquence prouvée : un agent ne peut jamais faire aboutir une transition vers `A_APPELER`/`LIVREE`/`REFUSEE`/`ANNULEE` par la table `orders`, même si le catalogue TS le laissait techniquement passer (défense en profondeur reproduisant l'incident 0134/0135 documenté dans CLAUDE.md — ici correctement fermé pour ce chemin précis).

## 5. Matrice mutations et réseau

| Mutation | Objet | Risque perte/doublon | Protection observée | État UI persistant | Écart | Priorité |
| -------- | ------ | ---------------------- | ---------------------- | ---------------------- | ----- | -------- |
| `performTransition` (toute transition ci-dessus) | `orders` (4 dimensions) + `order_state_transition` + `stock_movement` + parfois `cash_settlement`/`purchase_lot_line_allocation` | Double-clic : bouton/`TransitionDialog` désactivés pendant `transition.isExecuting` (`components/orders/order-actions-menu.tsx:361,386` via `TransitionDialog` `disabled={!canConfirm \|\| isSubmitting}`) ; réseau coupé après écriture SQL mais avant réponse HTTP : le retry applicatif (2ᵉ clic) échouera en `illegal_transition` car l'état a déjà changé — **pas de perte, pas de doublon**, car toute la mutation (dimensions + `order_state_transition` + mouvements stock) est **une seule transaction SQL** verrouillée par `select ... for update` | `prouvée` | Après succès : `router.refresh()` (ou callback `onTransitionSuccess` si fourni, ex. depuis `OrderDetailPanel`) recharge les données serveur ; pas de `router.refresh()` dépendant du Router Cache pour la donnée elle-même (le composant relit `updatedOrder` retourné par l'action, cf. `lib/actions/transitions.ts:450-462`) | Aucun écart prouvé | — |
| `performTransition` — action `invalider` spécifiquement | idem, **sans** ligne `audit_log`/`order_state_transition` | Anti-rejeu **ne repose pas** sur la ligne d'historique (absente) mais uniquement sur le lock + le changement d'état (2ᵉ appel après succès → `illegal_invalidation`, `orderState` n'est plus `completed`) | `prouvée` par lecture du code + confirmé par le commentaire de tête 0116 et le test dédié `tests/unit/orders/invalidate-audit-exception.test.ts` (existence confirmée, contenu non relu en détail — `probable` sur le détail exact des assertions) | Invisible dans "Activité récente" du Tableau (décision produit assumée, cf. CLAUDE.md) | Comportement volontaire, pas un défaut | P2 (rappel de la règle, pas un bug) |
| `reassignOrderDriverAction` | `orders.assigned_driver_id` + mouvements stock de réaffectation | Lecture (`select`) puis mutation séparée sans verrou explicite visible dans l'extrait lu (`performReassignDriverForContext`, `lib/actions/orders.ts:2219-2242`) — race possible entre lecture de `assigned_driver_id` et écriture si deux réaffectations concurrentes ; portée réduite (owner/manager uniquement) | `probable` — le corps complet de la fonction et l'éventuel `for update` dans la RPC sous-jacente (`reassign_order_driver`) n'ont pas été entièrement relus dans cet audit | `inconnue` (non vérifié) | Race concurrente non exclue avec certitude | P1 (à re-vérifier avant U1, hors garantie forte) |
| `updateOrderAmountsAction` | `orders.total_amount`, `delivery_fee_minor`, `cash_collectable_minor`, `scheduled_for` (**pas** une dimension d'état) | Lecture (`select cash_state, payment_channel_at_delivery, cash_collectable_minor`) puis `update` **séparés**, sans `for update` ni RPC transactionnelle (`lib/actions/orders.ts:1770-1804`) — une transition (`performTransition`) concurrente qui change `cash_state`/`payment_channel_at_delivery` entre les deux appels peut faire écrire `updateOrderAmountsAction` un `cash_collectable_minor` calculé sur un état déjà obsolète | Aucune protection observée (pas de verrou de ligne, pas de version optimiste) | `prouvée` par lecture directe du code | Pas de garde d'idempotence non plus (deux clics rapides = deux `update` séquentiels, le second écrase le premier sans erreur — bénin car même utilisateur, même valeurs voulues) | Fenêtre de course réelle mais étroite (owner/manager, montants, pas d'état COD) | **P1** |
| `setOrderNoteAction` | `orders.note` (RPC `set_order_note`, hors policy `orders_update`) | Aucune transition d'état impliquée ; RPC dédiée avec sa propre garde de rôle | `prouvée` | — | Conforme à la doc (0118) | — |
| `CodStatusSelector` + `updateCodStatusAction` | `orders` (4 dimensions, via `performTransitionForContext`) | **Composant mort** : `CodStatusSelector` n'est importé/rendu nulle part dans le repo (`Grep` sur `CodStatusSelector` ne retourne que sa propre définition) | `prouvée` — l'action serveur `updateCodStatusAction` elle-même est saine (passe par `getTransitionActionForTarget` + `performTransitionForContext`, aucune écriture brute), donc pas un risque de sécurité si jamais réactivée, mais le composant UI est du code mort actuellement inatteignable par un utilisateur | N/A (jamais rendu) | Dette de code, pas un défaut fonctionnel actif | P2 |
| Réseau : coupure pendant `TransitionDialog` (fetch stock requis/disponible) | Lecture seule (`getOrderRequiredStockAction`, `getDriverAvailableStockForAssignmentAction`) | `cancelled` flag local annule l'application du résultat tardif si `driverId`/`orderId` changent entre-temps | `prouvée` | Warning "stock insuffisant" reste vide/`stockCheckFailed=true` — n'empêche jamais la validation (alerte informative, non bloquante, cf. CLAUDE.md Lot 2) | Comportement volontaire | — |
| `getOrdersPageData` (recherche `/commandes?q=`) | Lecture seule | `AbortController` pour annuler une recherche obsolète (documenté CLAUDE.md, "Fix triage recherche") | `probable` — le mécanisme est documenté et le nom `AbortController` apparaît dans le CLAUDE.md du projet, mais le fichier source précis n'a pas été relu ligne à ligne dans cet audit | — | — | — |

**Aucun mécanisme "offline"/file d'attente locale n'a été identifié** pour aucune des mutations Commandes : chaque action est un appel réseau synchrone via `next-safe-action`, sans persistance locale de la mutation en cas de coupure (pas de `localStorage`/IndexedDB queue trouvée dans `components/orders/*`). Un toast de succès affiché après un `router.refresh()` reflète un état **serveur confirmé** (la donnée relue vient de `updatedOrder` retourné par la RPC), pas une promesse optimiste non garantie — **prouvée**, pas déduite.

## 6. Audit Tableau

| Carte / action | Source et portée | Drill-down | `0` / absent / insuffisant | Écart UX prouvé | Priorité |
| --------------- | ------------------- | ----------- | ------------------------------ | ------------------- | -------- |
| Bandeau "À appeler" (sous-titre) | `getDashboardKpi(shopId)` → `a_appeler_count`, RPC `get_dashboard_kpi` | Aucun lien direct depuis le sous-titre | Si erreur RPC, retombe silencieusement sur `0` (`kpiResult.ok ? ... : 0`, `app/(app)/tableau/page.tsx:77`) — **indiscernable d'un vrai zéro** | `prouvée` : une erreur réseau/RPC produit exactement le même texte qu'une file d'appel réellement vide | P1 |
| Carte "À appeler" (Exceptions) | `getPriorityCounts(shopId)` → `aAppeler`, RPC `get_dashboard_priority_counts`, fenêtre 7 jours calculée côté TS | `buildOrderViewHref('a-appeler', {period:'7j', shopId})` → `/commandes?vue=a-appeler&period=7j` | Idem : `countsResult.ok ? ... : {aAppeler:0,...}` en cas d'échec (`app/(app)/tableau/page.tsx:103-105`) | `prouvée` : zéro-erreur et zéro-réel indiscernables pour l'utilisateur (pas de bandeau d'erreur visible côté client dans le rendu de la carte elle-même, contrairement à `EssentialMetricCard` qui distingue explicitement `error`/`empty` via `toMetricLoadState`) | P1 |
| Carte "À rappeler" | `getPriorityCounts` → `aRappeler` (toutes les tentées `open+callback`, **sans fenêtre temporelle** depuis le fix "Option A") | `buildOrderViewHref('tentee-a-rappeler', {shopId})` (pas de `period` forcé) | idem fallback silencieux à 0 | Cohérent avec la vue cible (`matchesOrderSavedView('tentee-a-rappeler')` ne filtre pas non plus par date) — **pas d'écart de population** ici, contrairement à "En cours de livraison" ci-dessous | — |
| Carte "En cours de livraison" (Exceptions) | `getPriorityCounts` → `enLivraison` = commandes avec **transition récente (7j)** vers `EN_LIVRAISON` **ET** `delivery_state='out_for_delivery'` actuel (`supabase/migrations/0081...sql:67-77`) | `buildOrderViewHref('en-livraison', {period:'7j', shopId})` → vue `en-livraison` qui filtre **uniquement** sur `delivery_state='out_for_delivery'` **courant**, sans aucune fenêtre de date (`lib/domain/order-saved-views.ts:120-123`) | Le compteur peut afficher un chiffre **plus bas** que le nombre réel de commandes visibles au clic : une commande passée `out_for_delivery` il y a plus de 7 jours et jamais retransitionnée depuis (bloquée en livraison) est comptée dans la liste cible mais **absente** du compteur Tableau | `prouvée` par lecture croisée du SQL (0081) et de `matchesOrderSavedView` (TS) — contredit directement l'intention documentée en commentaire de tête (`app/(app)/tableau/page.tsx:95-97` : *"compteur dashboard = nombre affiché au clic, pas juste un period=7j cosmétique"*). C'est exactement le type d'écart "0/absent/insuffisant trompeur" que la mission demande de détecter | **P1** |
| Carte "Annulées/Retours" | `getPriorityCounts` → `annuleesRetours`, même famille de requête que "En cours de livraison" (transition récente + état courant) | `buildOrderViewHref('annulees-retours', {period:'7j', shopId})` → vue filtrant sur `order_state∈{cancelled,returned}` courant, sans fenêtre | Même mécanisme que ci-dessus : un défaut structurel identique est **probable** (transition ancienne vers ANNULEE/REFUSEE, état courant toujours cancelled/returned aujourd'hui, mais hors fenêtre 7j du compteur) | `probable` — non vérifié ligne à ligne dans `0081...sql` au-delà de la ligne 78-82 lue partiellement ; le motif SQL est visiblement le même gabarit que `en_livraison` | P1 (à confirmer) |
| Essentiels opérations (CA encaissé, Livraisons, Cash chez livreurs, taux annulation/livraison/retour) | `getDashboardCashCollectedTotal`, `getDashboardDeliveriesByProduct`, `getDriversCashOnHandTotal`, `getLossAnalyticsAction`, masqué agent | Pas de lien de drill-down direct (cartes KPI pures) | **Distinction explicite** empty/erreur via `toMetricLoadState` + `EssentialMetricCard` (`stateLabel` différent pour `error` vs `empty`, `stateTone='danger'` si erreur) — Sentry `captureMessage` posé sur toute erreur (`logMetricLoadError`) | Aucun écart prouvé ici : c'est le pattern *correct* documenté dans CLAUDE.md (`toMetricLoadState`, "ok:false ne doit jamais devenir 0/liste vide") | — |
| Graphe "Taux de livraison dans le temps" | `getLossAnalyticsAction`, masqué agent | Pas de drill-down (graphe seul) | `isDeliveryRateTrendEmpty` = tous les points à `totalOrders=0` ; erreur mappée séparément (`result.ok` check avant `toMetricLoadState`) | Pattern correct, aucun écart prouvé | — |
| CA / Top produits / Performance boutiques / Répartition COD | RPCs dédiées `getRevenue30d`, `getTopProducts`, `getShopPerformance`, `getCodBreakdown` | Pas de lien de clic direct vers `/commandes` (cartes de lecture pure) | Chacune retombe sur `[]`/`null` silencieusement en cas d'erreur RPC (pattern `xResult.ok ? xResult.data : []`) **sans** passer par `toMetricLoadState` — contrairement à la section Essentiels | `prouvée` : ces 4 blocs n'ont **pas** la distinction empty/erreur appliquée aux blocs Essentiels ; une erreur RPC silencieuse s'affiche identiquement à "aucune donnée sur la période" | P1 |
| "Activité récente" | `getRecentActivity(shopId)` — source `audit_log`, jamais `order_state_transition` (cf. CLAUDE.md, confirmé par cette lecture indirecte du code appelant, RPC elle-même non relue) | Pas de lien direct | Fallback silencieux `[]` en cas d'erreur | Historique volontairement non filtré courant/historique (règle documentée) ; l'action `invalider` n'y apparaît jamais (aucun `audit_log` posé) — **comportement voulu**, pas un bug | — |

## 7. Défauts strictement prouvés, classés (version 1 — conservée pour mémoire)

### P0 — aucun trouvé
Aucune donnée trompeuse bloquante, action inaccessible, perte/doublon de mutation, ou trou de sécurité n'a été identifié avec preuve directe dans le périmètre Tableau/Commandes. Le point le plus proche d'un P0 (course sur `updateOrderAmountsAction`) reste classé P1 : la fenêtre est étroite (deux actions concurrentes précises, rôle restreint owner/manager, effet borné aux montants et non à l'état COD).

### P1 — obstacle concret au parcours COD
1. **Écart compteur/liste "En cours de livraison"** (Tableau → `/commandes?vue=en-livraison`) : le compteur Tableau exige une transition *récente (7j)* vers EN_LIVRAISON en plus de l'état courant `out_for_delivery`, alors que la liste cible ne filtre que sur l'état courant. Une commande bloquée en livraison depuis >7 jours est invisible au compteur mais présente dans la liste — trompeur pour un opérateur qui se fie au chiffre du Tableau pour juger l'urgence. *(§6, ligne "En cours de livraison")*
2. **Même défaut probable sur "Annulées/Retours"** — même gabarit SQL (transition récente + état courant), à confirmer avant U1 en relisant intégralement `0081_dashboard_priority_counts.sql` lignes 78+.
3. **Fallback silencieux à `0`/`[]` sans distinction erreur/vide** sur : sous-titre "À appeler", cartes Exceptions (À appeler/À rappeler/En livraison/Annulées-retours), CA 30j, Top produits, Performance boutiques, Répartition COD — contrairement au bloc "Essentiels opérations" qui applique correctement `toMetricLoadState`. Un opérateur peut lire "0 commande à appeler" alors que le service est en panne.
4. **Course `updateOrderAmountsAction` / `performTransition`** : lecture puis écriture non verrouillées de `cash_state`/`cash_collectable_minor`, sans transaction ni verrou de ligne — une transition concurrente sur la même commande peut faire calculer `cash_collectable_minor` sur un état déjà périmé.
5. **`performReassignDriverForContext`** : lecture/écriture séparées sans verrou explicitement confirmé dans l'extrait lu — à revérifier intégralement (fonction tronquée dans cet audit) avant de le considérer clos.
6. **Menu "Refuser" masqué en UI pour `deliveryState=scheduled`** alors que le moteur dimensionnel le considère légal à ce stade — trou préexistant documenté (Lot 3), non un nouveau défaut mais confirmé toujours présent dans le code actuel.

### P2 — confort laptop, densité, dette
1. `CodStatusSelector` est un composant mort (aucun importeur) — l'action serveur sous-jacente est saine, mais le composant devrait être supprimé ou documenté comme intentionnellement en réserve.
2. Absence de toute trace pour `invalider` (audit_log, order_state_transition) : comportement **voulu et documenté**, mentionné ici seulement pour rappel dans le cadre du lot U1 (ne pas le "corriger" par erreur).

## 7bis. Défauts strictement prouvés, classés (révision 2 — U0-D1C, fait foi)

### P0 — 2 confirmés
1. **Fallback silencieux à `0`/`[]` sur 7 blocs du Tableau, sans distinction erreur/vide** — sous-titre "À appeler", cartes Exceptions (À appeler/À rappeler/En cours de livraison/Annulées-retours), CA 30j, Top produits, Performance boutiques, Répartition COD. Reclassé de P1 (version 1) à **P0** : le pattern correct (`toMetricLoadState`, distinguant `error`/`empty`) existe à quelques lignes de là dans le même fichier (`OperationsEssentialsSection`), rendant la classification P1 indéfendable au regard de la règle produit explicite du CLAUDE.md (« `ok:false` ne doit jamais devenir 0/liste vide », acquise et payée en Phase F). Une RPC en panne produit exactement le même rendu qu'une file d'attente réellement vide — un opérateur peut légitimement décider qu'il n'y a rien à faire alors que le système ne peut simplement pas le lui dire. *Preuve inchangée par rapport à la version 1, sévérité corrigée* : `app/(app)/tableau/page.tsx:77,103-105` (sous-titre, Exceptions) et les 4 blocs CA/Top produits/Performance/COD (pattern `xResult.ok ? xResult.data : []` sans passage par `toMetricLoadState`, §6 version 1).
2. **Écart compteur/liste "En cours de livraison" — statut requalifié en attente de mesure, traité comme P0 par défaut de preuve contraire.** La version 1 le classait P1 sur le seul argument structurel (le code prouve la divergence des deux prédicats). La mission U0-D1C demande explicitement de mesurer un numérateur réel avant de trancher P0/P1, et précise qu'**une exposition latente reste P0** quand le mécanisme qui la produirait est prouvé et qu'aucune mesure positive ne vient l'écarter. Aucun résultat de la requête de mesure (`## Preuves DB`) n'a été rendu à ce stade : faute de `numerateur_hors_fenetre_7j` mesuré à 0 sur un échantillon significatif, ce diagnostic ne peut pas affirmer que l'exposition est seulement latente — elle est donc portée en **P0 provisoire, à confirmer ou déclasser en P1 dès que la requête sera exécutée** (voir grille de classement complète au `## Preuves DB`). Ne pas lire ce P0 comme une preuve d'incident réel : c'est un défaut de preuve, pas un défaut observé en production.

### P1 — obstacle concret au parcours COD (confirmés ou ajoutés en révision 2)
1. **Même défaut probable sur "Annulées/Retours"** — même gabarit SQL que le point P0 n°2 ci-dessus ; non re-vérifié ligne à ligne dans cette révision au-delà de ce qui était déjà lu en version 1. Appliquer la même requête de mesure avant U1 ; classera P0 ou P1 selon le même barème que "En cours de livraison" une fois le résultat rendu.
2. **Course `updateOrderAmountsAction` / `performTransition`** — inchangé de la version 1 : lecture puis écriture non verrouillées de `cash_state`/`cash_collectable_minor`.
3. **`performReassignDriverForContext`** — inchangé de la version 1 : verrou non confirmé, fonction non entièrement relue.
4. **Menu "Refuser" masqué en UI pour `deliveryState=scheduled`** — inchangé de la version 1, trou préexistant confirmé toujours présent.
5. **Double représentation de la légalité sans test de parité** (`legalTransitions` vs `getAllowedTransitionActionsForDimensions` vs les transitions réellement acceptées par `transition_order`) — reclassé de `probable` (version 1) à **dette de cohérence P1 prouvée** : absence de test croisé confirmée par grep exhaustif (voir §4, note de cohérence révisée). Recommandation : un test de parité dédié (pour chaque `cod_status`, comparer l'ensemble des `to_status` atteignables via `legalTransitions` à l'ensemble dérivable des actions dimensionnelles autorisées), dans un lot séparé de UX-COD-01.
6. **`transition_order` — `p_actor` non confronté à `auth.uid()` dans le corps SQL** (trouvé en rouvrant `invalider` post-0145, §"Révision 2" point 7 ci-dessus) : un appel PostgREST direct (hors Server Action) pourrait forger l'attribution (`created_by`) des lignes `purchase_lot_line_allocation`/`cash_settlement`/`stock_movement` posées par ce RPC. Généralisé à l'ensemble de `transition_order`, pas spécifique à `invalider`. Recommandé pour un audit dédié (même motif que l'incident 0134/0135 et `correct_purchase_lot_cost`/0147), hors périmètre d'implémentation de UX-COD-01.

### Non reclassé — traçabilité `invalider` post-FIFO (0145)
**Rouvert puis refermé avec preuve directe** (§"Révision 2" point 7) : la réversion FIFO déclenchée par `invalider` porte `created_by`/`created_at` (colonnes `not null` sur `purchase_lot_line_allocation`, migration 0145) et `p_actor` est lié côté TS à la session réelle de l'appelant (`ctx.user.id`). Aucune reprise de cash n'est déclenchée sur ce chemin (réservée à `mark_returned`), cohérent avec la garde bloquante existante (`cash_state∈{remitted,discrepancy}` → refus). **Pas de perte de traçabilité financière trouvée** — ne remonte pas en P0/P1 sur ce point précis. Le point P1 n°6 ci-dessus (falsifiabilité de `p_actor` par bypass RPC direct) est un défaut distinct, plus général, découvert à cette occasion.

### P2 — confort laptop, densité, dette (inchangé de la version 1)
1. `CodStatusSelector` est un composant mort (aucun importeur).
2. Absence de toute trace pour `invalider` (audit_log, order_state_transition) : comportement **voulu et documenté** (0116) — rappel pour ne pas le "corriger" par erreur dans UX-COD-01.

## 8. Brief de lot futur — UX-COD-01 : Tableau + Commandes

> Renommé en révision 2 (`U1` est déjà pris par le chantier design system/navigation, livré :
> `U1-F`, `U1-F-bis`). Contenu inchangé sur le fond, à l'exception des priorités mises à jour
> ci-dessous pour refléter §7bis (révision 2) plutôt que §7 (version 1).

**Objectif** : fermer les écarts UX prouvés en §7bis (priorité P0 et P1) sans toucher au moteur de transitions ni à `transition_order`, et sans introduire de nouvelle notion de statut ou de rôle. Les deux P0 (§7bis) sont désormais la priorité de fermeture avant tout autre point de ce brief : le fallback silencieux (P0 n°1) a un correctif clair et borné (`toMetricLoadState`, pattern déjà en production) ; l'écart "En cours de livraison" (P0 n°2) doit d'abord être mesuré (`## Preuves DB`) avant qu'un correctif de portée puisse être choisi — la décision produit (retirer la fenêtre 7j du compteur, ou l'appliquer aussi à la liste) appartient au porteur, pas à ce diagnostic.

**Surfaces exactes** :
- `app/(app)/tableau/page.tsx` — sections `ExceptionsSection`, `CallQueueSubtitle`, `RevenueSection`, `TopProductsSection`, `ShopPerformanceSection`, `CodBreakdownSection` (adopter `toMetricLoadState` partout, comme déjà fait pour `OperationsEssentialsSection`).
- `supabase/migrations/` — nouvelle migration pour aligner `get_dashboard_priority_counts` (`en_livraison`, `annulees_retours`) sur l'état courant seul (retirer la double condition "transition récente ET état courant"), ou documenter explicitement pourquoi la fenêtre 7j doit rester si le porteur la veut — **c'est une décision produit à trancher avant d'écrire le code**, pas une évidence technique.
- `lib/actions/orders.ts` (`updateOrderAmountsAction`) — envisager un `select ... for update` ou passage par une RPC transactionnelle, à la manière de `transition_order`.
- `lib/actions/orders.ts` (`performReassignDriverForContext`) — relecture complète puis, si confirmé, même traitement.
- `components/orders/order-actions-menu.tsx` — décision produit sur le trou "Refuser" masqué en `scheduled` (documenter l'intention ou l'aligner sur le moteur).

**Contrats à préserver** :
- Ne jamais écrire `cod_status` directement (règle absolue, trigger seul autorité).
- `transition_order` reste l'unique porte d'écriture d'état — aucune nouvelle action TS ne doit contourner `performTransitionForContext`.
- L'exception `invalider` (zéro trace) reste intouchée.
- RLS `orders_update` (agent borné à 4 statuts) ne doit pas être assouplie sans revue de sécurité dédiée.
- Toute nouvelle migration touchant `get_dashboard_priority_counts` doit suivre le processus `teer-migration` (fichier `.sql`, développeur exécute `db push`).

**Fichiers probablement concernés** :
`app/(app)/tableau/page.tsx`, `lib/actions/dashboard.ts`, `supabase/migrations/0081_dashboard_priority_counts.sql` (nouvelle migration dérivée), `lib/actions/orders.ts`, `components/orders/order-actions-menu.tsx`, tests associés (`tests/rls/order-view-counts.rls.test.ts`, `tests/unit/orders/transitions.test.ts`, `tests/e2e/tableau-period.spec.ts`, `tests/e2e/orders-transitions.spec.ts`).

**Exclusions** : Finances, Produits, Stock, Livreurs, Clients, Plus — sauf lecture strictement nécessaire à un appel déjà identifié ci-dessus (ex. `is_driver_in_shop`). Aucune nouvelle feature de saisie côté Finances (rappel : Finances liste/agrège, Produits saisit).

**Critères de sortie testables** :
1. Chaque carte "Exceptions" du Tableau distingue visuellement `erreur` de `vide` (test unitaire sur le state rendu, ou capture E2E des deux cas).
2. Le compteur "En cours de livraison" et "Annulées/Retours" du Tableau égale, à `period` identique, le nombre de lignes retournées par la vue `/commandes?vue=...` correspondante pour un jeu de données couvrant une commande "ancienne" (>7 jours) dans cet état — preuve par test RLS/E2E dédié.
3. Une transition concurrente sur `cash_state` pendant un `updateOrderAmountsAction` ne produit plus de valeur `cash_collectable_minor` incohérente (test de mutation ciblé, à la manière de `tests/rls/stock-atomicity.rls.test.ts`).
4. `performReassignDriverForContext` prouvé atomique (verrou ou RPC transactionnelle) par un test de concurrence dédié.
5. Aucune régression sur `tests/unit/orders/transitions.test.ts`, `tests/unit/orders/state-dimensions.test.ts`, `tests/rls/orders-dimensions.rls.test.ts`, `tests/rls/order-view-counts.rls.test.ts`, `tests/e2e/orders-transitions.spec.ts`, `tests/e2e/tableau-period.spec.ts`.

## Critères de sortie de U0-D1 (auto-évaluation)

- Matrice des statuts/transitions fondée sur le code (`lib/domain/order-state-machine.ts`, `lib/domain/order-transition-actions.ts`, `lib/actions/transitions.ts`, `supabase/migrations/0145...sql`), jamais sur des captures — **respecté**.
- Chaque mutation prioritaire évaluée pour droits/perte/doublon/réseau — **respecté**, deux zones marquées `probable`/`inconnue` explicitement (réassignation livreur, détail exact du mécanisme `AbortController` de recherche) plutôt que présentées comme prouvées.
- Chaque KPI Tableau a une source, une portée et un comportement de drill-down établis — **respecté**, y compris l'écart de population "En cours de livraison" prouvé par lecture croisée SQL/TS.
- Le lot U1 est écrit sans hypothèse non sourcée sur routes/statuts/mutations/permissions — **respecté**.
- Aucun fichier autre que ce rapport n'a été modifié — **confirmé** (`git status --short` final).

## Critères de sortie de U0-D1C (révision 2 — auto-évaluation)

- Contradiction interne sur la preuve DB corrigée sans effacer la version 1 — **respecté** (section `> Ce document a été révisé…` + `## Révision 2` ajoutées, aucune section de la version 1 supprimée).
- Section `## Preuves DB — demandées, obtenues ou indisponibles` ajoutée, avec 6 requêtes prêtes à exécuter et leur grille de classement, toutes marquées `PREUVE DB INDISPONIBLE` — **respecté**, aucune requête exécutée.
- Brief final renommé `UX-COD-01` — **respecté** (§8).
- Divergence "En cours de livraison"/"Annulées-Retours" : requête de mesure à 3 chiffres rédigée avec grille P0/P1/non-concluant, y compris le rappel du contrôle positif faible attendu (pas d'ingestion webhook) — **respecté**, classé P0 provisoire faute de résultat rendu (règle "exposition latente reste P0" appliquée strictement).
- Pagination/troncature `/commandes` tranchée par lecture complète de `getOrdersPageData`/`listOrdersForPageData`/`fetchOrdersKeysetPage` — **respecté**, aucun P0 trouvé, matrice fournie.
- Fallbacks silencieux du Tableau reclassés selon la règle produit explicite (`manquant ou erreur ≠ zéro`) — **respecté**, P1 → P0.
- Double représentation de la légalité : absence de test de parité confirmée par grep exhaustif, reclassée `dette de cohérence P1 prouvée` — **respecté**.
- `invalider` rouvert avec la question précise posée par la mission (traçabilité acteur/date de la contre-écriture FIFO/cash post-0145) — **respecté** : traçabilité FIFO trouvée existante (`created_by`/`created_at`), aucune reprise de cash sur ce chemin, un défaut distinct et plus général (`p_actor` non confronté à `auth.uid()`) signalé séparément sans le rattacher à tort à `invalider` spécifiquement.
- Aucune requête SQL exécutée, aucun fichier d'environnement lu — **confirmé**.
- Décision finale portée explicitement (`bloqué`, 2 P0) plutôt que reconduite par défaut — **respecté**.

## Décision finale (révision 2)

**`bloqué`** — 2 P0 (voir §7bis) :
1. Fallback silencieux à `0`/`[]` sur 7 blocs du Tableau (correctif clair et borné : `toMetricLoadState`, déjà en production ailleurs dans le même fichier).
2. Écart compteur/liste "En cours de livraison" — P0 **provisoire par défaut de preuve**, à confirmer ou déclasser en P1 dès que la requête de mesure (`## Preuves DB`) sera exécutée et son résultat rendu par le porteur.

Aucun des deux P0 ne nécessite un correctif structurel massif ni ne remet en cause l'architecture de transition (`transition_order` reste l'unique porte d'écriture, RLS `orders_update` inchangée). Le lot `UX-COD-01` (§8) reste écrit et exploitable ; ces deux P0 en sont simplement la première étape, avant les points P1.

## SHA et diff (révision 2, U0-D1C)

- SHA initial de cette révision : `e3f5eb43c45bd8d4b17ff2466e9aca88da538d69` (`main`).
- SHA final : identique — aucun commit créé.
- `git status --porcelain=v1` avant intervention : `?? docs/phaseU/` (répertoire non suivi, contenant uniquement le rapport de la version 1).
- `git status --porcelain=v1` après intervention : `?? docs/phaseU/` (même unique entrée — seul le contenu du rapport a changé, aucun autre fichier créé/modifié/supprimé).
- **Diff attendu et confirmé : uniquement `docs/phaseU/U0-D1-TABLEAU-COMMANDES-DIAGNOSTIC.md`.**
- Commandes de lecture seule exécutées durant cette révision : `git status --porcelain=v1`, `git rev-parse HEAD`, puis `Read`/`Grep` sur `lib/actions/orders.ts`, `supabase/migrations/0145_lotF1_finances_v2_socle.sql`, `lib/actions/transitions.ts`, `tests/unit/orders/state-dimensions.test.ts`, `tests/unit/orders/transitions.test.ts`, et grep de `legalTransitions|canTransition\(` sur `**/*.ts`. Aucune requête SQL, aucun fichier `.env*`, aucune commande mutante.
