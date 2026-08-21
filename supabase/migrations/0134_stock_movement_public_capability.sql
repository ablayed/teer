-- 0134: Separate the stock engine from the authenticated public capability.
--
-- The twelve-argument function remains the internal engine used by SQL
-- transitions and by explicit service-role test seeds.  It is never callable by
-- authenticated users.  The thirteen-argument overload is the sole public
-- capability: it validates the active shop and derives created_by from auth.uid().

create or replace function public.post_stock_movement(
  p_merchant_account_id uuid,
  p_product_id uuid,
  p_movement_type text,
  p_qty integer,
  p_idempotency_key text,
  p_created_by uuid,
  p_order_id uuid default null::uuid,
  p_transition_id uuid default null::uuid,
  p_unit_cost bigint default null::bigint,
  p_received_value bigint default null::bigint,
  p_reason text default null::text,
  p_driver_id uuid default null::uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_movement_id    uuid;
  v_stock          public.product_stock%rowtype;
  v_new_on_hand    integer;
  v_new_reserved   integer;
  v_new_unit_cost  bigint;
  v_cump_numerator numeric;
  v_is_bundle      boolean;
  v_shop_id        uuid;
  v_component      record;
begin
  -- The engine is reached either from an authenticated SQL transition or from
  -- the explicitly granted service-role seed path.  It is not public.
  if coalesce(auth.role(), '') <> 'service_role'
     and public.current_member_role(p_merchant_account_id) is null
  then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_movement_type = 'manual_adjustment'
     and coalesce(nullif(btrim(coalesce(p_reason, '')), ''), null) is null
  then
    raise exception 'manual_adjustment requires a non-empty reason' using errcode = 'P0001';
  end if;

  if p_movement_type in (
       'allocate_to_courier', 'courier_return_lot', 'advance_commit',
       'order_assignment_commit', 'order_assignment_release', 'driver_stock_set'
     ) and p_driver_id is null
  then
    raise exception 'driver movement requires a driver' using errcode = 'P0001';
  end if;

  if p_movement_type in ('reassign_from_driver', 'reassign_to_driver')
     and p_driver_id is null
  then
    raise exception 'reassign movement requires a driver' using errcode = 'P0001';
  end if;

  select p.is_bundle, p.shop_id
    into v_is_bundle, v_shop_id
    from public.product p
   where p.id = p_product_id
     and p.merchant_account_id = p_merchant_account_id;

  if not found then
    raise exception 'product not found for this merchant account' using errcode = 'P0002';
  end if;

  if v_shop_id is null or not exists (
    select 1 from public.shop s
     where s.id = v_shop_id and s.merchant_account_id = p_merchant_account_id
  ) then
    raise exception 'stock_movement_store_conflict' using errcode = 'P0001';
  end if;

  -- Parent references must be from the same authoritative shop as the product.
  if p_order_id is not null and not exists (
    select 1 from public.orders o
     where o.id = p_order_id
       and o.merchant_account_id = p_merchant_account_id
       and o.shop_id = v_shop_id
  ) then
    raise exception 'stock_movement_order_store_conflict' using errcode = 'P0001';
  end if;

  if p_transition_id is not null and not exists (
    select 1 from public.order_state_transition ost
     where ost.id = p_transition_id
       and ost.merchant_account_id = p_merchant_account_id
       and ost.shop_id = v_shop_id
       and (p_order_id is null or ost.order_id = p_order_id)
  ) then
    raise exception 'stock_movement_transition_store_conflict' using errcode = 'P0001';
  end if;

  if v_is_bundle
     and p_movement_type in ('allocate_to_courier', 'courier_return_lot', 'driver_stock_set')
  then
    raise exception 'bundle product % cannot be the target of movement_type %',
      p_product_id, p_movement_type using errcode = 'P0001';
  end if;

  if p_driver_id is not null and not exists (
    select 1 from public.driver_shop ds
     where ds.merchant_account_id = p_merchant_account_id
       and ds.shop_id = v_shop_id
       and ds.driver_id = p_driver_id
  ) then
    raise exception 'driver not found in product shop' using errcode = 'P0002';
  end if;

  if v_is_bundle
     and p_movement_type in (
       'dispatch', 'sold', 'courier_return',
       'order_assignment_commit', 'order_assignment_release'
     )
  then
    for v_component in
      select pbc.component_product_id, pbc.quantity
        from public.product_bundle_component pbc
       where pbc.bundle_product_id = p_product_id
    loop
      perform public.post_stock_movement(
        p_merchant_account_id := p_merchant_account_id,
        p_product_id          := v_component.component_product_id,
        p_movement_type       := p_movement_type,
        p_qty                 := p_qty * v_component.quantity,
        p_idempotency_key     := p_idempotency_key || ':component:' || v_component.component_product_id::text,
        p_created_by          := p_created_by,
        p_order_id            := p_order_id,
        p_transition_id       := p_transition_id,
        p_unit_cost           := p_unit_cost,
        p_received_value      := p_received_value,
        p_reason              := p_reason,
        p_driver_id           := p_driver_id
      );
    end loop;

    return null;
  end if;

  insert into public.stock_movement (
    merchant_account_id, shop_id, product_id, movement_type, qty, unit_cost,
    reason, order_id, transition_id, idempotency_key, created_by, driver_id
  ) values (
    p_merchant_account_id, v_shop_id, p_product_id, p_movement_type, p_qty,
    p_unit_cost, p_reason, p_order_id, p_transition_id, p_idempotency_key,
    p_created_by, p_driver_id
  ) on conflict (idempotency_key) do nothing
  returning id into v_movement_id;

  if v_movement_id is null then
    return null;
  end if;

  if p_movement_type in (
       'order_assignment_commit', 'order_assignment_release',
       'allocate_to_courier', 'courier_return_lot', 'driver_stock_set'
     )
  then
    return v_movement_id;
  end if;

  insert into public.product_stock (product_id, merchant_account_id, shop_id)
  values (p_product_id, p_merchant_account_id, v_shop_id)
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
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);
      v_new_reserved := greatest(0, v_stock.qty_reserved + p_qty);
      update public.stock_movement set unit_cost = v_stock.unit_cost where id = v_movement_id;
    when 'advance_commit' then
      v_new_reserved := greatest(0, v_stock.qty_reserved - greatest(p_qty, 0));
    when 'sold' then
      update public.stock_movement set unit_cost = v_stock.unit_cost where id = v_movement_id;
    when 'purchase_in' then
      if (p_received_value is not null or p_unit_cost is not null)
         and (v_stock.qty_on_hand + p_qty) > 0
      then
        v_cump_numerator := v_stock.qty_on_hand::numeric * v_stock.unit_cost::numeric
          + coalesce(p_received_value::numeric, p_qty::numeric * p_unit_cost::numeric);
        v_new_unit_cost := (v_cump_numerator / (v_stock.qty_on_hand + p_qty))::bigint;
      end if;
      v_new_on_hand := v_stock.qty_on_hand + p_qty;
    when 'courier_return' then
      v_new_on_hand := v_stock.qty_on_hand + p_qty;
    when 'reassign_from_driver' then
      v_new_on_hand := v_stock.qty_on_hand + p_qty;
    when 'reassign_to_driver' then
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);
      update public.stock_movement set unit_cost = v_stock.unit_cost where id = v_movement_id;
    when 'manual_adjustment' then
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);
    else
      raise exception 'unknown stock movement_type: %', p_movement_type using errcode = 'P0001';
  end case;

  update public.product_stock
     set qty_on_hand = v_new_on_hand,
         qty_reserved = v_new_reserved,
         unit_cost = v_new_unit_cost,
         updated_at = now()
   where product_id = p_product_id;

  return v_movement_id;
end;
$function$;

-- Public human capability.  The received shop validates the request but never
-- determines the stored shop: the engine derives that value from the product.
create function public.post_stock_movement(
  p_merchant_account_id uuid,
  p_product_id uuid,
  p_movement_type text,
  p_qty integer,
  p_idempotency_key text,
  p_expected_shop_id uuid,
  p_created_by uuid,
  p_order_id uuid default null::uuid,
  p_transition_id uuid default null::uuid,
  p_unit_cost bigint default null::bigint,
  p_received_value bigint default null::bigint,
  p_reason text default null::text,
  p_driver_id uuid default null::uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_shop_id uuid;
  v_role text;
  v_actor uuid;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_role := public.current_shop_role(p_expected_shop_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_movement_type not in (
    'purchase_in', 'manual_adjustment', 'courier_return', 'driver_stock_set'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_created_by is not null and p_created_by <> v_actor then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select p.shop_id into v_shop_id
    from public.product p
   where p.id = p_product_id
     and p.merchant_account_id = p_merchant_account_id;

  if not found then
    raise exception 'product not found for this merchant account' using errcode = 'P0002';
  end if;

  if v_shop_id <> p_expected_shop_id then
    raise exception 'stock_movement_expected_shop_conflict' using errcode = 'P0001';
  end if;

  return public.post_stock_movement(
    p_merchant_account_id := p_merchant_account_id,
    p_product_id          := p_product_id,
    p_movement_type       := p_movement_type,
    p_qty                 := p_qty,
    p_idempotency_key     := p_idempotency_key,
    p_created_by          := v_actor,
    p_order_id            := p_order_id,
    p_transition_id       := p_transition_id,
    p_unit_cost           := p_unit_cost,
    p_received_value      := p_received_value,
    p_reason              := p_reason,
    p_driver_id           := p_driver_id
  );
end;
$function$;

-- The engine has no authenticated entry point.  Its service-role grant is
-- intentional and limited to internal seeds and engine-guard tests.
revoke all on function public.post_stock_movement(
  uuid, uuid, text, integer, text, uuid, uuid, uuid, bigint, bigint, text, uuid
) from public, anon, authenticated;
grant execute on function public.post_stock_movement(
  uuid, uuid, text, integer, text, uuid, uuid, uuid, bigint, bigint, text, uuid
) to service_role;

revoke all on function public.post_stock_movement(
  uuid, uuid, text, integer, text, uuid, uuid, uuid, uuid, bigint, bigint, text, uuid
) from public, anon, service_role;
grant execute on function public.post_stock_movement(
  uuid, uuid, text, integer, text, uuid, uuid, uuid, uuid, bigint, bigint, text, uuid
) to authenticated;
