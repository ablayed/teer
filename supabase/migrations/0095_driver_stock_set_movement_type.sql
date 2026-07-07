-- 0095 : Lot 4b+4c / PR 2 — nouveau movement_type driver_stock_set.
--
-- Nouveau geste "Modifier le stock" livreur (remplace les onglets Allouer un
-- lot/Retour de lot) : le marchand saisit une VALEUR ABSOLUE ("le livreur a
-- maintenant X"), le delta est calculé côté serveur avant l'appel RPC. Un seul
-- type suffit (positif = augmentation, négatif = diminution) — contrairement
-- au couple order_assignment_commit/release (Lot 2) qui répond à un besoin
-- différent (engagement vs restitution sur une commande), ici c'est un ajustement
-- direct en une seule écriture, hors commande.
--
-- Ledger-only dès sa création, comme order_assignment_commit/release (0091) :
-- ne mutent JAMAIS product_stock. Cohérent avec la décision Lot 4b+4c PR 1 —
-- ce nouveau geste ne doit jamais recréer un couplage au stock central que PR 1
-- vient de retirer pour allocate_to_courier/courier_return_lot.
--
-- Nom retenu : driver_stock_set (verbe + contexte, même convention que
-- order_assignment_commit/release). Un nom alternatif du style
-- "driver_stock_adjustment" aurait pu prêter à confusion avec
-- manual_adjustment (/produits, Lot 4a) qui est un DELTA appliqué au stock
-- CENTRAL — sémantique opposée (valeur absolue, stock livreur, ledger-only).

-- ────────────────────────────────────────────────────────────
-- 1. CHECK constraints : ajout de driver_stock_set
-- ────────────────────────────────────────────────────────────

alter table public.stock_movement
  drop constraint if exists stock_movement_type_check;

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
      'manual_adjustment',
      'allocate_to_courier',
      'courier_return_lot',
      'advance_commit',
      'reassign_from_driver',
      'reassign_to_driver',
      'order_assignment_commit',
      'order_assignment_release',
      'driver_stock_set'
    )
  )
  not valid;

alter table public.stock_movement
  validate constraint stock_movement_type_check;

alter table public.stock_movement
  drop constraint if exists stock_movement_lot_requires_driver_check;

alter table public.stock_movement
  add constraint stock_movement_lot_requires_driver_check
  check (
    movement_type not in (
      'allocate_to_courier',
      'courier_return_lot',
      'advance_commit',
      'order_assignment_commit',
      'order_assignment_release',
      'driver_stock_set'
    )
    or driver_id is not null
  )
  not valid;

alter table public.stock_movement
  validate constraint stock_movement_lot_requires_driver_check;

-- ────────────────────────────────────────────────────────────
-- 2. post_stock_movement : driver_stock_set ledger-only + guard driver requis.
-- Corps repris VERBATIM de 0093, seuls les deux ajouts ci-dessous changent.
-- ────────────────────────────────────────────────────────────

create or replace function public.post_stock_movement(
  p_merchant_account_id uuid,
  p_product_id          uuid,
  p_movement_type       text,
  p_qty                 integer,
  p_idempotency_key     text,
  p_created_by          uuid,
  p_order_id            uuid    default null,
  p_transition_id       uuid    default null,
  p_unit_cost           bigint  default null,
  p_received_value      bigint  default null,
  p_reason              text    default null,
  p_driver_id           uuid    default null
)
returns uuid
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
  v_cump_numerator numeric;
begin
  if public.current_member_role(p_merchant_account_id) is null then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if p_movement_type = 'manual_adjustment'
     and coalesce(nullif(btrim(coalesce(p_reason, '')), ''), null) is null
  then
    raise exception 'manual_adjustment requires a non-empty reason'
      using errcode = 'P0001';
  end if;

  if p_movement_type in (
       'allocate_to_courier',
       'courier_return_lot',
       'advance_commit',
       'order_assignment_commit',
       'order_assignment_release',
       'driver_stock_set'
     )
     and p_driver_id is null
  then
    raise exception 'driver movement requires a driver'
      using errcode = 'P0001';
  end if;

  if p_movement_type in ('reassign_from_driver', 'reassign_to_driver')
     and p_driver_id is null
  then
    raise exception 'reassign movement requires a driver'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.product
    where id = p_product_id
      and merchant_account_id = p_merchant_account_id
  ) then
    raise exception 'product not found for this merchant account'
      using errcode = 'P0002';
  end if;

  if p_driver_id is not null and not exists (
    select 1 from public.driver
    where id = p_driver_id
      and merchant_account_id = p_merchant_account_id
  ) then
    raise exception 'driver not found for this merchant account'
      using errcode = 'P0002';
  end if;

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

  if v_movement_id is null then
    return null;
  end if;

  -- Ledger-only movement types: no product_stock mutation.
  -- driver_stock_set added in 0095 (Lot 4b+4c / PR 2) — the driver-facing
  -- "Modifier le stock" gesture never touches the central figure, same
  -- reasoning as order_assignment_commit/release (Lot 2) and the PR 1 change
  -- to allocate_to_courier/courier_return_lot (0093).
  if p_movement_type in (
       'order_assignment_commit',
       'order_assignment_release',
       'allocate_to_courier',
       'courier_return_lot',
       'driver_stock_set'
     )
  then
    return v_movement_id;
  end if;

  insert into public.product_stock (product_id, merchant_account_id)
  values (p_product_id, p_merchant_account_id)
  on conflict (product_id) do nothing;

  select * into v_stock
  from public.product_stock
  where product_id = p_product_id
  for update;

  v_new_on_hand   := v_stock.qty_on_hand;
  v_new_reserved  := v_stock.qty_reserved;
  v_new_unit_cost := v_stock.unit_cost;

  case p_movement_type
    when 'reserve' then
      v_new_reserved := v_stock.qty_reserved + p_qty;

    when 'release' then
      v_new_reserved := greatest(0, v_stock.qty_reserved + p_qty);

    when 'dispatch' then
      v_new_on_hand  := greatest(0, v_stock.qty_on_hand  + p_qty);
      v_new_reserved := greatest(0, v_stock.qty_reserved + p_qty);
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'advance_commit' then
      v_new_reserved := greatest(0, v_stock.qty_reserved - greatest(p_qty, 0));

    when 'sold' then
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'purchase_in' then
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

    when 'reassign_from_driver' then
      v_new_on_hand := v_stock.qty_on_hand + p_qty;

    when 'reassign_to_driver' then
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'manual_adjustment' then
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

grant execute on function public.post_stock_movement(
  uuid, uuid, text, integer, text, uuid,
  uuid, uuid, bigint, bigint, text, uuid
) to authenticated;
