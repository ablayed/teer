-- ============================================================================
-- 0154 — correction du premier geste WooCommerce
--
-- Une intention peut cibler une boutique existante (réautorisation) ou la
-- création de la première boutique fournisseur. La création de cette boutique,
-- de la connexion et de ses credentials reste une seule transaction.
-- ============================================================================

-- La classification est entièrement déterminée par la forme déjà stockée.
-- Le préflight production de ce lot a relevé zéro intention ; cette mise à jour
-- protège aussi une application différée où une intention aurait été créée
-- entre le relevé et la migration.
alter table public.store_connection_intent
  add column target_kind text default 'existing_shop';

update public.store_connection_intent
set target_kind = case
  when shop_id is null then 'new_shop'
  else 'existing_shop'
end
where target_kind is null;

alter table public.store_connection_intent
  add constraint store_connection_intent_target_kind_check
  check (target_kind in ('new_shop', 'existing_shop'));

alter table public.store_connection_intent
  add constraint store_connection_intent_target_shop_shape_check
  check (
    (target_kind = 'new_shop' and shop_id is null)
    or
    (target_kind = 'existing_shop' and shop_id is not null)
  );

alter table public.store_connection_intent
  alter column target_kind set not null;

alter table public.store_connection_intent
  alter column shop_id drop not null;

create or replace function public.finalize_woocommerce_connection(
  p_intent_id uuid,
  p_verified_identity text,
  p_scheme text,
  p_key_id text,
  p_consumer_key_encrypted text,
  p_consumer_secret_encrypted text,
  p_key_permissions text
)
returns table (
  store_connection_id uuid,
  result_code text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_intent public.store_connection_intent%rowtype;
  v_member_user_id uuid;
  v_connection public.store_connection%rowtype;
  v_shop_connection public.store_connection%rowtype;
  v_connection_id uuid;
  v_shop_id uuid;
  v_shop_kind text;
  v_shop_domain text;
  v_identity_lock bigint;
begin
  -- Ordre fixe : intention, identité, puis boutique existante. Les deux
  -- premiers verrous couvrent respectivement une intention rejouée et deux
  -- intentions distinctes visant la même identité externe.
  select *
    into v_intent
  from public.store_connection_intent
  where id = p_intent_id
  for update;

  if not found then
    return query select null::uuid, 'intent_not_found'::text;
    return;
  end if;

  if v_intent.platform <> 'woocommerce' then
    return query select null::uuid, 'intent_platform_mismatch'::text;
    return;
  end if;

  if v_intent.consumed_at is not null then
    return query select null::uuid, 'intent_consumed'::text;
    return;
  end if;

  if v_intent.expires_at <= clock_timestamp() then
    return query select null::uuid, 'intent_expired'::text;
    return;
  end if;

  -- Une première boutique n'existe pas encore : le verdict porte alors sur
  -- merchant_member. Pour une boutique existante, il porte explicitement sur
  -- merchant_member ET shop_member dérivés de l'intention verrouillée.
  if v_intent.target_kind = 'new_shop' then
    select mm.user_id
      into v_member_user_id
    from public.merchant_member mm
    where mm.id = v_intent.created_by_member_id
      and mm.merchant_account_id = v_intent.merchant_account_id
      and mm.role in ('owner', 'manager');
  else
    select mm.user_id
      into v_member_user_id
    from public.merchant_member mm
    join public.shop_member sm
      on sm.user_id = mm.user_id
     and sm.merchant_account_id = mm.merchant_account_id
    where mm.id = v_intent.created_by_member_id
      and mm.merchant_account_id = v_intent.merchant_account_id
      and mm.role in ('owner', 'manager')
      and sm.shop_id = v_intent.shop_id
      and sm.role in ('owner', 'manager');
  end if;

  if v_member_user_id is null then
    return query select null::uuid, 'creator_not_authorized'::text;
    return;
  end if;

  if p_verified_identity is null or p_verified_identity <> v_intent.external_identifier then
    return query select null::uuid, 'identity_mismatch'::text;
    return;
  end if;

  if p_scheme <> 'basic_consumer'
     or nullif(btrim(coalesce(p_key_id, '')), '') is null
     or nullif(btrim(coalesce(p_consumer_key_encrypted, '')), '') is null
     or nullif(btrim(coalesce(p_consumer_secret_encrypted, '')), '') is null then
    return query select null::uuid, 'credentials_shape_invalid'::text;
    return;
  end if;

  v_identity_lock := pg_catalog.hashtextextended(
    pg_catalog.length(v_intent.platform)::text || ':' ||
      v_intent.platform ||
      pg_catalog.length(v_intent.external_identifier)::text || ':' ||
      v_intent.external_identifier,
    0
  );
  perform pg_catalog.pg_advisory_xact_lock(v_identity_lock);

  select *
    into v_connection
  from public.store_connection sc
  where sc.platform = v_intent.platform
    and sc.external_identifier = v_intent.external_identifier
  for update;

  if found then
    -- `new_shop` ne reprend jamais une identité déjà réservée, même par le
    -- même compte : cela éviterait de créer silencieusement une boutique de
    -- plus sur un retry ou une URL revendiquée deux fois.
    if v_intent.target_kind = 'new_shop'
       or v_connection.merchant_account_id <> v_intent.merchant_account_id
       or v_connection.shop_id <> v_intent.shop_id then
      return query select null::uuid, 'identity_already_assigned'::text;
      return;
    end if;
    v_connection_id := v_connection.id;
  end if;

  if v_intent.target_kind = 'new_shop' then
    -- L'UUID est généré dans PostgreSQL. Le domaine est une clé synthétique
    -- opaque, jamais l'URL WooCommerce ; l'identité autoritative est stockée
    -- uniquement dans store_connection.external_identifier.
    v_shop_id := pg_catalog.gen_random_uuid();
    v_shop_domain := 'woocommerce-' || replace(v_shop_id::text, '-', '') || '.internal';

    insert into public.shop (
      id,
      merchant_account_id,
      shop_domain,
      access_token_encrypted,
      scopes,
      status,
      display_name,
      store_kind,
      is_default
    ) values (
      v_shop_id,
      v_intent.merchant_account_id,
      v_shop_domain,
      null,
      '',
      'active',
      substring(v_intent.external_identifier from '^https://([^/]+)'),
      'woocommerce',
      false
    );
    -- api_version est volontairement absent : le défaut hérité s'applique
    -- comme compatibilité technique, sans sémantique WooCommerce.
  else
    select id, store_kind
      into v_shop_id, v_shop_kind
    from public.shop
    where id = v_intent.shop_id
      and merchant_account_id = v_intent.merchant_account_id
    for update;

    if v_shop_id is null then
      return query select null::uuid, 'intent_shop_not_found'::text;
      return;
    end if;

    if v_shop_kind <> 'woocommerce' then
      return query select null::uuid, 'intent_shop_kind_mismatch'::text;
      return;
    end if;

    select *
      into v_shop_connection
    from public.store_connection sc
    where sc.merchant_account_id = v_intent.merchant_account_id
      and sc.shop_id = v_shop_id
    for update;

    if found and (v_connection_id is null or v_shop_connection.id <> v_connection_id) then
      return query select null::uuid, 'shop_already_connected'::text;
      return;
    end if;
  end if;

  if v_connection_id is null then
    begin
      insert into public.store_connection (
        merchant_account_id,
        shop_id,
        platform,
        external_identifier,
        status
      ) values (
        v_intent.merchant_account_id,
        v_shop_id,
        'woocommerce',
        v_intent.external_identifier,
        'provisioning'
      )
      returning id into v_connection_id;
    exception
      when unique_violation then
        return query select null::uuid, 'identity_reservation_conflict'::text;
        return;
    end;
  else
    update public.store_connection
    set status = 'provisioning',
        uninstalled_at = null
    where id = v_connection_id
      and merchant_account_id = v_intent.merchant_account_id
      and shop_id = v_shop_id
      and platform = 'woocommerce';

    if not found then
      return query select null::uuid, 'connection_context_mismatch'::text;
      return;
    end if;
  end if;

  update public.store_connection_credential as scc
  set revoked_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where scc.store_connection_id = v_connection_id
    and scc.revoked_at is null;

  insert into public.store_connection_credential (
    store_connection_id,
    merchant_account_id,
    shop_id,
    scheme,
    key_id,
    consumer_key_encrypted,
    consumer_secret_encrypted,
    key_permissions
  ) values (
    v_connection_id,
    v_intent.merchant_account_id,
    v_shop_id,
    'basic_consumer',
    btrim(p_key_id),
    p_consumer_key_encrypted,
    p_consumer_secret_encrypted,
    nullif(btrim(coalesce(p_key_permissions, '')), '')
  );

  update public.store_connection_intent
  set consumed_at = clock_timestamp()
  where id = v_intent.id;

  return query select v_connection_id, 'ok'::text;
end;
$$;

revoke all on function public.finalize_woocommerce_connection(
  uuid, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.finalize_woocommerce_connection(
  uuid, text, text, text, text, text, text
) to service_role;
