-- 0165 — Import Shopify : commande et lignes écrites ensemble, lignes manquantes réparables.
--
-- Défaut mesuré en local le 2026-10-09 (10 000 commandes, trois passages) : 10 commandes sont
-- restées sans aucune order_line alors que l'import les comptait réussies à chaque passage.
--   * `persistShopifyOrder` insérait l'en-tête, puis les lignes dans une seconde requête dont
--     l'erreur était avalée (lib/shopify/orders-sync.ts, lib/stock/order-line-resolution.ts) ;
--   * au réimport, la garde de date (`shopify_updated_at` égal) écartait la commande avant toute
--     reconstruction.
--
-- Contrat :
--   * une commande Shopify n'existe pas sans ses lignes : l'en-tête et les lignes sont écrits
--     dans une seule transaction, ou rien n'est écrit ;
--   * une commande déjà présente et sans ligne est réparable tant qu'aucune transition n'a pu
--     poser — ou sauter — un mouvement de stock pour elle : ouverte, non confirmée, non
--     assignée, cash non dû, panier non modifié localement. transition_order pose une réserve
--     dès la confirmation : une commande confirmée sans lignes n'a pas eu la sienne, et lui
--     écrire des lignes ferait partir un stock jamais réservé. Au-delà de cet état, la
--     réparation relève du lot d'historique, pas de l'import ;
--   * la réparation n'écrit que des order_line : aucun mouvement de stock, aucun champ de la
--     commande. La rejouer n'ajoute rien.
--
--   * la décision d'écrire des lignes manquantes est prise EN BASE, sous le verrou de la
--     commande, sur les deux chemins de reconstruction (réparation, resynchronisation par une
--     charge plus récente). Une commande confirmée entre la lecture de l'import et son écriture
--     ne reçoit aucune ligne ; la fonction le dit à l'appelant, qui le signale.
--
-- Les trois fonctions sont réservées au rôle de service : SECURITY INVOKER, sans garde de rôle,
-- EXECUTE au seul service_role. `replace_shopify_order_cart` n'est pas modifiée : elle n'est plus
-- appelée par l'import qu'à travers `resync_shopify_order_cart`.

-- ── 1. Lignes d'une commande Shopify qui n'en a aucune ──────────────────────────────────────
-- Rend le nombre de lignes écrites ; 0 si la commande en porte déjà (rejeu sans effet).
create function public.repair_shopify_order_lines(p_order_id uuid, p_lines jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_line jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_match_status text;
  v_raw_title text;
  v_written integer := 0;
begin
  if jsonb_typeof(p_lines) is distinct from 'array'
     or jsonb_array_length(p_lines) = 0
     or jsonb_array_length(p_lines) > 250
  then
    raise exception 'invalid_shopify_order_lines_payload'
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

  if v_order.shopify_order_id is null then
    raise exception 'not_a_shopify_order'
      using errcode = '22023';
  end if;

  -- Rejeu, ou réparation concurrente déjà passée : rien à faire.
  if exists (select 1 from public.order_line ol where ol.order_id = v_order.id) then
    return 0;
  end if;

  -- Hors de cet état, des transitions ont pu poser (ou sauter) des mouvements de stock : écrire
  -- des lignes maintenant désaccorderait le stock de son journal.
  if v_order.order_state is distinct from 'open'
     or v_order.call_state is not distinct from 'validated'
     or v_order.delivery_state is distinct from 'unassigned'
     or v_order.cash_state is distinct from 'not_due'
     or v_order.cart_locally_modified_at is not null
  then
    raise exception 'shopify_order_lines_not_repairable'
      using errcode = '22023';
  end if;

  for v_line in
    select value
      from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(v_line) is distinct from 'object'
       or jsonb_typeof(v_line -> 'raw_title') is distinct from 'string'
       or jsonb_typeof(v_line -> 'quantity') is distinct from 'number'
       or jsonb_typeof(v_line -> 'match_status') is distinct from 'string'
    then
      raise exception 'invalid_shopify_order_line'
        using errcode = '22023';
    end if;

    v_raw_title := btrim(v_line ->> 'raw_title');
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
        raise exception 'invalid_shopify_order_line'
          using errcode = '22023';
    end;

    if v_raw_title = ''
       or v_quantity <= 0
       or (v_line ->> 'quantity')::numeric <> v_quantity::numeric
       or v_match_status not in ('matched', 'unresolved', 'ambiguous')
    then
      raise exception 'invalid_shopify_order_line'
        using errcode = '22023';
    end if;

    -- Un produit rapproché appartient au compte ET à la boutique de la commande.
    if v_match_status = 'matched' then
      if v_product_id is null or not exists (
        select 1
          from public.product p
         where p.id = v_product_id
           and p.merchant_account_id = v_order.merchant_account_id
           and p.shop_id = v_order.shop_id
      ) then
        raise exception 'invalid_shopify_order_line'
          using errcode = '22023';
      end if;
    elsif v_product_id is not null then
      raise exception 'invalid_shopify_order_line'
        using errcode = '22023';
    end if;

    -- Compte et boutique hérités de la COMMANDE, jamais de l'appelant ni de la boutique par
    -- défaut du compte.
    insert into public.order_line (
      merchant_account_id,
      shop_id,
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
      v_order.shop_id,
      v_order.id,
      v_product_id,
      v_raw_title,
      nullif(v_line ->> 'raw_sku', ''),
      nullif(v_line ->> 'raw_shopify_variant_id', ''),
      nullif(v_line ->> 'raw_shopify_product_id', ''),
      v_quantity,
      v_match_status
    );
    v_written := v_written + 1;
  end loop;

  return v_written;
end;
$$;

revoke all on function public.repair_shopify_order_lines(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.repair_shopify_order_lines(uuid, jsonb) to service_role;

-- ── 2. Création : en-tête et lignes dans la même transaction ────────────────────────────────
-- `p_order` porte exactement les colonnes que l'import écrivait par PostgREST ; toute autre clé
-- est refusée plutôt qu'ignorée. Les colonnes absentes gardent leur valeur par défaut, comme
-- avec une insertion PostgREST.
create function public.create_shopify_order_with_lines(p_order jsonb, p_lines jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_allowed constant text[] := array[
    'order_state', 'call_state', 'delivery_state', 'cash_state',
    'merchant_account_id', 'shop_id', 'customer_id', 'shopify_order_id',
    'order_number', 'total_amount', 'currency',
    'financial_status', 'fulfillment_status',
    'shopify_financial_status', 'shopify_fulfillment_status',
    'shopify_cancelled_at', 'shopify_updated_at',
    'items_summary', 'shipping_address', 'created_at_shopify',
    'shopify_order_attributes', 'shopify_line_item_attributes'
  ];
  v_order_id uuid;
  v_expected integer;
  v_written integer;
begin
  if jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_lines) is distinct from 'array'
     or exists (select 1 from jsonb_object_keys(p_order) k where k <> all (v_allowed))
     or exists (select 1 from unnest(v_allowed) k where not (p_order ? k))
     or nullif(p_order ->> 'merchant_account_id', '') is null
     or nullif(p_order ->> 'shop_id', '') is null
     or nullif(p_order ->> 'shopify_order_id', '') is null
  then
    raise exception 'invalid_shopify_order_payload'
      using errcode = '22023';
  end if;

  insert into public.orders (
    order_state, call_state, delivery_state, cash_state,
    merchant_account_id, shop_id, customer_id, shopify_order_id,
    order_number, total_amount, currency,
    financial_status, fulfillment_status,
    shopify_financial_status, shopify_fulfillment_status,
    shopify_cancelled_at, shopify_updated_at,
    items_summary, shipping_address, created_at_shopify,
    shopify_order_attributes, shopify_line_item_attributes
  )
  select
    r.order_state, r.call_state, r.delivery_state, r.cash_state,
    r.merchant_account_id, r.shop_id, r.customer_id, r.shopify_order_id,
    r.order_number, r.total_amount, r.currency,
    r.financial_status, r.fulfillment_status,
    r.shopify_financial_status, r.shopify_fulfillment_status,
    r.shopify_cancelled_at, r.shopify_updated_at,
    r.items_summary, r.shipping_address, r.created_at_shopify,
    r.shopify_order_attributes, r.shopify_line_item_attributes
  from jsonb_populate_record(null::public.orders, p_order) r
  returning id into v_order_id;

  v_expected := jsonb_array_length(p_lines);
  if v_expected > 0 then
    v_written := public.repair_shopify_order_lines(v_order_id, p_lines);
    if v_written is distinct from v_expected then
      raise exception 'shopify_order_lines_incomplete'
        using errcode = '22023';
    end if;
  end if;

  return v_order_id;
end;
$$;

revoke all on function public.create_shopify_order_with_lines(jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_shopify_order_with_lines(jsonb, jsonb) to service_role;

-- ── 3. Resynchronisation du panier par une charge plus récente, gardée sous verrou ──────────
-- `replace_shopify_order_cart` (0111) verrouille la commande mais ne connaît ni la confirmation
-- ni les réserves. Cette enveloppe prend le verrou d'abord et revérifie : une commande qui ne
-- porte AUCUNE ligne et n'est plus réparable n'en reçoit pas. Elle rend alors 'lines_missing'
-- sans rien écrire ; l'appelant met à jour les autres champs et signale. Dans tous les autres
-- cas, elle délègue à `replace_shopify_order_cart`, dans la même transaction, et rend 'resynced'.
create function public.resync_shopify_order_cart(
  p_order_id uuid,
  p_lines jsonb,
  p_order_update jsonb
)
returns text
language plpgsql
security invoker
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

  -- Même prédicat que repair_shopify_order_lines, évalué sous verrou.
  if not exists (select 1 from public.order_line ol where ol.order_id = v_order.id)
     and (
       v_order.order_state is distinct from 'open'
       or v_order.call_state is not distinct from 'validated'
       or v_order.delivery_state is distinct from 'unassigned'
       or v_order.cash_state is distinct from 'not_due'
       or v_order.cart_locally_modified_at is not null
     )
  then
    return 'lines_missing';
  end if;

  perform public.replace_shopify_order_cart(p_order_id, p_lines, p_order_update);
  return 'resynced';
end;
$$;

revoke all on function public.resync_shopify_order_cart(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.resync_shopify_order_cart(uuid, jsonb, jsonb) to service_role;
