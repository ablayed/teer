-- Les commandes ont déjà shipping_address en jsonb pour la donnée Shopify brute.
-- Cette table dédiée garde une adresse sénégalaise structurée réutilisable au niveau client
-- (customer_id avec order_id null) et permet aussi une copie/snapshot par commande (order_id).
-- Cela évite de réécrire les JSON Shopify existants tout en gardant un historique éditable.
create table public.delivery_address (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  customer_id uuid references public.customer(id) on delete cascade,
  order_id uuid references public.orders(id) on delete cascade,
  quartier_commune text not null,
  ville text not null default 'Dakar',
  repere text,
  indications_acces text,
  gps_lat numeric,
  gps_lng numeric,
  telephone_principal text not null check (telephone_principal ~ '^\+221[0-9]{9}$'),
  telephone_alternatif text check (
    telephone_alternatif is null or telephone_alternatif ~ '^\+221[0-9]{9}$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (customer_id is not null or order_id is not null)
);

create unique index delivery_address_customer_default_unique_idx
  on public.delivery_address (merchant_account_id, customer_id)
  where order_id is null and customer_id is not null;

create unique index delivery_address_order_unique_idx
  on public.delivery_address (merchant_account_id, order_id)
  where order_id is not null;

create index delivery_address_merchant_account_idx
  on public.delivery_address (merchant_account_id);

create index delivery_address_customer_idx
  on public.delivery_address (customer_id)
  where customer_id is not null;

create index delivery_address_order_idx
  on public.delivery_address (order_id)
  where order_id is not null;

alter table public.delivery_address enable row level security;
alter table public.delivery_address force row level security;

create policy delivery_address_select
  on public.delivery_address
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent'));

create policy delivery_address_insert
  on public.delivery_address
  for insert
  to authenticated
  with check (public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent'));

create policy delivery_address_update
  on public.delivery_address
  for update
  to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent'))
  with check (public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent'));

create policy delivery_address_delete
  on public.delivery_address
  for delete
  to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner', 'manager'));

create trigger delivery_address_set_updated_at
  before update on public.delivery_address
  for each row
  execute function public.set_updated_at();
