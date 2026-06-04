-- ============================================================
-- 0032 : phase4 — réconciliation stock prend en compte les types lot
-- ============================================================
-- Bug : reconcile_product_stock et rebuild_product_stock (0030) ne
-- sommaient que {purchase_in, dispatch, courier_return, manual_adjustment}.
-- Les types lot ajoutés en 0031 (allocate_to_courier, courier_return_lot)
-- AFFECTENT qty_on_hand (sortie/retour entrepôt) mais n'étaient pas comptés
-- → tout stock en main par lot créait un FAUX écart de réconciliation, et
-- rebuild reconstruisait une valeur erronée.
--
-- Correctif : les deux fonctions somment désormais TOUS les types qui
-- affectent qty_on_hand. (reserve/release → qty_reserved seulement ;
-- sold → aucune mutation de position : restent exclus, à raison.)
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. reconcile_product_stock — inclut allocate_to_courier / courier_return_lot
-- ────────────────────────────────────────────────────────────

create or replace function public.reconcile_product_stock()
returns table (
  product_id           uuid,
  merchant_account_id  uuid,
  stored_qty_on_hand   integer,
  ledger_qty_on_hand   integer,
  delta                integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with ledger as (
    select
      sm.product_id,
      sm.merchant_account_id,
      coalesce(sum(sm.qty), 0)::integer as ledger_qty
    from public.stock_movement sm
    where sm.movement_type in (
      'purchase_in',
      'dispatch',
      'courier_return',
      'manual_adjustment',
      'allocate_to_courier',
      'courier_return_lot'
    )
    group by sm.product_id, sm.merchant_account_id
  ),
  discrepancies as (
    select
      ps.product_id,
      ps.merchant_account_id,
      ps.qty_on_hand                              as stored,
      coalesce(l.ledger_qty, 0)                   as ledger,
      ps.qty_on_hand - coalesce(l.ledger_qty, 0)  as delta
    from public.product_stock ps
    left join ledger l
      on l.product_id          = ps.product_id
     and l.merchant_account_id = ps.merchant_account_id
    where ps.qty_on_hand <> coalesce(l.ledger_qty, 0)
  )
  select
    d.product_id,
    d.merchant_account_id,
    d.stored,
    d.ledger,
    d.delta
  from discrepancies d;

  -- Persiste les écarts dans la table d'alerte.
  insert into public.stock_reconciliation_alert (
    merchant_account_id, product_id,
    stored_qty_on_hand, ledger_qty_on_hand, delta
  )
  with ledger as (
    select
      sm.product_id,
      sm.merchant_account_id,
      coalesce(sum(sm.qty), 0)::integer as ledger_qty
    from public.stock_movement sm
    where sm.movement_type in (
      'purchase_in',
      'dispatch',
      'courier_return',
      'manual_adjustment',
      'allocate_to_courier',
      'courier_return_lot'
    )
    group by sm.product_id, sm.merchant_account_id
  )
  select
    ps.merchant_account_id,
    ps.product_id,
    ps.qty_on_hand,
    coalesce(l.ledger_qty, 0),
    ps.qty_on_hand - coalesce(l.ledger_qty, 0)
  from public.product_stock ps
  left join ledger l
    on l.product_id          = ps.product_id
   and l.merchant_account_id = ps.merchant_account_id
  where ps.qty_on_hand <> coalesce(l.ledger_qty, 0);
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 2. rebuild_product_stock — même liste de types
-- ────────────────────────────────────────────────────────────

create or replace function public.rebuild_product_stock()
returns integer   -- nombre de lignes reconstruites
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with ledger as (
    select
      sm.product_id,
      sm.merchant_account_id,
      coalesce(sum(sm.qty), 0)::integer as ledger_qty
    from public.stock_movement sm
    where sm.movement_type in (
      'purchase_in',
      'dispatch',
      'courier_return',
      'manual_adjustment',
      'allocate_to_courier',
      'courier_return_lot'
    )
    group by sm.product_id, sm.merchant_account_id
  )
  update public.product_stock ps
     set qty_on_hand = l.ledger_qty,
         updated_at  = now()
    from ledger l
   where l.product_id          = ps.product_id
     and l.merchant_account_id = ps.merchant_account_id
     and ps.qty_on_hand        <> l.ledger_qty;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
