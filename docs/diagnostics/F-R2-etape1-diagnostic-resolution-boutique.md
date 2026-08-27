# Phase F · Lot R2, Étape 1 — Diagnostic de données (lecture seule)

**Statut : ARRÊT après cette étape, en attente de confirmation avant Étape 2 (correctif).**

Aucune requête n'a été exécutée par l'agent. Aucune migration, aucune écriture, aucun `db push`,
aucun rejeu du cron. Le fondateur exécute les requêtes ci-dessous et colle les sorties brutes.

---

## 2.1 Comportement exact de l'écrasement — établi par lecture de code

**Question posée par le lot : l'`UPDATE` modifie-t-il aussi `shop_id` ?**

**Réponse : non.** Preuve directe dans `lib/shopify/orders-sync.ts` :

- La recherche de la commande existante (`persistShopifyOrder`, lignes 633-640) filtre par
  `(merchant_account_id, shopify_order_id)` — **jamais `shop_id`** :
  ```ts
  .eq('merchant_account_id', merchantAccountId)
  .eq('shopify_order_id', shopifyOrderId)
  .maybeSingle();
  ```
- Quand une ligne existante est trouvée, `buildShopifyOrderUpdate` (lignes 213-239) construit
  l'objet `orderUpdate` appliqué par `.update(orderUpdate).eq('id', existingOrder.id)`
  (ligne 674-678). Cet objet ne contient **aucune clé `shop_id`** — la liste complète des champs
  écrits est : `order_number`, `currency`, `financial_status`, `fulfillment_status`,
  `shopify_financial_status`, `shopify_fulfillment_status`, `shopify_cancelled_at`,
  `shopify_updated_at`, `shipping_address`, `customer_id`, `created_at_shopify`, `updated_at`,
  `shopify_order_attributes`, `shopify_line_item_attributes`, et conditionnellement
  `total_amount`/`items_summary`.

**Conclusion : c'est le cas « la ligne de la boutique A porte désormais le contenu de la boutique
B », pas une migration de ligne.** La commande reste rattachée à `shop_id = A` (jamais touché par
l'UPDATE), mais tous les champs ci-dessus — y compris `total_amount`, `items_summary`,
`shipping_address`, `customer_id` — prennent la valeur de la boutique B dès que B produit un
`shopify_order_id` déjà présent pour A sous le même `merchant_account_id`.

**Preuve par test (pas seulement par lecture) :** `tests/rls/shopify-reconcile-cross-shop-order-id-
collision.rls.test.ts`, livré en R1, reproduit exactement ce scénario contre une vraie base et
confirme `shop_id` inchangé + `total_amount` écrasé, `ok:true` des deux côtés.

**Conséquence pour les requêtes de détection ci-dessous :** chercher des `shopify_order_id`
dupliqués **au sein d'un même `merchant_account_id`, toutes boutiques confondues** (pas des lignes
en double — il n'y en a pas, l'INSERT n'a jamais lieu pour la seconde boutique) — et, séparément,
chercher des incohérences de contenu (client/produit d'une autre boutique sur une commande donnée).

---

## 2.2 Requêtes de détection — à exécuter en production par le fondateur

### D1. Un compte marchand détient-il aujourd'hui plus d'une boutique Shopify ?

**Précondition du défaut.** Si cette requête ne retourne aucune ligne, la corruption décrite en 2.1
n'a **structurellement** pas pu se produire à ce jour — le dire simplement, sans requête
supplémentaire nécessaire.

```sql
select
  merchant_account_id,
  count(*) as nb_boutiques_shopify,
  array_agg(shop_domain order by shop_domain) as domaines
from public.shop
where store_kind = 'shopify'
group by merchant_account_id
having count(*) > 1
order by nb_boutiques_shopify desc;
```

### D2. `shopify_order_id` apparaissant plus d'une fois au sein d'un même compte marchand

**Ne s'exécute utilement que si D1 retourne au moins une ligne** — sur un compte mono-boutique,
`(merchant_account_id, shopify_order_id)` et `(shop_id, shopify_order_id)` coïncident
nécessairement, aucune collision n'est possible.

```sql
select
  merchant_account_id,
  shopify_order_id,
  count(*) as nb_lignes,
  array_agg(distinct shop_id) as shop_ids_concernes,
  array_agg(id order by updated_at) as order_ids,
  array_agg(updated_at order by updated_at) as updated_at_par_ligne
from public.orders
where shopify_order_id is not null
group by merchant_account_id, shopify_order_id
having count(*) > 1
order by nb_lignes desc;
```

**Comment lire le résultat :** conformément à 2.1, une collision réelle produit **une seule ligne**
en base (l'INSERT de la seconde boutique n'a jamais lieu) — donc cette requête ne trouvera
**jamais** de collision (`count(*) > 1` restera toujours vide, par construction du défaut lui-même,
puisque l'écrasement empêche justement le doublon). **Un résultat vide ici ne prouve donc PAS
l'absence de corruption** — il prouve seulement l'absence de doublons visibles, ce qui est attendu
même en présence du défaut. C'est pourquoi D3 (incohérence de contenu) est la requête qui compte
réellement, pas D2. D2 est conservée pour exhaustivité méthodologique et pour détecter d'éventuelles
autres origines de doublon (hors du défaut R2), pas pour détecter ce défaut précis.

### D3. Incohérences de contenu — commande rattachée à une boutique, mais avec des données d'une
autre boutique du même compte

**La requête qui détecte réellement le défaut**, en respectant la règle acquise du projet
(comparaison exigeant une valeur non nulle des deux côtés, jamais un `NULL` traité comme faux
positif) :

```sql
-- 3a. Ligne de commande (order_line) pointant vers un produit d'une AUTRE boutique que celle de
-- la commande qui la porte, au sein du même compte marchand.
select
  o.id as order_id,
  o.shop_id as order_shop_id,
  o.shopify_order_id,
  ol.id as order_line_id,
  ol.product_id,
  p.shop_id as product_shop_id
from public.order_line ol
join public.orders o on o.id = ol.order_id
join public.product p on p.id = ol.product_id
where ol.product_id is not null
  and p.shop_id is not null
  and o.shop_id is not null
  and p.shop_id <> o.shop_id
  and p.merchant_account_id = o.merchant_account_id;
```

```sql
-- 3b. Commande rattachée à un client (customer) d'une AUTRE boutique que la sienne, au sein du
-- même compte marchand.
select
  o.id as order_id,
  o.shop_id as order_shop_id,
  o.shopify_order_id,
  o.customer_id,
  c.shop_id as customer_shop_id
from public.orders o
join public.customer c on c.id = o.customer_id
where o.customer_id is not null
  and c.shop_id is not null
  and o.shop_id is not null
  and c.shop_id <> o.shop_id
  and c.merchant_account_id = o.merchant_account_id;
```

```sql
-- 3c. Mouvement de stock (stock_movement) référençant un produit d'une AUTRE boutique que celle
-- de la commande qu'il sert, au sein du même compte marchand.
select
  sm.id as movement_id,
  sm.order_id,
  o.shop_id as order_shop_id,
  sm.product_id,
  p.shop_id as product_shop_id
from public.stock_movement sm
join public.orders o on o.id = sm.order_id
join public.product p on p.id = sm.product_id
where sm.product_id is not null
  and p.shop_id is not null
  and o.shop_id is not null
  and p.shop_id <> o.shop_id
  and p.merchant_account_id = o.merchant_account_id;
```

**Comment lire chaque résultat :** toute ligne retournée par 3a/3b/3c est une preuve directe d'une
corruption réelle en production (le produit/client/mouvement référencé n'appartient pas à la
boutique de la commande, alors que le schéma exige normalement cette cohérence) — **mais** ceci ne
peut apparaître que si D1 a déjà montré un compte multi-boutiques. Sur les données actuelles
(deux boutiques actives, deux comptes distincts, per `CLAUDE.md`), ces trois requêtes doivent
retourner 0 ligne — un résultat non vide serait une découverte contredisant le fait déjà établi et
devrait être signalé tel quel, pas ajusté.

**Anti-troncature :** les trois requêtes sont des agrégats/jointures directes sur des colonnes
indexées (`merchant_account_id`, `shop_id`), sans `.select()` PostgREST non paginé — le plafond
`max_rows=1000` ne s'applique qu'à l'API REST, pas à une requête SQL exécutée directement. Si le
nombre de lignes retournées approche 1000, le signaler explicitement plutôt que de le traiter comme
un résultat complet.

---

## 2.3 Inventaire des résolutions par `merchant_account_id` (graphe d'appel)

Méthode : parcours du graphe d'appel de tout code qui persiste une commande, ligne de commande,
produit, client ou remboursement Shopify — pas une recherche par nom de fichier. Chemins TS
uniquement (aucune fonction SQL de résolution par identifiant externe trouvée en dehors des RPC déjà
listées comme non concernées ci-dessous).

| Emplacement | Entité résolue | Clé utilisée dans le `SELECT`/lookup | Contrainte/index correspondant en base | Écart |
|---|---|---|---|---|
| `lib/shopify/orders-sync.ts:633-640` (`persistShopifyOrder`) | `orders` (commande) | `(merchant_account_id, shopify_order_id)` | `orders_shop_shopify_order_unique_idx` — `(shop_id, shopify_order_id)`, migration `0037` | **OUI — le défaut confirmé de ce lot.** |
| `lib/shopify/webhook-core.ts:750-755` (`processRefundCore`) | `orders` (commande, pour rattacher un remboursement) | `(merchant_account_id, shopify_order_id)` | même index que ci-dessus | **OUI — même motif, deuxième occurrence.** Une collision ferait attacher le remboursement de la boutique B à la commande (au contenu déjà potentiellement écrasé) de la boutique A ; `financial_status` serait mis à jour sur le mauvais enregistrement logique. |
| `lib/shopify/gdpr.ts:59-72` (`findCustomerIdsByShopifyId`, lookup initial) | `customer` | `merchant_account_id` seul (le `shopify_customer_id`/gid n'est PAS croisé avec `shop_id` à ce stade) | `customer` n'a pas de contrainte unique sur `(merchant_account_id, shopify_customer_id)` seul — scope réel imposé plus tard | **Partiel, pas prouvé exploitable.** Le résultat est ensuite strictement réduit (ligne 80-85) aux `customer_id` ayant au moins une commande dans `shop_id` exact — donc la sortie finale de la fonction reste shop-scopée par construction, mais le lookup intermédiaire interroge une population plus large que nécessaire. Signalé, non corrigé, car la sortie observable n'est pas prouvée fausse. |
| `lib/shopify/products-sync.ts:145-150` (`persistShopifyProducts`) | `product` | `(merchant_account_id, shop_id)` + `shopify_variant_id` | index/contrainte produit scopée boutique | **Non — correctement scopé** (les deux colonnes sont présentes dans le `.eq()`). |
| `lib/shopify/orders-sync.ts:500-561` (`resolveShopifyCustomer`) | `customer` | `(merchant_account_id, shop_id)` + téléphone/gid | scopé boutique | **Non — correctement scopé.** |
| `lib/stock/order-line-resolution.ts:68-69` | `product` (résolution de ligne de commande) | `(merchant_account_id, shop_id)` | scopé boutique | **Non — correctement scopé.** |
| `lib/ingestion/*` (`external_ref`, dual-write L1/L2) | registre canonique | clé `store_connection_id` (1 connexion = 1 boutique) | contrainte unique sur `external_ref`, scopée par connexion | **Non applicable** — ce chemin est un registre d'écriture par connexion (déjà shop-scopé structurellement via `store_connection_id`), pas une résolution par `merchant_account_id`. |

**Signalés, non corrigés dans ce lot, conformément au périmètre :** les deux lignes marquées « OUI »
ci-dessus (`orders-sync.ts` et `webhook-core.ts`) partagent exactement le même motif — un
identifiant Shopify reçu (`shopify_order_id`), jamais confronté à son parent autoritaire (`shop_id`
de la boutique émettrice), transmis à une opération qui dérive le contexte de cet identifiant même.
La ligne `gdpr.ts` est une piste de durcissement future, pas un défaut prouvé.

---

## Livrable de l'étape 1 — synthèse

1. **Comportement exact :** `shop_id` n'est jamais modifié par l'écrasement — la ligne de la
   boutique A conserve son `shop_id`, mais son contenu (montant, panier, adresse, client, dates
   miroir) devient celui de la boutique B. Établi par lecture de code, confirmé par test R1.
2. **Détection en production :** requêtes D1/D2/D3 ci-dessus, en attente d'exécution par le
   fondateur. **D2 seule ne peut structurellement rien détecter** (le défaut empêche par
   construction le doublon qu'elle cherche) — D1 (précondition) et D3 (incohérence de contenu) sont
   les requêtes qui comptent.
3. **Inventaire :** deux occurrences confirmées du même motif (`orders-sync.ts`,
   `webhook-core.ts`), une piste non prouvée (`gdpr.ts`), le reste des chemins audités est
   correctement scopé.

**ARRÊT. En attente de confirmation avant d'entamer l'Étape 2.**
