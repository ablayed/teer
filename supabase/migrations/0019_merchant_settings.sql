create table public.merchant_settings (
  merchant_account_id uuid primary key references public.merchant_account(id) on delete cascade,
  merchant_levy_bps int not null default 50 check (merchant_levy_bps between 0 and 10000),
  transfer_tax_bps int not null default 50 check (transfer_tax_bps between 0 and 10000),
  transfer_tax_cap_minor bigint not null default 2000 check (transfer_tax_cap_minor >= 0),
  wave_fee_bps int not null default 100 check (wave_fee_bps between 0 and 10000),
  orange_money_fee_bps int not null default 100 check (orange_money_fee_bps between 0 and 10000),
  free_money_fee_bps int not null default 100 check (free_money_fee_bps between 0 and 10000),
  default_delivery_cost_minor bigint not null default 0 check (default_delivery_cost_minor >= 0),
  cogs_known boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.merchant_settings enable row level security;
alter table public.merchant_settings force row level security;

create policy merchant_settings_select
  on public.merchant_settings
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner','manager'));

create policy merchant_settings_insert
  on public.merchant_settings
  for insert
  to authenticated
  with check (public.current_member_role(merchant_account_id) = 'owner');

create policy merchant_settings_update
  on public.merchant_settings
  for update
  to authenticated
  using (public.current_member_role(merchant_account_id) = 'owner')
  with check (public.current_member_role(merchant_account_id) = 'owner');

create trigger merchant_settings_set_updated_at
  before update on public.merchant_settings
  for each row
  execute function public.set_updated_at();
