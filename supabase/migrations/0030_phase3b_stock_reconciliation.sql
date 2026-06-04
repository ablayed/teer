-- ============================================================
-- 0030 : filet de réconciliation stock
-- reconcile_product_stock : détecte les écarts ledger ↔ projection.
-- rebuild_product_stock   : reconstruit qty_on_hand depuis le ledger.
-- pg_cron nocturne        : exécute la réconciliation chaque nuit.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. Table d'alerte pour conserver l'historique des écarts
-- ────────────────────────────────────────────────────────────

create table if not exists public.stock_reconciliation_alert (
  id                   uuid primary key default gen_random_uuid(),
  merchant_account_id  uuid not null references public.merchant_account(id) on delete cascade,
  product_id           uuid not null references public.product(id) on delete cascade,
  stored_qty_on_hand   integer not null,
  ledger_qty_on_hand   integer not null,
  delta                integer not null,
  detected_at          timestamptz not null default now()
);

create index stock_reconciliation_alert_merchant_idx
  on public.stock_reconciliation_alert (merchant_account_id, detected_at desc);

alter table public.stock_reconciliation_alert enable row level security;
alter table public.stock_reconciliation_alert force row level security;

create policy stock_reconciliation_alert_select
  on public.stock_reconciliation_alert
  for select
  to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
  );

revoke all on public.stock_reconciliation_alert from anon;
revoke all on public.stock_reconciliation_alert from authenticated;
grant select (
  id, merchant_account_id, product_id,
  stored_qty_on_hand, ledger_qty_on_hand, delta, detected_at
) on public.stock_reconciliation_alert to authenticated;

-- ────────────────────────────────────────────────────────────
-- 2. reconcile_product_stock
--    Σ ledger (mouvements affectant qty_on_hand) vs projection.
--    Insère une alerte par écart ; retourne les lignes en écart.
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
      'manual_adjustment'
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
      'purchase_in', 'dispatch', 'courier_return', 'manual_adjustment'
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
-- 3. rebuild_product_stock
--    Reconstruit qty_on_hand depuis le ledger (défense en profondeur).
--    N'affecte PAS qty_reserved ni unit_cost (hors scope ledger).
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
      'purchase_in', 'dispatch', 'courier_return', 'manual_adjustment'
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

-- ────────────────────────────────────────────────────────────
-- 4. pg_cron — réconciliation nocturne à 02:00 UTC
-- ────────────────────────────────────────────────────────────

create extension if not exists pg_cron with schema extensions;

select cron.schedule(
  'stock-reconciliation-nightly',
  '0 2 * * *',
  $$ select public.reconcile_product_stock(); $$
);
