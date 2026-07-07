-- Backfill OPTIONNEL — cash_collected_at daté au clic au lieu de scheduled_for.
-- Suite de la migration 0096 (fix forward, ne corrige QUE les futures livraisons).
-- Ce script corrige l'HISTORIQUE des commandes déjà livrées avant 0096.
--
-- ==========================================================================
-- NE JAMAIS EXÉCUTER VIA `supabase migration up` NI PAR L'AGENT. Ce n'est PAS
-- une migration — pas de fichier dans supabase/migrations, pas de db push,
-- pas de db:types associé. À exécuter MANUELLEMENT par le porteur (éditeur
-- SQL Supabase ou psql), après relecture complète, à un moment choisi par lui.
-- ==========================================================================
--
-- Périmètre (identique au diagnostic Phase A bis, scope LARGE — les 62
-- commandes, pas seulement les 19 à impact mensuel visible) :
--   order_state = 'completed'
--   delivery_state = 'delivered'
--   cash_state = 'collected'          -- garde ajoutée (Phase B) : exclut toute
--                                        commande dont le cash_state aurait
--                                        divergé depuis (remitted/discrepancy
--                                        ne sont normalement pas possibles avec
--                                        delivery_state='delivered' pour ces
--                                        colonnes, mais on ne backfill que ce
--                                        qui correspond exactement à l'état qui
--                                        a réellement posé cash_collected_at
--                                        dans transition_order).
--   scheduled_for is not null
--   cash_collected_at is not null
--   scheduled_for <> cash_collected_at
-- Annulées/refusées/retournées exclues PAR CONSTRUCTION (order_state='completed'
-- AND delivery_state='delivered' ne matche jamais une commande annulée,
-- refusée, ou retournée — order_state passe à 'returned' et delivery_state à
-- 'returned' sur un retour, cf. transition_order, illegal_return_transition).
--
-- Effets de bord du UPDATE à connaître AVANT d'exécuter (vérifiés en lisant
-- les triggers réels sur public.orders) :
--   1. `orders_set_updated_at` (BEFORE UPDATE, migration 0005) va poser
--      updated_at = now() sur CHAQUE ligne touchée — c'est un horodatage
--      technique, pas une donnée métier, mais ça veut dire que `updated_at`
--      ne reflètera plus "dernière vraie modification métier" pour ces lignes
--      après le backfill. Accepté (pas de contournement du trigger).
--   2. `orders_sync_legacy_cod_status` (BEFORE INSERT OR UPDATE, 0023/0055) va
--      recalculer cod_status à partir des 4 dimensions (order_state,
--      call_state, delivery_state, cash_state) — AUCUNE de ces colonnes n'est
--      touchée par ce backfill (seul cash_collected_at est dans le SET), donc
--      cod_status recalculé = cod_status actuel, aucun changement de valeur.
--      Vérifié en lisant le corps du trigger (0055) : pas de dépendance à
--      cash_collected_at.
--   3. Aucun trigger n'écrit `audit_log` sur `orders` — l'écriture d'audit_log
--      se fait exclusivement côté TS (`lib/actions/transitions.ts`,
--      `performTransitionForContext`), jamais par trigger DB. Ce backfill ne
--      laissera donc AUCUNE trace dans audit_log. C'est attendu (ce n'est pas
--      une transition métier, juste une correction de donnée historique) mais
--      à savoir si un futur audit cherche une trace de ce changement.
--
-- Idempotence : la clause WHERE rend un second passage sans effet naturel
-- (après le premier UPDATE, cash_collected_at = scheduled_for, donc la
-- condition `scheduled_for <> cash_collected_at` ne matche plus aucune ligne
-- déjà corrigée). CE N'EST PAS UN ROLLBACK : aucune trace de l'ancienne valeur
-- de cash_collected_at n'est conservée après exécution. Si le porteur veut
-- pouvoir annuler ce backfill, il doit noter les valeurs AVANT exécution (ou
-- exporter/sauvegarder les lignes concernées — cf. requête 0 ci-dessous, qui
-- produit exactement ce sous-ensemble et peut servir de sauvegarde si son
-- résultat est exporté avant l'UPDATE).

-- ==========================================================================
-- 0. SAUVEGARDE FACULTATIVE — exporter ce résultat AVANT l'UPDATE si un
--    rollback manuel doit rester possible (aucune colonne d'historique
--    n'existe pour cash_collected_at).
-- ==========================================================================
select
  id,
  merchant_account_id,
  order_number,
  cash_collected_at as cash_collected_at_avant,
  scheduled_for
from public.orders
where order_state = 'completed'
  and delivery_state = 'delivered'
  and cash_state = 'collected'
  and scheduled_for is not null
  and cash_collected_at is not null
  and scheduled_for <> cash_collected_at;

-- ==========================================================================
-- 1. RE-VÉRIFICATION — recompte le périmètre exact du diagnostic Phase A bis
--    pour confirmer qu'il n'a pas dérivé depuis (nouvelles livraisons entre-
--    temps). SELECT uniquement, aucune écriture.
-- ==========================================================================
select
  count(*) as commandes_concernees,
  sum(total_amount)::bigint as ca_concerne_fcfa
from public.orders
where order_state = 'completed'
  and delivery_state = 'delivered'
  and cash_state = 'collected'
  and scheduled_for is not null
  and cash_collected_at is not null
  and scheduled_for <> cash_collected_at;

-- Comparer ce résultat à la baseline Phase A bis (62 commandes, ~99 200 FCFA
-- d'impact mensuel réel sur 19 d'entre elles) avant de continuer. Un écart
-- important signale de nouvelles commandes livrées avec retard depuis le
-- diagnostic initial — normal si du temps a passé, mais à confirmer que ce
-- sont bien des cas légitimes (scheduled_for < cash_collected_at par retard
-- de saisie), pas une anomalie nouvelle.

-- ==========================================================================
-- 2. UPDATE — À EXÉCUTER MANUELLEMENT UNIQUEMENT, APRÈS VALIDATION DES
--    ÉTAPES 0 ET 1 CI-DESSUS. JAMAIS PAR L'AGENT.
-- ==========================================================================
-- update public.orders
--    set cash_collected_at = scheduled_for
--  where order_state = 'completed'
--    and delivery_state = 'delivered'
--    and cash_state = 'collected'
--    and scheduled_for is not null
--    and cash_collected_at is not null
--    and scheduled_for <> cash_collected_at;
