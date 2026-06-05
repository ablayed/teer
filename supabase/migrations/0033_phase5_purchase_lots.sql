-- ============================================================
-- 0033 : Phase 5 — lots fournisseur + coût de revient atterri
-- ============================================================
-- 1. purchase_lot          : lot d'achat fournisseur (statut, frais, ETA)
-- 2. purchase_lot_line     : lignes du lot (produit, qty, prix, dérivés réception)
-- 3. merchant_settings.import_vat_recoverable : flag TVA import (défaut true = exclue)
-- 4. post_stock_movement   : + p_received_value bigint default null
--      → branche purchase_in utilise la valeur atterrie EXACTE dans le
--        numérateur CUMP pour éviter la dérive qty × floor(total/qty).
--      → toutes les autres branches : comportement IDENTIQUE à 0031.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. purchase_lot
-- ────────────────────────────────────────────────────────────

create table public.purchase_lot (
  id                    uuid        primary key default gen_random_uuid(),
  merchant_account_id   uuid        not null references public.merchant_account(id) on delete cascade,
  supplier_name         text        not null,
  reference             text,
  ordered_at            date        not null,
  shipping_mode         text        not null default 'normal',
  supplier_prep_days    int         not null default 0,
  transport_days        int         not null default 0,
  local_buffer_days     int         not null default 0,
  eta_override          date,
  status                text        not null default 'ordered',
  freight_total         bigint      not null default 0,
  customs_total         bigint      not null default 0,
  transit_total         bigint      not null default 0,
  local_transport_total bigint      not null default 0,
  allocation_method     text        not null default 'value',
  received_at           date,
  created_at            timestamptz not null default now()
);

alter table public.purchase_lot
  add constraint purchase_lot_supplier_name_not_blank
  check (btrim(supplier_name) <> '')
  not valid;

alter table public.purchase_lot
  add constraint purchase_lot_shipping_mode_check
  check (shipping_mode in ('fast', 'normal'))
  not valid;

alter table public.purchase_lot
  add constraint purchase_lot_status_check
  check (status in ('ordered', 'in_transit', 'received'))
  not valid;

alter table public.purchase_lot
  add constraint purchase_lot_allocation_method_check
  check (allocation_method in ('value', 'quantity', 'weight'))
  not valid;

alter table public.purchase_lot
  add constraint purchase_lot_supplier_prep_days_nonnegative
  check (supplier_prep_days >= 0)
  not valid;

alter table public.purchase_lot
  add constraint purchase_lot_transport_days_nonnegative
  check (transport_days >= 0)
  not valid;

alter table public.purchase_lot
  add constraint purchase_lot_local_buffer_days_nonnegative
  check (local_buffer_days >= 0)
  not valid;

alter table public.purchase_lot
  add constraint purchase_lot_freight_total_nonnegative
  check (freight_total >= 0)
  not valid;

alter table public.purchase_lot
  add constraint purchase_lot_customs_total_nonnegative
  check (customs_total >= 0)
  not valid;

alter table public.purchase_lot
  add constraint purchase_lot_transit_total_nonnegative
  check (transit_total >= 0)
  not valid;

alter table public.purchase_lot
  add constraint purchase_lot_local_transport_total_nonnegative
  check (local_transport_total >= 0)
  not valid;

create index purchase_lot_merchant_account_idx
  on public.purchase_lot (merchant_account_id);

create index purchase_lot_status_idx
  on public.purchase_lot (merchant_account_id, status);

alter table public.purchase_lot enable row level security;
alter table public.purchase_lot force row level security;

create policy purchase_lot_select
  on public.purchase_lot
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) = 'owner');

create policy purchase_lot_insert
  on public.purchase_lot
  for insert
  to authenticated
  with check (public.current_member_role(merchant_account_id) = 'owner');

create policy purchase_lot_update
  on public.purchase_lot
  for update
  to authenticated
  using  (public.current_member_role(merchant_account_id) = 'owner')
  with check (public.current_member_role(merchant_account_id) = 'owner');

revoke all on public.purchase_lot from anon;
revoke all on public.purchase_lot from authenticated;

grant select (
  id,
  merchant_account_id,
  supplier_name,
  reference,
  ordered_at,
  shipping_mode,
  supplier_prep_days,
  transport_days,
  local_buffer_days,
  eta_override,
  status,
  freight_total,
  customs_total,
  transit_total,
  local_transport_total,
  allocation_method,
  received_at,
  created_at
) on public.purchase_lot to authenticated;

grant insert (
  merchant_account_id,
  supplier_name,
  reference,
  ordered_at,
  shipping_mode,
  supplier_prep_days,
  transport_days,
  local_buffer_days,
  eta_override,
  status,
  freight_total,
  customs_total,
  transit_total,
  local_transport_total,
  allocation_method
) on public.purchase_lot to authenticated;

grant update (
  supplier_name,
  reference,
  ordered_at,
  shipping_mode,
  supplier_prep_days,
  transport_days,
  local_buffer_days,
  eta_override,
  status,
  freight_total,
  customs_total,
  transit_total,
  local_transport_total,
  allocation_method,
  received_at
) on public.purchase_lot to authenticated;

-- ────────────────────────────────────────────────────────────
-- 2. purchase_lot_line
-- ────────────────────────────────────────────────────────────

create table public.purchase_lot_line (
  id                   uuid    primary key default gen_random_uuid(),
  merchant_account_id  uuid    not null references public.merchant_account(id) on delete cascade,
  purchase_lot_id      uuid    not null references public.purchase_lot(id) on delete cascade,
  product_id           uuid    not null references public.product(id) on delete restrict,
  qty                  int     not null,
  unit_purchase_price  bigint  not null,
  -- dérivés figés à la réception (null avant) :
  line_value           bigint,   -- qty × unit_purchase_price (exact)
  allocated_fees       bigint,   -- frais partagés alloués à cette ligne (plus grand reste)
  landed_total_value   bigint,   -- line_value + allocated_fees (valeur atterrie exacte)
  landed_unit_cost     bigint,   -- landed_total_value / qty (arrondi inférieur, affiché)
  created_at           timestamptz not null default now()
);

alter table public.purchase_lot_line
  add constraint purchase_lot_line_qty_nonnegative
  check (qty >= 0)
  not valid;

alter table public.purchase_lot_line
  add constraint purchase_lot_line_unit_purchase_price_nonnegative
  check (unit_purchase_price >= 0)
  not valid;

alter table public.purchase_lot_line
  add constraint purchase_lot_line_line_value_nonnegative
  check (line_value is null or line_value >= 0)
  not valid;

alter table public.purchase_lot_line
  add constraint purchase_lot_line_allocated_fees_nonnegative
  check (allocated_fees is null or allocated_fees >= 0)
  not valid;

alter table public.purchase_lot_line
  add constraint purchase_lot_line_landed_total_value_nonnegative
  check (landed_total_value is null or landed_total_value >= 0)
  not valid;

alter table public.purchase_lot_line
  add constraint purchase_lot_line_landed_unit_cost_nonnegative
  check (landed_unit_cost is null or landed_unit_cost >= 0)
  not valid;

create index purchase_lot_line_lot_idx
  on public.purchase_lot_line (purchase_lot_id);

create index purchase_lot_line_product_idx
  on public.purchase_lot_line (product_id);

create index purchase_lot_line_merchant_account_idx
  on public.purchase_lot_line (merchant_account_id);

alter table public.purchase_lot_line enable row level security;
alter table public.purchase_lot_line force row level security;

create policy purchase_lot_line_select
  on public.purchase_lot_line
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) = 'owner');

create policy purchase_lot_line_insert
  on public.purchase_lot_line
  for insert
  to authenticated
  with check (public.current_member_role(merchant_account_id) = 'owner');

create policy purchase_lot_line_update
  on public.purchase_lot_line
  for update
  to authenticated
  using  (public.current_member_role(merchant_account_id) = 'owner')
  with check (public.current_member_role(merchant_account_id) = 'owner');

revoke all on public.purchase_lot_line from anon;
revoke all on public.purchase_lot_line from authenticated;

grant select (
  id,
  merchant_account_id,
  purchase_lot_id,
  product_id,
  qty,
  unit_purchase_price,
  line_value,
  allocated_fees,
  landed_total_value,
  landed_unit_cost,
  created_at
) on public.purchase_lot_line to authenticated;

grant insert (
  merchant_account_id,
  purchase_lot_id,
  product_id,
  qty,
  unit_purchase_price
) on public.purchase_lot_line to authenticated;

grant update (
  qty,
  unit_purchase_price,
  line_value,
  allocated_fees,
  landed_total_value,
  landed_unit_cost
) on public.purchase_lot_line to authenticated;

-- ────────────────────────────────────────────────────────────
-- 3. merchant_settings.import_vat_recoverable
-- ────────────────────────────────────────────────────────────
-- true (défaut) : TVA import récupérable → exclue du coût atterri.
-- false         : TVA non récupérable → à inclure dans le prix d'achat saisi.
-- Décision finale par un expert-comptable OHADA/sénégalais.

alter table public.merchant_settings
  add column if not exists import_vat_recoverable boolean not null default true;

-- ────────────────────────────────────────────────────────────
-- 4. post_stock_movement — ajout p_received_value
-- ────────────────────────────────────────────────────────────
-- Seul changement par rapport à 0031 :
--   • signature : + p_received_value bigint default null (11e param, entre
--     p_unit_cost et p_reason pour grouper les params de coût)
--   • branche purchase_in : utilise p_received_value dans le numérateur CUMP
--     quand fourni, sinon fallback p_qty × p_unit_cost (backward-compatible).
--   • toutes les autres branches : code identique à 0031.

drop function if exists public.post_stock_movement(
  uuid, uuid, text, integer, text, uuid,
  uuid, uuid, bigint, text, uuid
);

create or replace function public.post_stock_movement(
  p_merchant_account_id uuid,
  p_product_id          uuid,
  p_movement_type       text,
  p_qty                 integer,          -- signé : négatif pour dispatch/release/allocate
  p_idempotency_key     text,
  p_created_by          uuid,
  p_order_id            uuid    default null,
  p_transition_id       uuid    default null,
  p_unit_cost           bigint  default null,   -- obligatoire pour purchase_in (stocké dans ledger)
  p_received_value      bigint  default null,   -- valeur atterrie exacte (purchase_in lot) → numérateur CUMP
  p_reason              text    default null,
  p_driver_id           uuid    default null    -- livreur attribué (lot ou commande)
)
returns uuid     -- id du stock_movement créé, NULL si doublon (idempotent)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_movement_id    uuid;
  v_stock          public.product_stock%rowtype;
  v_new_on_hand    integer;
  v_new_reserved   integer;
  v_new_unit_cost  bigint;
  v_cump_numerator numeric;  -- intermédiaire CUMP (évite overflow bigint × bigint)
begin
  -- Validation manual_adjustment : raison non vide obligatoire.
  if p_movement_type = 'manual_adjustment'
     and coalesce(nullif(btrim(coalesce(p_reason, '')), ''), null) is null
  then
    raise exception 'manual_adjustment requires a non-empty reason'
      using errcode = 'P0001';
  end if;

  -- Les mouvements lot exigent un livreur.
  if p_movement_type in ('allocate_to_courier', 'courier_return_lot')
     and p_driver_id is null
  then
    raise exception 'lot movement requires a driver'
      using errcode = 'P0001';
  end if;

  -- Guard tenant : le produit doit appartenir au merchant déclaré.
  -- (protège les appels RPC directs ; transition_order est déjà scopé par RLS.)
  if not exists (
    select 1 from public.product
    where id = p_product_id
      and merchant_account_id = p_merchant_account_id
  ) then
    raise exception 'product not found for this merchant account'
      using errcode = 'P0002';
  end if;

  -- Guard tenant : le livreur (si fourni) doit appartenir au merchant.
  if p_driver_id is not null and not exists (
    select 1 from public.driver
    where id = p_driver_id
      and merchant_account_id = p_merchant_account_id
  ) then
    raise exception 'driver not found for this merchant account'
      using errcode = 'P0002';
  end if;

  -- Ledger insert idempotent.
  insert into public.stock_movement (
    merchant_account_id,
    product_id,
    movement_type,
    qty,
    unit_cost,
    reason,
    order_id,
    transition_id,
    idempotency_key,
    created_by,
    driver_id
  )
  values (
    p_merchant_account_id,
    p_product_id,
    p_movement_type,
    p_qty,
    p_unit_cost,
    p_reason,
    p_order_id,
    p_transition_id,
    p_idempotency_key,
    p_created_by,
    p_driver_id
  )
  on conflict (idempotency_key) do nothing
  returning id into v_movement_id;

  -- Doublon : retour sans toucher product_stock (idempotence garantie).
  if v_movement_id is null then
    return null;
  end if;

  -- Création de la ligne product_stock si première écriture pour ce produit.
  insert into public.product_stock (product_id, merchant_account_id)
  values (p_product_id, p_merchant_account_id)
  on conflict (product_id) do nothing;

  -- Verrou exclusif sur la projection (anti lost-update).
  select * into v_stock
  from public.product_stock
  where product_id = p_product_id
  for update;

  v_new_on_hand   := v_stock.qty_on_hand;
  v_new_reserved  := v_stock.qty_reserved;
  v_new_unit_cost := v_stock.unit_cost;

  case p_movement_type

    when 'reserve' then
      -- Réserve molle : uniquement qty_reserved, jamais qty_on_hand.
      v_new_reserved := v_stock.qty_reserved + p_qty;

    when 'release' then
      -- p_qty est négatif ; on clamp à 0.
      v_new_reserved := greatest(0, v_stock.qty_reserved + p_qty);

    when 'dispatch' then
      -- p_qty est négatif ; décrément physique + réserve + snapshot CUMP courant.
      v_new_on_hand  := greatest(0, v_stock.qty_on_hand  + p_qty);
      v_new_reserved := greatest(0, v_stock.qty_reserved + p_qty);
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'allocate_to_courier' then
      -- Lot d'avance : sortie physique entrepôt → livreur (p_qty négatif),
      -- hors commande, hors réserve. Snapshot CUMP (valorisation du lot).
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'sold' then
      -- Snapshot CUMP pour COGS, aucune mutation de position.
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'purchase_in' then
      -- Recalcul CUMP (moyenne mobile pondérée, arithmétique entière).
      -- p_received_value (si fourni) = valeur atterrie EXACTE de la ligne lot :
      -- évite la dérive de qty × floor(landed_total / qty) dans le numérateur.
      -- Fallback sur p_qty × p_unit_cost pour la saisie manuelle existante.
      if (p_received_value is not null or p_unit_cost is not null)
         and (v_stock.qty_on_hand + p_qty) > 0
      then
        v_cump_numerator :=
          v_stock.qty_on_hand::numeric * v_stock.unit_cost::numeric
          + coalesce(
              p_received_value::numeric,
              p_qty::numeric * p_unit_cost::numeric
            );
        v_new_unit_cost :=
          (v_cump_numerator / (v_stock.qty_on_hand + p_qty))::bigint;
      end if;
      v_new_on_hand := v_stock.qty_on_hand + p_qty;

    when 'courier_return' then
      v_new_on_hand := v_stock.qty_on_hand + p_qty;

    when 'courier_return_lot' then
      -- Retour de l'invendu du lot : restaure qty_on_hand entrepôt (p_qty positif).
      v_new_on_hand := v_stock.qty_on_hand + p_qty;

    when 'manual_adjustment' then
      -- p_qty signé (+/-) ; raison validée ci-dessus ; clamp à 0.
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);

    else
      raise exception 'unknown stock movement_type: %', p_movement_type
        using errcode = 'P0001';

  end case;

  update public.product_stock
     set qty_on_hand  = v_new_on_hand,
         qty_reserved = v_new_reserved,
         unit_cost    = v_new_unit_cost,
         updated_at   = now()
   where product_id = p_product_id;

  return v_movement_id;
end;
$$;

-- Accessible depuis transition_order (INVOKER, rôle authenticated) et
-- depuis les actions autonomes via supabase.rpc().
grant execute on function public.post_stock_movement(
  uuid, uuid, text, integer, text, uuid,
  uuid, uuid, bigint, bigint, text, uuid
) to authenticated;
