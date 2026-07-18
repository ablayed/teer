-- 0107 : Bundles/packs — PR 1, schéma de composition.
--
-- Un bundle est un produit normal existant (product.is_bundle=true), jamais un nouveau
-- type de produit — cf. Phase A décision #1. La composition (quels composants, quelle
-- quantité chacun) vit dans une table de liaison séparée, product_bundle_component.
--
-- Pas de bundle imbriqué (Phase A décision #7, confirmé Phase B) : un composant ne peut
-- jamais être lui-même marqué is_bundle=true, et un produit déjà référencé comme composant
-- ne peut pas être promu bundle après coup. Les deux sens de cette invariante sont
-- appliqués par trigger (pas seulement par check constraint), car ils dépendent de l'état
-- d'une AUTRE ligne/table — un check constraint plat ne peut pas l'exprimer.

-- ────────────────────────────────────────────────────────────
-- 1. product.is_bundle
-- ────────────────────────────────────────────────────────────

alter table public.product
  add column is_bundle boolean not null default false;

-- ────────────────────────────────────────────────────────────
-- 2. product_bundle_component
-- ────────────────────────────────────────────────────────────

create table public.product_bundle_component (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  bundle_product_id uuid not null references public.product(id) on delete cascade,
  component_product_id uuid not null references public.product(id) on delete cascade,
  quantity integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.product_bundle_component
  add constraint product_bundle_component_quantity_positive
  check (quantity > 0)
  not valid;

alter table public.product_bundle_component
  add constraint product_bundle_component_no_self_reference
  check (bundle_product_id <> component_product_id)
  not valid;

create unique index product_bundle_component_pair_idx
  on public.product_bundle_component (bundle_product_id, component_product_id);

create index product_bundle_component_bundle_idx
  on public.product_bundle_component (bundle_product_id);

create index product_bundle_component_component_idx
  on public.product_bundle_component (component_product_id);

create index product_bundle_component_merchant_account_idx
  on public.product_bundle_component (merchant_account_id);

create trigger product_bundle_component_set_updated_at
  before update on public.product_bundle_component
  for each row
  execute function public.set_updated_at();

-- ────────────────────────────────────────────────────────────
-- 3. Invariantes cross-row : pas de bundle imbriqué, tenant cohérent.
-- ────────────────────────────────────────────────────────────

-- Côté product_bundle_component : à l'insertion/modification d'une ligne de composition,
-- vérifie que (a) le bundle est bien marqué is_bundle=true (une composition n'existe que
-- pour un bundle déclaré, jamais un produit orphelin), (b) le composant n'est PAS lui-même
-- un bundle (pas d'imbrication), (c) les deux produits appartiennent au même
-- merchant_account_id que la ligne de composition (isolation tenant, défense en profondeur
-- au-delà de RLS).
create or replace function public.assert_bundle_component_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bundle_is_bundle boolean;
  v_bundle_merchant_account_id uuid;
  v_component_is_bundle boolean;
  v_component_merchant_account_id uuid;
begin
  select is_bundle, merchant_account_id
    into v_bundle_is_bundle, v_bundle_merchant_account_id
    from public.product
   where id = new.bundle_product_id;

  if not found then
    raise exception 'bundle_product_id % not found'
      , new.bundle_product_id
      using errcode = 'P0002';
  end if;

  select is_bundle, merchant_account_id
    into v_component_is_bundle, v_component_merchant_account_id
    from public.product
   where id = new.component_product_id;

  if not found then
    raise exception 'component_product_id % not found'
      , new.component_product_id
      using errcode = 'P0002';
  end if;

  if not v_bundle_is_bundle then
    raise exception 'bundle_product_id % is not marked is_bundle=true'
      , new.bundle_product_id
      using errcode = 'P0001';
  end if;

  if v_component_is_bundle then
    raise exception 'component_product_id % is itself a bundle (nested bundles are not supported)'
      , new.component_product_id
      using errcode = 'P0001';
  end if;

  if v_bundle_merchant_account_id <> new.merchant_account_id
     or v_component_merchant_account_id <> new.merchant_account_id
  then
    raise exception 'bundle_product_id and component_product_id must belong to the same merchant_account_id as the composition row'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger product_bundle_component_assert_integrity
  before insert or update on public.product_bundle_component
  for each row
  execute function public.assert_bundle_component_integrity();

-- Côté product : empêche de promouvoir is_bundle=true un produit déjà référencé comme
-- COMPOSANT d'un autre bundle (sens inverse de la garde ci-dessus — sans ce trigger, un
-- produit ajouté légitimement comme composant à un moment où is_bundle=false pourrait être
-- promu bundle après coup, créant une imbrication a posteriori).
create or replace function public.assert_product_not_promoted_when_used_as_component()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_bundle and not old.is_bundle then
    if exists (
      select 1
        from public.product_bundle_component
       where component_product_id = new.id
    ) then
      raise exception 'product % is already used as a bundle component and cannot itself become a bundle'
        , new.id
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create trigger product_assert_not_promoted_when_used_as_component
  before update of is_bundle on public.product
  for each row
  execute function public.assert_product_not_promoted_when_used_as_component();

-- ────────────────────────────────────────────────────────────
-- 4. RLS — même isolation tenant que product/stock_movement.
-- ────────────────────────────────────────────────────────────

alter table public.product_bundle_component enable row level security;
alter table public.product_bundle_component force row level security;

create policy product_bundle_component_select
  on public.product_bundle_component
  for select
  to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  );

create policy product_bundle_component_insert
  on public.product_bundle_component
  for insert
  to authenticated
  with check (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
  );

create policy product_bundle_component_update
  on public.product_bundle_component
  for update
  to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
  )
  with check (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
  );

create policy product_bundle_component_delete
  on public.product_bundle_component
  for delete
  to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
  );

revoke all on public.product_bundle_component from anon;
revoke all on public.product_bundle_component from authenticated;

grant select (
  id,
  merchant_account_id,
  bundle_product_id,
  component_product_id,
  quantity,
  created_at,
  updated_at
) on public.product_bundle_component to authenticated;

grant insert (
  merchant_account_id,
  bundle_product_id,
  component_product_id,
  quantity
) on public.product_bundle_component to authenticated;

grant update (
  quantity,
  updated_at
) on public.product_bundle_component to authenticated;

grant delete on public.product_bundle_component to authenticated;

-- ────────────────────────────────────────────────────────────
-- 5. product.is_bundle — exposer en lecture/écriture comme les autres colonnes catalogue.
-- ────────────────────────────────────────────────────────────

grant select (is_bundle) on public.product to authenticated;
grant update (is_bundle) on public.product to authenticated;
