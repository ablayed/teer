-- ============================================================================
-- 0152 — R2.3/R2.4 : credentials WooCommerce, abonnements et ingestion générique
-- ============================================================================
-- Additif. Aucun secret Shopify n'est copié ou déplacé. Les quatre nouvelles
-- tables sont des coffres service-role : FORCE RLS, sans policy, et ACL
-- explicitement retiré à public/anon/authenticated.

-- ---------------------------------------------------------------------------
-- Préflight des CHECK élargis : une donnée existante incompatible bloque la
-- migration avant toute modification de contrainte.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from public.store_connection
    where platform not in ('shopify', 'woocommerce')
  ) then
    raise exception 'r2_store_connection_platform_backfill_incompatible';
  end if;

  if exists (
    select 1 from public.shop
    where store_kind not in ('manual', 'shopify', 'woocommerce')
  ) then
    raise exception 'r2_shop_store_kind_backfill_incompatible';
  end if;

  if exists (
    select 1 from public.orders
    where source is not null
      and source not in (
        'shopify', 'woocommerce', 'whatsapp', 'manual', 'instagram',
        'tiktok', 'facebook', 'appel'
      )
  ) then
    raise exception 'r2_orders_source_backfill_incompatible';
  end if;

  if exists (
    select 1 from public.customer
    where source not in ('manual', 'shopify', 'woocommerce', 'whatsapp', 'social')
  ) then
    raise exception 'r2_customer_source_backfill_incompatible';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Credentials : une seule génération non révoquée par connexion.
-- ---------------------------------------------------------------------------
create table public.store_connection_credential (
  id uuid primary key default gen_random_uuid(),
  store_connection_id uuid not null,
  merchant_account_id uuid not null,
  shop_id uuid not null,
  scheme text not null
    check (scheme in ('basic_consumer', 'oauth_bearer')),
  key_id text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  consumer_key_encrypted text,
  consumer_secret_encrypted text,
  key_permissions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint store_connection_credential_scheme_fields_check
    check (
      (
        scheme = 'basic_consumer'
        and consumer_key_encrypted is not null
        and consumer_secret_encrypted is not null
        and access_token_encrypted is null
        and refresh_token_encrypted is null
      )
      or (
        scheme = 'oauth_bearer'
        and access_token_encrypted is not null
        and consumer_key_encrypted is null
        and consumer_secret_encrypted is null
      )
    ),
  constraint store_connection_credential_connection_tenant_fk
    foreign key (store_connection_id, merchant_account_id, shop_id)
    references public.store_connection (id, merchant_account_id, shop_id)
    on delete cascade
);

create unique index store_connection_credential_current_idx
  on public.store_connection_credential (store_connection_id)
  where revoked_at is null;

create index store_connection_credential_connection_idx
  on public.store_connection_credential (store_connection_id, created_at desc);

alter table public.store_connection_credential enable row level security;
alter table public.store_connection_credential force row level security;
revoke all on table public.store_connection_credential from public, anon, authenticated;
grant all on table public.store_connection_credential to service_role;

-- ---------------------------------------------------------------------------
-- Abonnements : un secret HMAC chiffré et un token opaque par topic.
-- ---------------------------------------------------------------------------
create table public.store_connection_webhook_subscription (
  id uuid primary key default gen_random_uuid(),
  store_connection_id uuid not null,
  merchant_account_id uuid not null,
  shop_id uuid not null,
  provider_subscription_id text,
  topic text not null
    check (topic in ('order.created', 'order.updated')),
  delivery_token_hash text not null unique,
  secret_encrypted text not null,
  status text not null default 'provisioning'
    check (status in ('provisioning', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_connection_webhook_subscription_connection_topic_key
    unique (store_connection_id, topic),
  constraint store_connection_webhook_subscription_connection_tenant_fk
    foreign key (store_connection_id, merchant_account_id, shop_id)
    references public.store_connection (id, merchant_account_id, shop_id)
    on delete cascade
);

create index store_connection_webhook_subscription_connection_idx
  on public.store_connection_webhook_subscription (store_connection_id, status);

alter table public.store_connection_webhook_subscription enable row level security;
alter table public.store_connection_webhook_subscription force row level security;
revoke all on table public.store_connection_webhook_subscription from public, anon, authenticated;
grant all on table public.store_connection_webhook_subscription to service_role;

-- ---------------------------------------------------------------------------
-- Intention d'autorisation : UUID aléatoire opaque, courte et monousage.
-- ---------------------------------------------------------------------------
create table public.store_connection_intent (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null,
  shop_id uuid not null,
  platform text not null check (platform in ('shopify', 'woocommerce')),
  external_identifier text not null,
  created_by_member_id uuid not null references public.merchant_member(id),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint store_connection_intent_shop_tenant_fk
    foreign key (merchant_account_id, shop_id)
    references public.shop (merchant_account_id, id)
    on delete cascade,
  constraint store_connection_intent_expiry_check
    check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);

create index store_connection_intent_pending_idx
  on public.store_connection_intent (merchant_account_id, shop_id, expires_at)
  where consumed_at is null;

alter table public.store_connection_intent enable row level security;
alter table public.store_connection_intent force row level security;
revoke all on table public.store_connection_intent from public, anon, authenticated;
grant all on table public.store_connection_intent to service_role;

-- ---------------------------------------------------------------------------
-- Synchronisation initiale : last_page_observed est une trace, jamais un
-- curseur. Une reprise relit page=1 sur la fenêtre applicative de 90 jours.
-- ---------------------------------------------------------------------------
create table public.store_connection_sync_state (
  id uuid primary key default gen_random_uuid(),
  store_connection_id uuid not null,
  merchant_account_id uuid not null,
  shop_id uuid not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  last_page_observed integer not null default 0 check (last_page_observed >= 0),
  attempt integer not null default 0 check (attempt between 0 and 1000),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  last_error_code text
    check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$'),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint store_connection_sync_state_connection_key
    unique (store_connection_id),
  constraint store_connection_sync_state_connection_tenant_fk
    foreign key (store_connection_id, merchant_account_id, shop_id)
    references public.store_connection (id, merchant_account_id, shop_id)
    on delete cascade
);

alter table public.store_connection_sync_state enable row level security;
alter table public.store_connection_sync_state force row level security;
revoke all on table public.store_connection_sync_state from public, anon, authenticated;
grant all on table public.store_connection_sync_state to service_role;

-- ---------------------------------------------------------------------------
-- Registre de plateformes et d'états. Les lignes Shopify existantes restent
-- inchangées ; notamment `uninstalled` reste permis pour Shopify.
-- ---------------------------------------------------------------------------
alter table public.store_connection
  drop constraint if exists store_connection_platform_check;
alter table public.store_connection
  add constraint store_connection_platform_check
  check (platform in ('shopify', 'woocommerce'));

alter table public.shop
  drop constraint if exists shop_store_kind_check;
alter table public.shop
  add constraint shop_store_kind_check
  check (store_kind in ('manual', 'shopify', 'woocommerce'));

alter table public.orders
  drop constraint if exists orders_source_check;
alter table public.orders
  add constraint orders_source_check
  check (
    source is null
    or source in (
      'shopify', 'woocommerce', 'whatsapp', 'manual', 'instagram',
      'tiktok', 'facebook', 'appel'
    )
  ) not valid;
alter table public.orders validate constraint orders_source_check;

alter table public.customer
  drop constraint if exists customer_source_check;
alter table public.customer
  add constraint customer_source_check
  check (source in ('manual', 'shopify', 'woocommerce', 'whatsapp', 'social'))
  not valid;
alter table public.customer validate constraint customer_source_check;

alter table public.store_connection
  drop constraint if exists store_connection_status_check;
alter table public.store_connection
  add constraint store_connection_status_check
  check (
    status in ('provisioning', 'active', 'needs_reauth', 'disconnected')
    or (platform = 'shopify' and status = 'uninstalled')
  );

-- Aucun CHECK n'est ajouté à ingestion_event.platform : le relevé de
-- production reste requis avant de fermer ce registre.

-- ---------------------------------------------------------------------------
-- RPC atomique générique. SECURITY INVOKER est intentionnel : service_role
-- contourne déjà la RLS, tandis qu'un GRANT accidentel ne contournerait pas
-- les politiques des tables métier. Le JSON reçu ici est canonique ; aucun
-- payload fournisseur brut n'est persisté.
--
-- ordering_signal est sérialisé par cette fonction en UTC avec six décimales.
-- Pour une connexion nouvellement créée, sa comparaison lexicographique est
-- l'ordre chronologique stable utilisé par la garde de fraîcheur. Les appels
-- hors ordre sont donc ignorés pour l'état métier, mais restent journalisés.
-- ---------------------------------------------------------------------------
create function public.persist_connection_order(
  p_store_connection_id uuid,
  p_merchant_account_id uuid,
  p_shop_id uuid,
  p_platform text,
  p_topic text,
  p_delivery_id text,
  p_resource_external_id text,
  p_ordering_signal timestamptz,
  p_order jsonb,
  p_customer jsonb,
  p_lines jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_customer_id uuid;
  v_customer_external_id text;
  v_existing_signal text;
  v_signal text;
  v_should_apply boolean := true;
  v_total numeric;
  v_currency text;
  v_order_number text;
  v_created_at timestamptz;
  v_financial_status text;
  v_fulfillment_status text;
  v_items_summary jsonb;
  v_shipping_address jsonb;
begin
  if p_platform not in ('shopify', 'woocommerce') then
    raise exception 'r2_connection_platform_not_allowed';
  end if;

  if p_ordering_signal is not null then
    v_signal := to_char(
      p_ordering_signal at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    );
  end if;

  if not exists (
    select 1
    from public.store_connection sc
    where sc.id = p_store_connection_id
      and sc.merchant_account_id = p_merchant_account_id
      and sc.shop_id = p_shop_id
      and sc.platform = p_platform
      and sc.status = 'active'
  ) then
    raise exception 'r2_connection_context_not_active';
  end if;

  if btrim(coalesce(p_resource_external_id, '')) = '' then
    raise exception 'r2_order_external_id_required';
  end if;

  if jsonb_typeof(p_order) <> 'object'
     or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'r2_canonical_order_shape_invalid';
  end if;

  -- Le même delivery_id ne repasse pas dans le moteur métier. Il n'est
  -- qu'une protection de répétition de livraison, jamais la clé de ressource.
  if nullif(btrim(p_delivery_id), '') is not null
     and exists (
       select 1
       from public.ingestion_event ie
       where ie.store_connection_id = p_store_connection_id
         and ie.platform = p_platform
         and ie.delivery_id = btrim(p_delivery_id)
     ) then
    select er.entity_id
      into v_order_id
    from public.external_ref er
    where er.store_connection_id = p_store_connection_id
      and er.entity_type = 'order'
      and er.external_id = btrim(p_resource_external_id);
    if v_order_id is null then
      raise exception 'r2_delivery_without_resource';
    end if;
    return v_order_id;
  end if;

  v_order_number := nullif(btrim(p_order ->> 'order_number'), '');
  v_currency := coalesce(nullif(btrim(p_order ->> 'currency'), ''), 'XOF');
  v_financial_status := nullif(btrim(p_order ->> 'financial_status'), '');
  v_fulfillment_status := nullif(btrim(p_order ->> 'fulfillment_status'), '');
  v_items_summary := case
    when jsonb_typeof(p_order -> 'items_summary') = 'array'
      then p_order -> 'items_summary'
    else null
  end;
  v_shipping_address := case
    when jsonb_typeof(p_order -> 'shipping_address') = 'object'
      then p_order -> 'shipping_address'
    else null
  end;

  if coalesce(nullif(btrim(p_order ->> 'total_amount'), ''), '0')
       !~ '^-?[0-9]+(\.[0-9]+)?$' then
    raise exception 'r2_order_total_invalid';
  end if;
  v_total := coalesce(nullif(btrim(p_order ->> 'total_amount'), ''), '0')::numeric;

  if nullif(btrim(p_order ->> 'created_at'), '') is not null then
    v_created_at := (p_order ->> 'created_at')::timestamptz;
  end if;

  select er.entity_id
    into v_order_id
  from public.external_ref er
  where er.store_connection_id = p_store_connection_id
    and er.entity_type = 'order'
    and er.external_id = btrim(p_resource_external_id)
  for update;

  if v_order_id is not null then
    select max(ie.ordering_signal)
      into v_existing_signal
    from public.ingestion_event ie
    where ie.store_connection_id = p_store_connection_id
      and ie.resource_kind = 'order'
      and ie.resource_external_id = btrim(p_resource_external_id)
      and ie.ordering_signal is not null;

    if v_signal is null or (v_existing_signal is not null and v_signal <= v_existing_signal) then
      v_should_apply := false;
    end if;
  else
    insert into public.orders (
      merchant_account_id,
      shop_id,
      store_connection_id,
      order_number,
      total_amount,
      currency,
      financial_status,
      fulfillment_status,
      items_summary,
      shipping_address,
      source,
      created_at_shopify
    ) values (
      p_merchant_account_id,
      p_shop_id,
      p_store_connection_id,
      v_order_number,
      v_total,
      v_currency,
      v_financial_status,
      v_fulfillment_status,
      v_items_summary,
      v_shipping_address,
      p_platform,
      v_created_at
    )
    returning id into v_order_id;

    insert into public.external_ref (
      merchant_account_id,
      shop_id,
      store_connection_id,
      source_namespace,
      entity_type,
      entity_id,
      external_id
    ) values (
      p_merchant_account_id,
      p_shop_id,
      p_store_connection_id,
      null,
      'order',
      v_order_id,
      btrim(p_resource_external_id)
    );
  end if;

  v_customer_external_id := nullif(btrim(p_customer ->> 'external_id'), '');
  if v_customer_external_id is not null then
    select er.entity_id
      into v_customer_id
    from public.external_ref er
    where er.store_connection_id = p_store_connection_id
      and er.entity_type = 'customer'
      and er.external_id = v_customer_external_id
    for update;

    if v_customer_id is null then
      insert into public.customer (
        merchant_account_id,
        shop_id,
        full_name,
        phone,
        address,
        source
      ) values (
        p_merchant_account_id,
        p_shop_id,
        nullif(btrim(p_customer ->> 'full_name'), ''),
        nullif(btrim(p_customer ->> 'phone'), ''),
        case when jsonb_typeof(p_customer -> 'address') = 'object'
          then p_customer -> 'address' else null end,
        p_platform
      )
      returning id into v_customer_id;

      insert into public.external_ref (
        merchant_account_id,
        shop_id,
        store_connection_id,
        source_namespace,
        entity_type,
        entity_id,
        external_id
      ) values (
        p_merchant_account_id,
        p_shop_id,
        p_store_connection_id,
        null,
        'customer',
        v_customer_id,
        v_customer_external_id
      );
    elsif not exists (
      select 1 from public.customer c
      where c.id = v_customer_id
        and c.merchant_account_id = p_merchant_account_id
        and c.shop_id = p_shop_id
    ) then
      raise exception 'r2_customer_context_mismatch';
    elsif v_should_apply then
      update public.customer
      set full_name = coalesce(nullif(btrim(p_customer ->> 'full_name'), ''), full_name),
          phone = coalesce(nullif(btrim(p_customer ->> 'phone'), ''), phone),
          address = case when jsonb_typeof(p_customer -> 'address') = 'object'
            then p_customer -> 'address' else address end
      where id = v_customer_id;
    end if;
  end if;

  if v_should_apply then
    if v_order_id is not null and exists (
      select 1 from public.external_ref er
      where er.store_connection_id = p_store_connection_id
        and er.entity_type = 'order'
        and er.external_id = btrim(p_resource_external_id)
    ) and exists (select 1 from public.orders where id = v_order_id) then
      update public.orders
      set customer_id = coalesce(v_customer_id, customer_id),
          order_number = coalesce(v_order_number, order_number),
          total_amount = v_total,
          currency = v_currency,
          financial_status = coalesce(v_financial_status, financial_status),
          fulfillment_status = coalesce(v_fulfillment_status, fulfillment_status),
          items_summary = coalesce(v_items_summary, items_summary),
          shipping_address = coalesce(v_shipping_address, shipping_address)
      where id = v_order_id
        and exists (
          select 1 from public.external_ref er
          where er.entity_id = public.orders.id
            and er.store_connection_id = p_store_connection_id
            and er.entity_type = 'order'
            and er.external_id = btrim(p_resource_external_id)
        );

      delete from public.order_line where order_id = v_order_id;
    end if;

    if not exists (
      select 1 from public.order_line where order_id = v_order_id
    ) then
      if exists (
        select 1
        from jsonb_to_recordset(p_lines) as line(
          product_id uuid,
          raw_title text,
          raw_sku text,
          qty integer,
          match_status text
        )
        where btrim(coalesce(line.raw_title, '')) = ''
           or line.qty is null
           or line.qty <= 0
           or coalesce(line.match_status, 'unresolved')
                not in ('matched', 'unresolved', 'ambiguous')
      ) then
        raise exception 'r2_order_lines_invalid';
      end if;

      if exists (
        select 1
        from jsonb_to_recordset(p_lines) as line(product_id uuid)
        left join public.product p
          on p.id = line.product_id
         and p.merchant_account_id = p_merchant_account_id
         and p.shop_id = p_shop_id
        where line.product_id is not null
          and p.id is null
      ) then
        raise exception 'r2_product_context_mismatch';
      end if;

      insert into public.order_line (
        merchant_account_id,
        shop_id,
        order_id,
        product_id,
        raw_title,
        raw_sku,
        qty,
        match_status
      )
      select
        p_merchant_account_id,
        p_shop_id,
        v_order_id,
        line.product_id,
        line.raw_title,
        line.raw_sku,
        line.qty,
        coalesce(line.match_status, 'unresolved')
      from jsonb_to_recordset(p_lines) as line(
        product_id uuid,
        raw_title text,
        raw_sku text,
        qty integer,
        match_status text
      );
    end if;
  end if;

  insert into public.ingestion_event (
    merchant_account_id,
    shop_id,
    store_connection_id,
    platform,
    topic,
    delivery_id,
    resource_kind,
    resource_external_id,
    ordering_signal,
    status,
    triggered_at,
    completed_at
  ) values (
    p_merchant_account_id,
    p_shop_id,
    p_store_connection_id,
    p_platform,
    p_topic,
    nullif(btrim(p_delivery_id), ''),
    'order',
    btrim(p_resource_external_id),
    v_signal,
    'done',
    now(),
    now()
  ) on conflict do nothing;

  return v_order_id;
end;
$$;

revoke all on function public.persist_connection_order(
  uuid, uuid, uuid, text, text, text, text, timestamptz, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.persist_connection_order(
  uuid, uuid, uuid, text, text, text, text, timestamptz, jsonb, jsonb, jsonb
) to service_role;
