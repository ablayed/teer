-- merchant_account
create table public.merchant_account (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'decouverte' check (plan in ('decouverte','solo','pro')),
  country_code text not null default 'SN',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- merchant_member
create table public.merchant_member (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','manager','agent')),
  created_at timestamptz not null default now(),
  unique (merchant_account_id, user_id)
);

-- audit_log (append-only)
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  action text not null,
  resource_type text,
  resource_id uuid,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- Indexes pour RLS perf
create index merchant_member_user_idx on public.merchant_member (user_id, merchant_account_id);
create index merchant_member_account_idx on public.merchant_member (merchant_account_id);
create index audit_log_account_idx on public.audit_log (merchant_account_id, created_at desc);

-- Enable RLS + FORCE
alter table public.merchant_account enable row level security;
alter table public.merchant_account force row level security;
alter table public.merchant_member enable row level security;
alter table public.merchant_member force row level security;
alter table public.audit_log enable row level security;
alter table public.audit_log force row level security;

-- Helper function
create or replace function public.is_member_of(p_merchant_account_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.merchant_member
    where user_id = auth.uid()
    and merchant_account_id = p_merchant_account_id
  );
$$;

-- merchant_account policies
create policy mac_select on public.merchant_account for select to authenticated
  using (public.is_member_of(id));
create policy mac_insert on public.merchant_account for insert to authenticated
  with check (owner_user_id = auth.uid());
create policy mac_update on public.merchant_account for update to authenticated
  using (public.is_member_of(id));

-- merchant_member policies
create policy mm_select on public.merchant_member for select to authenticated
  using (user_id = auth.uid() or public.is_member_of(merchant_account_id));
create policy mm_insert on public.merchant_member for insert to authenticated
  with check (
    public.is_member_of(merchant_account_id) or user_id = auth.uid()
  );
create policy mm_delete on public.merchant_member for delete to authenticated
  using (public.is_member_of(merchant_account_id));

-- audit_log : select pour les members ; insert/update/delete via service_role uniquement
create policy al_select on public.audit_log for select to authenticated
  using (public.is_member_of(merchant_account_id));
