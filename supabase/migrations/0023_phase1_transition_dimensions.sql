create or replace function public.derive_legacy_cod_status(
  p_order_state text,
  p_call_state text,
  p_delivery_state text,
  p_cash_state text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_delivery_state in ('failed', 'returned') then
    return 'REFUSEE';
  end if;

  if p_order_state = 'returned' then
    return 'REFUSEE';
  end if;

  if p_order_state = 'cancelled' then
    return 'ANNULEE';
  end if;

  if p_delivery_state = 'delivered' then
    return 'LIVREE';
  end if;

  if p_delivery_state in ('out_for_delivery', 'assigned') then
    return 'EN_LIVRAISON';
  end if;

  if p_delivery_state = 'scheduled' then
    return 'PROGRAMMEE';
  end if;

  if p_call_state = 'validated' then
    return 'CONFIRMEE';
  end if;

  if p_call_state = 'callback' then
    return 'TENTEE';
  end if;

  return 'A_APPELER';
end;
$$;

create or replace function public.transition_order(
  p_order_id uuid,
  p_actor uuid,
  p_note text default null,
  p_payment_channel text default 'ESPECES',
  p_order_state text default null,
  p_call_state text default null,
  p_delivery_state text default null,
  p_cash_state text default null,
  p_attempt_count integer default null,
  p_next_contact_at timestamptz default null,
  p_scheduled_for timestamptz default null,
  p_cancel_reason text default null,
  p_assigned_driver_id uuid default null
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_next_cash_state text;
  v_next_delivery_state text;
  v_next_status text;
  v_payment_channel text;
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

  v_payment_channel := coalesce(p_payment_channel, 'ESPECES');
  v_next_delivery_state := coalesce(p_delivery_state, v_order.delivery_state);
  v_next_cash_state := coalesce(p_cash_state, v_order.cash_state);

  if v_next_delivery_state = 'delivered' and v_next_cash_state = 'collected' and v_payment_channel not in (
    'ESPECES',
    'WAVE',
    'ORANGE_MONEY',
    'FREE_MONEY',
    'INCONNU'
  ) then
    raise exception 'invalid_payment_channel'
      using errcode = '22023';
  end if;

  update public.orders
  set
    order_state = coalesce(p_order_state, order_state),
    call_state = coalesce(p_call_state, call_state),
    delivery_state = coalesce(p_delivery_state, delivery_state),
    cash_state = coalesce(p_cash_state, cash_state),
    attempt_count = coalesce(p_attempt_count, attempt_count),
    next_contact_at = coalesce(p_next_contact_at, next_contact_at),
    scheduled_for = coalesce(p_scheduled_for, scheduled_for),
    cancel_reason = coalesce(p_cancel_reason, cancel_reason),
    assigned_driver_id = coalesce(p_assigned_driver_id, assigned_driver_id),
    payment_channel_at_delivery = case
      when v_next_delivery_state = 'delivered' and v_next_cash_state = 'collected'
        then v_payment_channel
      else payment_channel_at_delivery
    end,
    cash_collectable_minor = case
      when v_next_delivery_state <> 'delivered' or v_next_cash_state <> 'collected'
        then cash_collectable_minor
      when v_payment_channel in ('WAVE', 'ORANGE_MONEY', 'FREE_MONEY')
        then 0
      else round(total_amount)::bigint
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
  );

  return v_next_status;
end;
$$;
