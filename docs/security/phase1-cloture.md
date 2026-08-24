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
  `CLAUDE.md`, non revérifiées à cette occasion). **Testé empiriquement en rôle `anon`** (transaction
  ouverte en local, `merchant_id`/`customer_id` réels avec historique de commandes, `ROLLBACK` — pas
  une déduction de code) : `select * from get_customer_reliability(...)` renvoie **0 ligne**. Les 5
  tables sources n'accordent aucun `GRANT` à `anon`/`PUBLIC`, donc un appel `anon` échoue avant même
  l'évaluation de la RLS. Exposée à l'exécution (`EXECUTE`) depuis `0014`, à travers le `DROP+CREATE`
  de `0049`, jamais exploitable en pratique. Fermée par `0140` (cf. §3) — ceci ne dispense pas de
  vérifier que la RLS elle-même reste correcte pour un rôle `authenticated` non membre du tenant
  concerné, question distincte non retraitée ici.
- **`assistant/chat`** : `buildAiToolSet` et la RLS de `ia_conversation` n'ont été vérifiés ni dans
  le Lot F (hors périmètre — ce n'est pas une RPC Postgres) ni dans ce lot.

**Justification du non-traitement** : dans chacun de ces cas, le SQL ou le code a été lu et jugé sûr
(à l'exception d'`assistant/chat`, non lu du tout dans cette Phase), **aucune fuite n'a été trouvée**,
et la Phase 2 refond l'accès aux données de ces surfaces — des tests écrits maintenant contre le
modèle d'accès actuel seraient à refaire contre le nouveau modèle. Ce n'est pas un report par
négligence : c'est un arbitrage explicite entre écrire un test jetable maintenant et le reporter à un
lot où il restera valide.

---

## 3. Migration 0140 — clôture du code mort exposé + de l'exécution ouverte à `anon`

`supabase/migrations/0140_close_public_execute_gaps.sql` (écrite dans ce lot, **non poussée** — cf.
§8 pour la procédure de vérification et le détail complet).

**Un premier balayage (texte des migrations) avait trouvé 9 fonctions dans cet état et en avait
raté 7 — corrigé avant clôture de ce document, pas après.** Cause identifiée, pas supposée : ce
projet tourne sur Supabase, dont le bootstrap de plateforme accorde `EXECUTE` **nommément** à
`anon`/`authenticated`/`service_role` sur toute fonction créée dans `public` — pas via le pseudo-rôle
`PUBLIC`. Un `revoke ... from public` (sans nommer `anon`) est alors un **no-op silencieux** pour ce
mécanisme : la migration a l'air fermée en texte tout en restant grande ouverte en ACL réelle. C'est
exactement ce qui s'est produit sur 5 fonctions dont les migrations d'origine (`0040`/`0041`/`0123`)
contenaient un `revoke ... from public` jamais accompagné de `from anon`. Le mécanisme symétrique
existe aussi : `reassign_order_driver` a reçu un `revoke ... from anon` en `0139` qui n'a RIEN retiré,
car son exposition venait du défaut `PUBLIC` classique de PostgreSQL (jamais un grant nommé à `anon`
à révoquer). **Seule une requête directe sur `pg_proc.proacl`, avant et après, permet de trancher —
jamais la présence d'une instruction `revoke` dans le SQL.** Vérifié ainsi pour les 15 fonctions
vivantes de ce fichier (capture avant/après sauvegardée), pas déduit du texte des migrations.

Ferme quatre classes de surface d'attaque gratuite sur **18 fonctions** exposées à `anon` trouvées
par le balayage local — **21 au total avec les 3 fermées séparément par `0141` en production, cf.
§3bis, dont une fuite réellement exploitée, pas seulement une exposition théorique.** Aucune fuite de
données prouvée sur aucune des 15 vivantes de ce fichier : **12 par appel réel en rôle `anon`** (transaction
ouverte, IDs de fixture réels, `ROLLBACK` — aucune trace laissée) et **3 par lecture complète du
corps SQL**, qui ne contient structurellement aucune référence à une table (rien à interroger,
donc rien à tester empiriquement — une preuve plus forte qu'un échantillon d'appels).

- **3 fonctions mortes** (`list_orders_paginated`, `orders_view_counts`, `list_customer_reliability`)
  — zéro appelant TS/SQL/E2E confirmé, `revoke` total y compris `authenticated`.
- **8 fonctions vivantes** avec un grant `authenticated` déjà posé par une migration antérieure
  (`cash_aging`, `receive_purchase_lot`, `resolve_order_required_component_quantities`,
  `get_customer_reliability`, `ia_finance_cost_movements`, `ia_product_cump`,
  `ia_count_recent_tool_calls`, `log_ia_tool_audit`, `reassign_order_driver`) — `revoke` de
  `public`/`anon` uniquement, le grant `authenticated` existant n'est pas touché.
- **5 fonctions vivantes n'ayant jamais reçu le moindre grant explicite** depuis leur création
  (`is_member_of`, `order_items_search_text`, `derive_legacy_cod_status`,
  `validate_pcd_access_audit_metadata`, `sn_phone_e164`) — `revoke` de `public`/`anon` **puis**
  `grant` explicite à `authenticated`, pour ne rien casser. `is_member_of` en particulier est
  appelée directement dans 6 fichiers de policies RLS ; sans ce grant, toute requête `authenticated`
  sur les tables scopées merchant aurait échoué en `permission denied`.
- **1 fonction déjà restreinte à `service_role`** (`purge_pcd_access_audit`) — `revoke` de
  `public`/`anon` seulement, aucun grant `authenticated` ajouté (la fonction refuse tout appelant
  qui n'est pas `service_role`, testé empiriquement : `42501`).

**Les 12 fonctions testées par appel réel en rôle `anon`** (contrôle positif via une fixture réelle
— owner authentique, produit, commande, mouvement de stock, ligne de commande, livreur — construite
puis effacée dans la même transaction que le test anon, jamais commitée) :

| Fonction | Contrôle positif (owner) | Résultat `anon` |
|---|---|---|
| `get_customer_reliability` | — (client réel avec historique) | **0 ligne** |
| `reassign_order_driver` | — (ordre réel assigné) | `order_not_found`, **0 mutation** vérifiée après coup |
| `log_ia_tool_audit` | — | `NULL` retourné, **0 ligne insérée** (compté après coup) |
| `ia_count_recent_tool_calls` | — | **`0`** |
| `purge_pcd_access_audit` | — | exception **`42501`** |
| `ia_finance_cost_movements` | **1 ligne** (mouvement `sold` réel, coût 5000) | **0 ligne** |
| `ia_product_cump` | **1 ligne** (coût unitaire 5000) | **0 ligne** |
| `cash_aging` | **1 ligne** (livreur réel, 3000 en souffrance) | **0 ligne** |
| `resolve_order_required_component_quantities` | **1 ligne** (quantité requise réelle) | exception **`42501`, `permission denied for table order_line`** — la table ne grant rien à `anon`, pas seulement la fonction |
| `is_member_of` | **`true`** (owner réel) | **`false`** |
| `receive_purchase_lot` | — | exception **`42501`, `forbidden`** avant tout accès table |
| `sn_phone_e164` | — (fonction pure) | s'exécute (`+221770123456`), aucune donnée protégée à fuir |

**Les 3 fonctions closes sans test `anon`, parce qu'il n'y a structurellement rien à tester** :
`order_items_search_text`, `derive_legacy_cod_status`, `validate_pcd_access_audit_metadata` — corps
SQL lu intégralement, chacune opère uniquement sur ses propres arguments (`jsonb`/`text`), aucune
clause `FROM` vers une table. Un appel `anon` ne peut rien retourner qu'un attaquant ne fournisse
déjà lui-même en argument.

**Balayage jugé clos, pas seulement « pas encore retrouvé d'autres cas » :** une requête exhaustive
sur `pg_proc` couvrant **tous les types d'objets** (fonctions, procédures) dans **les deux seuls
schémas exposés par PostgREST** (`public` et `graphql_public` — confirmé dans
`supabase/config.toml:6`, le schéma `private` où vit le cœur de `post_stock_movement` depuis `0136`
n'y figure pas) ne trouve, après application de `0140`, plus aucune fonction avec
`has_function_privilege('anon', oid, 'EXECUTE') = true` **hormis `graphql_public.graphql(...)`** —
l'entrée GraphQL fournie par l'extension `pg_graphql` de la plateforme Supabase elle-même, jamais
définie par une migration de ce projet (confirmé par grep, zéro résultat), hors du périmètre d'un
`revoke` applicatif. Le critère de clôture est : **zéro fonction définie par ce projet, dans un
schéma que PostgREST expose réellement, ne reste exécutable par `anon`.** **Ce critère a été vérifié
UNIQUEMENT contre une base locale reconstruite depuis les migrations committées — jamais contre la
production elle-même à ce stade.** C'est précisément la limite qui a laissé passer 3 fonctions
supplémentaires, découvertes séparément en production et fermées par `0141` — cf. §3bis, qui
corrige le compte final à **21 fonctions**, pas 18.

Détail complet, table par table, dans le corps du fichier de migration.

---

## 3bis. Incident production — dérive ACL hors migration (24 août 2026)

**Ce qui a été trouvé en production, pas en local, et pas par le balayage qui a précédé `0140`.**
Un contrôle direct contre la production (hors de la portée de l'agent au moment de `0140` — jamais
exécuté avant ce lot) a montré que `reconcile_product_stock()`, appelée en rôle `anon`, retournait
**13 lignes réelles** (`product_id`, `merchant_account_id`, quantités stockées/ledger, delta) — tous
tenants confondus. `SECURITY DEFINER`, `search_path = ''`, aucune garde de rôle interne : la RLS ne
s'applique jamais sous `SECURITY DEFINER`, donc rien en dessous n'aurait pu bloquer cet appel.
**C'est une fuite réellement exploitée au moment du contrôle, pas une exposition théorique** — la
distinction centrale de cet incident. `reconcile_order_cod_status()` (même famille, même absence de
garde) a renvoyé 0 ligne au moment du contrôle, uniquement parce qu'aucune incohérence `cod_status`
n'existait alors en production — elle aurait exposé dès qu'une incohérence serait apparue, ce qui
n'a rien de garanti dans le temps. `rebuild_product_stock()` (même famille) **écrit** : recompute
global du stock à la demande, un vecteur de déni de service en plus du risque de lecture des deux
autres.

**Diagnostic établi, pas supposé : ce n'était pas un trou dans les migrations.**
`0043_phase9_definer_gates_nullsafe.sql` (lignes 1004-1006) revoque déjà, nommément, les trois
fonctions des trois rôles `public, anon, authenticated` — exactement le motif recommandé dans ce
même lot pour tout `revoke` robuste sur Supabase. Vérifié empiriquement : un `supabase db reset
--local` qui rejoue l'historique complet des migrations committées (`0001`→`0140`, sans aucune
modification) produit `has_function_privilege('anon', oid, 'EXECUTE') = false` **et**
`has_function_privilege('authenticated', oid, 'EXECUTE') = false` pour les trois fonctions, exactement
comme voulu par `0043`. Le balayage exhaustif mené avant la fusion de `0140` (requête `pg_proc`
couvrant tous les schémas exposés par PostgREST, après un `db reset --local` complet) reflétait donc
fidèlement ce que produisent les migrations committées — aucun angle mort de filtre, aucun trou de
couverture de schéma.

**L'écart exact, établi et non supposé : le balayage a interrogé une base reconstruite depuis les
migrations committées, jamais la production elle-même.** Le contrôle qui a trouvé la fuite, lui, a
interrogé la production directement. La production avait donc dérivé du référentiel versionné : à un
moment non daté, postérieur à `0043`, un `GRANT EXECUTE` a été appliqué directement sur la base de
production — hors de toute migration, jamais committé, invisible dans
`supabase_migrations.schema_migrations`. **Aucun `db reset --local`, aussi rigoureux soit le
balayage qui le suit, ne peut détecter ce type de dérive : il ne rejoue que ce qui est committé,
jamais ce qui a été fait hors bande directement sur une base réelle.** C'est une limite structurelle
de toute vérification locale, pas un défaut de méthode corrigible par une requête différente — la
conséquence pratique la plus large de tout ce chantier : **`supabase migration list --linked` peut
afficher `Local = Remote` sur l'intégralité des migrations pendant que les ACL réelles divergent.**
Cette commande compare la liste des migrations appliquées, pas l'état réel du schéma ; toute
l'attestation de ce projet (cf. les nombreuses notes d'attestation historiques de `CLAUDE.md`) s'est
jusqu'ici reposée sur elle seule pour ce genre de garantie.

**Correctif manuel en production (par le porteur, avant `0141`), et son état exact aujourd'hui :**
`revoke execute ... from anon, public` appliqué manuellement sur les trois fonctions — confirmé,
`anon_exec = false` en production au moment de la vérification. **Ce correctif était partiel :
`authenticated` n'a pas été touché.** Un contrôle direct et exhaustif contre la production (mené
dans ce lot, comparant CHAQUE fonction des schémas exposés par PostgREST — `anon` et
`authenticated` — plus chaque table (4 privilèges), chaque séquence et l'`USAGE` de schéma, local vs
production) confirme : **`reconcile_product_stock`, `reconcile_order_cod_status` et
`rebuild_product_stock` restent exécutables par `authenticated` en production à ce jour.** Comme ce
sont des fonctions `SECURITY DEFINER` sans garde de rôle, **tout utilisateur connecté de n'importe
quel tenant peut aujourd'hui encore obtenir la même fuite cross-tenant que celle observée en `anon`**
— ce n'est pas résolu par le correctif manuel déjà appliqué, seulement par `0141` une fois poussée
(ou par un second correctif manuel équivalent sur `authenticated`, plus urgent que le cycle normal de
revue de cette PR).

**Aucune autre dérive trouvée.** Le même contrôle exhaustif (toutes les tables du schéma `public`,
les 4 privilèges standards, `anon` et `authenticated`, séquences, `USAGE` de schéma sur
`public`/`graphql_public`/`private`) ne montre **aucune différence** entre l'état réel de production
et un rejeu local propre — sur aucun objet en dehors des trois fonctions déjà connues. Ce n'est pas
une preuve qu'aucune autre dérive n'existera jamais ailleurs dans le catalogue (index, triggers,
policies RLS elles-mêmes, `pg_default_acl`) ; c'est une preuve que, sur le périmètre vérifié ici
(fonctions × 2 rôles, tables × 4 privilèges × 2 rôles, séquences, schémas), **rien d'autre n'a
dérivé au moment de ce contrôle.**

**Origine du `GRANT` manuel — question ouverte, pas tranchée.** Un `GRANT` ne s'applique jamais seul
: il vient soit d'une intervention manuelle passée (Studio UI, `psql`/`db query --linked` ad hoc,
script d'exploitation), soit d'un outil (une opération de la plateforme Supabase, une migration
d'un outil tiers, un reset partiel). Aucune trace exploitable n'a été trouvée dans ce lot pour
trancher entre ces hypothèses — PostgreSQL ne journalise pas les `GRANT`/`REVOKE` par défaut (pas
d'extension d'audit DDL confirmée active sur ce projet), et Supabase ne semble pas exposer d'historique
d'audit des changements de privilèges consultable depuis cet environnement. **Sans connaître
l'origine, on ne peut pas garantir que la dérive ne reviendra pas** — même après `0141`. À
investiguer séparément (logs Supabase, historique d'accès à la base, mémoire de l'équipe), pas
tranché ici.

**Migration `0141`** (`supabase/migrations/0141_reassert_reconciliation_functions_closed.sql`) :
reversionne le même `revoke` (les trois fonctions, `public, anon, authenticated`) — idempotent,
sans effet si déjà appliqué (confirmé : `db reset --local` avec `0141` produit un état identique à
sans elle, puisque `0043` fermait déjà tout en local). Elle ne protège que le cas d'un rejeu de
migrations depuis zéro (nouvel environnement, restauration) — **elle ne détecte ni ne prévient une
dérive future appliquée directement en production, hors migration, comme celle-ci.** Le vrai remède
à cette classe de risque serait une vérification périodique des ACL en CI — un job comparant l'état
`pg_proc`/`pg_class` attendu (déduit des migrations) à l'état réel de la production liée, alertant
sur toute divergence avant qu'elle ne devienne un incident. **Non construit dans ce lot** (portée
volontairement limitée à la fermeture immédiate), consigné ici comme dette pour un futur lot dédié.

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

**Règle n°8, ajoutée après l'incident production `0141` (§3bis)** : **`supabase migration list
--linked` compare la liste des migrations appliquées, pas l'état réel du schéma.** Elle peut afficher
`Local = Remote` sur l'intégralité de l'historique pendant que les ACL réelles ont dérivé par un
`GRANT`/`REVOKE` appliqué directement en production, hors de toute migration — cette commande ne
peut structurellement pas détecter ce cas. Toute garantie de sécurité au niveau des privilèges doit
donc être vérifiée par une requête directe sur le catalogue système (`pg_proc.proacl`,
`has_function_privilege`, `has_table_privilege`) exécutée **contre la base réellement concernée**
(local pour valider une migration, production pour valider l'état réel) — jamais déduite de l'état
« migrations appliquées » seul, aussi vert soit-il.

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
| Ce lot | migrations `0140` + `0141` (écrites, vérifiées localement, **non poussées**) + ce document |
| **Urgent, indépendant du cycle de revue de cette PR** | `authenticated` reste exécutable en production sur les 3 fonctions de §3bis **à ce jour** — le correctif manuel du porteur n'a fermé que `anon`/`public`. Recommandé : second correctif manuel immédiat sur `authenticated`, sans attendre la fusion de `0141`. |
| Origine du `GRANT` manuel | question ouverte, non tranchée — §3bis |
| Vérification périodique des ACL en CI | dette consignée, non construite — §3bis / §6 règle n°8 |
| Smoke production multi-boutiques | fondateur, protocole §7, ~1 h |
| Deux exceptions à acter | §4 — déjà actées par écrit, pas résolues |
| Clôture Phase 1 | après le smoke, pas avant |
