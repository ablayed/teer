drop policy if exists orders_select on public.orders;
drop policy if exists orders_update on public.orders;

create policy orders_select on public.orders for select to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  );

create policy orders_update on public.orders for update to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  )
  with check (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
    or (
      public.current_member_role(merchant_account_id) = 'agent'
      and cod_status in ('TENTEE', 'CONFIRMEE', 'PROGRAMMEE', 'EN_LIVRAISON')
    )
  );
