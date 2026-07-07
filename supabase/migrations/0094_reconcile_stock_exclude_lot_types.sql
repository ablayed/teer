-- 0094 : Lot 4b+4c / PR 1 — cohérence réconciliation avec 0093.
--
-- 0093 retire allocate_to_courier / courier_return_lot de la liste des
-- movement_type qui mutent product_stock.qty_on_hand (post_stock_movement).
-- reconcile_product_stock() / rebuild_product_stock() (0032) sommaient ces
-- deux types dans leur propre allowlist explicite pour recalculer
-- qty_on_hand depuis le ledger — laissée telle quelle, elle entrerait
-- systématiquement en conflit avec le nouveau comportement (tout produit
-- avec un historique d'allocation/retour de lot afficherait un faux écart,
-- et rebuild réintroduirait la mutation que 0093 vient de retirer).
--
-- Corps repris VERBATIM de 0032, seule la liste movement_type change (retrait
-- de 'allocate_to_courier' et 'courier_return_lot').

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
      'purchase_in',
      'dispatch',
      'courier_return',
      'manual_adjustment'
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
      'manual_adjustment'
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
