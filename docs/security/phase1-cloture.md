# Clôture Phase 1 — isolation multi-tenant / multi-boutique

> Document de clôture. Ne remplace pas `CLAUDE.md` (source de vérité opérationnelle) — synthétise
> et référence les migrations/PR/tests qui prouvent (ou ne prouvent pas encore) l'isolation
> tenant/boutique de Tëër à l'issue de la Phase 1.
>
> **Ce document ne déclare pas « PHASE 1 PASS ».** Le smoke production multi-boutiques (§7) n'a
> pas été exécuté — il est hors de la portée de l'agent qui a rédigé ce document (cf. §7).

---

## 1. Ce qui est prouvé

| Défaut | Nature | Preuve |
|---|---|---|
| Chaîne de navigation workspace (redirect+rewrite en cycle sur `/produits` etc.) | routage | `tests/e2e/workspace-routing.spec.ts`, CI 3 profils (chromium/pixel-7/iphone-14) |
| Parcours d'invitation bloqué (0 boutique → état vide au lieu du token) | produit | tests dédiés + CI, PR `f16b630` |
| Débordement Tableau mobile (largeur de carte non déterministe) | produit | largeur déterministe, 72 mesures (6 lectures × 2 exécutions × 6 baselines), CI visuelle |
| Écriture cross-tenant `product_stock`/`stock_movement`/`order_state_transition` sans `shop_id` dérivé du parent autoritaire | **fuite** | migration `0131`, mutation testing, écart historique mesuré à **zéro** sur tous les tenants avant correctif |
| Bundles cross-boutique (`product_bundle_component` non scopé) | **fuite** | migration `0137`, mutation testing 2 couches |
| Lignes de lot d'achat cross-boutique (`purchase_lot_line` non scopé) | **fuite** | migration `0138`, mutation testing 2 couches |
| Éligibilité livreur absente du SQL (garde applicative TS seule, contournable par appel RPC direct) | garde métier | migration `0139`, mutation testing 2 couches |
| Confusion cross-tenant webhook (`resolveShopDomain` préférait le header non signé au corps signé) | **faille destructive** | corps signé rendu autoritatif (`resolveSignedShopDomain`), mutation testing 2 couches, audit prod (2 lignes trouvées, 0 exploitation confirmée) — PR #143 |
| Cœur `post_stock_movement` (12 arguments) exposé à `authenticated` | escalade | migration `0136` (schéma `private`), contrôle négatif en prod (`PGRST202` sous JWT `authenticated` et `service_role`) |

Pour chaque ligne « fuite »/« faille destructive »/« escalade », un contrôle de corruption en lecture
seule a été exécuté en production (comptage d'abord, `IS DISTINCT FROM` sur une valeur non nulle,
`LEFT JOIN` pour les parents absents) avant et après le correctif — le détail de chaque requête et
son résultat vit dans le corps de la PR correspondante (`#137`–`#143`) et dans les sections
`CLAUDE.md` qu'elle a ajoutées, pas dupliqué ici.

---

## 2. Verdict par preuve de sortie

Les 9 lignes du tableau ci-dessus constituent l'ensemble des preuves de sortie de la Phase 1 traité
par ce document. **Note de traçabilité** : `CLAUDE.md` cite une « preuve 1E n°3 » pour l'incident
webhook (correspondant à la ligne « Confusion cross-tenant webhook » ci-dessus) — cette numérotation
globale 1 à 9, établie lors d'une session antérieure, n'a été retrouvée dans aucun fichier ni PR du
dépôt et n'a donc pas pu être reconstituée à l'identique. Ce document identifie chaque preuve par son
libellé (colonne « Défaut » du tableau) plutôt que par un numéro non vérifiable.

| Preuve | Verdict | Nature |
|---|---|---|
| Chaîne de navigation workspace | **Prouvé par test** | CI E2E, 3 profils, non mutation-testé (pas un test de sécurité — pas d'attaquant à simuler, juste un cycle de redirection) |
| Parcours d'invitation bloqué | **Prouvé par test** | CI E2E |
| Débordement Tableau mobile | **Prouvé par test** | assertions de dimension déterministe, CI visuelle |
| Écriture cross-tenant `product_stock`/etc. | **Prouvé par test** | mutation-testé, + preuve négative production (écart historique = 0 avant correctif, donc rien à rattraper) |
| Bundles cross-boutique | **Prouvé par test** | mutation-testé 2 couches |
| Lignes de lot d'achat cross-boutique | **Prouvé par test** | mutation-testé 2 couches |
| Éligibilité livreur absente du SQL | **Prouvé par test** | mutation-testé 2 couches |
| Confusion cross-tenant webhook | **Prouvé par test** | mutation-testé 2 couches + audit prod (limité — cf. §5, Exception 1) |
| Cœur `post_stock_movement` exposé | **Prouvé par test** | contrôle négatif direct (`PGRST202`), pas un mutation-test au sens strict (rien à faire rougir : la fonction est absente du schéma exposé, pas juste mal gardée) |

**Aucune de ces 9 preuves ne repose sur une simple lecture de code sans test.** Ce qui reste dans cet
état (« vérifié par lecture, non prouvé par test ») est un périmètre **adjacent** à ces 9 preuves,
pas une de ces preuves elle-même — recensé ci-dessous pour que rien ne reste invisible faute
d'apparaître dans le tableau.

### Périmètre adjacent vérifié par lecture, non prouvé par test

Issu de l'audit Lot F (RPC financières/consolidées, lecture seule, aucune fuite trouvée) et du
périmètre `assistant/chat` signalé séparément :

- **4 RPC dont le corps SQL a été lu et jugé sûr (filtre tenant/boutique en `AND`, garde de rôle
  correcte) mais sans test RLS dédié localisé** : `get_report_driver_cash_pending`,
  `get_dashboard_priority_counts`, `get_loss_analytics_joins`, `get_dashboard_kpi`.
- **2 fonctions dont le corps SQL n'a pas été relu intégralement** dans l'audit Lot F (filtre déduit
  par analogie avec une fonction sœur, pas vérifié ligne à ligne) : `list_customer_reliability`
  (fermée par la migration `0140` de ce lot — cf. §8, donc ce point devient sans objet pour elle),
  `orders_view_counts` (fermée elle aussi par `0140` pour son code mort — le corps reste non relu,
  mais la fonction n'est plus exécutable, donc le risque associé disparaît avec elle).
- **`get_customer_reliability`** : `SECURITY INVOKER`, sécurité entièrement dépendante des policies
  RLS de `customer`/`orders`/`order_state_transition`/`merchant_member`/`call_log`. Ces policies
  n'ont pas été ré-auditées dans le Lot F (elles l'ont été dans des lots RLS antérieurs selon
  `CLAUDE.md`, non revérifiées à cette occasion). Le sweep du lot `0140` (cf. §8) a confirmé une
  couche de protection supplémentaire non identifiée par le Lot F : ces 5 tables n'accordent aucun
  `GRANT` à `anon`/`PUBLIC`, donc un appel `anon` échoue par « permission denied » avant même
  l'évaluation de la RLS — mais ceci ne dispense pas de vérifier que la RLS elle-même est correcte
  pour un rôle `authenticated` non membre du tenant concerné.
- **`assistant/chat`** : `buildAiToolSet` et la RLS de `ia_conversation` n'ont été vérifiés ni dans
  le Lot F (hors périmètre — ce n'est pas une RPC Postgres) ni dans ce lot.

**Justification du non-traitement** : dans chacun de ces cas, le SQL ou le code a été lu et jugé sûr
(à l'exception d'`assistant/chat`, non lu du tout dans cette Phase), **aucune fuite n'a été trouvée**,
et la Phase 2 refond l'accès aux données de ces surfaces — des tests écrits maintenant contre le
modèle d'accès actuel seraient à refaire contre le nouveau modèle. Ce n'est pas un report par
négligence : c'est un arbitrage explicite entre écrire un test jetable maintenant et le reporter à un
lot où il restera valide.

---

## 3. Migration 0140 — clôture du code mort exposé

`supabase/migrations/0140_close_public_execute_gaps.sql` (écrite dans ce lot, **non poussée** — cf.
§8 pour la procédure de vérification et le détail complet).

Ferme trois classes de surface d'attaque gratuite, aucune fuite de données prouvée sur aucune des 11
fonctions touchées :

- **3 fonctions mortes** (`list_orders_paginated`, `orders_view_counts`, `list_customer_reliability`)
  — zéro appelant TS/SQL/E2E confirmé, `revoke` total y compris `authenticated`.
- **4 fonctions vivantes** avec un grant `authenticated` déjà posé par une migration antérieure
  (`cash_aging`, `receive_purchase_lot`, `resolve_order_required_component_quantities`,
  `get_customer_reliability`) — `revoke` de `public`/`anon` uniquement, le grant `authenticated`
  existant n'est pas touché.
- **4 fonctions vivantes n'ayant jamais reçu le moindre grant explicite** depuis leur création
  (`is_member_of`, `order_items_search_text`, `derive_legacy_cod_status`,
  `validate_pcd_access_audit_metadata`) — `revoke` de `public`/`anon` **puis** `grant` explicite à
  `authenticated`, pour ne rien casser. `is_member_of` en particulier est appelée directement dans
  6 fichiers de policies RLS ; sans ce grant, toute requête `authenticated` sur les tables scopées
  merchant aurait échoué en `permission denied`.

Détail complet, table par table, dans le corps du fichier de migration.

---

## 4. Exceptions de sécurité formelles

### Exception 1 — identité de boutique non authentifiée sur `orders/*`, `products/*`, `refunds/create`, `bulk_operations/finish`

- **Risque** : un marchand installé sur la même app Shopify que la victime peut rejouer son propre
  webhook signé avec un en-tête `x-shopify-shop-domain` forgé, faisant attribuer l'écriture à un
  autre tenant.
- **Cause** : Shopify ne signe (`x-shopify-hmac-sha256`) que le corps brut, jamais l'en-tête de
  boutique ; le secret HMAC est partagé par toutes les boutiques installées sous une même app
  (`lib/shopify/apps.ts`) ; ces 4 topics ne portent structurellement aucune identité de boutique dans
  leur corps (vérifié contre les fixtures E2E du dépôt, PR #143).
- **Exploitabilité mesurée** : **nulle aujourd'hui** — 2 boutiques Shopify actives en production, sur
  2 apps distinctes, 1 tenant chacune. Vérifié en production (§ « Vérification production » de
  `CLAUDE.md`, incident cross-tenant `resolveShopDomain`).
- **Contrôle compensatoire** : ne pas installer un second marchand sur une app Shopify partagée tant
  que la liaison n'est pas faite.
- **Propriétaire** : le fondateur.
- **Échéance** : avant le premier onboarding de la Phase 6.
- **Voies cadrées, non tranchées** (chiffrées au lot G) : URL de callback opaque par installation ·
  livraison via Pub/Sub ou EventBridge · vérification de la ressource auprès de l'API Shopify avec le
  token de la boutique revendiquée.
- **Limite à consigner** : `webhook_event.payload` est nullé dès que le statut passe
  `done`/`terminal` (`finish_shopify_webhook_event`) — **aucun contrôle a posteriori ne pourra donc
  jamais établir l'absence d'exploitation historique** sur ces 4 topics ; seule la détection en temps
  réel (désormais en place pour les 4 autres topics via `resolveSignedShopDomain`) protège l'avenir.

### Exception 2 — preuve 8, KOBA E2E OAuth/webhook

- **Couverture actuelle** : test unitaire du registre multi-app (routage du `client_id`, isolation
  des secrets par app, repli legacy).
- **Non prouvé** : comportement OAuth et webhook réel de bout en bout sur une installation KOBA.
- **Justification du report** : exige une boutique Shopify réelle et un accès au Partner Dashboard ;
  KOBA est un connecteur transitoire que la Phase 2 remplacera par l'adaptateur canonique — un test
  E2E lourd écrit maintenant serait à refaire.
- **Propriétaire** : le fondateur.
- **Échéance** : Phase 2.

---

## 5. Reporté hors Phase 1

- **Phase 4** : asymétrie d'audit — `execute_shopify_pcd_retention` anonymise sans écrire dans
  `audit_log`, là où le webhook `customers/redact` le fait. Même destruction de données, deux
  chemins, un seul tracé.
- **Lot d'hygiène** : `keep-alive` et `shopify-reconcile` comparent le secret de cron avec `!==` au
  lieu de `timingSafeEqual` (comparaison non constant-time).
- **Lot d'hygiène** : `shop.shop_gid` est une colonne morte, jamais lue ni écrite — un second facteur
  numérique d'identification de boutique la rendrait utile pour confronter le `shop_id` Shopify des
  payloads GDPR, en complément du domaine.
- **Lot dédié** : `saveBundleConfigurationAction` procède en `update → delete → insert` non
  transactionnel. Rendu inoffensif par la validation amont (RBAC + vérification du produit), pas
  supprimé.
- **À vérifier** : dev et production partagent la même base Supabase. Utile pendant les audits,
  risqué dès le second marchand réel — à séparer avant d'ouvrir largement les inscriptions.

---

## 6. Règles acquises — consignées dans `CLAUDE.md`

Sur les 8 règles proposées, une seule existait déjà (quasi verbatim, section « Incident production —
0134/0135 ») : *« lister les appelants et leur rôle effectif avant toute révocation de GRANT
EXECUTE »*. Les 7 autres ont été ajoutées à `CLAUDE.md` (section « Critical gotchas ») dans ce lot :

1. `CREATE OR REPLACE` conserve `ownership`/ACL, mais **pas** `SECURITY`, volatilité, parallélisme,
   `search_path` ni les valeurs par défaut des arguments.
2. `pg_get_functiondef` ne montre pas les grants — comparer l'ACL séparément
   (`has_function_privilege`/`pg_proc.proacl`).
3. Une requête de divergence doit exiger la valeur comparée **non nulle**, sinon toute absence de
   donnée ressemble à une attaque (leçon de l'incident webhook : `NULL IS DISTINCT FROM x` est
   toujours vrai).
4. Un test de sécurité ne compte que **mutation-testé** : rouge sur le code d'avant, vert après.
5. Un test purement négatif peut être vert parce que la surface est cassée — un **contrôle positif**
   est obligatoire.
6. Un helper de seed converti en capacité publique fait passer un test qui ne teste plus la même
   chose.
7. Le motif récurrent des défauts de ce chantier : **un identifiant reçu du client, jamais confronté
   au parent autoritatif, transmis à une opération qui dérive le contexte de cet identifiant
   même.**

---

## 7. Protocole du smoke production — hors de la portée de ce document

**Non exécuté.** À réaliser par le fondateur, sur la production, avec un compte réel disposant d'au
moins deux boutiques :

1. Cycle COD complet sur la boutique A : réception → confirmation → assignation → livraison →
   encaissement.
2. Un réassignement de livreur.
3. Bascule vers la boutique B, et vérification qu'**aucune donnée de A n'y apparaît**.
4. Création d'une commande manuelle dans B, absente de A.
5. Un mouvement de stock dans chaque boutique, vérifié dans le bon ledger.

**La Phase 1 ne peut pas être déclarée close avant ce smoke.** Tout ce qui est prouvé dans ce document
l'a été sur une base reconstruite par CI (`supabase db reset --local` ou l'équivalent en pipeline) ;
personne n'a encore vérifié le comportement réel en production avec deux boutiques actives
simultanément.

---

## 8. Ce qui reste après ce lot

| | |
|---|---|
| Ce lot | migration `0140` (écrite, vérifiée localement, **non poussée**) + ce document |
| Smoke production multi-boutiques | fondateur, protocole §7, ~1 h |
| Deux exceptions à acter | §4 — déjà actées par écrit, pas résolues |
| Clôture Phase 1 | après le smoke, pas avant |
