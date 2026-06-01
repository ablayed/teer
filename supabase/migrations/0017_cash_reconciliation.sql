create table public.cash_settlement (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id),
  driver_id uuid not null references public.driver(id),
  amount_received_minor bigint not null check (amount_received_minor >= 0),
  method text not null check (method in ('ESPECES','WAVE','ORANGE_MONEY','FREE_MONEY')),
  note text,
  settled_at timestamptz not null default now(),
  created_by uuid not null,
  client_request_id uuid not null,
  created_at timestamptz not null default now(),
  unique (merchant_account_id, client_request_id)
);

create table public.settlement_allocation (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.cash_settlement(id) on delete cascade,
  order_id uuid not null references public.orders(id),
  allocated_minor bigint not null check (allocated_minor > 0),
  merchant_account_id uuid not null references public.merchant_account(id),
  created_at timestamptz not null default now(),
  unique (settlement_id, order_id)
);

create table public.settlement_shortfall (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.cash_settlement(id) on delete cascade,
  merchant_account_id uuid not null references public.merchant_account(id),
  driver_id uuid not null references public.driver(id),
  expected_minor bigint not null,
  received_minor bigint not null,
  shortfall_minor bigint generated always as (expected_minor - received_minor) stored,
  resolution text not null default 'ROLLED_FORWARD'
    check (resolution in ('ROLLED_FORWARD','WRITTEN_OFF')),
  reason text,
  created_at timestamptz not null default now()
);

create index cash_settlement_merchant_driver_settled_idx
  on public.cash_settlement (merchant_account_id, driver_id, settled_at desc);

create index settlement_allocation_order_idx
  on public.settlement_allocation (order_id);

create index settlement_allocation_merchant_idx
  on public.settlement_allocation (merchant_account_id);

alter table public.cash_settlement enable row level security;
alter table public.cash_settlement force row level security;

alter table public.settlement_allocation enable row level security;
alter table public.settlement_allocation force row level security;

alter table public.settlement_shortfall enable row level security;
alter table public.settlement_shortfall force row level security;

create policy cash_settlement_select
  on public.cash_settlement
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner','manager'));

create policy cash_settlement_insert
  on public.cash_settlement
  for insert
  to authenticated
  with check (public.current_member_role(merchant_account_id) in ('owner','manager'));

create policy settlement_allocation_select
  on public.settlement_allocation
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner','manager'));

create policy settlement_allocation_insert
  on public.settlement_allocation
  for insert
  to authenticated
  with check (public.current_member_role(merchant_account_id) in ('owner','manager'));

create policy settlement_shortfall_select
  on public.settlement_shortfall
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner','manager'));

create policy settlement_shortfall_insert
  on public.settlement_shortfall
  for insert
  to authenticated
  with check (public.current_member_role(merchant_account_id) in ('owner','manager'));

create or replace function public.finance_kpis(
  p_merchant uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  ca_livre bigint,
  cash_chez_livreurs bigint,
  encaisse bigint,
  a_encaisser bigint,
  taux_refus numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with role_guard as (
    select public.current_member_role(p_merchant) as role
  ),
  delivered_orders as (
    select
      o.id,
      o.total_amount,
      coalesce(max(ost.created_at), o.updated_at) as delivered_at
    from public.orders o
    left join public.order_state_transition ost
      on ost.order_id = o.id
     and ost.to_status = 'LIVREE'
    where o.merchant_account_id = p_merchant
      and o.cod_status = 'LIVREE'
      and (select role from role_guard) in ('owner','manager')
    group by o.id, o.total_amount, o.updated_at
  ),
  outstanding_orders as (
    select
      o.id,
      greatest(
        coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
          - coalesce(sum(sa.allocated_minor), 0),
        0
      ) as outstanding_minor
    from public.orders o
    left join public.settlement_allocation sa
      on sa.order_id = o.id
     and sa.merchant_account_id = o.merchant_account_id
    where o.merchant_account_id = p_merchant
      and o.cod_status = 'LIVREE'
      and o.assigned_driver_id is not null
      and coalesce(o.payment_channel_at_delivery, 'INCONNU') in ('ESPECES','INCONNU')
      and (select role from role_guard) in ('owner','manager')
    group by o.id, o.cash_collectable_minor, o.total_amount
  ),
  refusal_counts as (
    select
      count(*) filter (where cod_status in ('REFUSEE','ANNULEE'))::numeric as refused,
      count(*) filter (where cod_status in ('LIVREE','REFUSEE','ANNULEE'))::numeric as decided
    from public.orders
    where merchant_account_id = p_merchant
      and created_at >= p_from
      and created_at < p_to
      and (select role from role_guard) in ('owner','manager')
  )
  select
    coalesce(sum(round(d.total_amount)::bigint) filter (
      where d.delivered_at >= p_from and d.delivered_at < p_to
    ), 0)::bigint as ca_livre,
    coalesce((select sum(outstanding_minor) from outstanding_orders), 0)::bigint
      as cash_chez_livreurs,
    coalesce((
      select sum(amount_received_minor)
      from public.cash_settlement
      where merchant_account_id = p_merchant
        and settled_at >= p_from
        and settled_at < p_to
        and (select role from role_guard) in ('owner','manager')
    ), 0)::bigint as encaisse,
    coalesce((select sum(outstanding_minor) from outstanding_orders), 0)::bigint
      as a_encaisser,
    coalesce((
      select 100.0 * refused / nullif(decided, 0)
      from refusal_counts
    ), 0)::numeric as taux_refus
  from delivered_orders d
  having (select role from role_guard) in ('owner','manager');
$$;

grant execute on function public.finance_kpis(uuid, timestamptz, timestamptz)
  to authenticated;

create or replace function public.cash_aging(p_merchant uuid)
returns table (
  driver_id uuid,
  driver_name text,
  bucket_lt1d bigint,
  bucket_1_3d bigint,
  bucket_gt3d bigint,
  outstanding_minor bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with role_guard as (
    select public.current_member_role(p_merchant) as role
  ),
  delivered_cash_orders as (
    select
      o.id,
      o.assigned_driver_id,
      coalesce(max(ost.created_at), o.updated_at) as delivered_at,
      greatest(
        coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
          - coalesce(sum(sa.allocated_minor), 0),
        0
      ) as outstanding_minor
    from public.orders o
    left join public.order_state_transition ost
      on ost.order_id = o.id
     and ost.to_status = 'LIVREE'
    left join public.settlement_allocation sa
      on sa.order_id = o.id
     and sa.merchant_account_id = o.merchant_account_id
    where o.merchant_account_id = p_merchant
      and o.cod_status = 'LIVREE'
      and o.assigned_driver_id is not null
      and coalesce(o.payment_channel_at_delivery, 'INCONNU') in ('ESPECES','INCONNU')
      and (select role from role_guard) in ('owner','manager')
    group by o.id, o.assigned_driver_id, o.updated_at, o.cash_collectable_minor, o.total_amount
  ),
  outstanding as (
    select *
    from delivered_cash_orders
    where outstanding_minor > 0
  )
  select
    d.id as driver_id,
    d.full_name as driver_name,
    coalesce(sum(o.outstanding_minor) filter (
      where now() - o.delivered_at < interval '1 day'
    ), 0)::bigint as bucket_lt1d,
    coalesce(sum(o.outstanding_minor) filter (
      where now() - o.delivered_at >= interval '1 day'
        and now() - o.delivered_at <= interval '3 days'
    ), 0)::bigint as bucket_1_3d,
    coalesce(sum(o.outstanding_minor) filter (
      where now() - o.delivered_at > interval '3 days'
    ), 0)::bigint as bucket_gt3d,
    coalesce(sum(o.outstanding_minor), 0)::bigint as outstanding_minor
  from outstanding o
  join public.driver d
    on d.id = o.assigned_driver_id
   and d.merchant_account_id = p_merchant
  where (select role from role_guard) in ('owner','manager')
  group by d.id, d.full_name
  order by outstanding_minor desc, d.full_name;
$$;

grant execute on function public.cash_aging(uuid) to authenticated;
