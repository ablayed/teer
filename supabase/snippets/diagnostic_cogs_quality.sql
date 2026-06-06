-- Diagnostic READ-ONLY de la qualité du COGS (Phase 6c).
-- Ventile, sur une période donnée (cash_collected_at), les commandes encaissées et leurs
-- lignes `sold` selon la disponibilité du coût de revient. À lancer sur la PROD via l'éditeur
-- SQL Supabase (ou `supabase db remote` / psql sur le projet lié). Aucune écriture.
--
-- Buckets :
--   1_orders_without_sold        : commandes encaissées SANS aucun mouvement sold
--                                  (lignes non résolues / sans order_line) → exclues du COGS.
--   2_frozen0_cump_avail         : lignes sold à coût figé 0 MAIS CUMP courant > 0
--                                  → estimables (fallback CUMP, marge « estimée »).
--   3_frozen0_no_cump_blindspot  : lignes sold à coût figé 0 ET CUMP courant 0
--                                  → coût totalement inconnu → exclues + signalées (pas de 0 silencieux).
--   _sold_lines_real_cost        : lignes sold à coût figé > 0 → COGS réel.
--
-- Adapter la période ci-dessous (et p_merchant si on veut scoper un tenant).
with params as (
  select
    '2000-01-01'::timestamptz as p_from,
    now()                     as p_to
    -- , '<uuid-merchant>'::uuid as p_merchant   -- décommenter pour scoper un tenant
),
collected as (
  select o.id
  from public.orders o, params
  where o.cash_collected_at is not null
    and o.cash_collected_at >= params.p_from
    and o.cash_collected_at <= params.p_to
    -- and o.merchant_account_id = params.p_merchant
),
sold as (
  select
    sm.order_id,
    sm.product_id,
    sm.qty,
    coalesce(sm.unit_cost, 0) as frozen,
    coalesce(ps.unit_cost, 0) as cump
  from public.stock_movement sm
  join collected c on c.id = sm.order_id
  left join public.product_stock ps on ps.product_id = sm.product_id
  where sm.movement_type = 'sold'
),
orders_with_sold as (select distinct order_id from sold)
select
  (select count(*) from collected)                                                   as collected_orders,
  (select count(*) from collected c
     where not exists (select 1 from orders_with_sold s where s.order_id = c.id))     as "1_orders_without_sold",
  (select count(*) from sold where frozen = 0 and cump > 0)                           as "2_frozen0_cump_avail",
  (select count(*) from sold where frozen = 0 and cump = 0)                           as "3_frozen0_no_cump_blindspot",
  (select count(*) from sold where frozen > 0)                                        as "_sold_lines_real_cost",
  (select count(*) from sold)                                                         as "_sold_lines_total";
