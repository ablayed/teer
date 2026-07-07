-- Diagnostic READ-ONLY — Lot 4b+4c / PR 1.
-- Mesure l'effet historique cumulé de allocate_to_courier / courier_return_lot
-- sur product_stock.qty_on_hand (retiré par les migrations 0093/0094) et
-- distingue les produits où une restitution manuelle serait sûre de ceux où
-- elle serait risquée. Aucune écriture (SELECT uniquement). À lancer
-- manuellement par le porteur (éditeur SQL Supabase / psql), jamais via
-- `supabase migration up`.
--
-- Méthode :
--   pre_change_ledger/pre_change_discrepancy : reproduisent l'allowlist de
--   reconcile_product_stock() TELLE QU'ELLE ÉTAIT AVANT ce lot (0032,
--   incluant encore allocate_to_courier/courier_return_lot). Un
--   pre_change_delta <> 0 signale un écart qui existait déjà AVANT tout
--   changement de ce lot — signe probable d'un clamp historique
--   (greatest(0, ...) silencieux sur allocate_to_courier, cf. audit Phase A)
--   ou d'une correction manuelle en base. Ce script reste correct que la
--   comparaison soit lancée avant ou après l'application de 0093/0094,
--   puisqu'il ne dépend d'aucune fonction en vigueur (tout est réécrit en
--   SQL brut ici).
--
--   lot_net_effect : somme signée des deux movement_type
--   (allocate_to_courier négatif, courier_return_lot positif) = montant net
--   qu'une restitution manuelle viserait à annuler pour les produits
--   "propres" (qty_on_hand := qty_on_hand - net_delta_on_hand).
--
-- Classification :
--   propre    : pre_change_delta = 0 → aucun écart préexistant détecté avant
--               ce lot, la restitution du net_delta_on_hand est un candidat
--               sûr (sous réserve de validation du porteur).
--   a_risque  : pre_change_delta <> 0 → un écart existait déjà AVANT ce lot
--               (clamp historique ou anomalie antérieure) → NE PAS restituer
--               automatiquement, dette à documenter séparément.
--
-- Aucune commande de restitution n'est fournie ici : elle fera l'objet d'un
-- script séparé, une fois ce diagnostic validé par le porteur.

-- 1. Détail par produit -------------------------------------------------
with pre_change_ledger as (
  select
    sm.product_id,
    sm.merchant_account_id,
    coalesce(sum(sm.qty), 0)::integer as ledger_qty
  from public.stock_movement sm
  where sm.movement_type in (
    'purchase_in', 'dispatch', 'courier_return',
    'manual_adjustment', 'allocate_to_courier', 'courier_return_lot'
  )
  group by sm.product_id, sm.merchant_account_id
),
pre_change_discrepancy as (
  select
    ps.product_id,
    ps.merchant_account_id,
    ps.qty_on_hand as stored_qty_on_hand,
    ps.unit_cost,
    coalesce(l.ledger_qty, 0) as pre_change_ledger_qty,
    ps.qty_on_hand - coalesce(l.ledger_qty, 0) as pre_change_delta
  from public.product_stock ps
  left join pre_change_ledger l
    on l.product_id          = ps.product_id
   and l.merchant_account_id = ps.merchant_account_id
),
lot_net_effect as (
  select
    sm.product_id,
    sm.merchant_account_id,
    coalesce(sum(sm.qty), 0)::integer as net_delta_on_hand,
    coalesce(sum(sm.qty) filter (where sm.movement_type = 'allocate_to_courier'), 0)::integer
      as allocate_to_courier_total,
    coalesce(sum(sm.qty) filter (where sm.movement_type = 'courier_return_lot'), 0)::integer
      as courier_return_lot_total
  from public.stock_movement sm
  where sm.movement_type in ('allocate_to_courier', 'courier_return_lot')
  group by sm.product_id, sm.merchant_account_id
)
select
  p.title,
  p.sku,
  d.merchant_account_id,
  d.product_id,
  d.stored_qty_on_hand,
  d.pre_change_delta,
  coalesce(n.net_delta_on_hand, 0)             as lot_net_delta_on_hand,
  coalesce(n.allocate_to_courier_total, 0)     as allocate_to_courier_total,
  coalesce(n.courier_return_lot_total, 0)      as courier_return_lot_total,
  case when d.pre_change_delta = 0 then 'propre' else 'a_risque' end as classification,
  coalesce(n.net_delta_on_hand, 0)::bigint * coalesce(d.unit_cost, 0) as estimated_value_minor
from pre_change_discrepancy d
join public.product p on p.id = d.product_id
left join lot_net_effect n
  on n.product_id          = d.product_id
 and n.merchant_account_id = d.merchant_account_id
where coalesce(n.net_delta_on_hand, 0) <> 0
   or d.pre_change_delta <> 0
order by classification desc, abs(coalesce(n.net_delta_on_hand, 0)) desc;

-- 2. Résumé agrégé (vision d'ampleur) ------------------------------------
with pre_change_ledger as (
  select
    sm.product_id,
    sm.merchant_account_id,
    coalesce(sum(sm.qty), 0)::integer as ledger_qty
  from public.stock_movement sm
  where sm.movement_type in (
    'purchase_in', 'dispatch', 'courier_return',
    'manual_adjustment', 'allocate_to_courier', 'courier_return_lot'
  )
  group by sm.product_id, sm.merchant_account_id
),
pre_change_discrepancy as (
  select
    ps.product_id,
    ps.merchant_account_id,
    ps.qty_on_hand,
    ps.unit_cost,
    ps.qty_on_hand - coalesce(l.ledger_qty, 0) as pre_change_delta
  from public.product_stock ps
  left join pre_change_ledger l
    on l.product_id          = ps.product_id
   and l.merchant_account_id = ps.merchant_account_id
)
select
  count(*) filter (where pre_change_delta <> 0)              as produits_a_risque,
  count(*) filter (where pre_change_delta = 0)               as produits_propres,
  sum(abs(pre_change_delta)) filter (where pre_change_delta <> 0)
    as total_unites_a_risque,
  sum(abs(pre_change_delta) * coalesce(unit_cost, 0)) filter (where pre_change_delta <> 0)
    as total_valeur_a_risque_minor
from pre_change_discrepancy;
