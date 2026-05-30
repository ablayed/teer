create table public.shop (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  shop_domain text not null unique,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scopes text not null,
  status text not null default 'active' check (status in ('active', 'uninstalled')),
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_account_id)
);

create index shop_merchant_account_idx on public.shop (merchant_account_id);

alter table public.shop enable row level security;
alter table public.shop force row level security;

create policy shop_select on public.shop for select to authenticated
  using (public.is_member_of(merchant_account_id));

create policy shop_insert on public.shop for insert to authenticated
  with check (public.is_member_of(merchant_account_id));

create policy shop_update on public.shop for update to authenticated
  using (public.is_member_of(merchant_account_id))
  with check (public.is_member_of(merchant_account_id));

create policy shop_delete on public.shop for delete to authenticated
  using (public.is_member_of(merchant_account_id));

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger shop_set_updated_at
  before update on public.shop
  for each row
  execute function public.set_updated_at();
