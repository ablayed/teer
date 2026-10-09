-- 0163 — Gardes de boutique sur les écritures de commande (lot de sécurité, distinct de L11B)
--
-- Corps repris du catalogue LOCAL (pg_get_functiondef), seules les gardes changent. Avant le
-- db push, les empreintes des corps de production sont à confronter à celles du lot (règle 19).
--
-- Défaut démontré en local le 2026-10-09 : replace_order_cart (0102, 0111),
-- reduce_order_cart_post_assignment (0112, 0136) et set_order_note (0118) sont SECURITY DEFINER
-- et ne vérifient que l'appartenance au COMPTE de la commande. Un membre du compte qui n'est pas
-- membre de la BOUTIQUE de la commande — et qui ne peut donc pas la lire, la RLS la lui masque —
-- réécrivait son panier, réduisait une quantité (total, mouvement de stock et audit compris) et
-- écrivait sa note.
--
-- Contrat appliqué aux trois fonctions :
--   * compte ET boutique sont dérivés de la commande, jamais d'un argument de l'appelant ;
--   * commande inexistante, ou interdite par le compte ou par la boutique : même réponse,
--     P0002 / order_not_found (contrat de transition_order) ;
--   * l'autorisation passe AVANT tout verrou et avant toute erreur qui dépend de l'état : un
--     appelant hors boutique n'obtient que P0002, quel que soit l'état de la commande ;
--   * après la prise du verrou, la commande est relue : même compte, même boutique, et
--     appartenance revérifiée pour les deux fonctions de panier. set_order_note ne prend pas de
--     verrou préalable : son UPDATE porte le compte et la boutique dans son prédicat ;
--   * le rôle exigé reste le rôle de COMPTE (owner ou manager pour les deux fonctions de panier,
--     tout membre pour la note) ; la boutique ne fait que borner l'accès ;
--   * rôle insuffisant dans la boutique (42501) et erreurs de validation métier : inchangés.
--
-- Corps repris tels quels du catalogue (pg_get_functiondef), seules les gardes changent.
-- Signatures identiques : CREATE OR REPLACE conserve l'ACL (à revérifier sur pg_proc.proacl) ;
-- le mode de sécurité et le search_path sont réécrits explicitement, car non hérités.
-- lock_order_cart_replaceable n'est pas modifiée.

-- 1) replace_order_cart
create or replace function public.replace_order_cart(p_order_id uuid, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_role text;
  v_guard_account uuid;
  v_guard_shop uuid;
  v_line jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_unit_price numeric;
  v_product public.product%rowtype;
  v_total numeric := 0;
  v_line_count integer := 0;
  v_items_summary jsonb := '[]'::jsonb;
  v_cash_collectable_minor bigint;
begin
  select o.merchant_account_id, o.shop_id
    into v_guard_account, v_guard_shop
    from public.orders o
   where o.id = p_order_id;

  if not found
     or public.current_member_role(v_guard_account) is null
     or public.current_shop_role(v_guard_shop) is null
  then
    raise exception 'order_not_found'
      using errcode = 'P0002';
  end if;

  v_role := public.current_member_role(v_guard_account);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0
     or jsonb_array_length(p_lines) > 20
  then
    raise exception 'cart_lines_required'
      using errcode = '22023';
  end if;

  select *
    into v_order
    from public.lock_order_cart_replaceable(p_order_id);

  if v_order.merchant_account_id is distinct from v_guard_account
     or v_order.shop_id is distinct from v_guard_shop
     or public.current_member_role(v_order.merchant_account_id) is null
     or public.current_shop_role(v_order.shop_id) is null
  then
    raise exception 'order_not_found'
      using errcode = 'P0002';
  end if;

  v_role := public.current_member_role(v_order.merchant_account_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  for v_line in
    select value
      from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(v_line) <> 'object'
       or jsonb_typeof(v_line -> 'product_id') <> 'string'
       or jsonb_typeof(v_line -> 'quantity') <> 'number'
       or jsonb_typeof(v_line -> 'unit_price') <> 'number'
    then
      raise exception 'invalid_cart_line'
        using errcode = '22023';
    end if;

    begin
      v_product_id := (v_line ->> 'product_id')::uuid;
      v_quantity := (v_line ->> 'quantity')::integer;
      v_unit_price := (v_line ->> 'unit_price')::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid_cart_line'
          using errcode = '22023';
    end;

    if v_quantity <= 0
       or v_quantity > 999
       or v_unit_price < 0
       or v_unit_price > 9007199254740991
    then
      raise exception 'invalid_cart_line'
        using errcode = '22023';
    end if;

    if (v_line ->> 'quantity')::numeric <> v_quantity::numeric then
      raise exception 'invalid_cart_line'
        using errcode = '22023';
    end if;

    select *
      into v_product
      from public.product
     where id = v_product_id
       and merchant_account_id = v_order.merchant_account_id
       and is_active = true;

    if not found then
      raise exception 'cart_product_not_found'
        using errcode = 'P0002';
    end if;

    v_line_count := v_line_count + 1;
    v_total := v_total + v_quantity * v_unit_price;
    v_items_summary := v_items_summary || jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product.id,
        'title', v_product.title,
        'sku', v_product.sku,
        'quantity', v_quantity,
        'price', v_unit_price
      )
    );
  end loop;

  v_cash_collectable_minor := case
    when v_order.payment_channel_at_delivery in ('WAVE', 'ORANGE_MONEY', 'FREE_MONEY') then 0
    else round(v_total)::bigint
  end;

  delete from public.order_line
   where order_id = v_order.id;

  for v_line in
    select value
      from jsonb_array_elements(p_lines)
  loop
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_quantity := (v_line ->> 'quantity')::integer;

    select *
      into v_product
      from public.product
     where id = v_product_id
       and merchant_account_id = v_order.merchant_account_id
       and is_active = true;

    insert into public.order_line (
      merchant_account_id,
      order_id,
      product_id,
      raw_title,
      raw_sku,
      raw_shopify_variant_id,
      raw_shopify_product_id,
      qty,
      match_status
    )
    values (
      v_order.merchant_account_id,
      v_order.id,
      v_product.id,
      v_product.title,
      v_product.sku,
      v_product.shopify_variant_id,
      v_product.shopify_product_id,
      v_quantity,
      'matched'
    );
  end loop;

  update public.orders
     set items_summary = v_items_summary,
         total_amount = v_total,
         cash_collectable_minor = v_cash_collectable_minor,
         cart_locally_modified_at = now(),
         updated_at = now()
   where id = v_order.id;

  insert into public.audit_log (
    merchant_account_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    payload
  )
  values (
    v_order.merchant_account_id,
    auth.uid(),
    'order.cart_updated',
    'orders',
    v_order.id,
    jsonb_build_object(
      'lineCount', v_line_count,
      'totalAmount', v_total
    )
  );
end;
$function$;

-- 2) reduce_order_cart_post_assignment
create or replace function public.reduce_order_cart_post_assignment(p_order_id uuid, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_role text;
  v_guard_account uuid;
  v_guard_shop uuid;
  v_line jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_old_qty integer;
  v_price numeric;
  v_product public.product%rowtype;
  v_total numeric := 0;
  v_line_count integer := 0;
  v_items_summary jsonb := '[]'::jsonb;
  v_cash_collectable_minor bigint;
  v_price_count integer;
  v_reduction_id uuid := gen_random_uuid();
  v_release record;
begin
  select o.merchant_account_id, o.shop_id
    into v_guard_account, v_guard_shop
    from public.orders o
   where o.id = p_order_id;

  if not found
     or public.current_member_role(v_guard_account) is null
     or public.current_shop_role(v_guard_shop) is null
  then
    raise exception 'order_not_found'
      using errcode = 'P0002';
  end if;

  v_role := public.current_member_role(v_guard_account);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0
     or jsonb_array_length(p_lines) > 20
  then
    raise exception 'cart_reduction_lines_required'
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

  if v_order.merchant_account_id is distinct from v_guard_account
     or v_order.shop_id is distinct from v_guard_shop
     or public.current_member_role(v_order.merchant_account_id) is null
     or public.current_shop_role(v_order.shop_id) is null
  then
    raise exception 'order_not_found'
      using errcode = 'P0002';
  end if;

  v_role := public.current_member_role(v_order.merchant_account_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if v_order.cash_state is null
     or v_order.cash_state in ('collected', 'remitted', 'discrepancy')
  then
    raise exception 'cart_reduction_not_allowed_after_cash_due'
      using errcode = '22023';
  end if;

  if v_order.delivery_state is null
     or v_order.delivery_state in ('unassigned', 'delivered', 'failed', 'returned')
  then
    raise exception 'cart_reduction_not_allowed_before_or_after_delivery'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_lines) as requested(value)
     group by requested.value ->> 'product_id'
    having count(*) > 1
  ) then
    raise exception 'cart_reduction_duplicate_product'
      using errcode = '22023';
  end if;

  for v_line in
    select value
      from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(v_line) <> 'object'
       or jsonb_typeof(v_line -> 'product_id') <> 'string'
       or jsonb_typeof(v_line -> 'quantity') <> 'number'
    then
      raise exception 'cart_reduction_invalid_line'
        using errcode = '22023';
    end if;

    begin
      v_product_id := (v_line ->> 'product_id')::uuid;
      v_quantity := (v_line ->> 'quantity')::integer;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'cart_reduction_invalid_line'
          using errcode = '22023';
    end;

    if v_quantity <= 0
       or v_quantity > 999
       or (v_line ->> 'quantity')::numeric <> v_quantity::numeric
    then
      raise exception 'cart_reduction_invalid_line'
        using errcode = '22023';
    end if;

    select sum(ol.qty)::integer
      into v_old_qty
      from public.order_line ol
     where ol.order_id = v_order.id
       and ol.product_id = v_product_id
       and ol.match_status = 'matched';

    if v_old_qty is null then
      raise exception 'cart_reduction_product_not_in_order'
        using errcode = '22023';
    end if;

    if v_quantity > v_old_qty then
      raise exception 'cart_reduction_quantity_increase_not_allowed'
        using errcode = '22023';
    end if;

    select *
      into v_product
      from public.product
     where id = v_product_id
       and merchant_account_id = v_order.merchant_account_id;

    if not found then
      raise exception 'cart_reduction_product_not_found'
        using errcode = 'P0002';
    end if;

    select
      count(distinct (item.value ->> 'price')::numeric)::integer,
      min((item.value ->> 'price')::numeric)
      into v_price_count, v_price
      from jsonb_array_elements(coalesce(v_order.items_summary, '[]'::jsonb))
           with ordinality as item(value, ordinal)
     where jsonb_typeof(item.value -> 'price') = 'number'
       and (
         (item.value ->> 'product_id') = v_product_id::text
         or (
           (item.value ->> 'product_id') is null
           and item.value ->> 'title' = v_product.title
         )
       );

    if coalesce(v_price_count, 0) = 0 then
      raise exception 'cart_reduction_missing_existing_price'
        using errcode = '22023';
    end if;

    if v_price_count <> 1 then
      raise exception 'cart_reduction_ambiguous_existing_price'
        using errcode = '22023';
    end if;

    v_line_count := v_line_count + 1;
    v_total := v_total + v_quantity * v_price;
    v_items_summary := v_items_summary || jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product.id,
        'title', v_product.title,
        'sku', v_product.sku,
        'quantity', v_quantity,
        'price', v_price
      )
    );
  end loop;

  if exists (
    with open_commitments as (
      select sm.product_id, sm.driver_id
      from public.stock_movement sm
      where sm.merchant_account_id = v_order.merchant_account_id
        and sm.order_id = v_order.id
        and sm.driver_id is not null
        and sm.movement_type in ('order_assignment_commit', 'order_assignment_release')
      group by sm.product_id, sm.driver_id
      having sum(case
        when sm.movement_type = 'order_assignment_commit' then sm.qty
        when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
        else 0
      end) > 0
    )
    select 1
      from open_commitments
     group by product_id
    having count(*) > 1
  ) then
    raise exception 'cart_reduction_multiple_open_commitment_drivers'
      using errcode = '22023';
  end if;

  for v_release in
    with old_required as (
      select
        coalesce(pbc.component_product_id, ol.product_id) as product_id,
        sum(ol.qty * coalesce(pbc.quantity, 1))::integer as qty
      from public.order_line ol
      left join public.product_bundle_component pbc
        on pbc.bundle_product_id = ol.product_id
      where ol.order_id = v_order.id
        and ol.match_status = 'matched'
        and ol.product_id is not null
      group by coalesce(pbc.component_product_id, ol.product_id)
    ),
    new_required as (
      select
        coalesce(pbc.component_product_id, (requested.value ->> 'product_id')::uuid) as product_id,
        sum(((requested.value ->> 'quantity')::integer) * coalesce(pbc.quantity, 1))::integer as qty
      from jsonb_array_elements(p_lines) as requested(value)
      left join public.product_bundle_component pbc
        on pbc.bundle_product_id = (requested.value ->> 'product_id')::uuid
      group by coalesce(pbc.component_product_id, (requested.value ->> 'product_id')::uuid)
    ),
    reductions as (
      select old_required.product_id, old_required.qty - coalesce(new_required.qty, 0) as qty
      from old_required
      left join new_required using (product_id)
      where old_required.qty > coalesce(new_required.qty, 0)
    ),
    open_commitments as (
      select
        sm.product_id,
        sm.driver_id,
        sum(case
          when sm.movement_type = 'order_assignment_commit' then sm.qty
          when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
          else 0
        end)::integer as net_open
      from public.stock_movement sm
      where sm.merchant_account_id = v_order.merchant_account_id
        and sm.order_id = v_order.id
        and sm.driver_id is not null
        and sm.movement_type in ('order_assignment_commit', 'order_assignment_release')
      group by sm.product_id, sm.driver_id
      having sum(case
        when sm.movement_type = 'order_assignment_commit' then sm.qty
        when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
        else 0
      end) > 0
    )
    select
      reductions.product_id,
      open_commitments.driver_id,
      least(reductions.qty, open_commitments.net_open)::integer as qty
    from reductions
    join open_commitments using (product_id)
    where least(reductions.qty, open_commitments.net_open) > 0
  loop
    perform private.post_stock_movement(
      p_merchant_account_id := v_order.merchant_account_id,
      p_product_id          := v_release.product_id,
      p_movement_type       := 'order_assignment_release',
      p_qty                 := -v_release.qty,
      p_idempotency_key     := 'cart_reduction:' || v_reduction_id::text
                               || ':' || v_release.product_id::text
                               || ':' || v_release.driver_id::text,
      p_created_by          := auth.uid(),
      p_order_id            := v_order.id,
      p_driver_id           := v_release.driver_id
    );
  end loop;

  v_cash_collectable_minor := case
    when v_order.payment_channel_at_delivery in ('WAVE', 'ORANGE_MONEY', 'FREE_MONEY') then 0
    else round(v_total)::bigint
  end;

  delete from public.order_line
   where order_id = v_order.id;

  for v_line in
    select value
      from jsonb_array_elements(p_lines)
  loop
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_quantity := (v_line ->> 'quantity')::integer;

    select *
      into v_product
      from public.product
     where id = v_product_id
       and merchant_account_id = v_order.merchant_account_id;

    insert into public.order_line (
      merchant_account_id,
      order_id,
      product_id,
      raw_title,
      raw_sku,
      raw_shopify_variant_id,
      raw_shopify_product_id,
      qty,
      match_status
    )
    values (
      v_order.merchant_account_id,
      v_order.id,
      v_product.id,
      v_product.title,
      v_product.sku,
      v_product.shopify_variant_id,
      v_product.shopify_product_id,
      v_quantity,
      'matched'
    );
  end loop;

  update public.orders
     set items_summary = v_items_summary,
         total_amount = v_total,
         cash_collectable_minor = v_cash_collectable_minor,
         cart_locally_modified_at = now(),
         updated_at = now()
   where id = v_order.id;

  insert into public.audit_log (
    merchant_account_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    payload
  )
  values (
    v_order.merchant_account_id,
    auth.uid(),
    'order.cart_reduced_post_assignment',
    'orders',
    v_order.id,
    jsonb_build_object(
      'lineCount', v_line_count,
      'totalAmount', v_total,
      'reductionId', v_reduction_id
    )
  );
end;
$function$;

-- 3) set_order_note
create or replace function public.set_order_note(p_order_id uuid, p_note text)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_merchant_account_id uuid;
  v_shop_id             uuid;
  v_role                text;
  v_note                text;
begin
  select merchant_account_id, shop_id
    into v_merchant_account_id, v_shop_id
    from public.orders
   where id = p_order_id;

  -- Compte ET boutique, dérivés de la commande. Inexistante ou interdite : même réponse.
  if v_merchant_account_id is null
     or public.current_member_role(v_merchant_account_id) is null
     or public.current_shop_role(v_shop_id) is null
  then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  -- Garde NULL-safe obligatoire : `current_member_role` renvoie NULL pour un
  -- non-membre, et `NULL not in (...)` ne vaut PAS TRUE — sans le test `is null`
  -- explicite la garde serait silencieusement sautée (fuite cross-tenant).
  v_role := public.current_member_role(v_merchant_account_id);

  if v_role is null or v_role not in ('owner', 'manager', 'agent') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');

  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'note_too_long' using errcode = '22001';
  end if;

  -- `updated_at` est bumpé par le trigger `orders_set_updated_at`.
  -- `cod_status` est recalculé par `derive_legacy_cod_status` à partir des 4
  -- dimensions, qu'on ne touche pas : sa valeur reste identique.
  -- Relecture sous verrou : l'UPDATE verrouille la ligne, puis réévalue son prédicat sur la
  -- version validée. Une commande passée entre-temps dans un autre compte ou une autre boutique
  -- n'est pas écrite.
  update public.orders
     set note = v_note
   where id = p_order_id
     and merchant_account_id = v_merchant_account_id
     and shop_id is not distinct from v_shop_id;

  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  return v_note;
end;
$function$;
