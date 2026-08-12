-- 0127 : Phase 1 store-scoped dependent rows, RPCs and organization views.

alter table public.order_state_transition add column if not exists shop_id uuid;
alter table public.call_log add column if not exists shop_id uuid;

update public.order_state_transition ost
set shop_id = o.shop_id
from public.orders o
where o.id = ost.order_id and ost.shop_id is null;

update public.call_log cl
set shop_id = o.shop_id
from public.orders o
where o.id = cl.order_id and cl.shop_id is null;

drop trigger if exists order_state_transition_default_store_context on public.order_state_transition;
create trigger order_state_transition_default_store_context
  before insert on public.order_state_transition
  for each row execute function public.assign_default_store_context();
drop trigger if exists call_log_default_store_context on public.call_log;
create trigger call_log_default_store_context
  before insert on public.call_log
  for each row execute function public.assign_default_store_context();

do $$
begin
  if exists (select 1 from public.order_state_transition where shop_id is null) then
    raise exception 'phase1_backfill_incomplete table=order_state_transition';
  end if;
  if exists (select 1 from public.call_log where shop_id is null) then
    raise exception 'phase1_backfill_incomplete table=call_log';
  end if;
end;
$$;

alter table public.order_state_transition alter column shop_id set not null;
alter table public.call_log alter column shop_id set not null;

alter table public.order_state_transition drop constraint if exists order_state_transition_shop_tenant_fk;
alter table public.order_state_transition add constraint order_state_transition_shop_tenant_fk
  foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id);
alter table public.call_log drop constraint if exists call_log_shop_tenant_fk;
alter table public.call_log add constraint call_log_shop_tenant_fk
  foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id);

create index if not exists order_state_transition_tenant_shop_created_idx
  on public.order_state_transition (merchant_account_id, shop_id, created_at desc);
create index if not exists call_log_tenant_shop_created_idx
  on public.call_log (merchant_account_id, shop_id, created_at desc);

drop trigger if exists order_state_transition_store_context_guard on public.order_state_transition;
create trigger order_state_transition_store_context_guard
  before update on public.order_state_transition
  for each row execute function public.prevent_store_context_change();
drop trigger if exists call_log_store_context_guard on public.call_log;
create trigger call_log_store_context_guard
  before update on public.call_log
  for each row execute function public.prevent_store_context_change();

drop policy if exists order_state_transition_select on public.order_state_transition;
drop policy if exists order_state_transition_insert on public.order_state_transition;
create policy order_state_transition_select on public.order_state_transition
  for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.is_shop_member_of(shop_id));
create policy order_state_transition_insert on public.order_state_transition
  for insert to authenticated
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));

drop policy if exists call_log_select on public.call_log;
drop policy if exists call_log_insert on public.call_log;
create policy call_log_select on public.call_log
  for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.is_shop_member_of(shop_id));
create policy call_log_insert on public.call_log
  for insert to authenticated
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));

drop policy if exists product_bundle_component_select on public.product_bundle_component;
drop policy if exists product_bundle_component_insert on public.product_bundle_component;
drop policy if exists product_bundle_component_update on public.product_bundle_component;
drop policy if exists product_bundle_component_delete on public.product_bundle_component;
create policy product_bundle_component_select on public.product_bundle_component
  for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));
create policy product_bundle_component_insert on public.product_bundle_component
  for insert to authenticated
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager'));
create policy product_bundle_component_update on public.product_bundle_component
  for update to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager'))
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager'));
create policy product_bundle_component_delete on public.product_bundle_component
  for delete to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager'));

drop policy if exists purchase_lot_select on public.purchase_lot;
drop policy if exists purchase_lot_insert on public.purchase_lot;
drop policy if exists purchase_lot_update on public.purchase_lot;
create policy purchase_lot_select on public.purchase_lot
  for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) = 'owner');
create policy purchase_lot_insert on public.purchase_lot
  for insert to authenticated
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) = 'owner');
create policy purchase_lot_update on public.purchase_lot
  for update to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) = 'owner')
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) = 'owner');

drop policy if exists purchase_lot_line_select on public.purchase_lot_line;
drop policy if exists purchase_lot_line_insert on public.purchase_lot_line;
drop policy if exists purchase_lot_line_update on public.purchase_lot_line;
create policy purchase_lot_line_select on public.purchase_lot_line
  for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) = 'owner');
create policy purchase_lot_line_insert on public.purchase_lot_line
  for insert to authenticated
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) = 'owner');
create policy purchase_lot_line_update on public.purchase_lot_line
  for update to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) = 'owner')
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) = 'owner');

drop policy if exists delivery_address_select on public.delivery_address;
drop policy if exists delivery_address_insert on public.delivery_address;
drop policy if exists delivery_address_update on public.delivery_address;
drop policy if exists delivery_address_delete on public.delivery_address;
create policy delivery_address_select on public.delivery_address
  for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.is_shop_member_of(shop_id));
create policy delivery_address_insert on public.delivery_address
  for insert to authenticated
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));
create policy delivery_address_update on public.delivery_address
  for update to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'))
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));
create policy delivery_address_delete on public.delivery_address
  for delete to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager'));

-- Workspace reads are always membership checked in SQL.  The application uses
-- the URL's store id as the argument; no client-provided tenant id is trusted.
create or replace function public.list_my_stores()
returns table (
  id uuid,
  merchant_account_id uuid,
  display_name text,
  shop_domain text,
  store_kind text,
  status text,
  is_default boolean,
  role text
)
language sql
security definer
stable
set search_path = ''
as $$
  select s.id, s.merchant_account_id, s.display_name, s.shop_domain,
         s.store_kind, s.status, s.is_default, sm.role
  from public.shop s
  join public.shop_member sm on sm.shop_id = s.id
  where sm.user_id = auth.uid()
  order by s.is_default desc, s.installed_at asc, s.id asc;
$$;

create or replace function public.get_my_store(p_shop_id uuid)
returns table (
  id uuid,
  merchant_account_id uuid,
  display_name text,
  shop_domain text,
  store_kind text,
  status text,
  is_default boolean,
  role text
)
language sql
security definer
stable
set search_path = ''
as $$
  select s.id, s.merchant_account_id, s.display_name, s.shop_domain,
         s.store_kind, s.status, s.is_default, sm.role
  from public.shop s
  join public.shop_member sm on sm.shop_id = s.id
  where s.id = p_shop_id and sm.user_id = auth.uid();
$$;

revoke all on function public.list_my_stores() from public, anon;
grant execute on function public.list_my_stores() to authenticated;
revoke all on function public.get_my_store(uuid) from public, anon;
grant execute on function public.get_my_store(uuid) to authenticated;

-- Organization-level operational surfaces deliberately consolidate across
-- stores.  Each view still checks the caller's organization role, so agents
-- cannot infer financial cash balances from the courier view.
create or replace view public.organization_driver_cash
with (security_invoker = true)
as
select
  o.merchant_account_id,
  o.assigned_driver_id as driver_id,
  d.full_name as driver_name,
  sum(greatest(
    coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
      - coalesce(sa.allocated_minor, 0),
    0
  ))::bigint as outstanding_minor,
  count(*)::bigint as outstanding_orders
from public.orders o
join public.driver d
  on d.id = o.assigned_driver_id
 and d.merchant_account_id = o.merchant_account_id
left join (
  select order_id, merchant_account_id, sum(allocated_minor) as allocated_minor
  from public.settlement_allocation
  group by order_id, merchant_account_id
) sa on sa.order_id = o.id and sa.merchant_account_id = o.merchant_account_id
where o.assigned_driver_id is not null
  and o.cod_status = 'LIVREE'
  and coalesce(o.payment_channel_at_delivery, 'INCONNU') in ('ESPECES','INCONNU')
  and public.current_member_role(o.merchant_account_id) in ('owner','manager')
group by o.merchant_account_id, o.assigned_driver_id, d.full_name;

create or replace view public.organization_consolidated_operations
with (security_invoker = true)
as
select
  s.merchant_account_id,
  s.id as shop_id,
  s.display_name,
  count(distinct o.id)::bigint as order_count,
  count(distinct o.id) filter (where o.cod_status = 'LIVREE')::bigint as delivered_order_count,
  count(distinct c.id)::bigint as customer_count,
  count(distinct p.id)::bigint as product_count
from public.shop s
left join public.orders o on o.shop_id = s.id
left join public.customer c on c.shop_id = s.id
left join public.product p on p.shop_id = s.id
where public.is_shop_member_of(s.id)
group by s.merchant_account_id, s.id, s.display_name;

grant select on public.organization_driver_cash to authenticated;
grant select on public.organization_consolidated_operations to authenticated;
