create extension if not exists pg_trgm with schema extensions;

create table public.product (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  shopify_product_id text,
  shopify_variant_id text,
  sku text,
  title text not null,
  unit_cost bigint not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.product
  add constraint product_title_not_blank
  check (btrim(title) <> '')
  not valid;

alter table public.product
  add constraint product_unit_cost_nonnegative
  check (unit_cost >= 0)
  not valid;

create index product_merchant_account_id_idx
  on public.product (merchant_account_id);

create unique index product_merchant_variant_idx
  on public.product (merchant_account_id, shopify_variant_id)
  where shopify_variant_id is not null;

create index product_merchant_sku_idx
  on public.product (merchant_account_id, sku)
  where sku is not null;

create index product_title_trgm_idx
  on public.product
  using gin (lower(title) extensions.gin_trgm_ops);

alter table public.product enable row level security;
alter table public.product force row level security;

create policy product_select
  on public.product
  for select
  to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  );

create policy product_insert
  on public.product
  for insert
  to authenticated
  with check (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
  );

create policy product_update
  on public.product
  for update
  to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
  )
  with check (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
  );

create trigger product_set_updated_at
  before update on public.product
  for each row
  execute function public.set_updated_at();

revoke all on public.product from anon;
revoke all on public.product from authenticated;

grant select (
  id,
  merchant_account_id,
  shopify_product_id,
  shopify_variant_id,
  sku,
  title,
  is_active,
  created_at,
  updated_at
) on public.product to authenticated;

grant insert (
  merchant_account_id,
  shopify_product_id,
  shopify_variant_id,
  sku,
  title,
  is_active
) on public.product to authenticated;

grant update (
  shopify_product_id,
  shopify_variant_id,
  sku,
  title,
  is_active,
  updated_at
) on public.product to authenticated;
