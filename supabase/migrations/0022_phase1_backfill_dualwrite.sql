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
  if p_order_state = 'cancelled' then
    return 'ANNULEE';
  end if;

  if p_order_state = 'returned' then
    return 'REFUSEE';
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

update public.orders
set
  order_state = case cod_status
    when 'A_APPELER' then 'open'
    when 'TENTEE' then 'open'
    when 'CONFIRMEE' then 'open'
    when 'PROGRAMMEE' then 'open'
    when 'EN_LIVRAISON' then 'open'
    when 'LIVREE' then 'completed'
    when 'REFUSEE' then 'cancelled'
    when 'ANNULEE' then 'cancelled'
    else order_state
  end,
  call_state = case cod_status
    when 'A_APPELER' then 'to_call'
    when 'TENTEE' then 'callback'
    when 'CONFIRMEE' then 'validated'
    when 'PROGRAMMEE' then 'validated'
    when 'EN_LIVRAISON' then 'validated'
    when 'LIVREE' then 'validated'
    when 'REFUSEE' then 'validated'
    when 'ANNULEE' then coalesce(call_state, 'validated')
    else call_state
  end,
  delivery_state = case cod_status
    when 'A_APPELER' then 'unassigned'
    when 'TENTEE' then 'unassigned'
    when 'CONFIRMEE' then 'unassigned'
    when 'PROGRAMMEE' then 'scheduled'
    when 'EN_LIVRAISON' then 'assigned'
    when 'LIVREE' then 'delivered'
    when 'REFUSEE' then 'failed'
    when 'ANNULEE' then 'unassigned'
    else delivery_state
  end,
  cash_state = case cod_status
    when 'A_APPELER' then 'not_due'
    when 'TENTEE' then 'not_due'
    when 'CONFIRMEE' then 'not_due'
    when 'PROGRAMMEE' then 'expected'
    when 'EN_LIVRAISON' then 'expected'
    when 'LIVREE' then 'collected'
    when 'REFUSEE' then 'not_due'
    when 'ANNULEE' then 'not_due'
    else cash_state
  end,
  attempt_count = case cod_status
    when 'TENTEE' then greatest(coalesce(attempt_count, 0), 1)
    else coalesce(attempt_count, 0)
  end,
  next_contact_at = next_contact_at,
  scheduled_for = case
    when cod_status = 'PROGRAMMEE' then scheduled_for
    else scheduled_for
  end,
  cancel_reason = case cod_status
    when 'REFUSEE' then coalesce(cancel_reason, 'refused')
    when 'ANNULEE' then coalesce(cancel_reason, 'cancelled')
    else cancel_reason
  end
where order_state is null;

create or replace function public.orders_sync_legacy_cod_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.order_state := coalesce(new.order_state, old.order_state, 'open');
  new.call_state := coalesce(new.call_state, old.call_state, 'to_call');
  new.delivery_state := coalesce(new.delivery_state, old.delivery_state, 'unassigned');
  new.cash_state := coalesce(new.cash_state, old.cash_state, 'not_due');
  new.attempt_count := coalesce(new.attempt_count, old.attempt_count, 0);
  new.next_contact_at := coalesce(new.next_contact_at, old.next_contact_at);
  new.scheduled_for := coalesce(new.scheduled_for, old.scheduled_for);
  new.cancel_reason := coalesce(new.cancel_reason, old.cancel_reason);
  new.cod_status := public.derive_legacy_cod_status(
    new.order_state,
    new.call_state,
    new.delivery_state,
    new.cash_state
  );

  return new;
end;
$$;

drop trigger if exists orders_sync_legacy_cod_status on public.orders;

create trigger orders_sync_legacy_cod_status
before insert or update on public.orders
for each row
execute function public.orders_sync_legacy_cod_status();
