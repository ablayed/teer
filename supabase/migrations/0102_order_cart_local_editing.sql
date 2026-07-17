-- 0102 — Modification atomique du panier avant assignation.
--
-- Une commande ne peut être modifiée que tant qu'elle est hors circuit logistique
-- (`delivery_state = 'unassigned'`) et avant tout encaissement (`cash_state =
-- 'not_due'`). La fonction remplace `order_line`, `items_summary` et les montants
-- dans la même transaction, puis marque le panier comme localement modifié afin que
-- la synchronisation Shopify conserve ces deux champs métier.

alter table public.orders
  add column if not exists cart_locally_modified_at timestamptz;

create function public.replace_order_cart(
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
    from public.orders
   where id = p_order_id
   for update;

  if not found then
    raise exception 'order_not_found'
      using errcode = 'P0002';
  end if;

  v_role := public.current_member_role(v_order.merchant_account_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if v_order.delivery_state is distinct from 'unassigned' then
    raise exception 'cart_edit_not_allowed_after_assignment'
      using errcode = '22023';
  end if;

  if v_order.cash_state is distinct from 'not_due' then
    raise exception 'cart_edit_not_allowed_after_cash_due'
      using errcode = '22023';
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

  if v_line_count = 0 then
    raise exception 'cart_lines_required'
      using errcode = '22023';
  end if;

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
