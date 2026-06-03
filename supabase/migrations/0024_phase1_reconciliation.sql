alter table public.orders
  validate constraint orders_order_state_check;

alter table public.orders
  validate constraint orders_call_state_check;

alter table public.orders
  validate constraint orders_delivery_state_check;

alter table public.orders
  validate constraint orders_cash_state_check;

create or replace function public.reconcile_order_cod_status()
returns table (
  order_id uuid,
  merchant_account_id uuid,
  stored_cod_status text,
  derived_cod_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.id as order_id,
    o.merchant_account_id,
    o.cod_status as stored_cod_status,
    public.derive_legacy_cod_status(
      o.order_state,
      o.call_state,
      o.delivery_state,
      o.cash_state
    ) as derived_cod_status
  from public.orders o
  where o.cod_status is distinct from public.derive_legacy_cod_status(
    o.order_state,
    o.call_state,
    o.delivery_state,
    o.cash_state
  );
$$;
