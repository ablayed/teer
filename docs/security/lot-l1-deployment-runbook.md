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

```sql
select
  count(*) as rows_without_shop_context,
  string_agg(shopify_webhook_id, ', ' order by received_at) as webhook_ids
from public.webhook_event
where merchant_account_id is null or shop_id is null;
```

Cette requête reproduit exactement le bloc préflight (5) de `0142` — `l1_ingestion_event_backfill_missing_shop_context`
— pour connaître le résultat AVANT de pousser la migration, jamais après un échec en production.

---

## La règle, sans ambiguïté

- **Si `rows_without_shop_context = 0`** : `0142` peut être poussée (`supabase db push`, exécuté
  par le porteur — jamais par un agent, cf. `CLAUDE.md` règle #2).
- **Si `rows_without_shop_context > 0`** : **le déploiement s'arrête ici.** `0142` échouera à
  l'identique en production (mêmes DO blocks, même contrainte `NOT NULL`) — mais en production,
  après un `db push` engagé, pas avant. Ne pas pousser en espérant que ça passe.

  Ce n'est pas un avertissement à franchir avec un correctif de dernière minute. `webhook_ids`
  liste les lignes concernées ; la décision qui se rouvre à ce stade est celle de `0142` elle-même
  — **`merchant_account_id`/`shop_id` NOT NULL sur `ingestion_event`, sans repli sur une boutique
  par défaut** (documentée dans l'en-tête de `0142` et dans `CLAUDE.md`). Rouvrir cette décision
  n'est pas au porteur de ce runbook de trancher seul : elle revient au fondateur, avec le compte
  exact et les identifiants obtenus par cette requête comme donnée d'entrée, pas une estimation.

  Le seul fait documenté à ce jour (audit prod antérieur, cf. `CLAUDE.md`, incident cross-tenant
  `resolveShopDomain`) est que 2 lignes de ce type existaient au 2026-05-30 (webhooks de test
  Shopify vers un domaine générique jamais enregistré). Ce nombre peut avoir changé depuis — la
  requête ci-dessus fait foi, pas ce rappel historique.

---

## Séquence complète

1. Confirmer le PASS du Lot 4B (baseline `ci_schema_auditor` en production).
2. Exécuter le préflight ci-dessus contre la production, en lecture seule.
3. `rows_without_shop_context = 0` → passer à l'étape 4. Sinon → **STOP**, rapporter le compte et
   les `webhook_ids` au fondateur, ne pas pousser.
4. `supabase db push` (porteur).
5. `supabase migration list --linked` (confirmer `0142` en colonnes *Local* et *Remote*).
6. `pnpm db:types` (linked) puis `pnpm format` — vérifier que le diff correspond exactement aux
   nouvelles tables/colonnes attendues (`store_connection`, `external_ref`, `ingestion_event`,
   `orders.store_connection_id`), rien d'autre.
