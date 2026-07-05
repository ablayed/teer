-- 0091 : Lot 2 / PR 1 - order assignment availability ledger
--
-- Adds the live ledger writes for driver available stock:
--   order_assignment_commit  : qty > 0, consumes driver availability
--   order_assignment_release : qty < 0, restores driver availability
--
-- The existing physical/finance movement types remain unchanged:
-- dispatch, sold, courier_return, allocate_to_courier, advance_commit and
-- reassign_from_driver/reassign_to_driver keep their current semantics.

-- ---------------------------------------------------------------------------
-- post_stock_movement: accept logical order-assignment movements.
-- These movements are ledger-only and intentionally do not mutate product_stock.
-- ---------------------------------------------------------------------------
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

  if p_movement_type in ('order_assignment_commit', 'order_assignment_release') then
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

    when 'allocate_to_courier' then
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);
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

    when 'courier_return_lot' then
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

-- ---------------------------------------------------------------------------
-- transition_order: keep physical movements unchanged, add availability ledger.
-- ---------------------------------------------------------------------------
create or replace function public.transition_order(
  p_order_id              uuid,
  p_actor                 uuid,
  p_note                  text         default null,
  p_payment_channel       text         default 'ESPECES',
  p_order_state           text         default null,
  p_call_state            text         default null,
  p_delivery_state        text         default null,
  p_cash_state            text         default null,
  p_attempt_count         integer      default null,
  p_next_contact_at       timestamptz  default null,
  p_scheduled_for         timestamptz  default null,
  p_cancel_reason         text         default null,
  p_assigned_driver_id    uuid         default null,
  p_cancel_reasons        text[]       default null,
  p_clear_scheduled_for   boolean      default false,
  p_clear_cancel_reasons  boolean      default false,
  p_clear_assigned_driver boolean      default false
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order                     public.orders%rowtype;
  v_next_cash_state           text;
  v_next_delivery_state       text;
  v_next_order_state          text;
  v_next_status               text;
  v_payment_channel           text;
  v_transition_id             uuid;
  v_movement_type             text;
  v_effective_driver_id       uuid;
  v_cash_reversal_minor       bigint := 0;
  v_cash_reversal_method      text;
  v_cash_reversal_settlement  uuid;
  v_line                      record;
  v_assignment_line           record;
  v_assignment_release        record;
  v_advance_avail             integer;
  v_cover                     integer;
  v_remainder                 integer;
begin
  select *
    into v_order
    from public.orders
   where id = p_order_id
     for update;

  if not found then
    raise exception 'order_not_found'
      using errcode = 'P0002';
  end if;

  v_payment_channel     := coalesce(p_payment_channel, 'ESPECES');
  v_next_order_state    := coalesce(p_order_state,    v_order.order_state);
  v_next_delivery_state := coalesce(p_delivery_state, v_order.delivery_state);
  v_next_cash_state     := coalesce(p_cash_state,     v_order.cash_state);
  v_effective_driver_id := coalesce(p_assigned_driver_id, v_order.assigned_driver_id);

  if v_next_delivery_state = 'delivered'
     and v_next_cash_state = 'collected'
     and v_payment_channel not in (
       'ESPECES', 'WAVE', 'ORANGE_MONEY', 'FREE_MONEY', 'INCONNU'
     )
  then
    raise exception 'invalid_payment_channel'
      using errcode = '22023';
  end if;

  if v_next_order_state = 'returned' or v_next_delivery_state = 'returned' then
    if not (
      v_order.order_state = 'completed'
      and v_order.delivery_state = 'delivered'
      and v_next_order_state = 'returned'
      and v_next_delivery_state = 'returned'
    ) then
      raise exception 'illegal_return_transition'
        using errcode = '22023';
    end if;
  end if;

  update public.orders
     set order_state    = coalesce(p_order_state,        order_state),
         call_state     = coalesce(p_call_state,          call_state),
         delivery_state = coalesce(p_delivery_state,      delivery_state),
         cash_state     = coalesce(p_cash_state,          cash_state),
         attempt_count  = coalesce(p_attempt_count,       attempt_count),
         next_contact_at = coalesce(p_next_contact_at,    next_contact_at),
         scheduled_for  = case
           when p_clear_scheduled_for then null
           else coalesce(p_scheduled_for, scheduled_for)
         end,
         cancel_reason  = case
           when p_clear_cancel_reasons then null
           when p_cancel_reasons is not null then p_cancel_reasons[1]
           else coalesce(p_cancel_reason, cancel_reason)
         end,
         cancel_reasons = case
           when p_clear_cancel_reasons then null
           else coalesce(p_cancel_reasons, cancel_reasons)
         end,
         assigned_driver_id = case
           when p_clear_assigned_driver then null
           else coalesce(p_assigned_driver_id, assigned_driver_id)
         end,
         payment_channel_at_delivery = case
           when v_next_delivery_state = 'delivered'
                and v_next_cash_state = 'collected'
             then v_payment_channel
           else payment_channel_at_delivery
         end,
         cash_collectable_minor = case
           when v_next_delivery_state <> 'delivered'
                or v_next_cash_state <> 'collected'
             then cash_collectable_minor
           when v_payment_channel in ('WAVE', 'ORANGE_MONEY', 'FREE_MONEY')
             then 0
           else round(total_amount)::bigint
         end,
         cash_collected_at = case
           when v_next_delivery_state = 'delivered'
                and v_next_cash_state = 'collected'
                and cash_collected_at is null
             then now()
           else cash_collected_at
         end,
         returned_at = case
           when p_order_state = 'returned'
                and v_order.order_state <> 'returned'
                and returned_at is null
             then now()
           else returned_at
         end,
         updated_at = now()
   where id = p_order_id
   returning cod_status into v_next_status;

  insert into public.order_state_transition (
    merchant_account_id,
    order_id,
    from_status,
    to_status,
    actor_user_id,
    note,
    created_at
  )
  values (
    v_order.merchant_account_id,
    v_order.id,
    v_order.cod_status,
    v_next_status,
    p_actor,
    p_note,
    now()
  )
  returning id into v_transition_id;

  if v_order.order_state = 'completed'
     and v_order.delivery_state = 'delivered'
     and v_next_order_state = 'returned'
     and v_next_delivery_state = 'returned'
  then
    select coalesce(sum(sa.allocated_minor), 0)
      into v_cash_reversal_minor
      from public.settlement_allocation sa
     where sa.order_id = v_order.id
       and sa.merchant_account_id = v_order.merchant_account_id;

    if v_cash_reversal_minor > 0 then
      if v_effective_driver_id is null then
        raise exception 'missing_driver_for_cash_reversal'
          using errcode = '22023';
      end if;

      v_cash_reversal_method := case
        when v_order.payment_channel_at_delivery in (
          'ESPECES', 'WAVE', 'ORANGE_MONEY', 'FREE_MONEY'
        )
          then v_order.payment_channel_at_delivery
        else 'ESPECES'
      end;

      insert into public.cash_settlement (
        merchant_account_id,
        driver_id,
        amount_received_minor,
        method,
        note,
        settled_at,
        created_by,
        client_request_id
      )
      values (
        v_order.merchant_account_id,
        v_effective_driver_id,
        -v_cash_reversal_minor,
        v_cash_reversal_method,
        'Reprise retour commande ' || coalesce(v_order.order_number, v_order.id::text),
        now(),
        p_actor,
        v_transition_id
      )
      returning id into v_cash_reversal_settlement;

      insert into public.settlement_allocation (
        settlement_id,
        order_id,
        allocated_minor,
        merchant_account_id
      )
      values (
        v_cash_reversal_settlement,
        v_order.id,
        -v_cash_reversal_minor,
        v_order.merchant_account_id
      );
    end if;
  end if;

  v_movement_type := case
    when v_next_delivery_state in ('assigned', 'out_for_delivery')
         and v_order.delivery_state not in (
           'assigned', 'out_for_delivery', 'delivered', 'failed', 'returned'
         )
      then 'dispatch'

    when v_next_delivery_state = 'delivered'
         and v_order.delivery_state <> 'delivered'
      then 'sold'

    when v_next_order_state = 'returned'
         and v_next_delivery_state = 'returned'
         and v_order.order_state = 'completed'
         and v_order.delivery_state = 'delivered'
      then 'courier_return'

    when coalesce(p_call_state, v_order.call_state) = 'validated'
         and v_order.call_state <> 'validated'
         and v_next_delivery_state in ('unassigned', 'scheduled')
      then 'reserve'

    when coalesce(p_call_state, v_order.call_state) = 'to_call'
         and v_order.call_state = 'validated'
         and v_order.order_state = 'open'
         and v_order.delivery_state in ('unassigned', 'scheduled')
      then 'release'

    when v_next_order_state in ('cancelled', 'returned')
         and v_order.order_state not in ('cancelled', 'returned')
         and v_order.delivery_state in ('unassigned', 'scheduled')
      then 'release'

    else null
  end;

  if v_movement_type is not null then
    for v_line in
      select ol.id, ol.product_id, ol.qty
        from public.order_line ol
       where ol.order_id  = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id   is not null
    loop
      if v_movement_type = 'dispatch' then
        select greatest(0,
            coalesce(sum(case when sm.movement_type = 'allocate_to_courier' then -sm.qty else 0 end), 0)
          - coalesce(sum(case when sm.movement_type = 'courier_return_lot'   then  sm.qty else 0 end), 0)
          - coalesce(sum(case when sm.movement_type = 'advance_commit'       then  sm.qty else 0 end), 0)
        )
          into v_advance_avail
          from public.stock_movement sm
         where sm.merchant_account_id = v_order.merchant_account_id
           and sm.product_id = v_line.product_id
           and sm.driver_id  = v_effective_driver_id;

        v_cover     := least(v_line.qty, coalesce(v_advance_avail, 0));
        v_remainder := v_line.qty - v_cover;

        if v_cover > 0 then
          perform public.post_stock_movement(
            p_merchant_account_id := v_order.merchant_account_id,
            p_product_id          := v_line.product_id,
            p_movement_type       := 'advance_commit',
            p_qty                 := v_cover,
            p_idempotency_key     := v_transition_id::text
                                     || ':' || v_line.id::text
                                     || ':advance_commit',
            p_created_by          := p_actor,
            p_order_id            := p_order_id,
            p_transition_id       := v_transition_id,
            p_driver_id           := v_effective_driver_id
          );
        end if;

        if v_remainder > 0 then
          perform public.post_stock_movement(
            p_merchant_account_id := v_order.merchant_account_id,
            p_product_id          := v_line.product_id,
            p_movement_type       := 'dispatch',
            p_qty                 := -v_remainder,
            p_idempotency_key     := v_transition_id::text
                                     || ':' || v_line.id::text
                                     || ':dispatch',
            p_created_by          := p_actor,
            p_order_id            := p_order_id,
            p_transition_id       := v_transition_id,
            p_driver_id           := v_effective_driver_id
          );
        end if;

      else
        perform public.post_stock_movement(
          p_merchant_account_id := v_order.merchant_account_id,
          p_product_id          := v_line.product_id,
          p_movement_type       := v_movement_type,
          p_qty                 := case
                                     when v_movement_type = 'release'
                                       then -v_line.qty
                                     else v_line.qty
                                   end,
          p_idempotency_key     := v_transition_id::text
                                   || ':' || v_line.id::text
                                   || ':' || v_movement_type,
          p_created_by          := p_actor,
          p_order_id            := p_order_id,
          p_transition_id       := v_transition_id,
          p_driver_id           := v_effective_driver_id
        );
      end if;
    end loop;
  end if;

  -- Availability commit is grouped by product because order_line does not have
  -- a unique (order_id, product_id) constraint.
  if v_movement_type = 'dispatch' then
    for v_assignment_line in
      select ol.product_id, sum(ol.qty)::integer as qty
        from public.order_line ol
       where ol.order_id = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id is not null
       group by ol.product_id
    loop
      perform public.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_assignment_line.product_id,
        p_movement_type       := 'order_assignment_commit',
        p_qty                 := v_assignment_line.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_assignment_line.product_id::text
                                 || ':order_assignment_commit',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := v_effective_driver_id
      );
    end loop;
  end if;

  -- Availability releases are targeted from the ledger, not from orders.assigned_driver_id.
  -- The release quantity is capped to min(required_qty, net_open) per product+driver.
  if v_next_order_state in ('cancelled', 'returned')
     and v_order.order_state not in ('cancelled', 'returned')
  then
    for v_assignment_release in
      with required as (
        select ol.product_id, sum(ol.qty)::integer as required_qty
          from public.order_line ol
         where ol.order_id = p_order_id
           and ol.match_status = 'matched'
           and ol.product_id is not null
         group by ol.product_id
      ),
      open_commitments as (
        select sm.product_id,
               sm.driver_id,
               sum(case
                 when sm.movement_type = 'order_assignment_commit' then sm.qty
                 when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
                 else 0
               end)::integer as net_open
          from public.stock_movement sm
         where sm.merchant_account_id = v_order.merchant_account_id
           and sm.order_id = p_order_id
           and sm.driver_id is not null
           and sm.movement_type in ('order_assignment_commit', 'order_assignment_release')
         group by sm.product_id, sm.driver_id
        having sum(case
          when sm.movement_type = 'order_assignment_commit' then sm.qty
          when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
          else 0
        end) > 0
      )
      select oc.product_id,
             oc.driver_id,
             least(r.required_qty, oc.net_open)::integer as qty
        from open_commitments oc
        join required r on r.product_id = oc.product_id
       where least(r.required_qty, oc.net_open) > 0
    loop
      perform public.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_assignment_release.product_id,
        p_movement_type       := 'order_assignment_release',
        p_qty                 := -v_assignment_release.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_assignment_release.product_id::text
                                 || ':' || v_assignment_release.driver_id::text
                                 || ':order_assignment_release',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := v_assignment_release.driver_id
      );
    end loop;
  end if;

  if p_clear_assigned_driver then
    for v_line in
      select sm.product_id,
             sm.driver_id,
             sum(sm.qty)::integer as committed
        from public.stock_movement sm
       where sm.order_id = p_order_id
         and sm.merchant_account_id = v_order.merchant_account_id
         and sm.movement_type = 'advance_commit'
         and sm.driver_id is not null
       group by sm.product_id, sm.driver_id
      having sum(sm.qty) <> 0
    loop
      perform public.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_line.product_id,
        p_movement_type       := 'advance_commit',
        p_qty                 := -v_line.committed,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_line.product_id::text
                                 || ':' || v_line.driver_id::text
                                 || ':advance_commit_reversal',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := v_line.driver_id
      );
    end loop;
  end if;

  return v_next_status;
end;
$$;

revoke all on function public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid,
  text[], boolean, boolean, boolean
) from public, anon;

grant execute on function public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid,
  text[], boolean, boolean, boolean
) to authenticated;

-- ---------------------------------------------------------------------------
-- reassign_order_driver: keep physical pair unchanged and move availability.
-- ---------------------------------------------------------------------------
create or replace function public.reassign_order_driver(
  p_order_id   uuid,
  p_actor      uuid,
  p_new_driver uuid,
  p_note       text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order              public.orders%rowtype;
  v_old_driver         uuid;
  v_transition_id      uuid;
  v_line               record;
  v_assignment_line    record;
  v_assignment_release record;
begin
  if p_new_driver is null then
    raise exception 'reassign_requires_driver'
      using errcode = '22023';
  end if;

  select *
    into v_order
    from public.orders
   where id = p_order_id
   for update;

  if not found then
    raise exception 'order_not_found'
      using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.driver
    where id = p_new_driver
      and merchant_account_id = v_order.merchant_account_id
  ) then
    raise exception 'driver not found for this merchant account'
      using errcode = 'P0002';
  end if;

  if v_order.delivery_state not in ('scheduled', 'assigned', 'out_for_delivery') then
    raise exception 'reassign_not_allowed_in_state'
      using errcode = '22023';
  end if;

  v_old_driver := v_order.assigned_driver_id;

  if v_old_driver is not distinct from p_new_driver then
    return;
  end if;

  update public.orders
     set assigned_driver_id = p_new_driver,
         updated_at         = now()
   where id = p_order_id;

  insert into public.order_state_transition (
    merchant_account_id,
    order_id,
    from_status,
    to_status,
    actor_user_id,
    note,
    created_at
  )
  values (
    v_order.merchant_account_id,
    v_order.id,
    v_order.cod_status,
    v_order.cod_status,
    p_actor,
    coalesce(p_note, 'Reassignation livreur'),
    now()
  )
  returning id into v_transition_id;

  if v_order.delivery_state in ('assigned', 'out_for_delivery') then
    if v_old_driver is null then
      raise exception 'reassign_missing_outgoing_driver'
        using errcode = '22023';
    end if;

    for v_line in
      select ol.id, ol.product_id, ol.qty
        from public.order_line ol
       where ol.order_id     = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id   is not null
    loop
      perform public.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_line.product_id,
        p_movement_type       := 'reassign_from_driver',
        p_qty                 := v_line.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_line.id::text
                                 || ':reassign_from',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := v_old_driver
      );

      perform public.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_line.product_id,
        p_movement_type       := 'reassign_to_driver',
        p_qty                 := -v_line.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_line.id::text
                                 || ':reassign_to',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := p_new_driver
      );
    end loop;

    for v_assignment_release in
      with required as (
        select ol.product_id, sum(ol.qty)::integer as required_qty
          from public.order_line ol
         where ol.order_id = p_order_id
           and ol.match_status = 'matched'
           and ol.product_id is not null
         group by ol.product_id
      ),
      open_commitments as (
        select sm.product_id,
               sm.driver_id,
               sum(case
                 when sm.movement_type = 'order_assignment_commit' then sm.qty
                 when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
                 else 0
               end)::integer as net_open
          from public.stock_movement sm
         where sm.merchant_account_id = v_order.merchant_account_id
           and sm.order_id = p_order_id
           and sm.driver_id is not null
           and sm.driver_id = v_old_driver
           and sm.movement_type in ('order_assignment_commit', 'order_assignment_release')
         group by sm.product_id, sm.driver_id
        having sum(case
          when sm.movement_type = 'order_assignment_commit' then sm.qty
          when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
          else 0
        end) > 0
      )
      select oc.product_id,
             oc.driver_id,
             least(r.required_qty, oc.net_open)::integer as qty
        from open_commitments oc
        join required r on r.product_id = oc.product_id
       where least(r.required_qty, oc.net_open) > 0
    loop
      perform public.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_assignment_release.product_id,
        p_movement_type       := 'order_assignment_release',
        p_qty                 := -v_assignment_release.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_assignment_release.product_id::text
                                 || ':' || v_assignment_release.driver_id::text
                                 || ':order_assignment_release',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := v_assignment_release.driver_id
      );
    end loop;

    for v_assignment_line in
      select ol.product_id, sum(ol.qty)::integer as qty
        from public.order_line ol
       where ol.order_id = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id is not null
       group by ol.product_id
    loop
      perform public.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_assignment_line.product_id,
        p_movement_type       := 'order_assignment_commit',
        p_qty                 := v_assignment_line.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_assignment_line.product_id::text
                                 || ':order_assignment_commit',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := p_new_driver
      );
    end loop;
  end if;
end;
$$;

grant execute on function public.reassign_order_driver(uuid, uuid, uuid, text)
  to authenticated;
