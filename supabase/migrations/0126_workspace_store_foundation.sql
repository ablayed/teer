-- 0126 : Phase 1 workspace/store foundation.
--
-- `shop` is the established store relation used by Shopify, orders and
-- webhooks.  This migration expands it to also represent a manual store so
-- existing merchants without a connector keep a first-class workspace.
-- Nothing in this migration deletes or rewrites business history.

alter table public.shop
  alter column access_token_encrypted drop not null,
  alter column scopes set default '';

alter table public.shop
  add column if not exists display_name text,
  add column if not exists store_kind text not null default 'shopify',
  add column if not exists is_default boolean not null default false;

alter table public.shop alter column display_name set default 'Boutique';

alter table public.shop
  drop constraint if exists shop_store_kind_check;

alter table public.shop
  add constraint shop_store_kind_check
  check (store_kind in ('manual', 'shopify'));

update public.shop
set display_name = coalesce(nullif(display_name, ''), shop_domain),
    store_kind = coalesce(nullif(store_kind, ''), 'shopify')
where display_name is null or display_name = '' or store_kind is null or store_kind = '';

alter table public.shop
  alter column display_name set not null;

-- Stable parent key for tenant/store composite foreign keys.
alter table public.shop
  drop constraint if exists shop_merchant_account_id_id_key;

alter table public.shop
  add constraint shop_merchant_account_id_id_key
  unique (merchant_account_id, id);

-- Every organization gets one deterministic manual store when it has no store
-- yet.  The synthetic domain is internal metadata only; Shopify code filters
-- by store_kind and can never attempt OAuth or API calls for these rows.
insert into public.shop (
  merchant_account_id,
  shop_domain,
  access_token_encrypted,
  scopes,
  status,
  display_name,
  store_kind,
  is_default
)
select
  ma.id,
  'manual-' || replace(ma.id::text, '-', '') || '.internal',
  null,
  '',
  'active',
  coalesce(nullif(btrim(ma.name), ''), 'Boutique principale'),
  'manual',
  true
from public.merchant_account ma
where not exists (
  select 1 from public.shop s where s.merchant_account_id = ma.id
);

-- The oldest installed store remains the default for organizations that
-- already had a connector.  Re-running the migration is harmless.
with ranked as (
  select
    s.id,
    row_number() over (
      partition by s.merchant_account_id
      order by s.installed_at asc, s.id asc
    ) = 1 as should_be_default
  from public.shop s
)
update public.shop s
set is_default = ranked.should_be_default
from ranked
where ranked.id = s.id;

create unique index if not exists shop_one_default_per_merchant_idx
  on public.shop (merchant_account_id)
  where is_default;

create index if not exists shop_merchant_kind_status_idx
  on public.shop (merchant_account_id, store_kind, status);

-- Explicit store memberships retain the existing organization roles.
create table if not exists public.shop_member (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  shop_id uuid not null references public.shop(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'manager', 'agent')),
  created_at timestamptz not null default now(),
  unique (shop_id, user_id),
  unique (merchant_account_id, shop_id, user_id),
  constraint shop_member_shop_tenant_fk
    foreign key (merchant_account_id, shop_id)
    references public.shop (merchant_account_id, id)
    on delete cascade
);

create index if not exists shop_member_user_shop_idx
  on public.shop_member (user_id, shop_id, merchant_account_id);
create index if not exists shop_member_shop_role_idx
  on public.shop_member (shop_id, role, user_id);

alter table public.shop_member enable row level security;
alter table public.shop_member force row level security;

create or replace function public.is_shop_member_of(p_shop_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.shop_member sm
    join public.shop s on s.id = sm.shop_id
    where sm.shop_id = p_shop_id
      and sm.user_id = auth.uid()
      and sm.merchant_account_id = s.merchant_account_id
  );
$$;

create or replace function public.current_shop_role(p_shop_id uuid)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select sm.role
  from public.shop_member sm
  where sm.shop_id = p_shop_id
    and sm.user_id = auth.uid()
  limit 1;
$$;

revoke all on function public.is_shop_member_of(uuid) from public, anon;
grant execute on function public.is_shop_member_of(uuid) to authenticated;
revoke all on function public.current_shop_role(uuid) from public, anon;
grant execute on function public.current_shop_role(uuid) to authenticated;

create policy shop_member_select on public.shop_member
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.current_member_role(merchant_account_id) in ('owner', 'manager')
  );
create policy shop_member_insert on public.shop_member
  for insert to authenticated
  with check (public.current_member_role(merchant_account_id) in ('owner', 'manager'));
create policy shop_member_update on public.shop_member
  for update to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner', 'manager'))
  with check (public.current_member_role(merchant_account_id) in ('owner', 'manager'));
create policy shop_member_delete on public.shop_member
  for delete to authenticated
  using (public.current_member_role(merchant_account_id) = 'owner');

-- Existing members retain access to every existing store.  The unique key
-- makes interrupted/repeated execution idempotent.
insert into public.shop_member (merchant_account_id, shop_id, user_id, role)
select s.merchant_account_id, s.id, mm.user_id, mm.role
from public.shop s
join public.merchant_member mm on mm.merchant_account_id = s.merchant_account_id
on conflict (shop_id, user_id) do update
set merchant_account_id = excluded.merchant_account_id,
    role = excluded.role;

create or replace function public.sync_shop_memberships_for_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.role is distinct from old.role then
    insert into public.shop_member (merchant_account_id, shop_id, user_id, role)
    select new.merchant_account_id, s.id, new.user_id, new.role
    from public.shop s
    where s.merchant_account_id = new.merchant_account_id
    on conflict (shop_id, user_id) do update set role = excluded.role;
  end if;
  return new;
end;
$$;

drop trigger if exists merchant_member_sync_shop_memberships on public.merchant_member;
create trigger merchant_member_sync_shop_memberships
  after insert or update of role on public.merchant_member
  for each row execute function public.sync_shop_memberships_for_member();

create or replace function public.seed_shop_memberships()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.shop_member (merchant_account_id, shop_id, user_id, role)
  select new.merchant_account_id, new.id, mm.user_id, mm.role
  from public.merchant_member mm
  where mm.merchant_account_id = new.merchant_account_id
  on conflict (shop_id, user_id) do update set role = excluded.role;
  return new;
end;
$$;

drop trigger if exists shop_seed_memberships on public.shop;
create trigger shop_seed_memberships
  after insert on public.shop
  for each row execute function public.seed_shop_memberships();

-- Existing signup-created organizations receive a manual workspace before the
-- first page render.  Invitation-created users are covered by the membership
-- trigger above.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
begin
  if exists (
    select 1 from public.invitation
    where lower(email) = lower(new.email)
      and status = 'pending'
      and expires_at > now()
  ) then
    return new;
  end if;

  insert into public.merchant_account (name, owner_user_id)
  values (coalesce(nullif(split_part(new.email, '@', 1), ''), 'marchand'), new.id)
  returning id into v_account_id;

  insert into public.merchant_member (merchant_account_id, user_id, role)
  values (v_account_id, new.id, 'owner');

  insert into public.shop (
    merchant_account_id,
    shop_domain,
    access_token_encrypted,
    scopes,
    status,
    display_name,
    store_kind,
    is_default
  )
  values (
    v_account_id,
    'manual-' || replace(v_account_id::text, '-', '') || '.internal',
    null,
    '',
    'active',
    'Boutique principale',
    'manual',
    true
  );

  insert into public.audit_log (merchant_account_id, actor_user_id, action, resource_type, resource_id)
  values (v_account_id, new.id, 'account.created', 'merchant_account', v_account_id);
  return new;
end;
$$;

-- Store context is immutable after creation.  Moves would silently merge
-- histories between stores; a future administrative migration must explicitly
-- repair a row under a reviewed migration rather than through normal writes.
create or replace function public.prevent_store_context_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.merchant_account_id is distinct from old.merchant_account_id
     or new.shop_id is distinct from old.shop_id then
    raise exception 'store_context_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Store-scoped business tables.  Parent backfills use the order/product
-- association first and the merchant default store as a deterministic fallback.
alter table public.customer add column if not exists shop_id uuid;
alter table public.product add column if not exists shop_id uuid;
alter table public.order_line add column if not exists shop_id uuid;
alter table public.product_stock add column if not exists shop_id uuid;
alter table public.stock_movement add column if not exists shop_id uuid;
alter table public.product_bundle_component add column if not exists shop_id uuid;
alter table public.purchase_lot add column if not exists shop_id uuid;
alter table public.purchase_lot_line add column if not exists shop_id uuid;
alter table public.delivery_address add column if not exists shop_id uuid;

-- Orders already had shop_id; manual orders are assigned to the organization's
-- deterministic default store.  Shopify order provenance is never changed.
update public.orders o
set shop_id = s.id
from public.shop s
where o.shop_id is null
  and s.merchant_account_id = o.merchant_account_id
  and s.is_default;

update public.customer c
set shop_id = coalesce(
  (
    select o.shop_id
    from public.orders o
    where o.customer_id = c.id and o.shop_id is not null
    order by o.created_at desc, o.id desc
    limit 1
  ),
  (
    select s.id from public.shop s
    where s.merchant_account_id = c.merchant_account_id and s.is_default
  )
)
where c.shop_id is null;

update public.product p
set shop_id = coalesce(
  (
    select o.shop_id
    from public.orders o
    cross join lateral jsonb_array_elements(coalesce(o.items_summary, '[]'::jsonb)) item
    where o.merchant_account_id = p.merchant_account_id
      and o.shop_id is not null
      and (
        item ->> 'shopify_variant_id' = p.shopify_variant_id
        or item ->> 'shopify_product_id' = p.shopify_product_id
      )
    order by o.created_at desc, o.id desc
    limit 1
  ),
  (
    select s.id from public.shop s
    where s.merchant_account_id = p.merchant_account_id and s.is_default
  )
)
where p.shop_id is null;

update public.order_line ol set shop_id = o.shop_id
from public.orders o where o.id = ol.order_id and ol.shop_id is null;
update public.product_stock ps set shop_id = p.shop_id
from public.product p where p.id = ps.product_id and ps.shop_id is null;
update public.stock_movement sm set shop_id = p.shop_id
from public.product p where p.id = sm.product_id and sm.shop_id is null;
update public.product_bundle_component pbc set shop_id = p.shop_id
from public.product p where p.id = pbc.bundle_product_id and pbc.shop_id is null;
update public.purchase_lot_line pll set shop_id = p.shop_id
from public.product p where p.id = pll.product_id and pll.shop_id is null;
update public.purchase_lot pl set shop_id = s.id
from public.shop s where s.merchant_account_id = pl.merchant_account_id
  and s.is_default and pl.shop_id is null;
update public.delivery_address da set shop_id = o.shop_id
from public.orders o where o.id = da.order_id and da.shop_id is null;
update public.delivery_address da set shop_id = c.shop_id
from public.customer c where c.id = da.customer_id and da.shop_id is null;

create or replace function public.assign_default_store_context()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.shop_id is null then
    select s.id
      into new.shop_id
      from public.shop s
     where s.merchant_account_id = new.merchant_account_id
       and s.is_default
     order by s.id
     limit 1;
  end if;
  return new;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'orders', 'customer', 'product', 'order_line', 'product_stock',
    'stock_movement', 'product_bundle_component', 'purchase_lot',
    'purchase_lot_line', 'delivery_address'
  ] loop
    execute format('drop trigger if exists %I on public.%I', v_table || '_default_store_context', v_table);
    execute format(
      'create trigger %I before insert on public.%I for each row execute function public.assign_default_store_context()',
      v_table || '_default_store_context', v_table
    );
  end loop;
end;
$$;

-- All current rows must be attributable to one store before constraints are
-- tightened.  Fail closed rather than inventing a partial association.
do $$
declare
  v_table text;
  v_missing bigint;
begin
  foreach v_table in array array['orders','customer','product','order_line','product_stock','stock_movement','product_bundle_component','purchase_lot','purchase_lot_line','delivery_address'] loop
    execute format('select count(*) from public.%I where shop_id is null', v_table) into v_missing;
    if v_missing > 0 then
      raise exception 'phase1_backfill_incomplete table=% rows=%', v_table, v_missing;
    end if;
  end loop;
end;
$$;

alter table public.orders alter column shop_id set not null;
alter table public.customer alter column shop_id set not null;
alter table public.product alter column shop_id set not null;
alter table public.order_line alter column shop_id set not null;
alter table public.product_stock alter column shop_id set not null;
alter table public.stock_movement alter column shop_id set not null;
alter table public.product_bundle_component alter column shop_id set not null;
alter table public.purchase_lot alter column shop_id set not null;
alter table public.purchase_lot_line alter column shop_id set not null;
alter table public.delivery_address alter column shop_id set not null;

alter table public.orders drop constraint if exists orders_shop_tenant_fk;
alter table public.orders add constraint orders_shop_tenant_fk
  foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id);
alter table public.customer drop constraint if exists customer_shop_tenant_fk;
alter table public.customer add constraint customer_shop_tenant_fk
  foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id);
alter table public.product drop constraint if exists product_shop_tenant_fk;
alter table public.product add constraint product_shop_tenant_fk
  foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id);
alter table public.order_line drop constraint if exists order_line_shop_tenant_fk;
alter table public.order_line add constraint order_line_shop_tenant_fk
  foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id);
alter table public.product_stock drop constraint if exists product_stock_shop_tenant_fk;
alter table public.product_stock add constraint product_stock_shop_tenant_fk
  foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id);
alter table public.stock_movement drop constraint if exists stock_movement_shop_tenant_fk;
alter table public.stock_movement add constraint stock_movement_shop_tenant_fk
  foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id);
alter table public.product_bundle_component drop constraint if exists product_bundle_component_shop_tenant_fk;
alter table public.product_bundle_component add constraint product_bundle_component_shop_tenant_fk
  foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id);
alter table public.purchase_lot drop constraint if exists purchase_lot_shop_tenant_fk;
alter table public.purchase_lot add constraint purchase_lot_shop_tenant_fk
  foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id);
alter table public.purchase_lot_line drop constraint if exists purchase_lot_line_shop_tenant_fk;
alter table public.purchase_lot_line add constraint purchase_lot_line_shop_tenant_fk
  foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id);
alter table public.delivery_address drop constraint if exists delivery_address_shop_tenant_fk;
alter table public.delivery_address add constraint delivery_address_shop_tenant_fk
  foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id);

create index if not exists orders_tenant_shop_created_idx
  on public.orders (merchant_account_id, shop_id, created_at desc);
create index if not exists customer_tenant_shop_idx
  on public.customer (merchant_account_id, shop_id, id);
create index if not exists product_tenant_shop_idx
  on public.product (merchant_account_id, shop_id, title, id);
create index if not exists order_line_tenant_shop_idx
  on public.order_line (merchant_account_id, shop_id, order_id);
create index if not exists product_stock_tenant_shop_idx
  on public.product_stock (merchant_account_id, shop_id, product_id);
create index if not exists stock_movement_tenant_shop_created_idx
  on public.stock_movement (merchant_account_id, shop_id, created_at desc);
create index if not exists purchase_lot_tenant_shop_idx
  on public.purchase_lot (merchant_account_id, shop_id, created_at desc);

-- Protect both the tenant key and the store key on every store-scoped table.
do $$
declare v_table text;
begin
  foreach v_table in array array['orders','customer','product','order_line','product_stock','stock_movement','product_bundle_component','purchase_lot','purchase_lot_line','delivery_address'] loop
    execute format(
      'drop trigger if exists %I on public.%I',
      v_table || '_store_context_guard', v_table
    );
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.prevent_store_context_change()',
      v_table || '_store_context_guard', v_table
    );
  end loop;
end;
$$;

-- Store RLS is additive to the established role rules: a valid organization
-- role is insufficient without membership in the active store.
drop policy if exists shop_select on public.shop;
drop policy if exists shop_insert on public.shop;
drop policy if exists shop_update on public.shop;
drop policy if exists shop_delete on public.shop;
create policy shop_select on public.shop for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.is_shop_member_of(id));
create policy shop_insert on public.shop for insert to authenticated
  with check (public.current_member_role(merchant_account_id) in ('owner','manager'));
create policy shop_update on public.shop for update to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(id) in ('owner','manager'))
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(id) in ('owner','manager'));
create policy shop_delete on public.shop for delete to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(id) = 'owner');

drop policy if exists customer_select on public.customer;
drop policy if exists customer_insert on public.customer;
drop policy if exists customer_update on public.customer;
drop policy if exists customer_delete on public.customer;
create policy customer_select on public.customer for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.is_shop_member_of(shop_id));
create policy customer_insert on public.customer for insert to authenticated
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));
create policy customer_update on public.customer for update to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'))
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));
create policy customer_delete on public.customer for delete to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager'));

drop policy if exists orders_select on public.orders;
drop policy if exists orders_insert on public.orders;
drop policy if exists orders_update on public.orders;
drop policy if exists orders_delete on public.orders;
create policy orders_select on public.orders for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.is_shop_member_of(shop_id));
create policy orders_insert on public.orders for insert to authenticated
  with check (
    public.current_member_role(merchant_account_id) is not null and (
      public.current_shop_role(shop_id) in ('owner','manager')
    or (public.current_shop_role(shop_id) = 'agent' and cod_status = 'A_APPELER'
      and order_state = 'open' and call_state = 'to_call'
      and delivery_state = 'unassigned' and cash_state = 'not_due'))
  );
create policy orders_update on public.orders for update to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'))
  with check (
    public.current_member_role(merchant_account_id) is not null and (
      public.current_shop_role(shop_id) in ('owner','manager')
    or (public.current_shop_role(shop_id) = 'agent'
      and cod_status in ('TENTEE','CONFIRMEE','PROGRAMMEE','EN_LIVRAISON')))
  );
create policy orders_delete on public.orders for delete to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager'));

-- Tables whose existing policies already encode role visibility only need the
-- store membership predicate added.  The explicit drops preserve policy names
-- used by existing tests and avoid accidental permissive combinations.
drop policy if exists product_select on public.product;
drop policy if exists product_insert on public.product;
drop policy if exists product_update on public.product;
create policy product_select on public.product for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));
create policy product_insert on public.product for insert to authenticated
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager'));
create policy product_update on public.product for update to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager'))
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager'));

drop policy if exists product_stock_select on public.product_stock;
create policy product_stock_select on public.product_stock for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));
drop policy if exists stock_movement_select on public.stock_movement;
drop policy if exists stock_movement_insert on public.stock_movement;
create policy stock_movement_select on public.stock_movement for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));
create policy stock_movement_insert on public.stock_movement for insert to authenticated
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));

drop policy if exists order_line_select on public.order_line;
drop policy if exists order_line_insert on public.order_line;
drop policy if exists order_line_update on public.order_line;
create policy order_line_select on public.order_line for select to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));
create policy order_line_insert on public.order_line for insert to authenticated
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));
create policy order_line_update on public.order_line for update to authenticated
  using (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'))
  with check (public.current_member_role(merchant_account_id) is not null and public.current_shop_role(shop_id) in ('owner','manager','agent'));

-- The service role remains the only writer for stock/purchase internals where
-- existing grants already enforce that boundary.  Store predicates still
-- protect authenticated reads.
