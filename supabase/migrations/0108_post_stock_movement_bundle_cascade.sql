-- 0108 : Bundles/packs — PR 1, cascade de stock dans post_stock_movement.
--
-- Point d'interception unique choisi : post_stock_movement lui-même, pas
-- transition_order/reassign_order_driver. Les deux fonctions appelantes postent déjà un
-- mouvement PAR (product_id, movement_type) résolu depuis order_line — elles n'ont besoin
-- d'aucune modification : post_stock_movement peut résoudre bundle→composants en interne et
-- se rappeler lui-même récursivement une fois par composant, avec sa MÊME logique
-- d'insertion/mutation product_stock déjà existante (pas de duplication de cette logique).
-- La récursion s'arrête à un seul niveau car un composant ne peut jamais être lui-même un
-- bundle (contrainte 0107, trigger assert_bundle_component_integrity).
--
-- Portée de la cascade (Phase B décision #3) : dispatch, sold, courier_return,
-- order_assignment_commit, order_assignment_release UNIQUEMENT. reserve, release,
-- advance_commit, reassign_from_driver, reassign_to_driver, purchase_in, manual_adjustment
-- restent hors scope de cette PR — un bundle posté via ces types continue de mouvementer le
-- product_id du bundle directement, sans cascade ni garde (dette documentée, pas un oubli).
--
-- Garde de rejet explicite (Phase B décision #4) : allocate_to_courier, courier_return_lot,
-- driver_stock_set rejettent toute cible is_bundle=true — un bundle n'existe jamais
-- physiquement en main d'un livreur ni comme lot entrepôt distinct.
--
-- Corps repris VERBATIM de 0095 pour tout le reste (aucun autre comportement changé).

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
  v_is_bundle      boolean;
  v_component      record;
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

  select p.is_bundle
    into v_is_bundle
    from public.product p
   where p.id = p_product_id
     and p.merchant_account_id = p_merchant_account_id;

  if not found then
    raise exception 'product not found for this merchant account'
      using errcode = 'P0002';
  end if;

  -- Garde explicite (Phase B décision #4) : un bundle n'existe jamais physiquement en main
  -- d'un livreur ni comme lot entrepôt distinct — rejet au niveau fonction, pas seulement UI.
  if v_is_bundle
     and p_movement_type in ('allocate_to_courier', 'courier_return_lot', 'driver_stock_set')
  then
    raise exception 'bundle product % cannot be the target of movement_type %'
      , p_product_id, p_movement_type
      using errcode = 'P0001';
  end if;

  if p_driver_id is not null and not exists (
    select 1 from public.driver
    where id = p_driver_id
      and merchant_account_id = p_merchant_account_id
  ) then
    raise exception 'driver not found for this merchant account'
      using errcode = 'P0002';
  end if;

  -- Cascade bundle → composants (Phase B décision #3). Aucun stock_movement n'est jamais
  -- inséré sur p_product_id (le bundle) dans ce cas : on reboucle sur post_stock_movement
  -- lui-même, une fois par composant, avec une idempotency_key dérivée (append composant)
  -- pour éviter toute collision on-conflict entre composants d'un même order_line/mouvement.
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
        p_idempotency_key     := p_idempotency_key
                                 || ':component:' || v_component.component_product_id::text,
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
