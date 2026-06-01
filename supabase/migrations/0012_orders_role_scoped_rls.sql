drop policy if exists orders_select on public.orders;
drop policy if exists orders_insert on public.orders;
drop policy if exists orders_update on public.orders;
drop policy if exists orders_delete on public.orders;

create policy orders_select on public.orders for select to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
    or (
      public.current_member_role(merchant_account_id) = 'agent'
      and cod_status in ('A_APPELER', 'TENTEE', 'PROGRAMMEE')
    )
  );

create policy orders_insert on public.orders for insert to authenticated
  with check (public.current_member_role(merchant_account_id) in ('owner', 'manager'));

create policy orders_update on public.orders for update to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
    or (
      public.current_member_role(merchant_account_id) = 'agent'
      and cod_status in ('A_APPELER', 'TENTEE', 'PROGRAMMEE')
    )
  )
  with check (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
    or (
      public.current_member_role(merchant_account_id) = 'agent'
      and cod_status in ('TENTEE', 'CONFIRMEE', 'PROGRAMMEE')
    )
  );

create policy orders_delete on public.orders for delete to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner', 'manager'));
