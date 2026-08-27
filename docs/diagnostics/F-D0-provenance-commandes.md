# Phase F · Lot D0/D0-bis — Diagnostic de provenance des commandes (`ntmwxz-83.myshopify.com`)

**Statut : diagnostic en cours de clôture (D0-bis).** D0 a posé les questions et les requêtes ; une
requête complémentaire exécutée par le fondateur (croisement `created_at`/`created_at_shopify` par
jour) a produit une mesure qui **corrige la prémisse initiale** : le volume réel de la boutique est
~1 509 commandes (et non 194, qui est une fenêtre de 30 jours), et l'ingestion par réconciliation
fonctionne en continu depuis le 24 juin 2026 — le webhook seul n'a jamais existé, pas l'ingestion
dans son ensemble. Voir Bloc E pour le détail. **Les Blocs E, F, G, H ci-dessous sont le lot
D0-bis** : ils ferment les questions ouvertes de D0 sur cette base corrigée. Tant que les requêtes
encore marquées « en attente » n'ont pas de sortie, la section 1 et le verdict final (section 6)
restent partiels.

Aucune requête n'a été exécutée par l'agent. Aucune migration, aucune écriture, aucun `db push`.
Une correction a été apportée à `CLAUDE.md` (attestation de migration périmée, section 6 du prompt
D0-bis) — voir le commit correspondant, hors périmètre de ce fichier.

---

## 0. Comment utiliser ce document

Chaque requête ci-dessous est autonome (elle résout elle-même `ntmwxz-83.myshopify.com` en
`shop_id`/`merchant_account_id` via une CTE `target_shop`). Exécuter chacune sur la base liée en
production, coller la sortie brute sous la question correspondante. Ne pas arrondir, ne pas
résumer les `NULL`/valeurs vides en les fusionnant avec une valeur littérale.

**Une requête est marquée `[TABLE POSSIBLEMENT ABSENTE]` quand elle porte sur `store_connection` /
`external_ref` / `ingestion_event` (migration `0142`, mergée mais confirmée non déployée en prod au
2026-08-24 par l'attestation en tête de `CLAUDE.md`).** Si ces requêtes échouent avec
`relation "..." does not exist`, c'est en soi une réponse : le registre L1/L2 n'est pas encore actif
sur cette base, donc aucune de ces commandes ne peut avoir été écrite par le chemin opaque L3.
Recopier l'erreur telle quelle plutôt que de la contourner.

---

## 1. Réponse en dix lignes

1. La boutique pilote a réellement ~1 509 commandes, remontant au 18 avril 2026 — 194 n'était
   qu'une fenêtre de 30 jours (29 juillet → 27 août), pas un total.
2. Aucune de ces commandes n'est passée par un webhook Shopify : `webhook_event` est vide pour ce
   domaine, confirmé par le code (les deux endpoints webhook écrivent systématiquement cette table).
3. L'ingestion réelle vient du cron de réconciliation nocturne (`persistShopifyOrder`, bulk Admin
   API, 02:00 UTC quotidien, tous shops Shopify actifs) — capacité confirmée par le code, usage
   confirmé par la mesure : rattrapage massif 17–23 juin (919 commandes), puis régime stable à
   0,1–0,3 jour de décalage depuis le 24 juin, signature d'un cron quotidien et non d'un flux
   temps réel.
4. Une part additionnelle vient de la saisie manuelle (`manual`/`whatsapp`/…), chemin réel et
   distinct, distinguable sans ambiguïté par `shopify_order_id IS NULL` — reste à chiffrer (Bloc E).
5. Un trou d'insertion existe du 12 au 17 août (aucune ligne insérée, la reprise du 18 août ne
   rattrape rien) — cause non établie (échec silencieux du cron le plus probable au vu du code :
   `last_reconciled_at` avance même si des commandes échouent à se persister, donc rien ne les
   rejoue automatiquement), à confirmer par une action fondateur (Bloc E3).
6. Le code confirme au moins **quatre axes de date différents** utilisés selon l'écran/la carte
   (`created_at`, `created_at_shopify`, `cash_collected_at`, `order_state_transition.created_at`,
   plus des axes non-commande comme `returned_at`/`settled_at`/`spent_at`) — voir le tableau
   exhaustif Bloc F. C'est la source structurelle des deux divergences constatées en production.
7. Les deux divergences (taux de refus, cash livreurs vs CA) sont des différences de définition/
   portée temporelle réelles dans le code, pas des bugs de calcul — confirmé en D0, non re-mesuré.
8. Le contrat F0 amendé (date de reconnaissance = encaissement) pointe vers `cash_collected_at`
   comme axe correct — mais sa fiabilité (taux de `NULL` parmi les commandes encaissées) n'est pas
   encore mesurée (Bloc F3, en attente).
9. `order_number` est un mélange d'au moins trois formats (`#n` Shopify, `M-n` manuel, `MAN-
   <timestamp>` legacy) — toute analyse de trous par numérotation est abandonnée, pas seulement
   mise en garde (Q9 de D0 est donc close par un refus méthodologique, pas par une mesure).
10. **Verdict encore ouvert** : l'aptitude Phase F (produit résolu, coût de revient, lot d'achat) et
    la fiabilité de `cash_collected_at` restent en attente des requêtes Bloc F3/G. Le premier
    critère de clôture (section 9 du prompt D0-bis) ne peut pas encore recevoir de oui/non motivé.

---

## Bloc A — Provenance

### Q1. Total et fenêtre 30 jours

```sql
with target_shop as (
  select id as shop_id, merchant_account_id
  from public.shop
  where shop_domain = 'ntmwxz-83.myshopify.com'
)
select
  (select count(*) from public.orders o join target_shop t on o.shop_id = t.shop_id)
    as total_orders_all_time,
  (select count(*) from public.orders o join target_shop t on o.shop_id = t.shop_id
     where o.created_at >= now() - interval '30 days')
    as orders_created_last_30d,
  (select count(*) from public.orders o join target_shop t on o.shop_id = t.shop_id
     where o.created_at_shopify >= now() - interval '30 days')
    as orders_shopify_date_last_30d,
  (select count(*) from public.orders o join target_shop t on o.shop_id = t.shop_id
     where o.created_at_shopify is null)
    as orders_without_shopify_created_at;
```

**À prouver :** si `total_orders_all_time = 194`, l'écran Analyses affiche un total sans fenêtre
temporelle (ou une fenêtre plus large que 30j). Si aucune des deux colonnes fenêtrées ne vaut 194
non plus, le chiffre affiché vient d'un filtre applicatif (statut, canal) qu'il faut retrouver dans
le code de `/analyses` plutôt que le supposer.

*Sortie : en attente.*

### Q2. Répartition exacte de `orders.source`

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
)
select
  o.source,
  (o.source is null) as is_null,
  (o.source = '') as is_empty_string,
  count(*) as n
from public.orders o
join target_shop t on o.shop_id = t.shop_id
group by o.source
order by n desc;
```

**À prouver :** `NULL` et `''` doivent apparaître comme deux lignes distinctes si les deux existent
— ne pas les additionner en lisant le résultat.

*Sortie : en attente.*

### Q3. Que signifie « canal inconnu » à l'écran — établi par le code

**Réponse (pas une requête) :** `lossSource()`, `lib/loss-analytics/metrics.ts:306-308` :

```ts
function lossSource(source: string | null): string {
  return source?.trim() || 'inconnu';
}
```

`NULL`, chaîne vide et chaîne composée uniquement d'espaces sont **traités de façon identique** —
tous tombent dans le fallback truthy `||` vers la chaîne littérale `'inconnu'`. Ce n'est pas un
switch/map avec des cas nommés, c'est un simple test de vérité. Le résultat alimente
`sourceAggregates`/`sourceScorecard` (`metrics.ts:497`) et est rendu tel quel (sans relabellisation
supplémentaire) dans le tableau de `/analyses` (`app/(app)/analyses/page.tsx:247`, `<td>
{item.source}</td>`). Une clé i18n orpheline `messages/fr.json:1248` (`"unknownSource": "inconnu"`)
existe mais n'est appelée nulle part dans le dépôt (grep négatif) — code mort probable, distinct du
vrai fallback ci-dessus. **Conséquence pour Q2 :** la requête Q2 doit être lue avec ce fallback en
tête — `NULL` et `''` produiront le même libellé à l'écran même s'ils sont deux populations
distinctes en base.

### Q4. Chemins d'écriture — établi par le code (graphe d'appel)

Voir le tableau complet section 3. Quatre chemins identifiés, tous les quatre atteignables en
production aujourd'hui : webhook legacy, webhook opaque (L3), cron de réconciliation, action
serveur de création manuelle. Aucun script de seed n'insère dans `orders` (grep négatif sur
`scripts/**`, pas de répertoire `supabase/seed`).

### Q5/Q7. Traces croisées — LA requête discriminante

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
)
select
  coalesce(o.source, '<NULL>') as source,
  count(*) as n,
  count(*) filter (where o.shopify_order_id is not null) as with_shopify_order_id,
  count(*) filter (where o.shopify_order_id is null) as without_shopify_order_id,
  min(o.created_at) as first_created_at,
  max(o.created_at) as last_created_at
from public.orders o
join target_shop t on o.shop_id = t.shop_id
group by o.source
order by n desc;
```

**Comment interpréter chaque cas :**
- Une ligne `source = <NULL ou une valeur Shopify plausible>` avec `with_shopify_order_id = n`
  (100%) et `without_shopify_order_id = 0` → cohérent avec le **chemin cron de réconciliation**
  (`persistShopifyOrder`, `lib/shopify/orders-sync.ts:684-688`), qui pose toujours
  `shopify_order_id` et ne passe jamais par le webhook.
- Une ligne `source ∈ {manual, whatsapp, instagram, tiktok, facebook, appel}` avec
  `with_shopify_order_id = 0` (100%) → cohérent avec **l'action de création manuelle**
  (`lib/actions/orders.ts:1506-1525`, qui pose `shopify_order_id: null` explicitement).
- Un mélange dans une même valeur de `source` casserait cette lecture binaire — le signaler tel
  quel plutôt que de forcer une conclusion.

Compléter avec une preuve négative sur le webhook :

```sql
with target_shop as (
  select shop_domain from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
)
select count(*) as webhook_event_rows_for_this_domain
from public.webhook_event w
join target_shop t on w.shop_domain = t.shop_domain;
```

**À prouver :** ce compte doit être 0, cohérent avec le fait donné en tête de brief. S'il n'est pas
0, le fait donné est faux et doit être corrigé avant de poursuivre — ne pas ignorer un résultat
contraire à la prémisse du lot (règle de méthode : « si une réponse contredit ce prompt, c'est ce
prompt qui a tort »).

Si applicable, croiser aussi avec `shop.last_reconciled_at` pour dater le dernier passage du cron :

```sql
select shop_domain, status, installed_at, last_reconciled_at
from public.shop
where shop_domain = 'ntmwxz-83.myshopify.com';
```

*Sorties : en attente.*

### Q6. Distribution des dates de création, par jour

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
)
select
  date_trunc('day', o.created_at) as day,
  count(*) as n
from public.orders o
join target_shop t on o.shop_id = t.shop_id
group by 1
order by 1;
```

**Rappel gotcha projet :** `date_trunc` dépend du fuseau de la session Postgres — si l'exécution
se fait via un client qui ne fixe pas explicitement `timezone`, noter le fuseau de session utilisé
à côté du résultat plutôt que de le supposer UTC. **À constater sans interpréter au-delà de la
forme** : une poignée de jours avec un pic massif est compatible avec un import en masse (backfill
cron) ; une distribution étalée est compatible avec une activité continue. Rapporter la forme
observée, pas une conclusion causale.

*Sortie : en attente.*

---

## Bloc B — Exhaustivité

### Q8. Exhaustivité — déterminable en base ?

**Ne peut être répondu qu'après Q1/Q2/Q5/Q9.** Sans un système externe de référence (export
Shopify Admin indépendant, ou tableau `store_connection`/`ingestion_event` qui n'existe pas encore
en prod — voir avertissement en tête de document), la base seule ne peut prouver l'exhaustivité,
seulement l'absence de trous internes (Q9). Si Q9 ne révèle aucun trou, la réponse honnête reste
« non déterminable en base à 100 %, mais aucun indice interne de manque » — pas « oui, exhaustif ».
Ce qu'il faudrait pour trancher : un export Admin API Shopify du nombre réel de commandes de la
boutique sur la même fenêtre, comparé au compte SQL.

### Q9. Trous — numérotation (ABANDONNÉE, Bloc G2) et périodes creuses

**L'analyse de trous par `order_number` est abandonnée, pas seulement mise en garde.** Établi par
lecture de code (Bloc G2) : `order_number` mélange au moins trois formats indépendants selon le
chemin d'écriture — `#<n>` (le `name` Shopify, `lib/shopify/orders-sync.ts:454`, une séquence que
l'app ne contrôle pas), `M-<n>` (compteur `reserve_manual_order_number`, per-`merchant_account_id`,
indépendant de Shopify, `supabase/migrations/0101_manual_order_number_counter.sql:24-52`), et un
format historique `MAN-<timestamp>` que la migration `0101` documente explicitement ne jamais lire
ni corriger. Ce n'est pas une séquence unique et monotone par boutique : toute lecture d'écart
comme un « trou » serait une conclusion non supportée. Ne pas exécuter de requête de ce type.

Compléter par une recherche de périodes creuses (celle-ci reste valide, indépendante de
`order_number`) :

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
),
days as (
  select date_trunc('day', o.created_at) as day
  from public.orders o join target_shop t on o.shop_id = t.shop_id
  group by 1
),
bounds as (select min(day) as lo, max(day) as hi from days),
calendar as (
  select generate_series(lo, hi, interval '1 day') as day from bounds
)
select c.day
from calendar c
left join days d on d.day = c.day
where d.day is null
order by c.day;
```

*Sorties : en attente.*

### Q10. Le cron de réconciliation couvre-t-il cette boutique — établi par le code

**Réponse (pas une requête), confirmée directement dans le code, pas déduite :**
`reconcileShopOrders` (`lib/shopify/reconcile.ts:84`) tire toutes les commandes Shopify modifiées
depuis `shop.last_reconciled_at` via une opération bulk GraphQL Admin API
(`startBulkOrdersOperation`, ligne 96), **indépendamment de toute livraison webhook**. La fonction
appelante `persistBulkOrders` (ligne 27→61-66) appelle `persistShopifyOrder` en boucle, qui insère
dès qu'aucune ligne locale ne correspond à `(merchant_account_id, shopify_order_id)`
(`orders-sync.ts:633-644, 683-701`) — **il n'y a aucune garde « mise à jour seulement »**. **Donc
oui : ce cron peut créer en base une commande jamais reçue par webhook.** Ceci ferme la dette
ouverte documentée dans `CLAUDE.md` (« cette question est ouverte dans les dettes du projet »).
Reste à vérifier par Q5 si ce mécanisme a **effectivement** été le chemin emprunté pour les 194
commandes de ce tenant (le code prouve la capacité, pas l'usage réel sur ce tenant précis — ne pas
confondre les deux).

Requête pour objectiver l'usage réel :

```sql
select shop_domain, last_reconciled_at
from public.shop
where shop_domain = 'ntmwxz-83.myshopify.com';
```

Si `last_reconciled_at` est renseigné et récent, le cron a tourné sur cette boutique — cohérent
avec (mais pas suffisant seul pour prouver) l'hypothèse cron comme origine principale.

*Sortie : en attente.*

---

## Bloc C — Utilisabilité pour la Phase F

### Q11. Lignes de commande et résolution produit

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
)
select
  ol.match_status,
  (ol.product_id is null) as product_id_is_null,
  count(*) as n
from public.order_line ol
join public.orders o on o.id = ol.order_id
join target_shop t on o.shop_id = t.shop_id
group by ol.match_status, (ol.product_id is null)
order by n desc;
```

*Sortie : en attente.*

### Q12. Coût de revient exploitable par ligne — origine du coût

`lib/finance/profit.ts:89-96` (`effectiveUnitCost`) définit trois niveaux, dans cet ordre
d'autorité : (1) `stock_movement.unit_cost` figé au moment du mouvement `sold` si `> 0` —
authoritatif ; (2) sinon le CUMP courant du produit (`product_stock.unit_cost`) si `> 0` —
marqué comme estimation ; (3) sinon `unknown`. `purchase_lot_line.landed_unit_cost` n'est **pas**
consulté directement à cet endroit — il n'alimente le CUMP que par ricochet, via le recalcul
`purchase_in` dans `post_stock_movement` (`0033_phase5_purchase_lots.sql:466-482`).

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
),
sold as (
  select sm.id, sm.unit_cost as frozen_unit_cost, sm.product_id
  from public.stock_movement sm
  join public.orders o on o.id = sm.order_id
  join target_shop t on o.shop_id = t.shop_id
  where sm.movement_type = 'sold'
),
priced as (
  select
    s.id,
    case
      when s.frozen_unit_cost is not null and s.frozen_unit_cost > 0 then 'frozen'
      when ps.unit_cost is not null and ps.unit_cost > 0 then 'current_cump_fallback'
      else 'unknown'
    end as cost_origin
  from sold s
  left join public.product_stock ps on ps.product_id = s.product_id
)
select cost_origin, count(*) as n
from priced
group by cost_origin
order by n desc;
```

**Avertissement :** cette requête reconstruit `effectiveUnitCost` en SQL pour compter — elle doit
donner le même total de lignes `sold` que Q13 ci-dessous (même population). Si les totaux
divergent, la reconstruction SQL a une erreur et il faut le signaler, pas ajuster silencieusement.

*Sortie : en attente.*

### Q13. Recoupement avec les deux avertissements de production

Établi par le code (`lib/finance/profit.ts:257,261-263`), formules exactes :

- **« N commandes encaissées sans coût de revient connu »** — population = `collectedOrders`
  (commandes encaissées). `cogsExcludedOrderCount = collectedOrders.filter(o =>
  !costedOrderIds.has(o.id)).length`, où `costedOrderIds` = ensemble des commandes ayant au moins
  une ligne `sold` avec un coût connu (frozen ou fallback CUMP, jamais `unknown`).
- **« N lignes vendues sans coût de revient »** — population = **lignes** `stock_movement` de type
  `sold` liées aux commandes encaissées, comptées quand `unknown = true`
  (`cogsUnknownLineCount = costedCollected.filter(m => m.unknown).length`).

Ces deux nombres comptent des populations différentes (commandes vs lignes) — ne jamais les
confondre ni les additionner. Requête de reproduction (nécessite de rejouer la définition
« encaissée » — voir Q14 pour la définition exacte de `collectedOrders` avant d'écrire cette
requête, faute de quoi le résultat ne sera pas comparable à l'écran) :

```sql
-- Nécessite d'abord de confirmer, par lecture de lib/finance/profit.ts au-delà des lignes déjà
-- citées, la clause exacte de collectedOrders (probablement cash_state='collected' scopé période)
-- avant exécution — ne pas deviner le filtre ici.
```

*Section volontairement laissée en requête ouverte : compléter après lecture du filtre amont de
`collectedOrders` dans `lib/finance/profit.ts`, non auditée dans cette passe.*

### Q14. Statut terminal calculable — établi par le code

`cod_status = 'LIVREE'` est dérivé (`deriveLegacyStatusFromDimensions`,
`lib/domain/order-transition-actions.ts:385-421`) quand `delivery_state = 'delivered'` et la
commande n'est ni `cancelled` ni `returned`. **Mais `LIVREE` n'est pas terminal au sens de la
machine à états** (`lib/domain/order-state-machine.ts:42,68-70` — `LIVREE → A_APPELER` reste légal
via `invalider`). Donc « livrée » seule ne suffit pas : il faut la combiner avec l'absence d'un
`invalider` ultérieur. Le retour/RTO est détecté par un flux d'événements
(`hasReturnEvent`/`hasRtoEvent`, `lib/loss-analytics/metrics.ts:420-426`), pas par un champ unique.
**Conclusion : oui, calculable aujourd'hui, mais seulement en combinant les quatre dimensions
(`order_state`/`call_state`/`delivery_state`/`cash_state`) avec le flux d'événements dérivé du
journal d'activité — pas par un simple filtre `cod_status = 'LIVREE'`.**

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
)
select
  o.cod_status,
  o.delivery_state,
  o.cash_state,
  o.order_state,
  count(*) as n
from public.orders o
join target_shop t on o.shop_id = t.shop_id
group by 1, 2, 3, 4
order by n desc;
```

*Sortie : en attente — permettra de voir combien de commandes sont `LIVREE`+`collected` sans
information supplémentaire nécessaire pour vérifier l'absence de retour ultérieur.*

### Q15. Lots d'achat renseignés

```sql
with target_shop as (
  select id as shop_id, merchant_account_id from public.shop
  where shop_domain = 'ntmwxz-83.myshopify.com'
),
products_with_lots as (
  select distinct pll.product_id
  from public.purchase_lot_line pll
  join public.product p on p.id = pll.product_id
  join target_shop t on p.merchant_account_id = t.merchant_account_id
)
select
  (select count(*) from public.product p join target_shop t
     on p.merchant_account_id = t.merchant_account_id) as total_products,
  (select count(*) from products_with_lots) as products_with_at_least_one_lot;
```

**Note :** aucune vue ou colonne pré-agrégée n'existe pour ce décompte (constaté par lecture de
code) — cette requête est la seule source de vérité, elle doit être exécutée sur les données
réelles, pas estimée.

*Sortie : en attente.*

---

## Bloc D — Les deux divergences constatées

### Q16. Taux de refus 31,579 % (Finances) vs 0 % (Analyses) — établi par le code

**Deux formules réellement différentes, pas la même mesure sous deux habillages.**

- **Finances** (`finance_kpis`, `supabase/migrations/0119_finance_kpis_cash_collected_at.sql:133-169`) :
  `taux_refus = 100 * refused / decided`, où `refused = count(cod_status in ('REFUSEE','ANNULEE'))`
  et `decided = count(cod_status in ('LIVREE','REFUSEE','ANNULEE'))`, filtré sur
  `orders.created_at` dans la fenêtre période. `REFUSEE` couvre `delivery_state ∈
  {failed,returned}` **ou** `order_state='returned'` ; `ANNULEE` couvre `order_state='cancelled'`.
  Ce chiffre mélange donc annulations pré-dispatch, échecs de livraison et retours.
- **Analyses** (`rtoRate`, `lib/loss-analytics/metrics.ts`) : `RTO_DELIVERY_STATES = {'failed'}`
  uniquement (ligne 3) — exclut explicitement `returned` et `order_state='cancelled'` (ces derniers
  alimentent un `cancellationRate` séparé, jamais affiché comme « refus »).
  `rtoRate = rtoCount / (deliveredCount + rtoCount)`, même champ de date `created_at`.

**Verdict du code : les deux chiffres sont probablement corrects chacun pour leur propre
définition — c'est un problème d'étiquetage (les deux se traduisent vaguement par « refus » dans
l'UI) et non un bug de calcul.** Si, sur ce tenant/période, aucune commande refusée n'a
`delivery_state='failed'` (toutes en `ANNULEE` ou `returned`), Finances affiche 31,579 % et
Analyses affiche légitimement 0 %. Ceci n'est pas vérifié sur les données réelles dans cette passe
— requête de confirmation :

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
)
select
  o.cod_status,
  o.delivery_state,
  o.order_state,
  count(*) as n
from public.orders o
join target_shop t on o.shop_id = t.shop_id
where o.cod_status in ('REFUSEE', 'ANNULEE')
group by 1, 2, 3
order by n desc;
```

*Sortie : en attente — doit confirmer qu'aucune ligne n'a `delivery_state = 'failed'`.*

### Q17. Cash livreurs 1 539 116 F vs CA période 495 405 F — établi par le code

**Confirmé : solde cumulé vs flux de période, affichés côte à côte sans distinction de portée
temporelle.**

- `get_driver_cash_consolidation` (`0100_driver_cash_consolidation_period_remitted.sql:30-87`) :
  la CTE `driver_orders` qui alimente `cash_on_hand_minor` **n'a aucun prédicat de date**. Les
  colonnes `p_period_from`/`p_period_to` ne filtrent qu'une sortie `period_*` séparée, jamais
  consommée par `getDriversCashOnHandTotal` (`lib/actions/drivers.ts:613-632`), qui n'appelle
  d'ailleurs même pas la RPC avec ces paramètres. C'est un **solde à date, toutes périodes
  confondues**.
- Le CA de 495 405 F correspond, selon l'emplacement d'affichage (`OperationsEssentialsSection`,
  `app/(app)/tableau/page.tsx:242-313`), à `get_dashboard_cash_collected_total`
  (`0098_dashboard_cash_collected_and_deliveries.sql:52-53`), qui filtre bien
  `o.cash_collected_at between p_from and p_to` — **un flux borné à la fenêtre du PeriodPicker.**

Les deux figurent côte à côte (`tableau/page.tsx:275-313`) sans étiquette indiquant leur portée
temporelle différente (`cashHint`, lignes 268-270, ne précise que le nombre de livreurs). **C'est
un fait de présentation constaté par le code, pas une hypothèse.**

---

## Bloc E — Provenance, clôture (D0-bis)

### E1. La requête discriminante — étendue avec `created_at_shopify`

Remplace/étend la requête Q5/Q7 de D0 (déjà non bornée sur la période — c'est bien la totalité de
la boutique) :

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
)
select
  coalesce(o.source, '<NULL>') as source,
  count(*) as n,
  count(*) filter (where o.shopify_order_id is not null) as with_shopify_order_id,
  count(*) filter (where o.shopify_order_id is null) as without_shopify_order_id,
  count(*) filter (where o.created_at_shopify is null) as without_created_at_shopify,
  min(o.created_at) as first_created_at,
  max(o.created_at) as last_created_at
from public.orders o
join target_shop t on o.shop_id = t.shop_id
group by o.source
order by n desc;
```

**Hypothèse à confronter explicitement au résultat, sans la présumer vraie :** les 14 commandes
sans `created_at_shopify` (fait mesuré en amont) correspondent aux commandes manuelles. Si le
compte de `without_created_at_shopify` toutes sources confondues ne fait pas exactement 14, ou si
ces lignes ne sont pas concentrées sur `source ∈ {manual,whatsapp,instagram,tiktok,facebook,
appel}`, le dire précisément — ne pas arrondir à « à peu près confirmé ».

*Sortie : en attente.*

### E2. Dater et qualifier le cron — établi par le code + une mesure à confirmer

**Établi par le code :** planification `vercel.json:9-12`, `"schedule": "0 2 * * *"` (quotidien
02:00 UTC), route `app/api/cron/shopify-reconcile`. Sélection des boutiques :
`app/api/cron/shopify-reconcile/route.ts:37-40`, `.eq('store_kind','shopify').eq('status','active')`
— **toutes** les boutiques Shopify actives, à chaque exécution, aucun sous-ensemble ni tirage.
`last_reconciled_at` est avancé à `now()` **inconditionnellement** après la boucle de persistance,
même si des commandes individuelles échouent (`lib/shopify/reconcile.ts:74-77`, ne teste pas
`failedCount`) — **une commande qui échoue à se persister n'est donc jamais rejouée
automatiquement**, la fenêtre de réconciliation avance sans elle. Une erreur au niveau boutique
(`needs_reauth`/`token_error`/`bulk_failed`) déclenche un `Sentry.captureMessage` de niveau
`warning` (`route.ts:64-69`) ; un échec partiel intra-bulk (`ok:true`, `failedCount>0`) **ne
déclenche aucune alerte** — visible seulement dans le corps JSON de la réponse HTTP du cron, que
personne ne consulte en routine. Ceci explique structurellement le mécanisme d'un trou silencieux
sans qu'aucune alerte ne se déclenche (cf. E3).

**Fréquence attendue vs décalage observé :** un cron quotidien à 02:00 UTC produit un décalage
`created_at − created_at_shopify` borné par ~24h dans le pire cas et proche de 0 juste après passage
— cohérent avec le régime observé de 0,1 à 0,3 jour depuis le 24 juin. Aucun autre chemin
d'écriture n'est nécessaire pour expliquer ce régime.

Requête de confirmation :

```sql
select shop_domain, status, installed_at, last_reconciled_at
from public.shop
where shop_domain = 'ntmwxz-83.myshopify.com';
```

*Sortie : en attente.*

### E3. Le trou du 12–17 août

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
)
select
  count(*) as commandes_shopify_creees_12_au_17_aout,
  min(o.created_at) as insertion_la_plus_ancienne,
  max(o.created_at) as insertion_la_plus_recente
from public.orders o
join target_shop t on o.shop_id = t.shop_id
where o.created_at_shopify >= timestamptz '2026-08-12'
  and o.created_at_shopify < timestamptz '2026-08-18';
```

**Comment lire chaque résultat :**
- Si `count > 0` et les insertions sont postérieures au 18 août → le trou est un **trou
  d'insertion** (rattrapage tardif), pas un trou de données — cohérent avec un cron qui a fini par
  rattraper la fenêtre à une exécution ultérieure.
- Si `count = 0` → indéterminable en base seule entre « aucune vente réelle sur cette fenêtre » et
  « commandes définitivement perdues » (cf. le mécanisme E2 : un échec de persistance n'est jamais
  rejoué). C'est précisément le cas où l'action fondateur ci-dessous est nécessaire.

**Action fondateur requise (aucune alternative en base) :** obtenir depuis le Shopify Admin de
`ntmwxz-83.myshopify.com` le nombre de commandes créées entre le 12 et le 17 août 2026 inclus, et
le comparer au résultat de la requête ci-dessus. Un écart positif (Admin > base) confirme la perte
silencieuse ; une égalité confirme l'absence de vente réelle sur la fenêtre.

*Sortie requête : en attente. Action fondateur : en attente.*

---

## Bloc F — Axes de date (le défaut le plus lourd pour la Phase F)

### F1. Inventaire exhaustif des axes de date

| Fonction/module | Écran | Axe de date | Citation |
|---|---|---|---|
| `finance_kpis` (ca_livre, delivered_orders_count) | /finances P&L | `orders.cash_collected_at` | `0119_finance_kpis_cash_collected_at.sql:73,146,152` |
| `finance_kpis` (taux_refus) | /finances | `orders.created_at` | `0119...sql:139-140` |
| `finance_kpis` (encaisse) | /finances | `cash_settlement.settled_at` | `0119...sql:160-161` |
| `finance_kpis` (cash_chez_livreurs / a_encaisser) | /finances | **aucun** — solde cumulé | `0119...sql:88-132` |
| `cash_aging` | /finances (aging) | **aucun** — pas de `p_from/p_to` | `0017_cash_reconciliation.sql:183-221` |
| `get_dashboard_cash_collected_total` | /tableau (CA encaissé) | `orders.cash_collected_at` | `0098_dashboard_cash_collected_and_deliveries.sql:52-53` |
| `get_dashboard_cash_collected_total` (returns) | /tableau | `orders.returned_at` | `0098...sql:62-63` |
| `get_dashboard_deliveries_by_product` | /tableau | `orders.cash_collected_at` | `0098...sql:112-113` |
| `get_dashboard_cod_breakdown` | /tableau | `orders.created_at` | `0104_dashboard_period_aware_optional_shop.sql:20` |
| `get_dashboard_shop_performance` | /tableau | `orders.created_at` | `0129_workspace_legacy_dashboard_compat.sql:39` |
| `get_dashboard_top_products` | /tableau | `orders.created_at` | `0104...sql:73` |
| `get_dashboard_priority_counts.a_appeler` | /tableau | `orders.created_at` | `0082_priority_a_rappeler_align_list.sql:44-45` |
| `get_dashboard_priority_counts.a_rappeler` | /tableau | **aucun** | `0082...sql:50-56` |
| `get_dashboard_priority_counts.en_livraison`/`annulees_retours` | /tableau | `order_state_transition.created_at` | `0082...sql:65-66,77-78` |
| `get_dashboard_kpi` (a_appeler_count/delta) | /tableau KPI | `orders.created_at` (fenêtre 7j glissante) | `0076_dashboard_kpi_a_appeler_7d_window.sql:51,59-60` |
| `get_dashboard_kpi` (ca_collecte_7j) | /tableau KPI | `orders.cash_collected_at` (+ `returned_at`) | `0076...sql:71,80,169,179` |
| `get_dashboard_kpi` (ca_en_attente, taux_livraison) | /tableau | **aucun** — cumulé | `0076...sql:89-94,141-144` |
| `get_dashboard_kpi` (taux_confirmation) | /tableau | `orders.created_at` (30j glissant) | `0076...sql:111` |
| `revenue-30d`/`aggregateRevenue30d` | /tableau (graphe 30j) | `orders.cash_collected_at` (repli `created_at_shopify ?? created_at` si null) | `lib/dashboard/revenue-30d.ts:50-56` ; `lib/actions/dashboard.ts:505-517` |
| `get_driver_cash_consolidation` (expected/collected/remitted/cash_on_hand) | /finances, /livreurs | **aucun** — cumulé (confirmé D0) | `0100...sql:88-132,156-167` |
| `get_driver_cash_consolidation` (period_collected/period_delivery_fees) | /livreurs (carte période) | `orders.created_at` | `0100...sql:110-111,118-119` |
| `get_driver_cash_consolidation` (period_remitted) | /livreurs | `settlement_allocation.created_at` | `0100...sql:142-143` |
| `get_driver_cash_outstanding_orders` | /finances, /livreurs | **aucun** — cumulé | `0083_driver_cash_consolidation.sql:198-201` |
| `get_report_status_breakdown` | Rapport PDF | `orders.created_at` | `0085_report_non_cash_aggregates.sql:105-106` |
| `get_report_revenue_by_day` | Rapport PDF | filtre `created_at`, bucket `coalesce(updated_at,created_at)` | `0085...sql:140,147-148` |
| `get_report_top_products` | Rapport PDF | `orders.created_at` | `0086_report_top_products_fix_ambiguous_title.sql:69-70` |
| `get_report_driver_cash_pending` | Rapport PDF | `orders.created_at` | `0084_report_driver_cash_pending.sql:90-91` |
| `get_finance_collected_joins` | /finances P&L | `orders.cash_collected_at` | `0087_finance_report_joins.sql:79-80` |
| `get_finance_returned_joins` | /finances P&L | `orders.returned_at` | `0087...sql:127-129` |
| `fetchFinanceReport` (collectedOrders) | /finances P&L | `orders.cash_collected_at` | `lib/finance/report-data.ts:56-58` |
| `fetchFinanceReport` (returned) | /finances P&L | `orders.returned_at` | `lib/finance/report-data.ts:73-76` |
| `fetchFinanceReport` (expenses) | /finances P&L | `expense.spent_at` | `lib/finance/report-data.ts:108-110` |
| `fetchFinanceDriverCostReport` | /finances (coût livreur) | `orders.cash_collected_at` | `lib/finance/driver-cost.ts:153-155` |
| `fetchFinanceProductCostReport` (orders) | /finances (coût produit) | `orders.cash_collected_at` | `lib/finance/product-cost.ts:517-519` |
| `fetchFinanceProductCostReport` (ad-spend) | /finances | `expense.spent_at` | `lib/finance/product-cost.ts:546-548` |
| `getReportData` (devise) | Rapport PDF | `orders.created_at` | `lib/report/data.ts:281-283` |
| `getReportData` (settlements) | Rapport PDF | `cash_settlement.settled_at` | `lib/report/data.ts:323-325` |
| `getLossAnalyticsAction` | /analyses | `orders.created_at` / `audit_log.created_at` | `lib/actions/loss-analytics.ts:129-130,147-148` |
| `get_loss_analytics_joins` | /analyses | `orders.created_at` | `0078_get_loss_analytics_joins.sql:55-56` |
| `list_repeated_refusers` | /analyses (fiabilité) | **aucun** | `lib/actions/loss-analytics.ts:102-105` |

**Constat structurel, pas une liste anodine :** `/tableau` mélange `created_at` et
`cash_collected_at` entre cartes voisines de son propre écran (`get_dashboard_cod_breakdown`/
`get_dashboard_top_products`/`get_dashboard_shop_performance` en `created_at`, mais
`get_dashboard_cash_collected_total`/`get_dashboard_deliveries_by_product` en `cash_collected_at`).
Le Rapport PDF a le même défaut en interne (`get_report_status_breakdown` en `created_at`, le bloc
P&L en `cash_collected_at`/`returned_at` — divergence déjà commentée dans le code,
`lib/report/data.ts:408-411`). `/analyses` borne toute sa fenêtre sur `created_at` mais annote
ensuite avec des champs `cash_collected_at`/`returned_at` qui peuvent tomber hors de cette fenêtre.
Combiné au rattrapage de juin (Bloc E), tout indicateur borné sur `created_at` pour la période
avril–juin attribuera artificiellement l'essentiel du volume à la semaine du rattrapage (17–23
juin) plutôt qu'aux dates réelles de vente.

### F2. Mesurer l'ampleur de la distorsion (avril–juin)

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
)
select date_trunc('month', o.created_at) as mois, count(*) as n_par_created_at
from public.orders o join target_shop t on o.shop_id = t.shop_id
where o.created_at >= '2026-04-01' and o.created_at < '2026-07-01'
group by 1 order by 1;
```

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
)
select date_trunc('month', o.created_at_shopify) as mois, count(*) as n_par_created_at_shopify
from public.orders o join target_shop t on o.shop_id = t.shop_id
where o.created_at_shopify >= '2026-04-01' and o.created_at_shopify < '2026-07-01'
group by 1 order by 1;
```

**À prouver :** comparer les deux tableaux ligne à ligne par mois. L'écart mesure directement de
combien un indicateur `created_at`-scopé se trompe de mois pour ces commandes.

*Sorties : en attente.*

### F3. Fiabilité de `cash_collected_at` comme axe correct

Le contrat F0 amendé fixe `cash_collected_at` comme date de reconnaissance de vente. Sa fiabilité
dépend du taux de `NULL` parmi les commandes réellement encaissées — mesuré indépendamment de
`cash_collected_at` lui-même (sinon la mesure serait circulaire), via l'état `cash_state`:

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
)
select
  count(*) as encaissees_par_etat_cash_state,
  count(*) filter (where o.cash_collected_at is null) as sans_cash_collected_at,
  count(*) filter (where o.cash_collected_at is not null) as avec_cash_collected_at
from public.orders o
join target_shop t on o.shop_id = t.shop_id
where o.cash_state = 'collected';
```

**À prouver :** si `sans_cash_collected_at` est une part significative de `encaissees_par_etat_cash_state`,
l'axe correct n'est pas exploitable en l'état sur ces données — le dire explicitement plutôt que de
présumer qu'il l'est parce que c'est l'axe harmonisé documenté (`CLAUDE.md`, migration `0119`).

*Sortie : en attente.*

---

## Bloc G — Reprises de D0 laissées ouvertes

### G1. La clause `collectedOrders` — établie, requête de reproduction prête

Établi par le code : `collectedOrders` n'est **pas** filtré par `cash_state`/`cod_status` du tout —
seulement par `cash_collected_at` dans la fenêtre, scopé tenant/boutique
(`lib/finance/report-data.ts:52-66`, commentaire ligne 41 : « CA = commandes avec `cash_collected_at`
dans la période »). C'est une différence de fond avec Q14/F3 ci-dessus, qui utilisent `cash_state`
— **ne pas confondre les deux définitions de « encaissée » dans ce document.**

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'ntmwxz-83.myshopify.com'
),
collected_orders as (
  select o.id
  from public.orders o
  join target_shop t on o.shop_id = t.shop_id
  where o.cash_collected_at >= :from_ts and o.cash_collected_at <= :to_ts
  -- remplacer :from_ts/:to_ts par la période exacte affichée à l'écran au moment
  -- de la capture des deux avertissements (« 11 commandes »/« 14 lignes »)
),
sold_lines as (
  select
    sm.id as movement_id,
    sm.order_id,
    (
      (sm.unit_cost is null or sm.unit_cost <= 0)
      and (ps.unit_cost is null or ps.unit_cost <= 0)
    ) as is_unknown
  from public.stock_movement sm
  join collected_orders co on co.id = sm.order_id
  left join public.product_stock ps on ps.product_id = sm.product_id
  where sm.movement_type = 'sold'
),
costed_order_ids as (
  select distinct order_id from sold_lines where is_unknown = false
)
select
  (select count(*) from collected_orders) as commandes_encaissees_total,
  (select count(*) from collected_orders where id not in (select order_id from costed_order_ids))
    as commandes_sans_cout_connu,
  (select count(*) from sold_lines where is_unknown) as lignes_vendues_sans_cout;
```

**À prouver :** `commandes_sans_cout_connu` doit reproduire 11, `lignes_vendues_sans_cout` doit
reproduire 14. S'ils ne reproduisent pas exactement, dire sur quelle population le nombre affiché
porte réellement plutôt que de forcer une correspondance approximative.

*Sortie : en attente — nécessite d'abord la période exacte affichée lors de la capture.*

### G2. `order_number`, format — traité en Q9 ci-dessus (Bloc B)

Voir la correction apportée à Q9 : analyse de trous par numérotation abandonnée, pas seulement mise
en garde. Résumé : `#<n>` (Shopify) / `M-<n>` (manuel, compteur séparé) / `MAN-<timestamp>` (legacy,
jamais lu ni corrigé) — trois formats indépendants, pas une séquence exploitable.

### G3. Mesures chiffrées restantes de D0

Q1 est close (194 = fenêtre 30j sur `created_at`, total réel ~1 509 — voir Bloc E introduction).
Q2, Q6, Q11, Q12, Q15, et la confirmation Q16 restent en attente ; leurs requêtes, écrites en D0,
sont **inchangées** par la correction du volume — aucune ne comportait de `limit` implicite ni de
fenêtre 30 jours, elles portaient déjà sur la boutique entière. Les réexécuter telles quelles.

**Rappel gotcha à respecter à l'exécution :** `max_rows=1000` (config Supabase) tronque en silence
tout `.select()` non paginé — sans effet sur les requêtes de ce document, qui sont toutes des
agrégats SQL (`count`/`group by`), jamais des sélections de lignes brutes.

---

## Bloc H — Vérification du Verrou 0 sur le fait corrigé

**Portée à respecter :** le Verrou 0 (PR #161, commit de merge `2cb8be6`, 2026-08-26 22:13:19 UTC)
concerne le cœur d'écriture partagé entre le webhook **legacy** et le endpoint **opaque L3**. Sur
`ntmwxz-83.myshopify.com`, ni l'un ni l'autre n'a jamais écrit — Bloc E établit une origine
cron/manuelle. **Une comparaison avant/après sur ce tenant précis serait donc vide de sens : il n'a
jamais eu de trafic webhook, avant ou après le Verrou 0.** La vérification champ-par-champ n'a de
portée réelle que sur une boutique qui reçoit effectivement du trafic webhook legacy —
`teer-test.myshopify.com`, seule boutique identifiée avec du trafic webhook réel (4 événements,
`CLAUDE.md`). La requête ci-dessous cible donc `teer-test`, pas la boutique pilote — l'écart avec
le périmètre du reste de ce document est déclaré, pas une erreur.

```sql
with target_shop as (
  select id as shop_id from public.shop where shop_domain = 'teer-test.myshopify.com'
)
select
  (o.created_at >= timestamptz '2026-08-26 22:13:19+00') as after_verrou0,
  count(*) as n,
  -- Règle acquise du projet : n'exiger une comparaison de taux que sur une base non nulle,
  -- jamais un compte brut de NULL seul (faux positifs sur un petit échantillon).
  count(*) filter (where o.shopify_order_id is not null) as with_shopify_order_id,
  round(
    100.0 * count(*) filter (where o.shopify_order_id is not null)
    / nullif(count(*), 0), 1
  ) as pct_with_shopify_order_id,
  count(*) filter (where o.items_summary is not null) as with_items_summary,
  round(
    100.0 * count(*) filter (where o.items_summary is not null)
    / nullif(count(*), 0), 1
  ) as pct_with_items_summary
from public.orders o
join target_shop t on o.shop_id = t.shop_id
where o.created_at >= timestamptz '2026-08-26 22:13:19+00' - interval '14 days'
group by 1
order by 1;
```

**À prouver :** les taux `pct_with_shopify_order_id`/`pct_with_items_summary` doivent rester stables
avant/après (les deux colonnes sont écrites en INSERT par `persistShopifyOrder`, indépendamment de
la refonte Verrou 0 selon la liste de champs auditée). Un décrochage sur l'une des deux colonnes
après le 26 août signalerait une régression réelle du cœur partagé — à constater, pas à expliquer a
priori. Si `teer-test` n'a reçu aucune commande dans les 14 jours entourant le déploiement, le dire
explicitement : la preuve ne serait alors pas atteignable faute de volume, pas « probablement bon ».

*Sortie : en attente.*

---

## Bloc I — Résultat du Lot R1 (fiabilité du cron de réconciliation, PR #163, mergé 2026-08-27)

**Contexte :** Bloc E2 ci-dessus avait établi par lecture de code que `last_reconciled_at` avançait
inconditionnellement même en cas d'échec de persistance individuel — une commande en échec n'était
alors plus jamais reprise automatiquement. Le Lot R1 a corrigé exactement ce défaut.

**Étape 1 (dédoublonnage) — prouvé sûr aux deux couches.** Test mutation-testé
(`tests/rls/shopify-reconcile-dedup.rls.test.ts`) : rejouer un webhook déjà traité ne produit pas de
doublon, à la fois via la garde applicative (`if (existingOrder)`) et, indépendamment, via la
contrainte unique en base — les deux couches ont été démontrées comme des filets indépendants.

**Étape 2 (curseur) — corrigé.** `computeNextReconcileCursor` (`lib/shopify/reconcile.ts`) : le
curseur `shop.last_reconciled_at` n'avance plus jamais au-delà de la commande en échec la plus
ancienne d'un passage ; un échec sans `updated_at` exploitable bloque totalement l'avancée plutôt que
de deviner une borne. Observabilité ajoutée : `Sentry.captureMessage` par commande en échec (absent
avant ce lot pour les échecs partiels intra-bulk — seul un échec au niveau boutique entière
déclenchait une alerte), et le cron répond HTTP 207 (au lieu de 200) dès qu'un run est dégradé.
Prouvé rouge avant / vert après par mutation-testing sur `tests/unit/shopify-reconcile-cursor.test.ts`
et `tests/rls/shopify-reconcile-cursor.rls.test.ts`.

**Défaut découvert en cours de revue, signalé mais explicitement NON corrigé dans ce lot (hors
périmètre R1) :** `persistShopifyOrder` (`lib/shopify/orders-sync.ts`) résout la commande existante
par `(merchant_account_id, shopify_order_id)`, alors que l'index unique qui protège réellement la
base (`orders_shop_shopify_order_unique_idx`, migration `0037`) porte sur `(shop_id,
shopify_order_id)` — la migration elle-même documentait ce déplacement d'autorité vers la boutique,
jamais suivi par le code applicatif. Prouvé par test
(`tests/rls/shopify-reconcile-cross-shop-order-id-collision.rls.test.ts`) : pour un marchand
possédant deux boutiques Shopify distinctes, un `shopify_order_id` identique produit sur les deux
fait écraser silencieusement le contenu de la commande de la boutique A par celui de la boutique B
— une seule ligne existe (pas de doublon détectable, l'index unique n'est jamais consulté puisqu'
aucun `INSERT` n'a lieu pour B), elle reste rattachée à `shop_id = A`, mais son contenu devient celui
de B. `ok:true` des deux côtés — aucune erreur ne remonte.

**Classification exacte, à respecter dans toute référence future à ce défaut : ce n'est pas un
« défaut latent ».** C'est une **circonstance, pas une garde.** Aucune exposition aujourd'hui — les
deux boutiques Shopify actuellement actives appartiennent à deux comptes marchands distincts, donc
la précondition (deux boutiques, un même compte) n'est pas remplie. Cette protection disparaît sans
préavis dès qu'un marchand connecte une seconde boutique.

**Conséquence directe pour ce diagnostic : le rejeu massif de l'historique (recul du curseur, Bloc E3
ci-dessus, action fondateur #2) est bloqué jusqu'à la correction de ce défaut.** Un rejeu massif est
précisément la circonstance qui déclencherait l'écrasement décrit ci-dessus sur tout marchand
multi-boutiques. Correction prévue par le Lot R2 (Phase F), qui doit réaligner la résolution sur
`(shop_id, shopify_order_id)` avec `shop_id` dérivé du parent autoritaire sur chaque chemin
d'écriture.

---

## 3. Tableau des chemins d'écriture de commande

| Chemin | Entrée | Insert (fichier:ligne) | Atteignable en prod | Trace laissée | Nb de commandes attribuables |
|---|---|---|---|---|---|
| Webhook Shopify legacy | `POST app/api/shopify/webhooks/route.ts:284` | `lib/shopify/orders-sync.ts:684-688` | Oui | `webhook_event` (avant), `shopify_order_id` posé, `finish_shopify_webhook_event` | **0 confirmé** — `webhook_event` vide pour ce domaine (fait donné, cohérent avec le code) |
| Webhook Shopify opaque (L3) | `POST app/api/shopify/ingest/[token]/route.ts:83` | `lib/shopify/orders-sync.ts:684-688` (même cœur) | Oui | idem, sans résolution par domaine | **0 attendu** (aucun abonnement réel ne pointe vers ce endpoint per `CLAUDE.md`) — non mesuré directement, découle de 0 webhook_event |
| Cron réconciliation nocturne | `GET app/api/cron/shopify-reconcile/route.ts:17` | `lib/shopify/orders-sync.ts:684-688` via `lib/shopify/reconcile.ts:61-66` | Oui, quotidien 02:00 UTC, tous shops Shopify actifs (`route.ts:37-40`) | `shopify_order_id` posé, **aucun** `webhook_event`, `shop.last_reconciled_at` avancé même en cas d'échec partiel (Bloc E2) | Très probablement l'essentiel des ~1 509 (rattrapage 17-23 juin mesuré) — décompte exact en attente de E1 |
| Action serveur manuelle | `lib/actions/orders.ts:1335` (`createManualOrderAction`), UI `components/orders/new-order-form.tsx:80` | `lib/actions/orders.ts:1506-1525` | Oui | `shopify_order_id = NULL` explicite, `source ∈ {manual,whatsapp,instagram,tiktok,facebook,appel}` | Au moins 14 (commandes sans `created_at_shopify`, hypothèse à confirmer par E1) |
| Seed / script | — | — | Non trouvé | — | 0 (grep négatif, pas de `supabase/seed`) |

---

## 4. Tableau d'aptitude pour la Phase F

| Donnée requise par F1 | Mécanisme de calcul (code) | Lignes exploitables | Lignes manquantes |
|---|---|---|---|
| Produit résolu par ligne | `order_line.match_status` / `product_id` | En attente (Q11) | En attente (Q11) |
| Coût de revient (frozen/CUMP/inconnu) | `effectiveUnitCost`, `lib/finance/profit.ts:89-96` | En attente (Q12) | En attente (Q12) |
| Lot d'achat par produit | `purchase_lot_line.product_id` | En attente (Q15) | En attente (Q15) |
| Statut terminal (livrée+encaissée+non retournée) | 4 dimensions + flux d'événements retour, pas un champ unique | En attente (Q14) | En attente (Q14) |
| Canal (`orders.source`) | `lossSource()`, `NULL`/`''` fusionnés en « inconnu » | En attente (Q2) | En attente (Q2) |

---

## 5. Actions fondateur identifiées

| # | Action | Chiffre exact à obtenir | À comparer à |
|---|---|---|---|
| 1 | Exécuter toutes les requêtes marquées « en attente » (E1, E2, E3, F2, F3, G1, G3, H, et Q2/Q6/Q11/Q12/Q15/Q16-confirmation reprises de D0) | Sorties SQL brutes, non arrondies, `NULL`/`''` non fusionnés | Les grilles de lecture données sous chaque requête |
| 2 | **Shopify Admin** de `ntmwxz-83.myshopify.com` : nombre de commandes créées entre le 12 et le 17 août 2026 inclus | Un entier | Le résultat de la requête E3 (`commandes_shopify_creees_12_au_17_aout`) — un écart positif confirme une perte silencieuse, une égalité confirme l'absence de vente réelle |
| 3 | Retrouver la période exacte affichée à l'écran au moment de la capture des deux avertissements (« 11 commandes »/« 14 lignes ») pour renseigner `:from_ts`/`:to_ts` dans la requête G1 | Deux horodatages | Les sorties de G1 doivent reproduire 11 et 14 exactement |
| 4 | (Optionnel, hors périmètre pilote) confirmer que `teer-test.myshopify.com` a bien reçu du trafic dans les 14 jours entourant le déploiement du Verrou 0, avant d'attendre un résultat exploitable de la requête H | Volume de commandes `teer-test` sur cette fenêtre | Si 0, la vérification H est inatteignable faute de volume — le dire, ne pas forcer une lecture |

## 6. Ce qui n'a pas pu être établi dans cette passe

- **Toutes les mesures chiffrées des Blocs A/B/C/E/F/G/H** : nécessitent l'exécution des requêtes
  par le fondateur (voir §5). Non un manque de méthode — c'est la contrainte imposée par le lot
  (agent en lecture seule, pas d'accès direct à la base de production).
- **Exhaustivité absolue (Q8)** : structurellement non déterminable en base seule sans référence
  externe. L'action fondateur #2 ci-dessus (décompte Shopify Admin du 12-17 août) est un premier
  point de recoupement partiel, pas une preuve d'exhaustivité globale sur toute l'histoire.
- **Le trou du 12-17 août (Bloc E3)** : la base seule ne peut pas distinguer « aucune vente » de
  « commandes perdues » — c'est structurel, pas un manque d'effort, d'où l'action fondateur #2.

---

## 7. Critère de fin de lot

**Question 1 du brief D0-bis :** *les ~1 509 commandes de la boutique du pilote constituent-elles
une base sur laquelle une marge par arrivage peut être calculée sans produire de chiffre faux ?*

**Réponse : indéterminée, en attente des Blocs E1/F3/G1/G3.** Ce qui est déjà acquis penche vers un
« non » partiel et motivé : un trou d'insertion non expliqué (E3), un axe de date `created_at`
massivement utilisé dans les écrans existants alors qu'il déforme structurellement avril-juin
(F1/F2), et une fiabilité de `cash_collected_at` non encore mesurée (F3) sont trois raisons
distinctes de ne pas construire F1 sur les données telles quelles sans ces réponses. Aucune
recommandation n'est formulée, conformément à la méthode imposée — ceci est un constat, pas une
décision.

**Question 2 du brief D0-bis :** *sur quel axe de date la Phase F doit-elle borner une période, et
cet axe est-il exploitable sur les données existantes ?*

**Réponse : axe identifié, exploitabilité non confirmée.** L'axe correct, au regard du contrat F0
amendé (date de reconnaissance = encaissement) et de l'harmonisation déjà actée dans le projet
(`CLAUDE.md`, migration `0119`, « toutes les surfaces CA/finance sont harmonisées sur
`cash_collected_at` depuis `0119` — ne jamais réintroduire une date concurrente sans le décider
délibérément ») est **`cash_collected_at`**. Ce n'est pas une proposition nouvelle de ce lot, c'est
une règle déjà actée que Bloc F1 confirme être appliquée de façon incohérente sur les écrans
existants (mélangée avec `created_at` sur `/tableau`, `/analyses` et le Rapport PDF). **Son
exploitabilité réelle sur les données du pilote — le taux de `NULL` parmi les commandes
effectivement encaissées — reste à mesurer (F3, en attente).** Ce n'est pas un « je ne sais pas » :
c'est un axe nommé, avec la mesure précise qui manque encore pour le confirmer utilisable, listée
en action fondateur #1.
