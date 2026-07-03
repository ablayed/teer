# Tëër — Performance Audit and Optimization Plan

> Date : 2026-07-03 · Branche : `main` (HEAD `0cf9857`) · Dernière migration : `0082`
> Audit **lecture seule** — aucun code applicatif, SQL, test ou snapshot modifié.
>
> Ce document part de `docs/TEER_PROJECT_AUDIT_AND_SPEC.md` (§7, §8, §10, §13, §15) et
> transforme chaque risque performance déjà identifié en verdict prouvé par le code.
> Statuts utilisés : **[Confirmé code]** (lu ligne à ligne), **[Confirmé mesure]** (aucun
> dans cet audit — aucune mesure n'a été exécutée), **[Hypothèse]** (à mesurer),
> **[Recommandation]**. En cas de divergence avec `CLAUDE.md`, `CLAUDE.md` fait foi.

---

## 1. Executive Summary

L'architecture data du projet est saine dans ses patterns récents (RPC agrégées SQL
`0080`–`0082`, keyset pagination produits, charts Recharts lazy-loadés) mais **une famille
structurelle de requêtes non bornées subsiste**, exactement de la classe corrigée par #56 :
des `.select()` sans `.range()`/`.limit()` silencieusement plafonnés à 1000 lignes par
PostgREST (`supabase/config.toml:8`), agrégés ensuite côté JS.

**5 hotspots prioritaires, tous confirmés par lecture du code :**

1. **`getLossAnalyticsAction`** (`lib/actions/loss-analytics.ts:89-113`) : les selects
   fenêtrés `orders` et `audit_log` n'ont **aucune pagination** → cap 1000 silencieux.
   Le fix #50 (RPC `0078`) a couvert les jointures, **pas les deux requêtes d'entrée**.
   `audit_log` compte plusieurs lignes par commande → probablement **déjà tronqué
   aujourd'hui** sur le gros compte (~1000 commandes) en fenêtre 90j. Chiffres d'/analyses
   ET du bloc « Essentiels ops » du Tableau faux au-delà du cap.
2. **Famille cash livreur** (`getDriversCashOnHandTotal`, `buildDriverSettlements`,
   `listDriverOutstandingAction`, `lib/finance/report-data.ts` / `product-cost.ts` /
   `driver-cost.ts`) : select `orders` all-time non borné (cap 1000 → cash total faux)
   **plus** `.in('order_id', orderIds)` jusqu'à ~1000 UUID en URL (classe 400 du bug #50).
   Touche le Tableau, /finances, le flux de versement et le rapport PDF.
3. **`getRevenue30d`** (`lib/actions/dashboard.ts:533-551`) : rapatrie les commandes
   `LIVREE` **all-time** avec `.limit(5000)` — or `max_rows=1000` plafonne la réponse à
   1000 lignes quelle que soit la limite demandée → graphe CA 30j faux dès ~1000 livrées
   cumulées, et payload inutile (l'agrégation JS ne garde que 30 jours).
4. **`fetchTransitionOrderIdSets`** (`lib/actions/orders.ts:245-276`) : select
   `order_state_transition` fenêtré sans limite → cap 1000 → les vues `en-livraison` /
   `annulees-retours` perdent des commandes au-delà de 1000 transitions dans la période.
5. **`getOrdersPageData`** (`lib/actions/orders.ts:350-503`) : charge **tout l'historique
   du tenant** en mémoire (boucle `.range()` séquentielle de 500) à chaque rendu RSC,
   chaque recherche debouncée, chaque « charger plus » et chaque relecture post-création
   (poll jusqu'à 13 relectures complètes) — puis filtre/trie/compte/pagine en JS. Correct
   (pas de cap), mais coût **O(n·requêtes séquentielles)** dominant de /commandes.

**Score global : 16/100** (méthode §4 — dominé par la famille « caps silencieux » ; les
catégories rendu React, bundle et cache sont saines, cf. tableau §4). **Quick wins TS-only
sans migration** (boucles `.range()` sur les 4 requêtes cappées, borne de fenêtre sur
`getRevenue30d`, `React.cache` sur la résolution user/membre) récupèrent l'essentiel de la
correction ; les RPC SQL viennent ensuite pour la latence.

---

## 2. Methodology and Scope

- **Sources** : lecture ciblée de `app/(app)/tableau/page.tsx`, `lib/actions/dashboard.ts`
  (849 l.), `lib/actions/orders.ts` (1495 l., zones 200–530), `lib/actions/drivers.ts`,
  `lib/actions/loss-analytics.ts`, `lib/actions/finance.ts`, `lib/finance/*`,
  `components/orders/orders-workspace.tsx`, greps bornés sur `lib/actions/{customers,
  products,stock,purchases}.ts` et sur les imports lourds client. Migrations `0044`/`0045`,
  `0076`–`0082` identifiées par nom ; `supabase/config.toml:8` (`max_rows = 1000`) relu.
- **Aucune mesure exécutée** : pas d'EXPLAIN, pas de bundle analyzer, pas de trace — les
  chiffres de latence sont donc absents par construction (règle « ne pas inventer de
  métriques »). Le plan de mesure est en §12/§13.
- **Périmètre** : latence serveur, requêtes SQL, payloads, calculs JS, rendus React, N+1,
  caps PostgREST, bundle client. Hors périmètre : produit, sécurité (couverte §14 de
  l'audit existant), refonte.
- **Fait PostgREST central à tout ce document** : `max_rows = 1000` plafonne la réponse
  de toute requête, **y compris avec un `.limit()` supérieur** (le `Range` demandé est
  tronqué côté gateway). Un `.limit(5000)` renvoie au plus 1000 lignes, sans erreur.

---

## 3. Inputs from Existing Project Audit

Verdicts sur les 10 points hérités de `TEER_PROJECT_AUDIT_AND_SPEC.md` §13/§15 :

| # | Risque hérité | Verdict | Preuve |
|---|---|---|---|
| 1 | `max_rows=1000` silencieux | **Confirmé, encore actif** | 4 requêtes non bornées trouvées (§10) alors que §13 le croyait cantonné aux « nouvelles » agrégations |
| 2 | `.select()` agrégé JS sans pagination | **Confirmé** | loss-analytics (orders + audit_log), famille cash livreur, `getRevenue30d` |
| 3 | `.in(uuidArray)` volumineux | **Confirmé, résiduel** | 6+ occurrences `.in('order_id', orderIds)` dans la famille finance/cash où `orderIds` vient d'un select non borné (jusqu'à 1000 UUID) — les autres `.in()` (produits, purchases) sont bornés par la page |
| 4 | `getRevenue30d` à vérifier (P1 §15) | **Confirmé mauvais** | all-time + `.limit(5000)` inopérant au-delà de 1000 + agrégation JS 30j (`dashboard.ts:533-551`) |
| 5 | `getDriversCashOnHandTotal` à vérifier (P1 §15) | **Confirmé mauvais** | select non borné + `.in(orderIds)` (`drivers.ts:439-492`) |
| 6 | RPC dashboard récentes : plan SQL | **Hypothèse à mesurer** | `0080`–`0082` jamais EXPLAINées sur gros tenant (§13 le notait déjà « jamais fait ») |
| 7 | `/analyses` et `get_loss_analytics_joins` | **Partiellement corrigé** | la RPC `0078` est saine (POST body) mais les 2 requêtes d'entrée de l'action sont cappées (hotspot 1) |
| 8 | Revalidation/cache post-mutations | **Sain** | Paradigm A déterministe (orders-workspace), `revalidatePath('/tableau')` sur versement (#57), pas de `staleTimes` global (choix documenté) |
| 9 | Bundle client charts/Recharts | **Sain** | Recharts isolé dans 3 fichiers, tous derrière `next/dynamic` `ssr:false` ; @react-pdf côté serveur (`app/api/rapport/route.tsx`) |
| 10 | Listes et filtres /commandes | **Confirmé coûteux** | full-scan en mémoire + filtres/tri/comptes JS (hotspot 5) ; RPC keyset `list_orders_paginated` (`0045`) existe en base mais **n'est appelée nulle part** dans le code TS |

---

## 4. Performance Health Score

Méthode : score initial 100, pénalités du barème ci-dessous, appliquées **par unité de
fix** (une famille partageant la même correction = une ligne, la double casse cap+URL de
la famille cash est comptée sur ses deux modes de défaillance).

| Code | Pénalité | Item | Barème |
|---|---:|---|---|
| H1 | −15 | Entrées loss-analytics cappées (orders + audit_log) — chiffres faux /analyses + Tableau | hotspot confirmé haute gravité |
| H2 | −15 | Famille cash livreur : selects all-time cappés → cash total faux (Tableau, /finances, versements, PDF) | hotspot confirmé haute gravité |
| H3 | −10 | `getRevenue30d` non borné (cap 1000 effectif malgré `.limit(5000)`) | requête confirmée non paginée sur gros volume |
| H4 | −10 | `fetchTransitionOrderIdSets` non borné (vues transition) | requête confirmée non paginée sur gros volume |
| H5 | −10 | `getOrdersPageData` : full-scan historique + filtres/tri/comptes JS à chaque appel | requête confirmée non paginée sur gros volume |
| H6 | −10 | `.in(orderIds)` ~1000 UUID en URL (famille cash) — classe 400 #50 | requête confirmée à risque sur gros volume |
| E1 | −8 | RPC `get_dashboard_*` (`0076`, `0080`–`0082`) sans EXPLAIN gros tenant | RPC critique sans EXPLAIN |
| E2 | −8 | RPC `get_loss_analytics_joins` (`0078`) sans EXPLAIN gros tenant | RPC critique sans EXPLAIN |
| Y1 | −4 | Plan de `list_customer_reliability` (/clients) non mesuré (scoring par client, classe du timeout 503 pré-`0077`) | hypothèse haute priorité non mesurée |
| Y2 | −4 | /tableau : ~10 blocs × (`auth.getUser()` réseau + select `merchant_member`) par rendu, non dédupliqués | hypothèse haute priorité non mesurée |

**Total pénalités : −94 → Score global : 16/100** (plancher 0 non atteint). Lecture : le
score est écrasé par une seule classe de défaut (agrégation JS sur requêtes cappées),
« gros tenants uniquement » et invisible en dev/seed — exactement le profil des bugs #50 et
#56. Les quick wins §15 (TS-only) remontent mécaniquement H1–H4/H6 (~+60).

| Catégorie | Score | Justification |
|---|---:|---|
| Database / SQL | 35 | Indexes keyset (`0036`/`0044`) et RPC agrégées récentes solides, mais 4 requêtes cappées actives et 0 EXPLAIN documenté |
| Server Actions | 40 | Layering next-safe-action propre ; full-scan /commandes et résolution user/membre dupliquée par bloc |
| Dashboard data | 55 | `0080`–`0082` ont assaini 7 blocs ; restent `getRevenue30d` et le bloc cash livreurs |
| React rendering | 80 | Suspense keyed par bloc + clé boutique, injection Paradigm A maîtrisée, pas de re-render suspect identifié |
| Bundle client | 85 | Recharts/Kanban/Finance charts en `dynamic(ssr:false)` ; PDF serveur ; framer-motion (9 fichiers) seul candidat à vérifier |
| Mobile performance | 70 | Double rendu volontaire table `sr-only` + cartes = DOM ×2 sur 6 tables d'/analyses (coût accepté, non mesuré) |
| Cache / revalidation | 75 | Paradigm A, revalidations prouvées (#57) ; pas de couche cache data (chaque rendu re-questionne tout) |
| Test coverage perf | 15 | Aucun test de charge, aucun seed gros tenant, aucun benchmark, EXPLAIN jamais joué |

---

## 5. Page-by-Page Performance Matrix

| Page | Source données | Nb requêtes estimé (rendu) | Gros payload ? | Calculs JS | Risque DB | Risque rendu | Verdict |
|---|---|---:|---|---|---|---|---|
| `/tableau` | 6 RPC + 3 selects + loss-analytics + cash livreurs | ~25–30 (dont ~10 `auth.getUser` + ~10 `merchant_member` dupliqués) | oui via `getRevenue30d` (jusqu'à 1000 lignes) et loss-analytics | agrégation revenue 30j, consolidation cash | **Haut** (H2, H3 + hérite H1) | Faible (Suspense par bloc) | À corriger |
| `/commandes` | `getOrdersPageData` full-scan | 1 + ⌈n/500⌉ séquentielles + 2 transitions + ≤25 RPC fiabilité (vue a-appeler) | **oui** : tout l'historique + jointure customer | filtre période ×7 vues, recherche, tri O(n log n), comptes | **Haut** (H4, H5) | Moyen (listes 25, OK) | À corriger |
| `/analyses` | `getLossAnalyticsAction` (3 requêtes ∥ + RPC joins) | ~5 | oui : lignes/clients/livreurs de la fenêtre en un JSON | `computeLossAnalytics` O(n) avec Maps — sain | **Haut** (H1, E2) | Faible (charts lazy, Suspense keyed) | À corriger (entrées) |
| `/finances` | `finance_kpis` + `cash_aging` (RPC) + `buildDriverSettlements` | ~8 | oui : orders assignés all-time (cappé) | consolidation cash JS | **Haut** (H2, H6) | Faible (loaders dynamic) | À corriger |
| `/livreurs` | `getDriverStockOnHand` (mouvements par livreur, non borné), cash partagé H2 | ~5 | moyen | dérivation ledger JS | Moyen (cap à >1000 mouvements/livreur) | Faible | À surveiller |
| `/clients` | RPC `list_customer_reliability` (p_limit 50) + détail borné (`.limit(30)`) | ~3 | non | non | **Hypothèse** (Y1 : coût du scoring SQL) | Faible | À mesurer |
| `/produits` | `.range(offset, limit)` + `.in(productIds)` borné page | ~4 | non | non | Faible | Faible | Sain |

---

## 6. Big-O Complexity Matrix

N = commandes du tenant ; W = lignes dans la fenêtre de dates ; P = taille de page (25).

| Priorité | Domaine | Fichier/Fonction | Preuve courte | N | Complexité actuelle | Coût actuel | Optimisation proposée | Complexité après | Statut |
|---|---|---|---|---:|---|---|---|---|---|
| P1 | Analyses + Tableau | `loss-analytics.ts:89-113` selects orders/audit_log | aucun `.limit`/`.range` | W | O(min(W,1000)) **tronqué** | chiffres faux si W>1000 | boucle `.range()` (quick win) puis agrégats dans RPC `0078` étendue | O(W) exact / O(1) rapatrié | confirmé |
| P1 | Finance/cash | `drivers.ts:439-492`, `driver-settlements.ts:66-95`, `finance.ts:241-277`, `report-data.ts`, `product-cost.ts`, `driver-cost.ts` | selects orders all-time sans borne + `.in(orderIds)` | N | O(min(N,1000)) tronqué + URL O(N) | cash faux + 400 potentiel | RPC SQL de consolidation (jointure `settlement_allocation` côté SQL) | O(1) rapatrié | confirmé |
| P1 | Dashboard | `dashboard.ts:533-551` `getRevenue30d` | all-time, `.limit(5000)` > `max_rows` | N livrées | O(min(N,1000)) tronqué | graphe CA faux à terme + payload | filtre `created_at >= fenêtre` (quick win) puis RPC `group by day` | O(30) rapatrié | confirmé |
| P1 | Commandes | `orders.ts:245-276` `fetchTransitionOrderIdSets` | aucun `.limit` | W transitions | O(min(W,1000)) tronqué | vues transition incomplètes si W>1000 | boucle `.range()` (quick win) | O(W) exact | confirmé |
| P2 | Commandes | `orders.ts:350-503` `fetchOrdersPageData` | boucle `.range(500)` jusqu'à épuisement, à chaque appel | N | O(N) I/O séquentiel + O(7N) filtres + O(N log N) tri | latence /commandes ∝ historique | moyen terme : comptes en RPC ; long terme : filtrage+keyset SQL (`list_orders_paginated` `0045` existe, inutilisée) | O(P) par page | confirmé |
| P2 | Tableau | `tableau/page.tsx` ×10 blocs → `auth.getUser()` + `merchant_member` | seul le KPI est `React.cache` (`page.tsx:53`) | 10 | ~20 requêtes évitables/rendu | latence additive par bloc | `React.cache` sur la résolution user+membre | 2 requêtes/rendu | confirmé |
| P3 | Commandes | `orders.ts:404-434` fiabilité par client | 1 RPC/client unique de la page (≤25, vue a-appeler seulement) | P | O(P) RPC ∥ | ~25 appels ∥ acceptables | RPC batch `p_ids uuid[]` si mesuré coûteux | O(1) appel | hypothèse à mesurer |
| P3 | Livreurs | `drivers.ts:154-179` `getDriverStockOnHand` | mouvements d'un livreur sans borne | mouvements/livreur | O(min(M,1000)) | faux si >1000 mouvements/livreur | boucle `.range()` ou agrégat SQL | O(M) exact | confirmé (volume improbable court terme) |
| P3 | Clients | RPC `list_customer_reliability` (`0014`) | scoring par client, p_limit 50 | clients | plan SQL inconnu | classe du 503 pré-`0077` | EXPLAIN puis pré-filtre éventuel | — | hypothèse à mesurer |
| — | Analyses | `computeLossAnalytics` (`metrics.ts`) | Maps par id, passes linéaires | W | O(W) | sain | rien | — | infirmé (pas un hotspot JS) |
| — | Dashboard | blocs COD/top produits/perf boutique/priorités | RPC agrégées `0080`–`0082` | — | O(1) rapatrié | sain | EXPLAIN seulement | — | déjà corrigé (#56/#57/#59) |

---

## 7. Database and Supabase Audit

### 7.1 Database / RPC Matrix

| Requête/RPC | Fichier appelant | Type | Risque | Index probable | EXPLAIN requis ? | Optimisation |
|---|---|---|---|---|---|---|
| `get_dashboard_kpi` (`0076`) | `dashboard.ts:588` | RPC agrégée | plan inconnu sur gros tenant | `(merchant_account_id, created_at)` à vérifier | **oui** | selon plan |
| `get_dashboard_priority_counts` (`0082`) | `dashboard.ts:811` | RPC 4 counts | idem + `count(distinct)` sur transitions | idem + index transitions | **oui** | selon plan |
| `get_dashboard_cod_breakdown` / `_shop_performance` / `_top_products` (`0080`) | `dashboard.ts:290-373` | RPC all-time | scan complet par tenant, all-time assumé | index merchant | **oui** | selon plan (top_products parse `items_summary` jsonb → candidat n°1) |
| `get_loss_analytics_joins` (`0078`) | `loss-analytics.ts:125` | RPC fenêtrée | payload JSON potentiellement large (toutes lignes/clients de la fenêtre) | `0039` loss analytics | **oui** | mesurer taille payload 90j |
| select `orders` fenêtré (loss) | `loss-analytics.ts:89-100` | PostgREST | **cap 1000** | ok | non | borner (quick win QW1) |
| select `audit_log` fenêtré (loss) | `loss-analytics.ts:104-111` | PostgREST | **cap 1000** (≥1 ligne/transition) | `(merchant, action, created_at)` à vérifier | non | borner (QW1) |
| select `orders` assignés all-time | `drivers.ts:444-450`, `driver-settlements.ts:66-73`, `finance.ts:241-248` | PostgREST | **cap 1000** + source du `.in()` | ok | non | RPC consolidation (MT1) |
| `settlement_allocation .in(orderIds)` | `drivers.ts:458-463`, `driver-settlements.ts:88-95`, `finance.ts:270-277` | PostgREST GET | **URL ~37 KB à 1000 UUID → 400** | ok | non | même RPC (MT1) |
| select `order_state_transition` fenêtré | `orders.ts:258-264` | PostgREST | **cap 1000** | index transitions à vérifier | non | borner (QW2) |
| orders full-scan | `orders.ts:359-392` | PostgREST paginé | latence O(N) séquentielle | keyset `0036`/`0044` posés | non (I/O, pas plan) | MT/LT (§15) |
| `list_orders_paginated` (`0045`) | **aucun appelant TS** | RPC keyset | dérive sémantique probable vs #55 (période view-aware) | — | avant toute réutilisation | ne pas adopter sans ré-audit (§18) |
| `list_customer_reliability` (`0014`) | `customers.ts:108` | RPC | coût du scoring par client | — | **oui** | selon plan |
| `list_repeated_refusers` (`0077`), `finance_kpis` (`0065`), `cash_aging` | analyses/finances | RPC bornées | faible | — | souhaitable | — |
| `get_customer_reliability` ×≤25 | `orders.ts:415-421` | RPC ∥ | N+1 borné page | — | non | batch si mesuré lent |

### 7.2 Constats transverses

- **Le pattern sain existe déjà dans le repo** (RPC agrégées `0080`–`0082`, boucle
  `.range()` de `listOrdersForPageData`, `p_limit` sur `0077`) — les hotspots sont les
  survivants d'avant ces conventions, pas un défaut de conception.
- **`.limit(k)` avec k > 1000 est un piège spécifique** : il *semble* borner mais
  `max_rows` tronque à 1000 (cas `getRevenue30d`). Règle à ajouter aux reviews : tout
  `.limit()` > 1000 est suspect.
- Plusieurs fonctions de la famille cash utilisent le **client admin (service-role)** pour
  des lectures (`resolveOwnerManagerContext`, `drivers.ts:137`) — hors périmètre perf mais
  en tension avec la règle « service-role = audit_log uniquement » de `CLAUDE.md`/§14 de
  l'audit ; à signaler au passage du fix MT1, sans l'y mélanger.

---

## 8. Server Actions and Revalidation Audit

- **Layering** : toutes les lectures dashboard existent en double (fonction serveur directe
  pour RSC + action next-safe-action pour le client) — pas un problème perf, mais chaque
  variante refait `auth.getUser()` + lookup `merchant_member` (hotspot Y2 sur /tableau où
  ~10 blocs Suspense appellent chacun sa fonction).
- **Revalidation** : `recordSettlementAction` revalide `/tableau` (`finance.ts:195`, fix
  #57 prouvé) ; transitions revalident `/commandes` + détail (`orders.ts:201-204`).
  Aucune revalidation manquante identifiée dans les fichiers lus.
- **Paradigm A** : la relecture post-création (`orders-workspace.tsx:160-204`) poll jusqu'à
  **13 exécutions complètes de `getOrdersPageData`** (13 full-scans) dans le pire cas —
  le coût du poll est un multiplicateur direct du hotspot H5, argument de plus pour
  réduire le coût unitaire de `getOrdersPageData` plutôt que de toucher au poll (dont le
  déterminisme est prouvé 30/30, ne pas y toucher).
- **Recherche /commandes** : chaque frappe stabilisée (debounce) déclenche un
  `getOrdersPageData` complet côté serveur (`orders-workspace.tsx:235-254`) — la couche
  mémoire instantanée est bien faite, mais le refetch serveur coûte un full-scan.
- **Pas de cache data** : ni `unstable_cache`/`use cache`, ni `staleTimes` (choix
  documenté et justifié — fraîcheur COD). Chaque rendu re-questionne tout : acceptable si
  le coût unitaire des lectures est corrigé (H1–H5).

---

## 9. React Rendering and Bundle Audit

Constats (92 composants `'use client'` sous `app/` + `components/`) :

- **Charts** : Recharts importé uniquement par 3 fichiers (`RevenueChartInner`,
  `FinanceCharts`, `loss-analytics-charts`), tous chargés via `next/dynamic`
  `ssr:false` avec skeleton — le pattern cible est déjà en place. [Confirmé code]
- **Kanban** : `KanbanBoardLoader` en dynamic également. [Confirmé code]
- **PDF** : `@react-pdf` confiné à `app/api/rapport/route.tsx` (serveur, hors bundle
  client). [Confirmé code]
- **framer-motion** : 9 fichiers, dont `DashboardMotion` (monté sur /tableau à chaque
  visite) et des composants marketing. [Hypothèse] impact bundle modéré (~30-40 KB gz) ;
  à confirmer au bundle analyzer avant d'agir — ne pas retirer les animations sur une
  intuition.
- **Suspense** : /tableau keye chaque bloc par `prefixe-shopKey` (commentaire
  `tableau/page.tsx:420-425` documente la régression d'empilement évitée) ; /finances est
  la référence keyed-Suspense du projet. Pas de « vue figée » identifiée.
- **Rendu listes** : /commandes rend 25 lignes/page — pas de virtualisation nécessaire à
  cette taille. Le double rendu accessible (`sr-only` table + cartes `aria-hidden`) double
  le DOM des 6 tables d'/analyses : coût accepté par design (#47), à ne revisiter que si
  une mesure mobile le condamne.
- **Aucun `useMemo`/`useEffect` pathologique repéré** dans les fichiers lus ; audit
  exhaustif des 92 composants non réalisé (hors budget de cet audit, faible priorité vu
  les tailles de listes).

---

## 10. Confirmed Hotspots

Détail des confirmations (tous [Confirmé code], aucun mesuré) :

**H1 — Entrées de `getLossAnalyticsAction` cappées** (`lib/actions/loss-analytics.ts`)
- `ordersQuery` (l.89-100) : fenêtre marchand+dates, filtre boutique — **aucune
  pagination**. >1000 commandes dans la fenêtre (90j sur le gros compte) → commandes
  manquantes dans TOUS les calculs (taux, tendances, zones, produits, livreurs).
- `audit_log` (l.104-111) : mêmes bornes, **aucune pagination**, or une commande génère
  plusieurs transitions → ce select sature avant celui des orders. Les événements de perte
  (raisons, timelines) sont dérivés de ce flux.
- Effet de bord : le bloc « Essentiels ops » du Tableau (`tableau/page.tsx:145-198`)
  consomme la même action en 30j → mêmes chiffres faux.

**H2 — Famille cash livreur** (6 call-sites, même structure)
- Étape 1 : select `orders` `assigned_driver_id not null` **all-time sans borne** →
  cap 1000 → commandes cash manquantes → `cashOnHandMinor` sous-évalué. Fichiers :
  `drivers.ts:444-450` (bloc Tableau), `driver-settlements.ts:66-73` (page Finances +
  action de relecture Paradigm A), `finance.ts:241-248` (`listDriverOutstandingAction`,
  flux versement), plus `report-data.ts`, `product-cost.ts:481-490`, `driver-cost.ts:171-174`
  (rapport PDF/coûts) qui héritent d'`orderIds` amont.
- Étape 2 : `.in('order_id', orderIds)` sur `settlement_allocation` / `stock_movement` /
  `order_line` — à 1000 UUID l'URL ≈ 37 KB → 400 gateway (mode de panne prouvé par #50).
  Ironie : le cap de l'étape 1 « protège » aujourd'hui l'étape 2 en tronquant orderIds.
- Gravité produit maximale : c'est du **cash réel** (écrans de versement compris).

**H3 — `getRevenue30d`** (`dashboard.ts:533-551`) : périmètre all-time `LIVREE` trié
desc + `.limit(5000)` neutralisé par `max_rows` → dès 1000 livrées cumulées, les 1000 plus
récentes par `created_at` seulement ; l'agrégation JS (`aggregateRevenue30d`, l.222-253)
jette ensuite tout ce qui a plus de 30 jours. Double défaut : payload ×~30 trop grand
aujourd'hui, chiffres faux demain (des jours anciens de la fenêtre perdront des commandes).

**H4 — `fetchTransitionOrderIdSets`** (`orders.ts:245-276`) : 2 requêtes parallèles
(EN_LIVRAISON ; ANNULEE+REFUSEE) fenêtrées sans borne → au-delà de 1000 transitions dans
la période, le `Set` d'order_ids est tronqué → commandes absentes des vues `en-livraison`
/ `annulees-retours` et de leurs compteurs (violation silencieuse de « compteur = univers
exact du lien », alors que la RPC `0081`/`0082` du Tableau compte juste → divergence
compteur Tableau ≠ liste /commandes, précisément ce que #55 a voulu interdire).

**H5 — `getOrdersPageData` full-scan** (`orders.ts:350-503`) : voir §1/§6. À souligner :
la boucle `.range()` est **séquentielle** (⌈N/500⌉ allers-retours enchaînés), le tri
`paginateOrders` re-trie tout à chaque page, et `viewCounts` refait le filtre période +
recherche **par vue** (7 passes). Multiplicateurs : debounce recherche, « charger plus »,
poll post-création (≤13×), relectures Paradigm A.

**H6/Y2** : cf. §4 (modes de défaillance de H2 ; duplication auth /tableau).

---

## 11. Hypotheses to Confirm

| ID | Hypothèse | Pourquoi plausible | Comment trancher |
|---|---|---|---|
| Y1 | `list_customer_reliability` coûteux sur gros tenant | même famille que le 503 corrigé par `0077` (scoring latéral) ; p_limit 50 ne borne pas forcément le scoring interne | EXPLAIN ANALYZE sur tenant synthétique (§13) |
| Y2 | ~20 requêtes auth/membre par rendu /tableau pèsent sur le TTFB | 10 blocs Suspense × (`auth.getUser` réseau + select) ; seule la KPI est dédupliquée | span Sentry par bloc ou log timing local |
| Y3 | Payload `get_loss_analytics_joins` lourd en 90j gros tenant | renvoie toutes les lignes/clients/livreurs de la fenêtre en un JSON | mesurer taille réponse (Supabase logs / span) |
| Y4 | framer-motion + Radix pèsent dans le First Load JS | 9 fichiers framer-motion dont /tableau | `next build` + `@next/bundle-analyzer` (dispo ? `À confirmer`) |
| Y5 | `get_dashboard_top_products` (parse jsonb all-time) est la plus lente des RPC `0080` | agrégation sur `items_summary` jsonb sans index dédié | EXPLAIN ANALYZE (§13) |
| Y6 | Le poll post-création rallonge le p95 de création de commande | ≤13 full-scans séquentiels (H5 en multiplicateur) | trace Playwright + span sur `getOrdersPageData` |

---

## 12. Real Metrics Plan

Sentry et PostHog sont en place ; **aucun chiffre n'est inventé ici** — ce plan dit où
regarder. Les server actions next-safe-action remontent déjà leurs exceptions
(`handleServerError` → Sentry) mais pas leurs **durées** : l'instrumentation de spans est
le prérequis n°1.

| Hotspot | Métrique à vérifier | Source | Comment confirmer | Seuil d'alerte proposé |
|---|---|---|---|---|
| H5 /commandes | durée `getOrdersPageData` + nb batchs `.range()` | span Sentry à ajouter (wrapper metadata `actionName` déjà présent — instrumenter le client de base) | percentiles par tenant ; corréler au nb de commandes | p95 > 1,5 s |
| H1 /analyses | durée action + **nb de lignes** orders/audit_log retournées | span + `count: 'exact', head: true` de contrôle ponctuel | si count > 1000 alors que data.length == 1000 → cap prouvé en prod | data.length == 1000 (sentinelle exacte) |
| H2 cash | idem sur les 3 actions + taille `orderIds` | span + log length | `orderIds.length >= 900` = zone rouge URL | ≥ 900 |
| H3 revenue | `data.length` retourné | log ponctuel | == 1000 → cap atteint | == 1000 |
| Y2 /tableau | TTFB serveur de la page + durée par bloc | Sentry Performance (transaction RSC) / Vercel logs | comparer avant/après `React.cache` | p95 TTFB > 800 ms |
| Y3 payload joins | taille réponse RPC | Supabase logs (durée + bytes) | fenêtre 90j sur gros compte | > 2 MB |
| Y4 bundle | First Load JS par route | `next build` (tableau de sortie) ± bundle-analyzer | comparer /tableau, /commandes, /analyses | > 250 KB gz par route |
| UX global | durée de chargement perçue par page | PostHog (pageview duration / web vitals si activés — `À confirmer` config) | segmenter par tenant | LCP p75 > 3 s mobile |
| E2E | régressions de durée | traces Playwright existantes (CI) | comparer durées de specs stables | dérive > 30 % |

Sentinelle générique recommandée [Recommandation, hors périmètre de ce ticket] : un
helper de lecture qui **loggue un warning Sentry quand `data.length === 1000`** sur une
requête sans pagination — transforme le cap silencieux en signal.

---

## 13. EXPLAIN ANALYZE Plan

Prérequis : un tenant synthétique ≥ 50k commandes / ≥ 150k transitions / ≥ 20k clients
sur un stack local (`supabase start`, seed dédié — **ne jamais viser la prod**, garde-fou
`assertLocalSupabase` à respecter). Jouer via `mcp__postgres__query` ou psql local, en
`security invoker` avec un JWT de membre pour des plans réalistes sous RLS.

Ordre de passage (rendement décroissant) :

1. `get_dashboard_top_products(p_merchant_id)` — all-time + parse `items_summary` jsonb (Y5).
2. `get_dashboard_shop_performance` / `get_dashboard_cod_breakdown` — all-time counts.
3. `get_dashboard_priority_counts(p_merchant_id, p_since, p_until, p_shop_id)` —
   `count(distinct)` sur `order_state_transition`.
4. `get_loss_analytics_joins(p_merchant_id, p_from, p_to, p_shop_id)` — fenêtre 90j.
5. `get_dashboard_kpi` — fenêtres 7j.
6. `list_customer_reliability` (Y1) puis `list_repeated_refusers` (contrôle).
7. Les selects PostgREST équivalents des hotspots H1/H2/H4 (traduits en SQL) pour valider
   les index avant d'écrire les RPC de remplacement (MT1/MT2).

Pour chaque plan : noter seq scan vs index scan, lignes estimées vs réelles, buffers ;
consigner les résultats dans ce document (§12/§13) en **[Confirmé mesure]**.

---

## 14. Recommended Optimizations

Toutes [Recommandation] ; comportement strictement préservé (mêmes chiffres — ou chiffres
enfin **exacts** là où le cap tronquait, ce qui est le comportement spécifié) ; aucune ici
n'est implémentée dans ce ticket.

1. **QW1 — Borner les entrées loss-analytics** : boucle `.range()` (pattern
   `listOrdersForPageData`) sur les selects orders et audit_log. TS-only, zéro migration.
2. **QW2 — Borner `fetchTransitionOrderIdSets`** : même boucle. TS-only.
3. **QW3 — Fenêtrer `getRevenue30d`** : ajouter `.gte('created_at', <fenêtre 30j − marge>)`
   côté requête. Sûr car `created_at ≥ created_at_shopify` (l'import suit la commande) :
   toute commande dont la date d'affichage (`created_at_shopify ?? created_at`) tombe dans
   la fenêtre a un `created_at` dans la fenêtre élargie ; prendre une marge (60j) et
   garder l'agrégation JS inchangée. Boucle `.range()` en plus si >1000 dans la fenêtre.
4. **QW4 — Dédupliquer auth/membre sur /tableau** : `React.cache()` autour d'un helper
   `getCurrentMember()` partagé par les blocs (même pattern que `loadDashboardKpi`,
   `tableau/page.tsx:53`).
5. **QW5 — Boucle `.range()` sur la famille cash** (pansement avant MT1) : rétablit
   l'exactitude mais **aggrave** le risque URL du `.in()` (orderIds > 1000) → à ne faire
   que couplé à un chunking du `.in()` (batches de 200 UUID) — ou passer directement à MT1.
6. **MT1 — RPC consolidation cash livreur** : `get_driver_cash_consolidation(p_merchant_id)`
   jointure orders × settlement_allocation côté SQL, retour par livreur. Remplace les 3
   call-sites principaux + alimente le PDF. Migration + contrat = colonnes consommées par
   `consolidateCashByDriver` (règle #50 : contrat de sortie = mapping JS inchangé).
7. **MT2 — Étendre `get_loss_analytics_joins`** pour renvoyer aussi orders et événements
   de la fenêtre (ou une RPC sœur), supprimant les 2 selects d'entrée.
8. **MT3 — RPC `get_orders_view_counts`** : les 7 compteurs de vues en SQL (élimine les 7
   passes JS et une grosse part du besoin de full-scan quand `cursor == null`).
9. **MT4 — Campagne EXPLAIN** (§13) puis index selon résultats.
10. **LT1 — /commandes en filtrage + keyset SQL** : porter période view-aware (#55),
    recherche et pagination côté SQL. `list_orders_paginated` (`0045`) existe mais est
    antérieure à #55 → **ré-audit sémantique obligatoire** avant réutilisation (§18).
11. **LT2 — Bundle** : mesurer (Y4) avant d'agir ; candidats : framer-motion scope,
    `optimizePackageImports`.

## 15. Safe Refactoring Roadmap

### Quick wins — faible risque (TS-only, zéro migration, rollback = revert)

| Optimisation | Impact | Risque | Effort | Preuve | Benchmark attendu | Tests nécessaires | Rollback |
|---|---|---|---|---|---|---|---|
| QW1 loss-analytics `.range()` | exactitude /analyses + Tableau ops | faible (pattern éprouvé `orders.ts:379`) | S | H1 | mêmes chiffres ≤1000 ; exacts au-delà | unit metrics existants + seed >1000 (nouveau) | revert |
| QW2 transitions `.range()` | exactitude vues transition | faible | XS | H4 | idem | E2E transitions existants | revert |
| QW3 revenue fenêtré | payload ÷~30, cap éloigné | moyen (raisonnement date §14.3 à vérifier par un data-check) | S | H3 | graphe identique (visual 0-diff) | visual baselines + unit `aggregateRevenue30d` | revert |
| QW4 `React.cache` membre | −~18 requêtes/rendu /tableau | faible (scope requête) | S | Y2 | TTFB /tableau ↓ (mesurer avant/après) | E2E tableau existants | revert |

### Moyen terme (migrations/RPC — règle « écrire le .sql et STOP », EXPLAIN d'abord)

| Optimisation | Impact | Risque | Effort | Preuve | Benchmark attendu | Tests nécessaires | Rollback |
|---|---|---|---|---|---|---|---|
| MT1 RPC cash | exactitude cash partout + fin du 400 latent | moyen (invariant financier — comparer à `consolidateCashByDriver` sur seed) | M | H2/H6 | totaux identiques ≤1000, exacts au-delà | RLS test + unit parity + E2E versement (qa-prelaunch) | drop RPC, revert TS |
| MT2 RPC loss étendue | latence /analyses ↓, 3 requêtes → 1 | moyen (contrat `.map()` à figer) | M | H1/Y3 | chiffres identiques (règle #50) | visual /analyses 0-diff | idem |
| MT3 RPC view counts | latence /commandes ↓ (chemin compteurs) | moyen (parité stricte avec `matchesOrderSavedView` ×7 + période view-aware) | M | H5 | compteurs identiques | E2E chips compteurs | idem |
| MT4 EXPLAIN + index | latence RPC | faible | S | E1/E2/Y1/Y5 | selon plans | `pnpm test:rls` non-skippé | drop index |

### Long terme

| Optimisation | Impact | Risque | Effort | Preuve | Benchmark attendu | Tests nécessaires | Rollback |
|---|---|---|---|---|---|---|---|
| LT1 /commandes filtrage+keyset SQL | O(P) par page, recherche SQL | **élevé** (sémantique #55, recherche, tri `tentee-a-rappeler`, Paradigm A, poll création) | L | H5 | p95 indépendant de l'historique | suite E2E complète 3 cibles + parité compteurs | feature-flag / revert |
| LT2 bundle | First Load ↓ | faible | S–M | Y4 | mesurer d'abord | visual + E2E | revert |
| LT3 cache data court (si un jour nécessaire) | TTFB ↓ | élevé (fraîcheur COD — interdit par la mémoire projet sans preuve) | — | — | — | — | ne pas faire sans nouveau dossier |

Ordre recommandé : QW1→QW4 en un lot TS-only (une PR), puis MT4 (mesure), puis MT1, puis
MT2/MT3, LT1 seulement si les mesures post-MT le justifient.

---

## 16. Regression and Rollback Strategy

- **Invariant absolu : mêmes chiffres.** Chaque fix de cap doit prouver l'égalité des
  résultats sous 1000 lignes (unit de parité sur seed) — au-delà, la nouvelle valeur est
  la valeur *spécifiée* (l'ancienne était fausse) ; le documenter dans la PR.
- **Sanity loop projet avant tout commit** : `pnpm typecheck && pnpm lint && pnpm
  test:unit && pnpm build` + `pnpm test:rls` non-skippé ; CI 3 cibles (chromium/pixel-7/
  iphone-14) seule juge E2E — jamais un run local complet.
- **Visual 0-diff** pour QW3/MT2 (le graphe/les tableaux ne doivent pas bouger d'un pixel
  sur les seeds actuels) ; ne pas régénérer une baseline au premier rouge (gotcha flake).
- **Migrations** : `.sql` écrit puis STOP (le développeur pousse) ; local resynchronisé
  via `pnpm exec supabase migration up --local` avant tests ; RPC nouvelles en
  `security invoker` + tenant-scopées, jamais de logique de date en SQL (bornes TS →
  `timestamptz`).
- **Rollback** : QW = revert TS pur ; MT = revert TS + la RPC devient orpheline (inoffensive,
  drop dans une migration ultérieure) ; LT1 derrière comparaison A/B avant bascule.

## 17. Do-Not-Touch Areas

- `performTransition` / `transition_order` / les 3 couches TS de transition — aucun enjeu
  perf identifié, risque métier maximal.
- La sémantique **view-aware** d'`orderMatchesPeriod` (#55) et les fenêtres des blocs
  Tableau (7j/30j/all-time) : toute optimisation doit reproduire ces prédicats à
  l'identique, jamais les « simplifier ».
- Le poll borné post-création et les surcouches Paradigm A (`orders-workspace.tsx`) :
  déterminisme prouvé 30/30 ; on réduit le coût *sous* le poll, pas le poll.
- `formatMoney`, bornes de dates TS, RLS/rôles, `cod_status` dérivé.
- Pas de `staleTimes` global ni de cache data sans nouveau dossier (mémoire projet).
- Les baselines visuelles et les specs E2E (hors ajouts de couverture dédiés aux fixes).

## 18. Open Questions

1. `list_orders_paginated` (`0045`) : pourquoi n'est-elle plus appelée ? A-t-elle jamais
   été branchée ? Sa sémantique (pré-#55) diverge-t-elle des vues actuelles ? À trancher
   avant LT1.
2. Le gros compte de référence (~1000 commandes) a-t-il **déjà** franchi le cap sur
   `audit_log` 90j (H1) ? Un simple `count(*)` en prod (lecture seule) le dira.
3. `@next/bundle-analyzer` est-il installable/installé ? (`À confirmer` — non vérifié.)
4. PostHog web vitals sont-ils activés ? (`À confirmer` — config non lue.)
5. Lectures via client admin dans la famille cash (`resolveOwnerManagerContext`) : dette
   sécurité à traiter avec MT1 ou séparément ? (décision hors perf).
6. Le seed E2E permet-il de générer facilement un tenant >1000 commandes pour les tests de
   parité ? (`assertLocalSupabase` ok, volumétrie à vérifier).

## 19. Appendix: Commands Used

Audit conduit sous Windows (outils du harnais : lecture de fichiers + recherches ripgrep
bornées ; équivalents PowerShell indicatifs) :

```powershell
# Phase 0
Get-Content docs/TEER_PROJECT_AUDIT_AND_SPEC.md   # §7, §8, §10, §13, §15
Select-String -Path supabase/config.toml -Pattern "max_rows"

# Domaine 1 — Tableau
Get-Content "app/(app)/tableau/page.tsx"
Get-Content lib/actions/dashboard.ts
Get-ChildItem supabase/migrations | Select-Object -Last 8

# Domaines 2–4 — requêtes non bornées / RPC / .in()
Select-String -Path lib/actions/orders.ts,lib/actions/drivers.ts,lib/actions/finance.ts `
  -Pattern "\.range\(|\.limit\(|\.rpc\(|\.in\(" -Context 3
Get-Content lib/actions/loss-analytics.ts
Select-String -Path lib/finance/*.ts -Pattern "\.in\(|\.limit\(|\.range\("
Select-String -Path components/orders/orders-workspace.tsx -Pattern "getOrdersPageData"

# Domaine 5
Select-String -Path lib/actions/customers.ts,lib/actions/products.ts,lib/actions/stock.ts,
  lib/actions/purchases.ts -Pattern "\.range\(|\.limit\(|\.rpc\(|\.in\("

# Domaine 6 — bundle
Select-String -Path app,components -Pattern "'use client'" -List | Measure-Object
Select-String -Path app,components,lib -Pattern "recharts|@react-pdf|framer-motion|dynamic\(" -List

# RPC keyset dormante
Select-String -Path supabase/migrations/0045*.sql -Pattern "list_orders"
Select-String -Path lib,components,app -Pattern "list_orders_paginated" -List

# Vérification finale
pnpm typecheck
pnpm lint
```

---
*Audit lecture seule. Aucune optimisation implémentée dans ce ticket ; toute suite passe
par une branche + PR + CI 3 cibles (workflow de lot Tëër).*
