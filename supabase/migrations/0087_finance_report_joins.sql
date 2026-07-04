-- 0087 — Lot 5 : jointures finance/marge/P&L en SQL (suite H2/H6, dernier hotspot documenté
-- dans docs/PERFORMANCE_AUDIT_AND_OPTIMIZATION_PLAN.md §15 pour la famille finance).
--
-- Call-sites : lib/finance/report-data.ts:fetchFinanceReport (P&L, rapport PDF + action
-- owner-only), lib/finance/product-cost.ts:fetchFinanceProductCostReport,
-- lib/finance/driver-cost.ts:fetchFinanceDriverCostReport.
--
-- Bug corrigé (même famille que #50/0078, distincte de Lot 3/3b/4 déjà mergés — ceux-ci
-- couvraient le cash livreur/settlements et les agrégats non-cash du rapport PDF, PAS les
-- coûts/marge/P&L) : les 3 fichiers ci-dessus font chacun un select `orders` fenêtré (par
-- `cash_collected_at` ou `returned_at`, PAS `created_at` — convention P&L distincte, cf.
-- ci-dessous) SANS `.range()` → cap silencieux `max_rows=1000` (config.toml:8) sur un gros
-- tenant/grosse fenêtre, PUIS prennent les id (potentiellement déjà tronqués) et font
-- `.in('order_id', orderIds)` sur `stock_movement` (×3, dont un sur `order_line` en plus dans
-- product-cost.ts) — jusqu'à ~1000 UUID en URL, classe 400 gateway (#50).
--
-- Fix : 2 RPC qui partent de la FENÊTRE marchand+dates (jamais un tableau d'UUID en
-- paramètre) et font les jointures order_line/stock_movement côté SQL, comme
-- get_loss_analytics_joins (0078). `returns jsonb` (PAS `returns table`) : `max_rows=1000`
-- s'applique aussi en sortie des RPC `returns table`/`setof` — un mouvement de stock par ligne
-- rapatrié en table plafonnerait à l'identique côté sortie sur un gros tenant. Une seule
-- « ligne » PostgREST contenant un jsonb_agg contourne ce plafond.
--
-- `computeFinanceReport` (lib/finance/profit.ts), `computeFinanceProductCostReport`
-- (product-cost.ts), `computeFinanceDriverCostReport` (driver-cost.ts) — les 3 fonctions PURES
-- de calcul — restent INTÉGRALEMENT INCHANGÉES : seule la forme du data-fetch change, la
-- granularité ligne-par-ligne (un mouvement = une ligne) est préservée à l'identique, aucune
-- pré-agrégation SQL ne remplace leur logique.
--
-- get_finance_collected_joins(p_merchant_id, p_from, p_to, p_shop_id) :
--   Fenêtre = orders.cash_collected_at ∈ [p_from,p_to] (bornes INCLUSIVES, comme le TS actuel
--   `.gte(...).lte(...)`) + shop optionnel NULL-safe. RPC PARTAGÉE par les 3 fichiers :
--     - report-data.ts : soldForCollected ← soldMovements (projette order_id/product_id/qty/
--       unit_cost, ignore driver_id) ;
--     - product-cost.ts : soldMovements ← soldMovements (projette product_id/qty/unit_cost) ET
--       orderLines ← orderLines (as-is) ;
--     - driver-cost.ts : soldMovements ← soldMovements (projette driver_id/qty/unit_cost).
--   Sortie : { "soldMovements": [{order_id,product_id,driver_id,qty,unit_cost}],
--              "orderLines": [{order_id,product_id,raw_title,qty}] } — clés toujours des
--   tableaux ([]::jsonb si vide), comme 0078.
--
-- get_finance_returned_joins(p_merchant_id, p_from, p_to, p_shop_id) :
--   Fenêtre = orders.returned_at ∈ [p_from,p_to] (inclusif) AND cash_collected_at IS NOT NULL
--   (contra-revenue réel uniquement, reproduit exactement `returnedQuery` de report-data.ts) +
--   shop optionnel. Utilisée UNIQUEMENT par report-data.ts (soldForReturned, courierReturnRows).
--   Sortie : { "soldMovements": [{order_id,product_id,qty,unit_cost}],
--              "courierReturns": [{order_id,product_id,qty}] }.
--
-- Sécurité — EXCEPTION explicite au pattern owner/manager NULL-safe des Lots 3/3b/4 :
--   les 3 fichiers appelants utilisent déjà `createFinanceAdminClient()` (client service-role,
--   contourne RLS), nécessaire pour lire `stock_movement.unit_cost` (masqué à `agent` au niveau
--   colonne) — JAMAIS appelés via une session utilisateur authentifiée. Une garde de rôle
--   `current_member_role()`/`auth.uid()` rejetterait TOUJOURS ces appels (rôle NULL en
--   service-role — même piège que le gotcha projet « DEFINER guard breaks service-role
--   callers »). Modèle retenu : `security invoker` (le service-role bypass RLS de toute façon,
--   invoker ne change rien pour cet appelant), AUCUNE garde de rôle applicative dans la RPC,
--   `revoke all from public, anon, authenticated` puis `grant execute to service_role`
--   uniquement — ces RPC ne sont donc atteignables que par le client service-role déjà utilisé
--   par ces 3 fichiers, jamais par une session utilisateur. Le contrôle d'accès owner/manager
--   reste en amont (server actions/route qui appellent ces fonctions), inchangé par ce lot.
--   Ce pattern n'est PAS à généraliser à d'autres RPC.

create or replace function public.get_finance_collected_joins(
  p_merchant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with scoped_orders as (
    select o.id
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and o.cash_collected_at >= p_from
      and o.cash_collected_at <= p_to
      and (p_shop_id is null or o.shop_id = p_shop_id)
  )
  select jsonb_build_object(
    'soldMovements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', sm.order_id,
        'product_id', sm.product_id,
        'driver_id', sm.driver_id,
        'qty', sm.qty,
        'unit_cost', sm.unit_cost
      ))
      from public.stock_movement sm
      where sm.merchant_account_id = p_merchant_id
        and sm.movement_type = 'sold'
        and sm.order_id in (select so.id from scoped_orders so)
    ), '[]'::jsonb),
    'orderLines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', ol.order_id,
        'product_id', ol.product_id,
        'raw_title', ol.raw_title,
        'qty', ol.qty
      ))
      from public.order_line ol
      where ol.merchant_account_id = p_merchant_id
        and ol.order_id in (select so.id from scoped_orders so)
    ), '[]'::jsonb)
  );
$$;

create or replace function public.get_finance_returned_joins(
  p_merchant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with scoped_orders as (
    select o.id
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and o.returned_at >= p_from
      and o.returned_at <= p_to
      and o.cash_collected_at is not null
      and (p_shop_id is null or o.shop_id = p_shop_id)
  )
  select jsonb_build_object(
    'soldMovements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', sm.order_id,
        'product_id', sm.product_id,
        'qty', sm.qty,
        'unit_cost', sm.unit_cost
      ))
      from public.stock_movement sm
      where sm.merchant_account_id = p_merchant_id
        and sm.movement_type = 'sold'
        and sm.order_id in (select so.id from scoped_orders so)
    ), '[]'::jsonb),
    'courierReturns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', sm.order_id,
        'product_id', sm.product_id,
        'qty', sm.qty
      ))
      from public.stock_movement sm
      where sm.merchant_account_id = p_merchant_id
        and sm.movement_type = 'courier_return'
        and sm.order_id in (select so.id from scoped_orders so)
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_finance_collected_joins(
  uuid, timestamptz, timestamptz, uuid
) from public, anon, authenticated;

grant execute on function public.get_finance_collected_joins(
  uuid, timestamptz, timestamptz, uuid
) to service_role;

revoke all on function public.get_finance_returned_joins(
  uuid, timestamptz, timestamptz, uuid
) from public, anon, authenticated;

grant execute on function public.get_finance_returned_joins(
  uuid, timestamptz, timestamptz, uuid
) to service_role;
