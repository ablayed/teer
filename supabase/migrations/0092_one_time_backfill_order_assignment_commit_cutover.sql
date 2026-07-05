-- 0092 : Lot 2 / PR 1 - one-time cutover backfill for driver availability
--
-- One-time data migration.
-- `created_by` is a required FK to auth.users for stock_movement.
-- No dedicated system user exists in this project; we therefore use the oldest
-- available merchant member only as a technical backfill actor.
-- The movement was not manually created by that user.
-- Real origin is tracked by idempotency_key prefix:
--   backfill_cutover:order_assignment_commit:%
-- and by stock_movement.reason.
--
-- Rollback by DELETE on `backfill_cutover:%` is allowed only in the immediate
-- post-deploy window, before any real transition on a backfilled order.
-- After real traffic, do not DELETE historical rows retroactively:
-- use a corrective migration instead, because releases may already
-- depend on these commits.

do $$
declare
  v_missing_actor_merchant uuid;
  v_invalid_driver_order uuid;
begin
  -- Fail before any write if an assigned driver does not belong to the same
  -- merchant as the candidate order. orders.assigned_driver_id has no FK tenant
  -- guarantee, while post_stock_movement normally enforces this guard.
  select o.id
    into v_invalid_driver_order
    from public.orders o
   where o.assigned_driver_id is not null
     and (
       (o.order_state = 'open' and o.delivery_state in ('assigned', 'out_for_delivery'))
       or (o.order_state = 'completed' and o.delivery_state = 'delivered')
     )
     and not exists (
       select 1
         from public.driver d
        where d.id = o.assigned_driver_id
          and d.merchant_account_id = o.merchant_account_id
     )
   limit 1;

  if v_invalid_driver_order is not null then
    raise exception 'order_assignment backfill assigned_driver_id tenant mismatch for order_id %',
      v_invalid_driver_order
      using errcode = 'P0001';
  end if;

  -- Fail before any write if a candidate merchant has no member usable as the
  -- technical `created_by` actor.
  with candidate_orders as (
    select distinct o.merchant_account_id
      from public.orders o
     where o.assigned_driver_id is not null
       and (
         (o.order_state = 'open' and o.delivery_state in ('assigned', 'out_for_delivery'))
         or (o.order_state = 'completed' and o.delivery_state = 'delivered')
       )
  ),
  actor_by_merchant as (
    select distinct on (mm.merchant_account_id)
      mm.merchant_account_id,
      mm.user_id as created_by
    from public.merchant_member mm
    order by
      mm.merchant_account_id,
      case mm.role when 'owner' then 0 when 'manager' then 1 else 2 end,
      mm.created_at asc,
      mm.user_id asc
  )
  select co.merchant_account_id
    into v_missing_actor_merchant
    from candidate_orders co
   where not exists (
     select 1
       from actor_by_merchant abm
      where abm.merchant_account_id = co.merchant_account_id
   )
   limit 1;

  if v_missing_actor_merchant is not null then
    raise exception 'order_assignment backfill missing technical actor for merchant_account_id %',
      v_missing_actor_merchant
      using errcode = 'P0001';
  end if;

  -- Direct insert is intentional for this one-time migration: post_stock_movement
  -- requires current_member_role(auth.uid()), which is not available while running
  -- a migration. The two new movement types have no product_stock side effect, so
  -- preserving the ledger constraints, tenant joins and idempotency key is enough.
  with candidate_orders as (
    select
      o.merchant_account_id,
      o.id as order_id,
      o.assigned_driver_id,
      o.delivery_state
    from public.orders o
    where o.assigned_driver_id is not null
      and (
        (o.order_state = 'open' and o.delivery_state in ('assigned', 'out_for_delivery'))
        or (o.order_state = 'completed' and o.delivery_state = 'delivered')
      )
  ),
  grouped_lines as (
    select
      co.merchant_account_id,
      co.order_id,
      co.assigned_driver_id,
      co.delivery_state,
      ol.product_id,
      sum(ol.qty)::integer as qty
    from candidate_orders co
    join public.order_line ol
      on ol.order_id = co.order_id
     and ol.merchant_account_id = co.merchant_account_id
     and ol.match_status = 'matched'
     and ol.product_id is not null
    group by
      co.merchant_account_id,
      co.order_id,
      co.assigned_driver_id,
      co.delivery_state,
      ol.product_id
  ),
  actor_by_merchant as (
    select distinct on (mm.merchant_account_id)
      mm.merchant_account_id,
      mm.user_id as created_by
    from public.merchant_member mm
    order by
      mm.merchant_account_id,
      case mm.role when 'owner' then 0 when 'manager' then 1 else 2 end,
      mm.created_at asc,
      mm.user_id asc
  ),
  rows_to_insert as (
    select
      gl.merchant_account_id,
      gl.order_id,
      gl.assigned_driver_id,
      gl.product_id,
      gl.qty,
      abm.created_by,
      'backfill_cutover:order_assignment_commit:'
        || gl.order_id::text || ':' || gl.product_id::text as idempotency_key
    from grouped_lines gl
    join actor_by_merchant abm
      on abm.merchant_account_id = gl.merchant_account_id
    where not exists (
      select 1
        from public.stock_movement sm
       where sm.merchant_account_id = gl.merchant_account_id
         and sm.order_id = gl.order_id
         and sm.product_id = gl.product_id
         and sm.driver_id = gl.assigned_driver_id
         and sm.movement_type = 'order_assignment_commit'
    )
  )
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
  select
    rti.merchant_account_id,
    rti.product_id,
    'order_assignment_commit',
    rti.qty,
    null,
    'Technical backfill: order_assignment_commit cutover. Not manually created by this user.',
    rti.order_id,
    null,
    rti.idempotency_key,
    rti.created_by,
    rti.assigned_driver_id
  from rows_to_insert rti
  on conflict (idempotency_key) do nothing;
end;
$$;
