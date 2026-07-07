-- 0093 : Lot 4b+4c / PR 1 — fin de la décrémentation/incrémentation centrale
-- par allocate_to_courier / courier_return_lot.
--
-- Contexte (audit Phase A) : ces deux movement_type mutaient jusqu'ici
-- product_stock.qty_on_hand (allocate_to_courier décrémente, clampé à 0 via
-- greatest(0, ...) ; courier_return_lot incrémente, non clampé). Décision
-- produit validée : le stock central (/produits) ne doit plus refléter ces
-- deux gestes livreur — le prochain lot (PR 2) introduit une lecture/action
-- basée sur le stock physique livreur (ledger stock_movement), découplée de
-- product_stock. Symétrie obligatoire : les DEUX types cessent de muter
-- qty_on_hand, pas seulement allocate_to_courier (sinon un retour de lot
-- gonflerait le stock central sans contrepartie).
--
-- Aucune restitution de l'effet historique n'est faite ici : c'est un
-- diagnostic + une décision séparée du porteur (cf.
-- supabase/snippets/diagnostic_lot_cutover_readonly.sql).
--
-- Corps repris VERBATIM de 0091 (dernière définition), à l'exception de :
--   - allocate_to_courier / courier_return_lot ajoutés à la liste "ledger-only"
--     (insert + retour immédiat, comme order_assignment_commit/release) ;
--   - leurs branches du `case` (désormais inatteignables) supprimées.
-- Rien d'autre n'est modifié : guards, driver_id requirement, dispatch,
-- sold, purchase_in, courier_return, reassign_*, manual_adjustment,
-- reserve/release, order_assignment_commit/release restent inchangés.

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
       'order_assignment_release'
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
  -- allocate_to_courier / courier_return_lot moved here in 0093 (previously
  -- mutated qty_on_hand — see migration header).
  if p_movement_type in (
       'order_assignment_commit',
       'order_assignment_release',
       'allocate_to_courier',
       'courier_return_lot'
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
