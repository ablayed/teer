-- 0111 — Resynchronisation atomique du panier Shopify avant assignation.
--
-- Le chemin local replace_order_cart et le chemin Shopify partagent la même
-- garde transactionnelle : commande verrouillée, delivery_state=unassigned et
-- cash_state=not_due. Le chemin Shopify est service_role-only : il conserve le
-- payload Shopify (résumé + total) et ne marque jamais le panier localement.

create or replace function public.lock_order_cart_replaceable(
  p_order_id uuid
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
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

  if v_order.delivery_state is distinct from 'unassigned' then
    raise exception 'cart_edit_not_allowed_after_assignment'
      using errcode = '22023';
  end if;

  if v_order.cash_state is distinct from 'not_due' then
    raise exception 'cart_edit_not_allowed_after_cash_due'
      using errcode = '22023';
  end if;

  return v_order;
end;
$$;

revoke all on function public.lock_order_cart_replaceable(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.replace_order_cart(
  p_order_id uuid,
  p_lines jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_role text;
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
$$;

revoke all on function public.replace_order_cart(uuid, jsonb) from public, anon;
grant execute on function public.replace_order_cart(uuid, jsonb) to authenticated;

create or replace function public.replace_shopify_order_cart(
  p_order_id uuid,
  p_lines jsonb,
  p_order_update jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_line jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_match_status text;
  v_raw_title text;
  v_raw_sku text;
  v_raw_shopify_variant_id text;
  v_raw_shopify_product_id text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0
     or jsonb_array_length(p_lines) > 20
     or jsonb_typeof(p_order_update) <> 'object'
     or jsonb_typeof(p_order_update -> 'items_summary') <> 'array'
     or jsonb_typeof(p_order_update -> 'total_amount') <> 'number'
  then
    raise exception 'invalid_shopify_cart_sync_payload'
      using errcode = '22023';
  end if;

  select *
    into v_order
    from public.lock_order_cart_replaceable(p_order_id);

  if v_order.cart_locally_modified_at is not null then
    raise exception 'shopify_cart_sync_blocked_by_local_edit'
      using errcode = '22023';
  end if;

  delete from public.order_line
   where order_id = v_order.id;

  for v_line in
    select value
      from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(v_line) <> 'object'
       or jsonb_typeof(v_line -> 'raw_title') <> 'string'
       or jsonb_typeof(v_line -> 'quantity') <> 'number'
       or jsonb_typeof(v_line -> 'match_status') <> 'string'
    then
      raise exception 'invalid_shopify_cart_line'
        using errcode = '22023';
    end if;

    v_raw_title := btrim(v_line ->> 'raw_title');
    v_raw_sku := nullif(v_line ->> 'raw_sku', '');
    v_raw_shopify_variant_id := nullif(v_line ->> 'raw_shopify_variant_id', '');
    v_raw_shopify_product_id := nullif(v_line ->> 'raw_shopify_product_id', '');
    v_match_status := v_line ->> 'match_status';

    begin
      v_quantity := (v_line ->> 'quantity')::integer;
      v_product_id := case
        when jsonb_typeof(v_line -> 'product_id') = 'string'
          then (v_line ->> 'product_id')::uuid
        else null
      end;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid_shopify_cart_line'
          using errcode = '22023';
    end;

    if v_raw_title = ''
       or v_quantity <= 0
       or v_quantity > 999
       or (v_line ->> 'quantity')::numeric <> v_quantity::numeric
       or v_match_status not in ('matched', 'unresolved', 'ambiguous')
    then
      raise exception 'invalid_shopify_cart_line'
        using errcode = '22023';
    end if;

    if v_match_status = 'matched' then
      if v_product_id is null or not exists (
        select 1
          from public.product
         where id = v_product_id
           and merchant_account_id = v_order.merchant_account_id
           and is_active = true
      ) then
        raise exception 'invalid_shopify_cart_line'
          using errcode = '22023';
      end if;
    elsif v_product_id is not null then
      raise exception 'invalid_shopify_cart_line'
        using errcode = '22023';
    end if;

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
      v_product_id,
      v_raw_title,
      v_raw_sku,
      v_raw_shopify_variant_id,
      v_raw_shopify_product_id,
      v_quantity,
      v_match_status
    );
  end loop;

  update public.orders
     set order_number = p_order_update ->> 'order_number',
         total_amount = (p_order_update ->> 'total_amount')::numeric,
         -- Same rule as replace_order_cart: this path is always not_due,
         -- so the collectable amount follows the new Shopify total.
         cash_collectable_minor = case
           when v_order.payment_channel_at_delivery in ('WAVE', 'ORANGE_MONEY', 'FREE_MONEY')
             then 0
           else round((p_order_update ->> 'total_amount')::numeric)::bigint
         end,
         currency = p_order_update ->> 'currency',
         financial_status = p_order_update ->> 'financial_status',
         fulfillment_status = p_order_update ->> 'fulfillment_status',
         shopify_financial_status = p_order_update ->> 'shopify_financial_status',
         shopify_fulfillment_status = p_order_update ->> 'shopify_fulfillment_status',
         shopify_cancelled_at = nullif(p_order_update ->> 'shopify_cancelled_at', '')::timestamptz,
         shopify_updated_at = nullif(p_order_update ->> 'shopify_updated_at', '')::timestamptz,
         items_summary = p_order_update -> 'items_summary',
         shipping_address = case
           when p_order_update -> 'shipping_address' = 'null'::jsonb then null
           else p_order_update -> 'shipping_address'
         end,
         customer_id = nullif(p_order_update ->> 'customer_id', '')::uuid,
         created_at_shopify = nullif(p_order_update ->> 'created_at_shopify', '')::timestamptz,
         shopify_order_attributes = case
           when p_order_update -> 'shopify_order_attributes' = 'null'::jsonb then null
           else p_order_update -> 'shopify_order_attributes'
         end,
         shopify_line_item_attributes = case
           when p_order_update -> 'shopify_line_item_attributes' = 'null'::jsonb then null
           else p_order_update -> 'shopify_line_item_attributes'
         end,
         updated_at = now()
   where id = v_order.id;
end;
$$;

revoke all on function public.replace_shopify_order_cart(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_shopify_order_cart(uuid, jsonb, jsonb)
  to service_role;
