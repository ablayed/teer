# Runbook de déploiement — Lot L1 (migration `0142`)

> Document opérationnel. Ne remplace pas `CLAUDE.md` (source de vérité) — décrit la séquence
> exacte à exécuter pour déployer `supabase/migrations/0142_l1_canonical_ingestion_schema.sql`
> en production, et rien d'autre.

---

## Verrou — à ne pas franchir avant confirmation

**Ce runbook ne s'exécute qu'après un PASS du Lot 4B** (baseline production réussie avec le rôle
`ci_schema_auditor` — voir `CLAUDE.md`, section « Lot 4A — détection de l'exposition ACL »). Avant
ce PASS, `0142` reste committée, appliquée en local, verte en CI — **jamais déployée**. Ce verrou
est indépendant du harnais de backfill (`scripts/l1-backfill-harness.sh`, `ci.yml` job
`l1-backfill-harness`) : le harnais prouve que le backfill est correct sur une fixture ; il ne dit
rien de l'état réel de la production, exactement la classe de dérive documentée pour l'incident
`0141` (`reconcile_product_stock`).

Si tu lis ce document sans confirmation explicite que le Lot 4B a PASS, **arrête-toi ici**.

---

## Pourquoi ce préflight n'utilise pas `ci_schema_auditor`

`ci_schema_auditor` (Lot 4B) est un rôle **sans aucun privilège de lecture sur les données
métier** — c'est précisément cette propriété qui le rend sûr à connecter en continu contre la
production (`LOGIN`, aucun `SELECT` au-delà des catalogues système `pg_proc`/`pg_class`/etc.). Lui
accorder un `SELECT` sur `webhook_event`, même borné à deux colonnes, pour ce comptage détruirait
cette garantie et laisserait une dette de privilège après le déploiement — un rôle censé ne jamais
lire de donnée métier qui en lirait une, en permanence, pour un contrôle exécuté une fois.

**Ce préflight est donc une lecture manuelle, en lecture seule, exécutée une fois par le porteur
avant de pousser `0142`** — jamais un rôle CI, jamais une automatisation permanente. La requête est
fournie ci-dessous pour être collée telle quelle dans le SQL Editor Supabase (ou tout client
connecté avec des identifiants qui ont un accès de lecture légitime à la production), pas pour être
exécutée par un service.

---

## Le préflight, prêt à coller

**LOT L1-bis (25 août 2026) : le préflight ne compte plus, il VENTILE par terminalité.** Le
préflight original (simple compte de `merchant_account_id is null or shop_id is null`) a été
exécuté contre la production le 25 août 2026 et a trouvé **8 lignes**, pas 2 — toutes
`status in ('done','terminal')`. `0142` telle qu'elle existait alors aurait donc échoué en
production, après un `db push` engagé : le verrou a fonctionné, mais le préflight lui-même donnait
un résultat trop grossier pour décider quoi que ce soit. `0142` a été corrigée sur place (jamais
déployée à ce moment, cf. l'exception d'édition documentée dans `CLAUDE.md`) pour distinguer un
événement **terminé** sans contexte (exclu du backfill, sans risque — il n'a jamais eu de
traitement applicatif rattachable à une boutique) d'un événement **encore en vol**
(`processing`/`retryable`) ou à **contexte partiel** (une seule des deux colonnes nulle) sans
contexte, qui doit continuer à bloquer.

```sql
select
  status,
  count(*) as rows_without_full_shop_context,
  string_agg(shopify_webhook_id, ', ' order by received_at) as webhook_ids
from public.webhook_event
where merchant_account_id is null or shop_id is null
group by status
order by status;
```

Cette requête reproduit exactement le bloc préflight (5) de `0142` — reste à appliquer la même
ventilation que la migration :

- **`status in ('done', 'terminal')` ET les DEUX colonnes nulles** → exclu du backfill sans
  bloquer (`l1_ingestion_event_backfill_excluded_no_context`, `RAISE NOTICE`).
- **Toute autre ligne de ce résultat** — `status` en dehors de `('done','terminal')` (en vol, ou
  toute valeur imprévue), OU une seule des deux colonnes nulle quel que soit le statut — →
  `l1_ingestion_event_backfill_missing_shop_context`, `RAISE EXCEPTION`, migration bloquée.

Aucune lecture de `shop_domain` dans cette décision, même si le domaine correspond à une boutique
active : c'est un en-tête webhook non signé (incident cross-tenant `resolveShopDomain`, cf.
`CLAUDE.md`), son autorité ne doit jamais peser sur ce qui entre dans le registre canonique.

---

## La règle, sans ambiguïté

- **Si toutes les lignes retournées ont `status in ('done', 'terminal')`** (ou si la requête ne
  retourne aucune ligne) : `0142` peut être poussée (`supabase db push`, exécuté par le porteur —
  jamais par un agent, cf. `CLAUDE.md` règle #2). Le décompte exact de ces lignes est le nombre
  d'exclusions attendu au déploiement — le retrouver dans le `NOTICE`
  `l1_ingestion_event_backfill_excluded_no_context` de la sortie `db push` confirme que rien
  d'inattendu ne s'est glissé entre le préflight et le push.
- **Si au moins une ligne a un `status` hors de `('done', 'terminal')`, ou porte un contexte
  partiel (une seule colonne nulle)** : **le déploiement s'arrête ici.** `0142` échouera à
  l'identique en production (même DO block, même distinction) — mais en production, après un
  `db push` engagé, pas avant. Ne pas pousser en espérant que ça passe.

  Ce n'est pas un avertissement à franchir avec un correctif de dernière minute. `webhook_ids`
  liste les lignes concernées par statut. Pour une ligne en vol (`processing`/`retryable`), la
  question à trancher est opérationnelle : laisser le rejeu naturel (cron de retry) la faire
  progresser vers un état terminal, ou l'investiguer si elle est bloquée depuis longtemps — jamais
  la forcer manuellement en `done`/`terminal` pour débloquer le déploiement. Pour un contexte
  partiel, la décision qui se rouvre est celle de `0142` elle-même — **`merchant_account_id`/
  `shop_id` NOT NULL sur `ingestion_event`, sans repli sur une boutique par défaut** (documentée
  dans l'en-tête de `0142` et dans `CLAUDE.md`). Rouvrir cette décision n'est pas au porteur de ce
  runbook de trancher seul : elle revient au fondateur, avec le compte exact et les identifiants
  obtenus par cette requête comme donnée d'entrée, pas une estimation.

  **Résultat du 25 août 2026, pour référence, PAS comme hypothèse à réutiliser pour un futur
  déploiement** : 8 lignes, toutes `status in ('done', 'terminal')`, aucune bloquante — 5 sur le
  domaine `teer-test.myshopify.com` (boutique de test active), 3 sur des domaines génériques non
  enregistrés (outil « Send test notification » Shopify). Ce chiffre remplace la mention
  historique « 2 lignes au 30 mai 2026 » (audit `resolveShopDomain`, cf. `CLAUDE.md`), qui portait
  sur un sous-ensemble plus ancien et ne doit plus être citée comme ordre de grandeur — seule la
  requête ci-dessus, ré-exécutée au moment du déploiement, fait foi.

---

## Séquence complète

1. Confirmer le PASS du Lot 4B (baseline `ci_schema_auditor` en production).
2. Exécuter le préflight ventilé ci-dessus contre la production, en lecture seule.
3. Toutes les lignes retournées (s'il y en a) ont `status in ('done', 'terminal')` → passer à
   l'étape 4, en notant le décompte total comme exclusions attendues. Sinon (au moins une ligne en
   vol ou à contexte partiel) → **STOP**, rapporter le compte ventilé et les `webhook_ids` au
   fondateur, ne pas pousser.
4. `supabase db push` (porteur) — vérifier dans sa sortie que le `NOTICE`
   `l1_ingestion_event_backfill_excluded_no_context` porte exactement le décompte noté à l'étape 3.
5. `supabase migration list --linked` (confirmer `0142` en colonnes *Local* et *Remote*).
6. `pnpm db:types` (linked) puis `pnpm format` — vérifier que le diff correspond exactement aux
   nouvelles tables/colonnes attendues (`store_connection`, `external_ref`, `ingestion_event`,
   `orders.store_connection_id`), rien d'autre.
