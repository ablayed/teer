alter table public.orders
  drop constraint if exists orders_cod_status_check;

update public.orders
set cod_status = 'A_APPELER';

alter table public.orders
  alter column cod_status set default 'A_APPELER';

alter table public.orders
  add constraint orders_cod_status_check
  check (
    cod_status in (
      'A_APPELER',
      'TENTEE',
      'CONFIRMEE',
      'PROGRAMMEE',
      'EN_LIVRAISON',
      'LIVREE',
      'REFUSEE',
      'ANNULEE'
    )
  );

create table public.order_state_transition (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_user_id uuid not null references auth.users(id),
  note text,
  created_at timestamptz not null default now()
);

create index order_state_transition_order_created_idx
  on public.order_state_transition (order_id, created_at desc);

create index order_state_transition_merchant_account_idx
  on public.order_state_transition (merchant_account_id);

alter table public.order_state_transition enable row level security;
alter table public.order_state_transition force row level security;

create policy order_state_transition_select
  on public.order_state_transition
  for select
  to authenticated
  using (public.is_member_of(merchant_account_id));

create policy order_state_transition_insert
  on public.order_state_transition
  for insert
  to authenticated
  with check (public.is_member_of(merchant_account_id));

create policy order_state_transition_update
  on public.order_state_transition
  for update
  to authenticated
  using (false)
  with check (false);

create policy order_state_transition_delete
  on public.order_state_transition
  for delete
  to authenticated
  using (false);

create table public.call_log (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  agent_user_id uuid not null references auth.users(id),
  outcome text not null check (
    outcome in (
      'CONFIRMEE',
      'SANS_REPONSE',
      'A_RAPPELER',
      'REFUSEE'
    )
  ),
  note_fr text,
  next_action_at timestamptz,
  created_at timestamptz not null default now()
);

create index call_log_order_created_idx
  on public.call_log (order_id, created_at desc);

create index call_log_merchant_account_idx
  on public.call_log (merchant_account_id);

alter table public.call_log enable row level security;
alter table public.call_log force row level security;

create policy call_log_select
  on public.call_log
  for select
  to authenticated
  using (public.is_member_of(merchant_account_id));

create policy call_log_insert
  on public.call_log
  for insert
  to authenticated
  with check (public.is_member_of(merchant_account_id));

create policy call_log_update
  on public.call_log
  for update
  to authenticated
  using (false)
  with check (false);

create policy call_log_delete
  on public.call_log
  for delete
  to authenticated
  using (false);
