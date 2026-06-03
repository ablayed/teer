drop policy if exists orders_insert on public.orders;

create policy orders_insert on public.orders for insert to authenticated
  with check (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
    or (
      public.current_member_role(merchant_account_id) = 'agent'
      and cod_status = 'A_APPELER'
      and order_state = 'open'
      and call_state = 'to_call'
      and delivery_state = 'unassigned'
      and cash_state = 'not_due'
    )
  );
