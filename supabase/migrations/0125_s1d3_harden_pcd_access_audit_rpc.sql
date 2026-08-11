-- 0125 — S1D-3R : durcissement SQL de la frontière RPC d'audit PCD
--
-- La RPC reste le seul chemin d'écriture autorisé aux rôles applicatifs.
-- Cette migration répète les bornes de sécurité côté SQL afin qu'un appel
-- direct PostgREST ne puisse pas contourner le validateur TypeScript.

create or replace function public.validate_pcd_access_audit_metadata(p_metadata jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
  v_text text;
  v_number numeric;
begin
  if p_metadata is null
     or jsonb_typeof(p_metadata) <> 'object'
     or octet_length(p_metadata::text) > 2048
     or (select count(*) from jsonb_object_keys(p_metadata)) > 8 then
    return false;
  end if;

  for v_key, v_value in select key, value from jsonb_each(p_metadata) loop
    if v_key <> all (array[
      'channel',
      'duration_ms',
      'error_code',
      'http_status',
      'latency_ms',
      'page_number',
      'page_size',
      'provider',
      'quota_count',
      'quota_limit',
      'reason_code',
      'result_count',
      'source'
    ]) then
      return false;
    end if;

    if jsonb_typeof(v_value) not in ('string', 'number', 'boolean') then
      return false;
    end if;

    if jsonb_typeof(v_value) = 'string' then
      v_text := v_value #>> '{}';
      if length(v_text) not between 1 and 128
         or v_text !~ '^[A-Za-z0-9._:-]+$'
         or v_text ~* '^(bearer|basic)[[:space:]]+'
         or v_text ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
         or v_text ~ '^[A-Za-z-]{2,32}:[^:]+$' then
        return false;
      end if;
    end if;

    if v_key in ('duration_ms', 'latency_ms', 'page_number', 'page_size', 'quota_count', 'quota_limit', 'result_count') then
      if jsonb_typeof(v_value) <> 'number' then
        return false;
      end if;
      v_number := (v_value #>> '{}')::numeric;
      if v_number < 0 or v_number > 5000 or v_number <> trunc(v_number) then
        return false;
      end if;
    end if;

    if v_key = 'http_status' then
      if jsonb_typeof(v_value) <> 'number' then
        return false;
      end if;
      v_number := (v_value #>> '{}')::numeric;
      if v_number < 100 or v_number > 599 or v_number <> trunc(v_number) then
        return false;
      end if;
    end if;
  end loop;

  return true;
exception when others then
  return false;
end;
$$;

create or replace function public.log_pcd_access_event(
  p_tenant_id uuid,
  p_shop_id uuid,
  p_actor_kind text,
  p_service_kind text,
  p_action text,
  p_data_category text,
  p_purpose text,
  p_outcome text,
  p_resource_type text,
  p_resource_id uuid,
  p_surface text,
  p_metadata jsonb default '{}'::jsonb,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid;
  v_id uuid;
begin
  if p_tenant_id is null
     or p_actor_kind is null
     or p_action is null
     or p_data_category is null
     or p_purpose is null
     or p_outcome is null
     or p_resource_type is null
     or p_surface is null then
    raise exception using errcode = '22023', message = 'pcd_access_audit_argument_rejected';
  end if;

  if p_actor_kind not in ('human', 'service')
     or p_action not in (
       'view_detail', 'search', 'list_access', 'generate_export',
       'download_export', 'generate_signed_url',
       'generate_download_authorization', 'external_share',
       'privileged_read', 'ai_processing', 'support_submission'
     )
     or p_data_category not in (
       'customer_identity', 'customer_contact', 'delivery_address',
       'shopify_payload', 'dsar_artifact', 'member_data', 'merchant_data'
     )
     or p_purpose not in (
       'order_fulfillment', 'customer_support', 'delivery_execution',
       'cash_reconciliation', 'fraud_review', 'legal_request',
       'external_share', 'system_processing'
     )
     or p_outcome not in ('allowed', 'denied', 'succeeded', 'failed')
     or p_resource_type not in (
       'order', 'customer', 'driver', 'member', 'delivery_address',
       'dsar_artifact', 'export', 'assistant', 'feedback',
       'shopify_payload', 'support_submission', 'whatsapp_share'
     )
     or p_surface not in (
       'server_component', 'server_action', 'route_handler', 'rpc',
       'assistant', 'dsar', 'whatsapp', 'feedback', 'shopify', 'worker',
       'sentry', 'posthog', 'resend', 'groq'
     ) then
    raise exception using errcode = '22023', message = 'pcd_access_audit_argument_rejected';
  end if;

  if p_idempotency_key is not null
     and (length(p_idempotency_key) not between 1 and 96
       or p_idempotency_key !~ '^[A-Za-z0-9._:-]+$') then
    raise exception using errcode = '22023', message = 'pcd_access_audit_idempotency_rejected';
  end if;

  if not public.validate_pcd_access_audit_metadata(coalesce(p_metadata, '{}'::jsonb)) then
    raise exception using errcode = '22023', message = 'pcd_access_audit_metadata_rejected';
  end if;

  if p_actor_kind = 'human' then
    if p_service_kind is not null
       or auth.role() <> 'authenticated'
       or auth.uid() is null then
      raise exception using errcode = '42501', message = 'pcd_access_audit_human_actor_required';
    end if;

    v_actor_user_id := auth.uid();
    if not exists (
      select 1
      from public.merchant_member member
      where member.merchant_account_id = p_tenant_id
        and member.user_id = v_actor_user_id
    ) then
      raise exception using errcode = '42501', message = 'pcd_access_audit_tenant_forbidden';
    end if;
  elsif p_actor_kind = 'service' then
    if p_service_kind is null
       or p_service_kind not in ('webhook', 'cron', 'worker', 'service_role', 'shopify_sync', 'dsar_worker')
       or auth.role() <> 'service_role' then
      raise exception using errcode = '42501', message = 'pcd_access_audit_service_actor_required';
    end if;
  end if;

  if p_shop_id is not null and not exists (
    select 1
    from public.shop
    where id = p_shop_id
      and merchant_account_id = p_tenant_id
  ) then
    raise exception using errcode = '42501', message = 'pcd_access_audit_shop_forbidden';
  end if;

  insert into public.pcd_access_audit (
    tenant_id, shop_id, actor_user_id, actor_kind, service_kind, action,
    data_category, purpose, outcome, resource_type, resource_id, surface,
    metadata, idempotency_key
  ) values (
    p_tenant_id, p_shop_id, v_actor_user_id, p_actor_kind, p_service_kind, p_action,
    p_data_category, p_purpose, p_outcome, p_resource_type, p_resource_id, p_surface,
    coalesce(p_metadata, '{}'::jsonb), p_idempotency_key
  )
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id
    from public.pcd_access_audit
    where tenant_id = p_tenant_id
      and idempotency_key = p_idempotency_key;
  end if;

  if v_id is null then
    raise exception using errcode = 'XX000', message = 'pcd_access_audit_write_failed';
  end if;
  return v_id;
end;
$$;

revoke all on function public.log_pcd_access_event(
  uuid, uuid, text, text, text, text, text, text, text, uuid, text, jsonb, text
) from public, anon;
grant execute on function public.log_pcd_access_event(
  uuid, uuid, text, text, text, text, text, text, text, uuid, text, jsonb, text
) to authenticated, service_role;

comment on function public.log_pcd_access_event(
  uuid, uuid, text, text, text, text, text, text, text, uuid, text, jsonb, text
) is
  'S1D-3R SQL-bounded append-only PCD access audit writer; no PCD, secrets, payloads or free-form metadata.';
