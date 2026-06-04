create table public.stock_movement (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  product_id uuid not null references public.product(id) on delete cascade,
  movement_type text not null,
  qty integer not null,
  unit_cost bigint,
  reason text,
  order_id uuid references public.orders(id) on delete set null,
  transition_id uuid references public.order_state_transition(id) on delete set null,
  idempotency_key text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.stock_movement
  add constraint stock_movement_type_check
  check (
    movement_type in (
      'purchase_in',
      'reserve',
      'release',
      'dispatch',
      'sold',
      'courier_return',
      'manual_adjustment'
    )
  )
  not valid;

alter table public.stock_movement
  add constraint stock_movement_manual_adjustment_reason_check
  check (
    movement_type <> 'manual_adjustment'
    or nullif(btrim(coalesce(reason, '')), '') is not null
  )
  not valid;

alter table public.stock_movement
  add constraint stock_movement_unit_cost_nonnegative
  check (unit_cost is null or unit_cost >= 0)
  not valid;

create unique index stock_movement_idempotency_key_idx
  on public.stock_movement (idempotency_key);

create index stock_movement_product_created_idx
  on public.stock_movement (product_id, created_at desc);

create index stock_movement_merchant_account_idx
  on public.stock_movement (merchant_account_id);

create index stock_movement_order_idx
  on public.stock_movement (order_id);

alter table public.stock_movement enable row level security;
alter table public.stock_movement force row level security;

create policy stock_movement_select
  on public.stock_movement
  for select
  to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  );

create policy stock_movement_insert
  on public.stock_movement
  for insert
  to authenticated
  with check (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  );

revoke all on public.stock_movement from anon;
revoke all on public.stock_movement from authenticated;

grant select (
  id,
  merchant_account_id,
  product_id,
  movement_type,
  qty,
  reason,
  order_id,
  transition_id,
  idempotency_key,
  created_by,
  created_at
) on public.stock_movement to authenticated;

create table public.product_stock (
  product_id uuid primary key references public.product(id) on delete cascade,
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  qty_on_hand integer not null default 0,
  qty_reserved integer not null default 0,
  unit_cost bigint not null default 0,
  low_stock_threshold integer not null default 10,
  updated_at timestamptz not null default now()
);

alter table public.product_stock
  add constraint product_stock_unit_cost_nonnegative
  check (unit_cost >= 0)
  not valid;

alter table public.product_stock
  add constraint product_stock_low_stock_threshold_nonnegative
  check (low_stock_threshold >= 0)
  not valid;

create index product_stock_merchant_account_idx
  on public.product_stock (merchant_account_id);

create index product_stock_low_stock_idx
  on public.product_stock (merchant_account_id)
  where qty_on_hand <= low_stock_threshold;

create trigger product_stock_set_updated_at
  before update on public.product_stock
  for each row
  execute function public.set_updated_at();

alter table public.product_stock enable row level security;
alter table public.product_stock force row level security;

create policy product_stock_select
  on public.product_stock
  for select
  to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  );

revoke all on public.product_stock from anon;
revoke all on public.product_stock from authenticated;

grant select (
  product_id,
  merchant_account_id,
  qty_on_hand,
  qty_reserved,
  low_stock_threshold,
  updated_at
) on public.product_stock to authenticated;

create table public.order_line (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.product(id) on delete set null,
  raw_title text not null,
  raw_sku text,
  raw_shopify_variant_id text,
  raw_shopify_product_id text,
  qty integer not null,
  match_status text not null,
  created_at timestamptz not null default now()
);

alter table public.order_line
  add constraint order_line_raw_title_not_blank
  check (btrim(raw_title) <> '')
  not valid;

alter table public.order_line
  add constraint order_line_qty_positive
  check (qty > 0)
  not valid;

alter table public.order_line
  add constraint order_line_match_status_check
  check (match_status in ('matched', 'unresolved', 'ambiguous'))
  not valid;

create index order_line_order_idx
  on public.order_line (order_id);

create index order_line_product_idx
  on public.order_line (product_id);

alter table public.order_line enable row level security;
alter table public.order_line force row level security;

create policy order_line_select
  on public.order_line
  for select
  to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  );

create policy order_line_insert
  on public.order_line
  for insert
  to authenticated
  with check (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  );

create policy order_line_update
  on public.order_line
  for update
  to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  )
  with check (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  );

revoke all on public.order_line from anon;
revoke all on public.order_line from authenticated;

grant select (
  id,
  merchant_account_id,
  order_id,
  product_id,
  raw_title,
  raw_sku,
  raw_shopify_variant_id,
  raw_shopify_product_id,
  qty,
  match_status,
  created_at
) on public.order_line to authenticated;

grant insert (
  merchant_account_id,
  order_id,
  product_id,
  raw_title,
  raw_sku,
  raw_shopify_variant_id,
  raw_shopify_product_id,
  qty,
  match_status
) on public.order_line to authenticated;

grant update (
  product_id,
  raw_title,
  raw_sku,
  raw_shopify_variant_id,
  raw_shopify_product_id,
  qty,
  match_status
) on public.order_line to authenticated;

alter table public.merchant_settings
  add column if not exists default_low_stock_threshold integer default 10;

alter table public.merchant_settings
  add constraint merchant_settings_default_low_stock_threshold_nonnegative
  check (
    default_low_stock_threshold is null or default_low_stock_threshold >= 0
  )
  not valid;
