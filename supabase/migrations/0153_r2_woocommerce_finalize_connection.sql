-- ============================================================================
-- 0153 — correction de la porte manquée de l'arrêt A
--
-- 0152 avait créé les structures et persist_connection_order, mais aucune
-- primitive atomique de finalisation du callback. Cette migration additive ne
-- crée que cette primitive ; elle ne réécrit pas 0152.
-- ============================================================================

create function public.finalize_woocommerce_connection(
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
  v_connection_id uuid;
  v_identity_lock bigint;
begin
  -- Premier verrou, toujours acquis avant le verrou d'identité.
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

  -- La décision d'appartenance ne passe pas par current_member_role/current_shop_role :
  -- service_role les évaluerait dans le contexte service_role. Le verdict vient
  -- explicitement de merchant_member (compte/rôle/créateur) et shop_member
  -- (compte/boutique/utilisateur/rôle). Ces tables n'ont pas de colonne active ;
  -- une ligne existante avec un rôle owner/manager est le statut actif du membre.
  select mm.user_id
    into v_member_user_id
  from public.merchant_member mm
  join public.shop_member sm
    on sm.user_id = mm.user_id
   and sm.merchant_account_id = mm.merchant_account_id
  where mm.id = v_intent.created_by_member_id
    and mm.merchant_account_id = v_intent.merchant_account_id
    and mm.role in ('owner', 'manager')
    and sm.merchant_account_id = v_intent.merchant_account_id
    and sm.shop_id = v_intent.shop_id
    and sm.role in ('owner', 'manager');

  if v_member_user_id is null then
    return query select null::uuid, 'creator_not_authorized'::text;
    return;
  end if;

  -- L'identité venant du client est déjà normalisée hors transaction. La
  -- comparaison reste exacte avec celle stockée dans l'intention ; aucune
  -- identité ou contexte de tenant n'est pris depuis un paramètre séparé.
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

  -- Deuxième verrou, dans le même ordre pour toutes les finalisations. Le
  -- hash ne peut provoquer qu'une sérialisation supplémentaire en cas de
  -- collision ; il ne remplace pas la recherche exacte ci-dessous.
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
    if v_connection.merchant_account_id <> v_intent.merchant_account_id
       or v_connection.shop_id <> v_intent.shop_id then
      return query select null::uuid, 'identity_already_assigned'::text;
      return;
    end if;
    v_connection_id := v_connection.id;
  else
    begin
      insert into public.store_connection (
        merchant_account_id,
        shop_id,
        platform,
        external_identifier,
        status
      ) values (
        v_intent.merchant_account_id,
        v_intent.shop_id,
        'woocommerce',
        v_intent.external_identifier,
        'provisioning'
      )
      returning id into v_connection_id;
    exception
      when unique_violation then
        -- Un autre écrivain ne transforme jamais 23505 en réponse externe.
        -- La ligne est relue sous le verrou d'identité et reclassée nommément.
        select *
          into v_connection
        from public.store_connection sc
        where sc.platform = v_intent.platform
          and sc.external_identifier = v_intent.external_identifier
        for update;

        if not found then
          return query select null::uuid, 'identity_reservation_conflict'::text;
          return;
        end if;
        if v_connection.merchant_account_id <> v_intent.merchant_account_id
           or v_connection.shop_id <> v_intent.shop_id then
          return query select null::uuid, 'identity_already_assigned'::text;
          return;
        end if;
        v_connection_id := v_connection.id;
    end;
  end if;

  -- Une reprise est autorisée uniquement après la comparaison exacte du
  -- compte et de la boutique dérivés de l'intention. Cette branche ne peut
  -- donc jamais reprendre une connexion d'un autre tenant, y compris
  -- needs_reauth.
  update public.store_connection
  set status = 'provisioning',
      uninstalled_at = null
  where id = v_connection_id
    and merchant_account_id = v_intent.merchant_account_id
    and shop_id = v_intent.shop_id
    and platform = 'woocommerce';

  if not found then
    return query select null::uuid, 'connection_context_mismatch'::text;
    return;
  end if;

  -- La contrainte partielle de 0152 garantit une génération courante unique.
  -- Révoquer puis insérer est atomique dans cette transaction ; tout échec
  -- de l'insertion annule également la révocation.
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
    v_intent.shop_id,
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
