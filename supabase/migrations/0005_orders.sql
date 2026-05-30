create table public.customer (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  shopify_customer_id text,
  full_name text,
  phone text,
  email text,
  shipping_address jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index customer_shopify_customer_unique_idx
  on public.customer (merchant_account_id, shopify_customer_id)
  where shopify_customer_id is not null;

create index customer_merchant_account_idx on public.customer (merchant_account_id);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  shop_id uuid references public.shop(id) on delete set null,
  customer_id uuid references public.customer(id) on delete set null,
  shopify_order_id text,
  order_number text,
  total_amount numeric(12, 2) not null default 0,
  currency text not null default 'XOF',
  financial_status text,
  fulfillment_status text,
  cod_status text not null default 'nouvelle' check (
    cod_status in (
      'nouvelle',
      'confirmee',
      'assignee',
      'en_livraison',
      'livree',
      'annulee',
      'retournee'
    )
  ),
  items_summary jsonb,
  shipping_address jsonb,
  assigned_driver_id uuid,
  created_at_shopify timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index orders_shopify_order_unique_idx
  on public.orders (merchant_account_id, shopify_order_id)
  where shopify_order_id is not null;

create index orders_merchant_cod_status_idx on public.orders (merchant_account_id, cod_status);
create index orders_merchant_created_shopify_idx on public.orders (merchant_account_id, created_at_shopify desc);

alter table public.customer enable row level security;
alter table public.customer force row level security;

alter table public.orders enable row level security;
alter table public.orders force row level security;

create policy customer_select on public.customer for select to authenticated
  using (public.is_member_of(merchant_account_id));

create policy customer_insert on public.customer for insert to authenticated
  with check (public.is_member_of(merchant_account_id));

create policy customer_update on public.customer for update to authenticated
  using (public.is_member_of(merchant_account_id))
  with check (public.is_member_of(merchant_account_id));

create policy customer_delete on public.customer for delete to authenticated
  using (public.is_member_of(merchant_account_id));

create policy orders_select on public.orders for select to authenticated
  using (public.is_member_of(merchant_account_id));

create policy orders_insert on public.orders for insert to authenticated
  with check (public.is_member_of(merchant_account_id));

create policy orders_update on public.orders for update to authenticated
  using (public.is_member_of(merchant_account_id))
  with check (public.is_member_of(merchant_account_id));

create policy orders_delete on public.orders for delete to authenticated
  using (public.is_member_of(merchant_account_id));

create trigger customer_set_updated_at
  before update on public.customer
  for each row
  execute function public.set_updated_at();

create trigger orders_set_updated_at
  before update on public.orders
  for each row
  execute function public.set_updated_at();
