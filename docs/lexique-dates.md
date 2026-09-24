# Lexique des dates — quelle date chaque colonne porte, et laquelle chaque chiffre utilise

> Document de référence, issu du diagnostic `DIAG-DATES-01` et publié par le lot `COHERENCE-01`.
> Il remplace le fichier temporaire dans lequel ce lexique vivait jusque-là.
>
> **À consulter avant d'écrire tout filtre, toute borne de période, ou tout libellé qui annonce une fenêtre.**
> Toute colonne temporelle ajoutée au domaine doit être ajoutée ici dans le même lot.

---

## 0. Portée épistémique — à lire avant de s'appuyer sur ce document

`[Fait]` Les types, nullabilités, défauts et triggers ci-dessous sont lus **au catalogue**, sur le stack **local à la migration `0155`**, et recoupés avec `lib/supabase/database.types.ts`, généré depuis le projet **lié**.

**Ce que cela ferme.** « Le texte d'une migration n'est pas le schéma. » Les affirmations de ce document ne sont plus des lectures du texte des migrations : elles portent sur des objets réellement mesurés.

**Ce que cela ne ferme PAS.** « Local ≠ production. » Une dérive manuelle en production — de la classe de l'incident `0141`, un `grant` posé à la main et jamais commité — **ne serait pas visible ici**. La sonde `acl-production-probe.yml` couvre cette classe de dérive pour les privilèges, jamais pour les types ni les défauts.

**Une exception, délimitée :** les deux fonctions touchées par ce lot (`get_report_revenue_by_day`, `cash_aging`) **ont** été lues au catalogue de **production**, corps et ACL, le 2026-09-18 (voir ci-dessous). Pour elles, et pour elles seules, ce document est une attestation de production. Toute autre ligne reste une lecture du local à `0155`.

`[Fait]` **Fuseau de la session Postgres : `UTC`**, mesuré. Conséquence unique : le seul `date_trunc('day', …)` du domaine (`ca_collecte_7j` / `sparkline_7j` de `get_dashboard_kpi`, `0076`:64-83 et 138-178) **serait juste** — et il est **mort**, `toDashboardKpi` (`lib/actions/dashboard.ts`:132-141) ne mappant aucune de ces deux clés. Aucun chiffre affiché ne dépend de ce réglage.

`[Fait]` **Les deux migrations de ce lot — `0156` (`get_report_revenue_by_day`) et `0157` (`cash_aging`) — sont APPLIQUÉES EN PRODUCTION, vérifiées AU CATALOGUE le 2026-09-18.** Trois mesures distinctes, et non le seul message de succès de `db push` :

1. **`db push` réussi, attesté par le porteur** (`Finished supabase db push.`), et `0156`/`0157` présentes en colonne *Remote* de `supabase migration list --linked`. Cela établit la **présence dans l'historique**, jamais la conformité du catalogue — d'où les deux mesures suivantes.
2. **Corps lus au catalogue de production** (`supabase db dump --linked`, lecture seule). `get_report_revenue_by_day` : `coalesce(o.cash_collected_at, max(ost.created_at), o.updated_at) as delivered_at`, avec `to_char((d.delivered_at at time zone 'utc')::date, …)` **et** `where d.delivered_at >= p_from and d.delivered_at <= p_to` — filtre et bucket sur la même colonne. L'ancien `coalesce(o.updated_at, o.created_at)` est **absent**. `cash_aging` : `o.cash_collected_at as financial_at`, `and o.cash_collected_at is not null`, **aucune** mention de `order_state_transition` (le join a disparu), l'ancien `coalesce(max(ost.created_at), o.updated_at)` **absent**. Les deux restent `SECURITY DEFINER`, `STABLE`, `search_path=public`.
3. **ACL de production inchangée**, mesurée au même dump : `REVOKE ALL … FROM PUBLIC` + `GRANT … TO authenticated` + `GRANT … TO service_role` sur les deux, et **zéro** grant à `anon`. Identique à la mesure locale avant/après.

Tout le reste de `COHERENCE-01` est du code applicatif ou de la microcopie : cela prend effet à la fusion, sans `db push`.

`[Non vérifié]` **Une preuve reste due, et elle n'est pas de la même nature** : l'égalité fonctionnelle en production entre la série de `get_report_revenue_by_day` et `finance_kpis.ca_livre` sur une même fenêtre. Elle exige d'impersonner un owner (les deux fonctions sont gardées par `current_member_role`, qui lit `auth.uid()`), donc elle ne se lit pas dans un dump de schéma. Lire le corps d'une fonction n'est pas la voir produire le bon chiffre.

`[Non vérifié]` **Le `TZ` du runtime Node de production n'est pas fixé par le dépôt** (ni `vercel.json`, ni `next.config`, ni aucune variable) et n'est pas mesurable en lecture seule. Il reste **non mesuré** — ne pas écrire que Vercel tourne en UTC.

`[Fait]` **Depuis `FIX-DATE-RANGE-TZ-01` (#232, `d2959e2`), ce réglage ne décide plus des bornes de période** : `resolvePeriodRange` et ses primitives calculent en `Africa/Dakar` explicitement (§4-a). Il continue en revanche de décider des **bornes du rapport PDF**, non corrigées (§6, point 9).

`[Non vérifié]` **Avant cette correction, il décidait de toutes les bornes serveur.** L'écart réellement affiché en production avant `d2959e2` est donc inconnu : côté serveur parce que ce `TZ` historique n'a jamais été mesuré, côté navigateur (§4-c2) parce que le fuseau des postes marchands varie. Le comportement futur est déterministe ; l'écart passé n'est pas mesuré. **Ne pas écrire qu'aucun chiffre n'a changé.**

---

## 1. `orders` — 14 colonnes temporelles

| Colonne | Type | Nullable **en base** | Défaut | Ce qu'elle signifie réellement | Qui l'écrit |
|---|---|---|---|---|---|
| `created_at` | `timestamptz` | **non** | `now()` | **Date d'entrée dans Tëër.** Pour une commande Shopify importée après coup, c'est la date d'**import**, pas la date de la commande réelle (`0114`:47-52) | Défaut de colonne. Tous les chemins d'écriture : `persistShopifyOrder`, `create_csv_order` (`0151`), `persist_connection_order` (`0152`), création manuelle |
| `created_at_shopify` | `timestamptz` | oui | — | **Date de la commande chez le fournisseur.** NULL sur toute commande manuelle, CSV ou WooCommerce | Mapping du webhook / de la synchro Shopify |
| `sort_at` | `timestamptz` **générée stored** | **oui — déclarée nullable** | `coalesce(created_at_shopify, created_at)` | **La « vraie » date de commande**, au mieux de ce qu'on sait. Rien ne peut l'écrire, donc rien ne peut la rejeter | Postgres (`0044`:22-24). Lecture seule absolue |
| `updated_at` | `timestamptz` | **non** | `now()` | **Dernière modification, quelle qu'elle soit.** Ne désigne **aucun** événement métier — et deux fonctions s'en servent pourtant en dernier repli, ce qui n'est pas une contradiction : voir le piège 3 ci-dessous | `set_updated_at()` via le trigger `orders_set_updated_at` (`0005`:93, `BEFORE UPDATE`), et `transition_order` (`0148`:313) |
| `next_contact_at` | `timestamptz` | oui | — | **Date de rappel souhaitée.** Jamais renseignée en pratique : seul `journaliser_appel` la pose (`lib/domain/order-transition-actions.ts`:627) et aucun composant vivant n'appelle cette action | `transition_order(p_next_contact_at)`, jamais atteint |
| `next_action_at` | `timestamptz` **générée stored** | **oui — déclarée nullable** | `coalesce(next_contact_at, created_at_shopify, created_at)` | Clé de tri de la vue « À rappeler ». `next_contact_at` étant vide, elle **égale `sort_at`** dans les faits | Postgres (`0044`:26-28) |
| `scheduled_for` | `timestamptz` | oui | — | **Date/heure convenue de la livraison**, passée comme future. **Alimente `cash_collected_at`** si aucune date de livraison n'est saisie | `transition_order(p_scheduled_for)` sur `programmer` / `reprogrammer` / assignation. **Valeur construite dans le navigateur** — voir §4 |
| `call_confirmed_at` | `timestamptz` | oui | — | **Date/heure réelle de la confirmation client.** Aucun backfill : NULL sur toute commande confirmée avant `0114` | `transition_order`, quand `call_state` **devient** `validated` et qu'elle est encore NULL : `coalesce(p_call_confirmed_at, now())` (`0148`:291-298). Effacée par `invalider` |
| `cash_collected_at` | `timestamptz` | oui | — | **Date de référence comptable de la vente.** `0119` l'a érigée en date de record pour tout le CA. **N'est PAS l'instant physique de l'encaissement** — voir §3 | `transition_order`, quand `delivery_state='delivered'` **et** `cash_state='collected'` **et** encore NULL : **`coalesce(p_delivered_at, v_order.scheduled_for, now())`** (`0148`:299-306). Remise à NULL par `invalider` (`0116`) |
| `returned_at` | `timestamptz` | oui | — | **Date du retour.** Base du contra-revenue | `transition_order` : `now()` quand `order_state` devient `returned` et qu'elle est NULL (`0148`:307-314). **Jamais éditable** |
| `shopify_updated_at` | `timestamptz` | oui | — | Dernière mise à jour **chez Shopify**. Sert de garde hors-ordre | Chemin webhook / synchro Shopify |
| `shopify_cancelled_at` | `timestamptz` | oui | — | **Date d'annulation chez Shopify.** N'entre dans aucun chiffre affiché | Chemin webhook Shopify |
| `cart_locally_modified_at` | `timestamptz` | oui | — | Marqueur : le panier a été édité dans Tëër → interdit sa resynchronisation Shopify (`0102`, `0111`) | Édition de panier |
| `pcd_finalized_at` | `timestamptz` | oui | — | Date de finalisation de la minimisation PCD (`0122`). Aucun usage analytique | **Le trigger `orders_set_pcd_finalized_at`** (`0122`:94-95), jamais le cron directement |

**Deux pièges de déclaration, mesurés.**

1. **`sort_at` et `next_action_at` sont déclarées `nullable`**, pas `NOT NULL`. Étant `GENERATED … STORED` sur des expressions dont le dernier terme est `created_at` (`NOT NULL`), leur valeur ne peut jamais être nulle **en pratique**. Mais une requête écrite sur la déclaration — un `is not null` défensif, un type TS `string | null` propagé — se tromperait sur ce qu'elle protège. `database.types.ts` les rend bien `string | null`.
2. **`updated_at` est `NOT NULL DEFAULT now()` ET entretenue par trigger.** Conséquence, et elle est ASYMÉTRIQUE — c'est la lire de travers qui produit des erreurs dans les deux sens :
   - tout terme placé **APRÈS** `updated_at` dans un `coalesce` est **du code mort**, puisque `updated_at` ne peut pas être nulle. C'était exactement le cas de `coalesce(o.updated_at, o.created_at)` dans `get_report_revenue_by_day` avant ce lot : le repli vers `created_at` n'était jamais atteint, et le graphe datait *toujours* sur la dernière modification (§5) ;
   - en revanche, `updated_at` placée **EN DERNIER** dans un `coalesce` est parfaitement atteignable, et garantit seulement que l'expression ne rend jamais NULL. Ce n'est pas du code mort — voir le piège 3.

3. **Deux fonctions datent en dernier recours sur `updated_at`, et ce n'est pas une contradiction avec la ligne ci-dessus.** `finance_kpis.ca_livre` (`0119`:73) et, depuis `0156`, `get_report_revenue_by_day` portent toutes deux :

   `coalesce(cash_collected_at, max(order_state_transition.created_at WHERE to_status='LIVREE'), updated_at)`

   Ce troisième terme n'est atteint que si `cash_collected_at` **ET** toute transition `LIVREE` sont absentes — le cas d'une commande livrée avant l'existence du champ (avant `0096`), ou dont l'état a été écrit directement sans passer par `transition_order` (seed, backfill : la RPC est le seul producteur de `order_state_transition`).

   **`0156` conserve ce repli pour rester aligné sur `finance_kpis`, pas parce qu'il serait juste.** C'est la condition pour que le graphe « Tendance du CA livré » et le KPI « Chiffre d'affaires » du même rapport PDF se recoupent : un repli différent du sien rouvrirait l'écart que `0156` ferme, une telle commande comptant au KPI et manquant au graphe.

   **C'est une dette héritée de `0119`, jamais un choix de `COHERENCE-01`.** La corriger signifierait décider ce qu'on fait des commandes livrées sans aucune date de record — les exclure des deux côtés, comme `0157` le fait pour l'ancienneté, ou leur trouver une date. C'est un arbitrage métier, à mener sur `finance_kpis` et sur `0156` **ensemble**, jamais sur l'un sans l'autre. À ne pas « réparer » d'un côté seul en croyant supprimer une incohérence : on en créerait une.

---

## 2. Autres tables du domaine

| Table.colonne | Type | Nullable | Signification | Écrit par |
|---|---|---|---|---|
| `order_line.created_at` | `timestamptz` `now()` | non | Date d'écriture de la ligne. **N'est la date de rien de métier** : une resynchronisation Shopify reconstruit les lignes (`0111`). Aucun chiffre ne la filtre | Insert |
| `order_state_transition.created_at` | `timestamptz` `now()` | non | **Instant du clic serveur.** `0119` l'a explicitement écartée comme date de CA. Reste un repli de `finance_kpis` | `transition_order`. **Aucune ligne pour `invalider`** (exception assumée) |
| `stock_movement.created_at` | `timestamptz` `now()` | non | Instant du mouvement de stock. **Jamais utilisée comme fenêtre** par les lectures Finances : `0087` fenêtre sur `orders.cash_collected_at`/`returned_at` et remonte aux mouvements par jointure | `post_stock_movement` |
| `cash_settlement.settled_at` | `timestamptz` `now()` | **non** | **Date du versement du livreur au marchand.** **Non éditable** : aucun paramètre applicatif ne l'alimente — c'est toujours l'instant du clic | `record_cash_settlement` |
| `cash_settlement.created_at` | `timestamptz` `now()` | non | Instant d'écriture de la ligne de versement. Aucun chiffre ne la filtre. **Cette table n'a pas d'`updated_at`** | `record_cash_settlement` |
| `settlement_allocation.created_at` | `timestamptz` `now()` | non | Instant d'imputation d'un versement (ou de sa reprise négative, `0056`) sur une commande. Entre dans le terme « remis » de « Cash chez le livreur sur période » | `record_cash_settlement` |
| `expense.spent_at` | **`date`** | non | **Jour de la dépense**, saisi par le marchand. Sans heure, donc sans fuseau | Saisie `ExpenseSection` |
| `expense.created_at` / `expense.updated_at` | `timestamptz` `now()` | non | Écriture / dernière modification de la ligne de charge. Aucun chiffre ne les filtre | Saisie, puis trigger |
| `product_ad_spend.spent_at` | **`date`** | non | Jour de la dépense publicitaire par arrivage. `window_start`/`window_end` optionnels | Saisie fiche arrivage |
| `product_ad_spend.created_at` | `timestamptz` `now()` | non | Écriture de la ligne. Aucun chiffre ne la filtre. **Cette table n'a pas d'`updated_at`** | Saisie |
| `purchase_lot.ordered_at` | `date` | non | Date de commande fournisseur | Création de l'arrivage |
| `purchase_lot.received_at` | `date` | oui | **Date de réception.** Ordonne le FIFO d'allocation (`0148`:385) | `receive_purchase_lot` |
| `purchase_lot.eta_override` | **`date`** | oui | **Date d'arrivée estimée forcée à la main**, court-circuitant le calcul par délais (`supplier_prep_days` + `transport_days` + `local_buffer_days`). Aucun chiffre financier ne la lit | Saisie fiche arrivage (`0033`:27) |
| `purchase_lot.created_at` | `timestamptz` `now()` | non | Écriture de l'arrivage. Aucun chiffre ne la filtre. **Cette table n'a pas d'`updated_at`** | Création |
| `audit_log.created_at` | `timestamptz` `now()` | non | Instant de l'écriture d'audit. **Source réelle** des événements de `/analyses` et des cohortes de maturité — jamais `order_state_transition` | Écriture service-role dans `lib/actions/transitions.ts` |
| `shop.installed_at` | `timestamptz` | **non — `NOT NULL DEFAULT now()`** (`0004`:11) | Date d'installation de l'app. Ordonne « Performance par boutique ». **Non remise à zéro après libération d'identité** : une boutique rattachée à nouveau garde sa date d'origine | OAuth Shopify |
| `shop.uninstalled_at` | `timestamptz` | oui | Date de désinstallation (`0037`:22). Aucun chiffre affiché ne la lit ; ne sert pas non plus à filtrer `resolveShopContext`, qui **ignore délibérément** `shop.status` | `processAppUninstalledCore` |
| `shop.last_reconciled_at` | `timestamptz` | oui | Dernier passage du cron de réconciliation Shopify (`0037`:23), quotidien 02:00 UTC. Diagnostic d'exploitation, aucun usage analytique | `app/api/cron/shopify-reconcile` |
| `shop.access_token_expires_at` | `timestamptz` | oui | Expiration du jeton d'accès fournisseur (`0004`:7). Aucun usage analytique | Chemin OAuth / rafraîchissement |
| `shop.refresh_token_expires_at` | `timestamptz` | oui | Expiration du jeton de rafraîchissement (`0004`:8). Aucun usage analytique | Chemin OAuth / rafraîchissement |

`[Fait]` **Correction d'une liste trop large, à ne pas rétablir.** Le mandat de ce lot demandait d'ajouter « les `created_at`/`updated_at` de `expense`, `product_ad_spend`, `purchase_lot`, `cash_settlement` ». Mesuré : **seule `expense` porte un `updated_at`**. Les trois autres n'ont qu'un `created_at`, confirmé au catalogue **et** dans `database.types.ts`. La liste est écrite ci-dessus telle qu'elle est, pas telle qu'elle a été demandée — ne pas généraliser une propriété vraie d'un élément à l'ensemble.

**Aucune des colonnes ajoutées par ce lot ne porte un chiffre affiché.** Elles sont nommées parce qu'un lexique qui se présente comme la référence doit être exhaustif : une colonne absente s'y lit comme une colonne inexistante.

---

## 3. `cash_collected_at` n'est pas un horodatage de collecte

`[Décision]` À écrire explicitement, parce que son nom suggère le contraire.

`cash_collected_at = coalesce(p_delivered_at, v_order.scheduled_for, now())` (`0148`:299-306). Sa valeur peut donc être **héritée de `scheduled_for`**, c'est-à-dire d'une date *convenue à l'avance*, éventuellement dans le futur par rapport au clic qui la fixe.

**Ce qu'elle est** : la **date de record comptable de la vente** — la meilleure approximation disponible de la date réelle de livraison, avec priorité à la saisie explicite, puis à la date programmée, puis à l'instant du clic.

**Ce qu'elle n'est pas** : un instant physique d'encaissement. **Aucun événement de collecte réellement horodaté n'existe dans le schéma.**

**Deux conséquences contre-intuitives, à ne pas confondre avec un bug :**

1. une commande **programmée pour demain et livrée en avance aujourd'hui**, sans saisie explicite, voit son CA tomber **demain** ;
2. toute métrique d'**ancienneté** bâtie sur `cash_collected_at` est une **ancienneté financière**, jamais physique. C'est le choix retenu pour `cash_aging` par ce lot — dit dans la microcopie de la carte, jamais présenté comme un âge réel du cash. `[Fait]` L'axe est en production depuis `0157` (§0) ; la microcopie de la carte part à la fusion du lot.

---

## 4. Les régimes de fuseau, et le seul qui écrive en base

**a) Bornes de période : `Africa/Dakar` explicite** — le régime de **tous** les écrans. `resolvePeriodRange` (`lib/periods/date-range.ts`:103-145) est la **seule** source des bornes de période. `[Fait]` Depuis `FIX-DATE-RANGE-TZ-01` (#232, `d2959e2`), les presets `today`/`yesterday`/`7j`/`30j`/`90j`/`month` **et** les bornes `custom` sont calculés sur la **journée calendaire `Africa/Dakar`** (`zonedDayStart`, :41-44, qui emprunte le calcul de décalage de `lib/format/datetime-input.ts` au lieu de le présumer nul). Le résultat ne dépend plus ni du `TZ` du runtime Vercel, ni du fuseau du processus local, ni du fuseau du navigateur. Appelée depuis **6 sites serveur** (5 Server Components — `/analyses`, `/commandes`, `/finances`, `/livreurs`, `/tableau` — et 1 action, `lib/actions/dashboard.ts`:794) **et 1 composant client** (voir c2) : les sept obtiennent les mêmes bornes.

- **`toDateInput`** (:99-101) rend le jour calendaire **`Africa/Dakar`** de l'instant donné. `[Fait]` Ce n'est **pas** une sérialisation UTC qui tomberait juste par coïncidence de décalage : la zone est nommée. Ses consommateurs de production (`app/(app)/finances/page.tsx`) en font des paramètres d'URL et le filtre de `expense.spent_at` (colonne `date`).
- **`parseDateInput`** (:76-93) — `[Fait]` **durcissement livré, hors objectif initial du lot** : une date calendaire impossible (`2026-02-31`) n'est plus normalisée silencieusement par V8 vers `2026-03-03`, elle est **refusée par vérification aller-retour** (`toDateInput(date) === value`). Verrouillé par `tests/unit/period-range.test.ts`:168.

**Historique, à ne pas relire comme l'état courant.** Avant `d2959e2`, `today`/`yesterday`/`month` et les presets passaient par `setHours(0,0,0,0)` / `setDate`, et `custom` par `new Date("YYYY-MM-DDT00:00:00")` : l'arithmétique s'évaluait dans le fuseau du **processus**, tandis que `toDateInput` formatait en UTC. Le défaut venait de la superposition des deux, et le décalage appliqué était celui de la date **analysée**, pas celui de `now()` (mesuré par `DIAG-TZ-01` : sous `Europe/London`, `custom.from = '2026-06-01'` rendait `2026-05-31` même avec un `now()` d'hiver).

**b) UTC dur** — `lib/ia/periods.ts` (assistant), `lib/dashboard/revenue-30d.ts`, `lib/finance/charts.ts`, `lib/loss-analytics/metrics.ts`, et le bucket SQL de `0085` (`at time zone 'utc'`). Toujours juste pour un marchand sénégalais, quel que soit le process. **Écart de convention à connaître** : `7d`/`30d` de l'assistant comptent `n` jours **pleins** en arrière, contre `n` jours **inclusifs** pour `resolvePeriodRange` — « 30 jours » ne désigne pas la même fenêtre dans l'assistant et sur le Tableau.

**c) Navigateur** — deux points, et **le premier est le seul défaut de fuseau qui inscrive durablement une valeur fausse en base.**

- **c1 — la saisie de `scheduled_for` et de la date de livraison.** `lib/format/datetime-input.ts` convertit ISO ↔ `<input type=date>` + `<input type=time>`. Trois consommateurs, tous `'use client'` : `transition-dialog.tsx`, `assignment-details-dialog.tsx`, `order-amounts-editor.tsx`. **Figé sur `Africa/Dakar` par `COHERENCE-01`** — avant ce lot la conversion se faisait dans le fuseau du poste, et un utilisateur en `Europe/London` en été qui programmait une livraison pour le 18 septembre à 00:00 écrivait `scheduled_for = 2026-09-17T23:00:00Z`, donc un CA au 17. **Les valeurs déjà écrites de travers n'ont pas été corrigées** : le fuseau du poste de saisie n'est enregistré nulle part, un backfill serait une invention.
- **c2 — `driver-cash-panel.tsx` appelle `resolvePeriodRange` côté client** (ligne 97). Le premier rendu de `/livreurs` utilise les bornes calculées **sur le serveur** ; le `refreshCash()` qui suit l'enregistrement d'un versement les recalcule **dans le navigateur**. `[Fait]` **Les deux calculs rendent désormais les mêmes bornes**, la fonction partagée étant figée sur `Africa/Dakar` (régime a) — sans que ce fichier ait été modifié par `FIX-DATE-RANGE-TZ-01`. **L'écart entre régime serveur et régime navigateur sur cette page n'existe plus.** Historique : avant `d2959e2`, sur un poste dont le fuseau différait de celui du serveur, « Collecté sur période » pouvait changer de valeur après un versement sans qu'aucune donnée de collecte n'ait bougé.

**Le fuseau est désormais figé à trois niveaux.** `lib/format/date.ts` (`DATE_TIME_ZONE`, ligne 1) rend toute date en `Africa/Dakar` depuis toujours ; `COHERENCE-01` a étendu la règle à la **saisie** (c1) ; `FIX-DATE-RANGE-TZ-01` l'a étendue aux **bornes de lecture** (a). **Hors de ces trois niveaux, elle n'est pas généralisée** : les bornes du rapport PDF restent dans le fuseau du processus (§6, point 9).

---

## 5. Quel axe chaque famille de chiffres utilise

| Famille | Axe de date | État |
|---|---|---|
| CA, P&L, COGS, marge, CA par produit, CA par jour / par boutique, arrivages, KPI « Chiffre d'affaires » du PDF, les 4 outils financiers de l'assistant | **`cash_collected_at`** (retours sur `returned_at`) | **Harmonisé par `0119`** |
| Cohortes : taux d'annulation, RTO, retour, taux de livraison, performance par livreur, tendances `/analyses`, entonnoir COD, répartition COD, « Performance par boutique » | `orders.created_at` | **Volontaire** — ce sont des cohortes de commandes créées |
| Listes et badges de `/commandes` | `coalesce(created_at_shopify, created_at)` = `sort_at` | Aligné compteur/liste par `0149` |
| Versements, « Encaissé » | `cash_settlement.settled_at` | Correct |
| Charges, publicité | `expense.spent_at` / `product_ad_spend.spent_at` (`date`) | Correct pour `/finances`, qui passe par `toDateInput` (jour `Africa/Dakar` explicite, §4-a) et par des bornes `resolvePeriodRange`. Réserve résiduelle : d'autres lecteurs tronquent l'ISO (`fromIso.slice(0,10)`, `lib/finance/product-cost.ts`:547-548, `lib/finance/report-data.ts`:107-108) — sérialisation **UTC**, juste pour le Sénégal (UTC+00:00) quand les bornes viennent de `resolvePeriodRange`, mais **dépendante du fuseau du processus** quand elles viennent de la route du rapport PDF (§6, point 9) |
| Ancienneté du cash (`cash_aging`) | **`cash_collected_at`**, alias interne `financial_at`, sans repli — lignes sans date **exclues** | **Repassé par `0157`, appliquée et vérifiée au catalogue de production le 2026-09-18** (§0). Était sur `coalesce(max(ost.created_at LIVREE), orders.updated_at)`, l'instant du clic serveur |
| Graphe « Tendance du CA livré » du PDF (`get_report_revenue_by_day`) | **même expression que `finance_kpis.ca_livre`**, filtre **et** bucket sur cette seule colonne | **Repassé par `0156`, appliquée et vérifiée au catalogue de production le 2026-09-18** (§0). Filtrait sur `created_at` et buckait sur `coalesce(updated_at, created_at)` : deux axes pour une même série, le repli étant du code mort. Subsiste un écart d'une milliseconde sur la borne haute (`<= p_to` ici, `< p_to` dans `finance_kpis`), nommé et non corrigé |
| « Collecté sur période », « Frais de livraison », « Manquant » du PDF (`get_driver_cash_consolidation`, `get_report_driver_cash_pending`) | `orders.created_at` | **Incohérent avec `0119`, NON corrigé.** Décision assumée et datée dans `0100`:17-24 ; `COHERENCE-01` n'a corrigé que le **libellé** (voir `docs/lexique-microcopie.md`) |
| « Top produits » du PDF (`get_report_top_products`) | `orders.created_at`, **aucun filtre de statut** | **Faux et NON corrigé** — voir §6 |

---

## 6. Ce qui reste ouvert, nommé

`[Décision]` **Formulation étroite, obligatoire.** Le diagnostic dont ce lexique est issu concluait que « le cœur financier est juste ». C'est une généralisation d'un élément à un ensemble. La formulation exacte est :

> **Le parcours de CA et de P&L du scénario testé est cohérent ; le cœur financier global n'est pas entièrement clos.**

Et la contradiction interne de ce diagnostic est corrigée ici, pas reformulée vaguement : son verdict déclarait l'affirmation du testeur « fausse de tous les chiffres de vente **et de trésorerie** », alors que son propre corps classait **trois chiffres de trésorerie** comme fenêtrés sur `orders.created_at`. L'affirmation est donc **fausse des chiffres de CA harmonisés par `0119`**, et **vraie** de ces trois chiffres de trésorerie. `0119` a harmonisé les surfaces qu'elle a touchées, pas l'ensemble du domaine.

**Restent objectivement incohérents après `COHERENCE-01` — ses deux migrations étant appliquées en production (§0), il ne reste que la fusion du code :**

1. **« Collecté sur période », « Frais de livraison », « Cash chez le livreur sur période » (`/livreurs`) et « Manquant » du PDF** — fenêtrés sur `orders.created_at`. Du cash réellement encaissé pendant la période est **invisible** si la commande a été créée avant la fenêtre ; du cash encaissé après est **compté dedans**. Avec le preset par défaut `30j` et un p90 de livraison mesuré à 10,43 j, ce n'est pas un cas de bord. **Ce lot n'a corrigé que les libellés** — le changement d'axe est un arbitrage métier, pas une correction de colonne, et il touche deux RPC et un PDF.
2. **« Cash chez le livreur sur période » mélange deux axes dans une seule soustraction** : collecté et frais sur `orders.created_at`, remis sur `settlement_allocation.created_at`.
3. **« Top produits » du PDF (`get_report_top_products`, `0086`)** — daté sur `created_at` et **sans aucun filtre de statut** : une commande **annulée** ou **refusée** contribue son montant. Son jumeau du Tableau (« Produits les plus vendus ») et celui de l'assistant (`get_top_products`) ont été **retirés** par `COHERENCE-01` ; **celui du PDF reste, et reste faux.** Un doublon retiré d'un écran et conservé dans un document est un écart, pas une clôture.
4. **`get_dashboard_top_products` (`0104`) est une RPC orpheline** depuis `COHERENCE-01` : plus aucun appelant. Non supprimée — ce serait une migration pour rien.
5. **Le numérateur du « Taux confirmation »** est structurellement sous-compté : il compte les transitions `to_status='CONFIRMEE'`, or `programmer` pose `cod_status='PROGRAMMEE'` et `visibleAllowedActions` masque `confirmer` dès que `programmer` est proposée. Ce n'est pas un défaut de date ; il n'a pas été instruit.
6. **Les `scheduled_for` déjà écrits dans un autre fuseau** restent faux, et les `cash_collected_at` qui en dérivent aussi. Dette de **données**, non corrigée par construction (§4-c1).
7. ~~**`driver-cash-panel.tsx`** recalcule ses bornes côté client (§4-c2).~~ **CLOS par `FIX-DATE-RANGE-TZ-01`** (#232, `d2959e2`) : le recalcul client existe toujours, mais il rend les mêmes bornes que le serveur (§4-c2).
8. ~~**Dépendance de l'ancien calcul de période au fuseau du processus.**~~ **CLOS par `FIX-DATE-RANGE-TZ-01`** (#232, `d2959e2`). Cette dette était formulée jusque-là comme « trois tests de `tests/unit/period-range.test.ts` ne passent que sous `TZ=UTC` » ; **ce chiffre n'a jamais désigné un ensemble stable**. Mesuré au diagnostic (`DIAG-TZ-01`) : trois échecs sous `Europe/London`, deux sous `America/New_York` dans la mesure initiale, puis les mutations complètes ont montré que **le nombre et l'identité des assertions rouges variaient avec le signe du décalage** — un décalage positif cassait les bornes **basses**, un décalage négatif les bornes **hautes**. La dette réelle était la dépendance du calcul au fuseau du processus ; les tests rouges n'en étaient que les symptômes.

   **Preuve de clôture — ce sous quoi tout futur changement de ce calcul doit tenir.** `tests/unit/period-range.test.ts` vert sous **`Africa/Dakar`, `UTC`, `Europe/London` et `America/New_York`** (ce dernier à décalage **négatif**), et comportant un **cas hiver/été croisé** dans les deux sens (:135 et :153) — le seul à distinguer un décalage appliqué à `now()` d'un décalage appliqué à la date analysée. `[Fait]` Rejoué le 2026-09-24 sur `d2959e2`, depuis PowerShell : 13/13 sous chacun des quatre fuseaux, le fuseau effectif du processus ayant été vérifié pour chacun par les trois sondes du mode opératoire ci-dessous (décalages mesurés : `0`/`0`, `0`/`0`, `-60`/`0`, `240`/`300` pour juin/janvier).

   `[Fait]` **Cette matrice n'est pas rejouée par la CI** : le job `test-unit` de `ci.yml` ne pose pas de `TZ` et hérite de celui du runner. Les tests fixent eux-mêmes la zone attendue et pinnent des instants, ce qui les rend probants sous n'importe quel fuseau ; mais la preuve multi-fuseaux ci-dessus reste une exécution manuelle, à refaire à la main à chaque modification de `lib/periods/date-range.ts`.

   **Mode opératoire pour la refaire — observation datée, pas une propriété générale.** Pendant `DIAG-TZ-01`, sur le poste et dans la session d'outil observés, une affectation `TZ=…` passée depuis Bash n'a pas atteint le processus Node comme attendu ; la mesure fiable a été obtenue depuis PowerShell (`$env:TZ = '…'`). **Ce n'est ni une propriété de Bash, ni de POSIX** — c'est un fait de cet outil dans cette session. La conduite qui en découle vaut partout : **avant de conclure qu'un fuseau n'a aucun effet, vérifier dans le processus mesuré `process.env.TZ`, la zone résolue par `Intl.DateTimeFormat().resolvedOptions().timeZone`, et le décalage effectif (`new Date('2026-06-01T00:00:00').getTimezoneOffset()`, puis une date d'hiver).** Un test « vert sous `Europe/London` » dont le processus tournait en réalité en UTC ne prouve rien.
9. **Les bornes du rapport PDF restent dans le fuseau du processus — non corrigées, sans couverture dédiée.** `app/api/rapport/route.tsx`:26 (`` new Date(`${value}T00:00:00`) ``), :33 (`setHours(23, 59, 59, 999)`), :41-42 (`setHours(0,0,0,0)` / `setDate`) ; puis `lib/report/data.ts`:180-186, où la série du graphe est pré-peuplée par `setHours(0,0,0,0)` / `setDate` et indexée par une clé UTC (`dateKey`, :166). `FIX-DATE-RANGE-TZ-01` n'a **pas** touché ces fichiers : la correction de `lib/periods/date-range.ts` ne se généralise pas à tous les calculs de dates du dépôt. Lot distinct, correctif non conçu ici.
