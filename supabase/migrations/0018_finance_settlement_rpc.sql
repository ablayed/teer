create or replace function public.record_cash_settlement(
  p_merchant uuid,
  p_driver uuid,
  p_amount_received_minor bigint,
  p_method text,
  p_note text,
  p_client_request_id uuid,
  p_allocations jsonb default null,
  p_actor uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_driver_id uuid;
  v_settlement_id uuid;
  v_existing_settlement public.cash_settlement%rowtype;
  v_allocated_minor bigint := 0;
  v_expected_minor bigint := 0;
  v_shortfall_id uuid;
  v_order record;
  v_allocation record;
  v_remaining bigint;
  v_alloc_minor bigint;
begin
  v_role := public.current_member_role(p_merchant);

  if v_role not in ('owner','manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if auth.uid() is null or p_actor is distinct from auth.uid() then
    raise exception 'invalid_actor'
      using errcode = '42501';
  end if;

  if p_amount_received_minor < 0 then
    raise exception 'invalid_amount'
      using errcode = '22023';
  end if;

  if p_method not in ('ESPECES','WAVE','ORANGE_MONEY','FREE_MONEY') then
    raise exception 'invalid_method'
      using errcode = '22023';
  end if;

  select id
  into v_driver_id
  from public.driver
  where id = p_driver
    and merchant_account_id = p_merchant
    and is_active = true;

  if v_driver_id is null then
    raise exception 'driver_not_found'
      using errcode = 'P0002';
  end if;

  select *
  into v_existing_settlement
  from public.cash_settlement
  where merchant_account_id = p_merchant
    and client_request_id = p_client_request_id
  limit 1;

  if v_existing_settlement.id is not null then
    select coalesce(sum(allocated_minor), 0)
    into v_allocated_minor
    from public.settlement_allocation
    where settlement_id = v_existing_settlement.id
      and merchant_account_id = p_merchant;

    select id
    into v_shortfall_id
    from public.settlement_shortfall
    where settlement_id = v_existing_settlement.id
      and merchant_account_id = p_merchant
    limit 1;

    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'settlementId', v_existing_settlement.id,
      'allocatedMinor', v_allocated_minor,
      'expectedMinor', null,
      'shortfallId', v_shortfall_id,
      'shortfallMinor', null
    );
  end if;

  insert into public.cash_settlement (
    merchant_account_id,
    driver_id,
    amount_received_minor,
    method,
    note,
    client_request_id,
    created_by
  )
  values (
    p_merchant,
    p_driver,
    p_amount_received_minor,
    p_method,
    nullif(trim(coalesce(p_note, '')), ''),
    p_client_request_id,
    p_actor
  )
  returning id into v_settlement_id;

  if p_allocations is not null and jsonb_array_length(p_allocations) > 0 then
    for v_allocation in
      select *
      from jsonb_to_recordset(p_allocations) as allocation(
        order_id uuid,
        allocated_minor bigint
      )
    loop
      if v_allocation.allocated_minor <= 0 then
        raise exception 'invalid_allocation'
          using errcode = '22023';
      end if;

      perform 1
      from public.orders o
      where o.id = v_allocation.order_id
        and o.merchant_account_id = p_merchant
        and o.assigned_driver_id = p_driver
        and o.cod_status = 'LIVREE'
        and coalesce(o.payment_channel_at_delivery, 'INCONNU') in ('ESPECES','INCONNU')
      for update of o;

      if not found then
        raise exception 'order_not_found'
          using errcode = 'P0002';
      end if;

      select
        o.id,
        greatest(
          coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
            - coalesce((
              select sum(sa.allocated_minor)
              from public.settlement_allocation sa
              where sa.order_id = o.id
                and sa.merchant_account_id = o.merchant_account_id
            ), 0),
          0
        ) as outstanding_minor
      into v_order
      from public.orders o
      where o.id = v_allocation.order_id
        and o.merchant_account_id = p_merchant;

      if v_allocation.allocated_minor > v_order.outstanding_minor then
        raise exception 'over_allocation'
          using errcode = '22023';
      end if;

      v_expected_minor := v_expected_minor + v_order.outstanding_minor;
      v_allocated_minor := v_allocated_minor + v_allocation.allocated_minor;

      if v_allocated_minor > p_amount_received_minor then
        raise exception 'allocated_exceeds_received'
          using errcode = '22023';
      end if;

      insert into public.settlement_allocation (
        settlement_id,
        order_id,
        allocated_minor,
        merchant_account_id
      )
      values (
        v_settlement_id,
        v_order.id,
        v_allocation.allocated_minor,
        p_merchant
      );
    end loop;
  else
    v_remaining := p_amount_received_minor;

    for v_order in
      select
        o.id,
        o.updated_at,
        coalesce((
          select max(ost.created_at)
          from public.order_state_transition ost
          where ost.order_id = o.id
            and ost.to_status = 'LIVREE'
        ), o.updated_at) as delivered_at,
        greatest(
          coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
            - coalesce((
              select sum(sa.allocated_minor)
              from public.settlement_allocation sa
              where sa.order_id = o.id
                and sa.merchant_account_id = o.merchant_account_id
            ), 0),
          0
        ) as outstanding_minor
      from public.orders o
      where o.merchant_account_id = p_merchant
        and o.assigned_driver_id = p_driver
        and o.cod_status = 'LIVREE'
        and coalesce(o.payment_channel_at_delivery, 'INCONNU') in ('ESPECES','INCONNU')
        and greatest(
          coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
            - coalesce((
              select sum(sa.allocated_minor)
              from public.settlement_allocation sa
              where sa.order_id = o.id
                and sa.merchant_account_id = o.merchant_account_id
            ), 0),
          0
        ) > 0
      order by delivered_at asc, o.updated_at asc, o.id
      for update of o
    loop
      v_expected_minor := v_expected_minor + v_order.outstanding_minor;
      v_alloc_minor := least(v_order.outstanding_minor, v_remaining);

      if v_alloc_minor > 0 then
        insert into public.settlement_allocation (
          settlement_id,
          order_id,
          allocated_minor,
          merchant_account_id
        )
        values (
          v_settlement_id,
          v_order.id,
          v_alloc_minor,
          p_merchant
        );

        v_allocated_minor := v_allocated_minor + v_alloc_minor;
        v_remaining := v_remaining - v_alloc_minor;
      end if;
    end loop;
  end if;

  if p_amount_received_minor < v_expected_minor then
    insert into public.settlement_shortfall (
      settlement_id,
      merchant_account_id,
      driver_id,
      expected_minor,
      received_minor
    )
    values (
      v_settlement_id,
      p_merchant,
      p_driver,
      v_expected_minor,
      p_amount_received_minor
    )
    returning id into v_shortfall_id;
  end if;

  insert into public.audit_log (
    merchant_account_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    payload
  )
  values (
    p_merchant,
    p_actor,
    'settlement_recorded',
    'cash_settlement',
    v_settlement_id,
    jsonb_build_object(
      'driverId', p_driver,
      'amountReceivedMinor', p_amount_received_minor,
      'allocatedMinor', v_allocated_minor,
      'expectedMinor', v_expected_minor,
      'method', p_method
    )
  );

  if v_shortfall_id is not null then
    insert into public.audit_log (
      merchant_account_id,
      actor_user_id,
      action,
      resource_type,
      resource_id,
      payload
    )
    values (
      p_merchant,
      p_actor,
      'shortfall_recorded',
      'settlement_shortfall',
      v_shortfall_id,
      jsonb_build_object(
        'driverId', p_driver,
        'expectedMinor', v_expected_minor,
        'receivedMinor', p_amount_received_minor,
        'shortfallMinor', v_expected_minor - p_amount_received_minor
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'settlementId', v_settlement_id,
    'allocatedMinor', v_allocated_minor,
    'expectedMinor', v_expected_minor,
    'shortfallId', v_shortfall_id,
    'shortfallMinor', greatest(v_expected_minor - p_amount_received_minor, 0)
  );
end;
$$;

revoke all on function public.record_cash_settlement(
  uuid,
  uuid,
  bigint,
  text,
  text,
  uuid,
  jsonb,
  uuid
) from public, anon;

grant execute on function public.record_cash_settlement(
  uuid,
  uuid,
  bigint,
  text,
  text,
  uuid,
  jsonb,
  uuid
) to authenticated;

create or replace function public.write_off_shortfall(
  p_merchant uuid,
  p_shortfall_id uuid,
  p_reason text,
  p_actor uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_shortfall public.settlement_shortfall%rowtype;
  v_settlement_id uuid;
  v_remaining bigint;
  v_allocated_minor bigint := 0;
  v_alloc_minor bigint;
  v_order record;
begin
  v_role := public.current_member_role(p_merchant);

  if v_role <> 'owner' then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if auth.uid() is null or p_actor is distinct from auth.uid() then
    raise exception 'invalid_actor'
      using errcode = '42501';
  end if;

  select *
  into v_shortfall
  from public.settlement_shortfall
  where id = p_shortfall_id
    and merchant_account_id = p_merchant
    and resolution = 'ROLLED_FORWARD'
  for update;

  if v_shortfall.id is null then
    raise exception 'shortfall_not_found'
      using errcode = 'P0002';
  end if;

  v_remaining := v_shortfall.shortfall_minor;

  insert into public.cash_settlement (
    merchant_account_id,
    driver_id,
    amount_received_minor,
    method,
    note,
    client_request_id,
    created_by
  )
  values (
    p_merchant,
    v_shortfall.driver_id,
    0,
    'ESPECES',
    nullif(trim(coalesce(p_reason, '')), ''),
    gen_random_uuid(),
    p_actor
  )
  returning id into v_settlement_id;

  for v_order in
    select
      o.id,
      o.updated_at,
      coalesce((
        select max(ost.created_at)
        from public.order_state_transition ost
        where ost.order_id = o.id
          and ost.to_status = 'LIVREE'
      ), o.updated_at) as delivered_at,
      greatest(
        coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
          - coalesce((
            select sum(sa.allocated_minor)
            from public.settlement_allocation sa
            where sa.order_id = o.id
              and sa.merchant_account_id = o.merchant_account_id
          ), 0),
        0
      ) as outstanding_minor
    from public.orders o
    where o.merchant_account_id = p_merchant
      and o.assigned_driver_id = v_shortfall.driver_id
      and o.cod_status = 'LIVREE'
      and coalesce(o.payment_channel_at_delivery, 'INCONNU') in ('ESPECES','INCONNU')
      and greatest(
        coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
          - coalesce((
            select sum(sa.allocated_minor)
            from public.settlement_allocation sa
            where sa.order_id = o.id
              and sa.merchant_account_id = o.merchant_account_id
          ), 0),
        0
      ) > 0
    order by delivered_at asc, o.updated_at asc, o.id
    for update of o
  loop
    exit when v_remaining <= 0;

    v_alloc_minor := least(v_order.outstanding_minor, v_remaining);

    insert into public.settlement_allocation (
      settlement_id,
      order_id,
      allocated_minor,
      merchant_account_id
    )
    values (
      v_settlement_id,
      v_order.id,
      v_alloc_minor,
      p_merchant
    );

    v_allocated_minor := v_allocated_minor + v_alloc_minor;
    v_remaining := v_remaining - v_alloc_minor;
  end loop;

  update public.settlement_shortfall
  set
    resolution = 'WRITTEN_OFF',
    reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = v_shortfall.id
    and merchant_account_id = p_merchant;

  insert into public.audit_log (
    merchant_account_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    payload
  )
  values (
    p_merchant,
    p_actor,
    'shortfall_written_off',
    'settlement_shortfall',
    v_shortfall.id,
    jsonb_build_object(
      'driverId', v_shortfall.driver_id,
      'writeOffSettlementId', v_settlement_id,
      'allocatedMinor', v_allocated_minor,
      'reason', p_reason
    )
  );

  return jsonb_build_object(
    'ok', true,
    'shortfallId', v_shortfall.id,
    'writeOffSettlementId', v_settlement_id,
    'allocatedMinor', v_allocated_minor,
    'remainingMinor', v_remaining
  );
end;
$$;

revoke all on function public.write_off_shortfall(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.write_off_shortfall(uuid, uuid, text, uuid) to authenticated;
