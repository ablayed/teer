create or replace function public.transition_order(
  p_order_id uuid,
  p_to text,
  p_actor uuid,
  p_note text default null,
  p_payment_channel text default 'ESPECES'
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
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

  if p_to = 'LIVREE' and v_payment_channel not in (
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
    cod_status = p_to,
    payment_channel_at_delivery = case
      when p_to = 'LIVREE' then v_payment_channel
      else payment_channel_at_delivery
    end,
    cash_collectable_minor = case
      when p_to <> 'LIVREE' then cash_collectable_minor
      when v_payment_channel in ('WAVE', 'ORANGE_MONEY', 'FREE_MONEY') then 0
      else round(total_amount)::bigint
    end,
    updated_at = now()
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
    p_to,
    p_actor,
    p_note,
    now()
  );

  return p_to;
end;
$$;
