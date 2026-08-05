-- 0124 — S1C-2 : contrôles bornés des accès PCD et téléchargements DSAR one-shot
--
-- Les tables ci-dessous ne contiennent aucune valeur PCD. Les écritures passent
-- exclusivement par des fonctions SECURITY DEFINER contrôlées. Les limites de
-- quota et la durée d'autorisation sont des décisions produit provisoires.

alter table public.pcd_access_audit
  add column if not exists idempotency_key text;

alter table public.pcd_access_audit
  drop constraint if exists pcd_access_audit_action_check;

alter table public.pcd_access_audit
  drop constraint if exists pcd_access_audit_resource_type_check;

alter table public.pcd_access_audit
  drop constraint if exists pcd_access_audit_surface_check;

alter table public.pcd_access_audit
  add constraint pcd_access_audit_action_check check (action in (
    'view_detail',
    'search',
    'list_access',
    'generate_export',
    'download_export',
    'generate_signed_url',
    'generate_download_authorization',
    'external_share',
    'privileged_read',
    'ai_processing',
    'support_submission'
  ));

alter table public.pcd_access_audit
  add constraint pcd_access_audit_resource_type_check check (resource_type in (
    'order', 'customer', 'driver', 'member', 'delivery_address', 'dsar_artifact', 'export',
    'assistant', 'feedback', 'shopify_payload', 'support_submission', 'whatsapp_share'
  ));

alter table public.pcd_access_audit
  add constraint pcd_access_audit_surface_check check (surface in (
    'server_component', 'server_action', 'route_handler', 'rpc', 'assistant', 'dsar',
    'whatsapp', 'feedback', 'shopify', 'worker', 'sentry', 'posthog', 'resend', 'groq'
  ));

alter table public.pcd_access_audit
  add constraint pcd_access_audit_idempotency_key_safe check (
    idempotency_key is null
    or (
      length(idempotency_key) between 1 and 128
      and idempotency_key ~ '^[A-Za-z0-9._:-]+$'
    )
  );

create unique index if not exists pcd_access_audit_tenant_idempotency_idx
  on public.pcd_access_audit (tenant_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.validate_pcd_access_audit_metadata(p_metadata jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
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

    if jsonb_typeof(v_value) not in ('string', 'number', 'boolean', 'null') then
      return false;
    end if;

    if jsonb_typeof(v_value) = 'string' and length(v_value #>> '{}') > 128 then
      return false;
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
      if jsonb_typeof(v_value) <> 'number'
         or (v_value #>> '{}')::numeric < 100
         or (v_value #>> '{}')::numeric > 599
         or (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric) then
        return false;
      end if;
    end if;
  end loop;

  return true;
exception when others then
  return false;
end;
$$;

drop function if exists public.log_pcd_access_event(uuid, uuid, text, text, text, text, text, text, text, uuid, text, jsonb);

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
  if not public.validate_pcd_access_audit_metadata(coalesce(p_metadata, '{}'::jsonb)) then
    raise exception using errcode = '22023', message = 'pcd_access_audit_metadata_rejected';
  end if;

  if p_idempotency_key is not null
     and (length(p_idempotency_key) not between 1 and 128
       or p_idempotency_key !~ '^[A-Za-z0-9._:-]+$') then
    raise exception using errcode = '22023', message = 'pcd_access_audit_idempotency_rejected';
  end if;

  if p_actor_kind = 'human' then
    if auth.role() <> 'authenticated' or auth.uid() is null then
      raise exception using errcode = '42501', message = 'pcd_access_audit_human_actor_required';
    end if;
    v_actor_user_id := auth.uid();
    if not exists (
      select 1 from public.merchant_member member
      where member.merchant_account_id = p_tenant_id
        and member.user_id = v_actor_user_id
    ) then
      raise exception using errcode = '42501', message = 'pcd_access_audit_tenant_forbidden';
    end if;
  elsif p_actor_kind = 'service' then
    if auth.role() <> 'service_role' then
      raise exception using errcode = '42501', message = 'pcd_access_audit_service_actor_required';
    end if;
  else
    raise exception using errcode = '22023', message = 'pcd_access_audit_actor_kind_rejected';
  end if;

  if p_shop_id is not null and not exists (
    select 1 from public.shop
    where id = p_shop_id and merchant_account_id = p_tenant_id
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
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  end if;

  if v_id is null then
    raise exception using errcode = 'XX000', message = 'pcd_access_audit_write_failed';
  end if;
  return v_id;
end;
$$;

revoke all on function public.log_pcd_access_event(uuid, uuid, text, text, text, text, text, text, text, uuid, text, jsonb, text) from public;
grant execute on function public.log_pcd_access_event(uuid, uuid, text, text, text, text, text, text, text, uuid, text, jsonb, text) to authenticated, service_role;

create table public.pcd_access_quota_policy (
  action text primary key check (action in (
    'search', 'generate_export', 'download_export',
    'generate_download_authorization', 'external_share'
  )),
  window_seconds integer not null check (window_seconds between 60 and 86400),
  max_count integer not null check (max_count between 1 and 500),
  updated_at timestamptz not null default clock_timestamp()
);

insert into public.pcd_access_quota_policy (action, window_seconds, max_count) values
  ('generate_export', 900, 5),
  ('download_export', 900, 5),
  ('generate_download_authorization', 86400, 3),
  ('external_share', 900, 20),
  ('search', 60, 60)
on conflict (action) do update set window_seconds = excluded.window_seconds, max_count = excluded.max_count;

create table public.pcd_access_quota_bucket (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.merchant_account(id) on delete cascade,
  shop_id uuid references public.shop(id) on delete cascade,
  actor_scope_key text not null check (actor_scope_key ~ '^[A-Za-z0-9:_-]{1,160}$'),
  action text not null references public.pcd_access_quota_policy(action),
  window_start timestamptz not null,
  count integer not null check (count between 0 and 5000),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create unique index pcd_access_quota_bucket_scope_idx
  on public.pcd_access_quota_bucket (
    tenant_id,
    coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid),
    actor_scope_key,
    action,
    window_start
  );

create index pcd_access_quota_bucket_expiry_idx
  on public.pcd_access_quota_bucket (window_start, updated_at);

alter table public.pcd_access_quota_policy enable row level security;
alter table public.pcd_access_quota_policy force row level security;
alter table public.pcd_access_quota_bucket enable row level security;
alter table public.pcd_access_quota_bucket force row level security;
revoke all on table public.pcd_access_quota_policy, public.pcd_access_quota_bucket from public, anon, authenticated;

create or replace function public.consume_pcd_access_quota(
  p_tenant_id uuid,
  p_shop_id uuid,
  p_actor_kind text,
  p_service_kind text,
  p_action text
)
returns table (allowed boolean, current_count integer, max_count integer, window_start timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_scope_key text;
  v_window_start timestamptz;
  v_policy public.pcd_access_quota_policy%rowtype;
  v_count integer;
begin
  select * into v_policy from public.pcd_access_quota_policy where action = p_action;
  if not found then
    raise exception using errcode = '22023', message = 'pcd_quota_action_rejected';
  end if;

  if p_actor_kind = 'human' then
    if auth.role() <> 'authenticated' or v_uid is null
       or not exists (select 1 from public.merchant_member where merchant_account_id = p_tenant_id and user_id = v_uid) then
      raise exception using errcode = '42501', message = 'pcd_quota_actor_forbidden';
    end if;
    v_scope_key := 'user:' || v_uid::text;
  elsif p_actor_kind = 'service' and auth.role() = 'service_role' and p_service_kind in ('worker','service_role','shopify_sync','dsar_worker','webhook','cron') then
    v_scope_key := 'service:' || p_service_kind;
  else
    raise exception using errcode = '42501', message = 'pcd_quota_actor_forbidden';
  end if;

  if p_shop_id is not null and not exists (select 1 from public.shop where id = p_shop_id and merchant_account_id = p_tenant_id) then
    raise exception using errcode = '42501', message = 'pcd_quota_shop_forbidden';
  end if;

  v_window_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / v_policy.window_seconds) * v_policy.window_seconds);

  insert into public.pcd_access_quota_bucket (tenant_id, shop_id, actor_scope_key, action, window_start, count)
  values (p_tenant_id, p_shop_id, v_scope_key, p_action, v_window_start, 1)
  on conflict (tenant_id, (coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid)), actor_scope_key, action, window_start)
  do update set count = public.pcd_access_quota_bucket.count + 1,
                updated_at = clock_timestamp()
  where public.pcd_access_quota_bucket.count < v_policy.max_count
  returning public.pcd_access_quota_bucket.count into v_count;

  if v_count is null then
    select quota_bucket.count into v_count
    from public.pcd_access_quota_bucket quota_bucket
    where quota_bucket.tenant_id = p_tenant_id
      and quota_bucket.shop_id is not distinct from p_shop_id
      and quota_bucket.actor_scope_key = v_scope_key
      and quota_bucket.action = p_action
      and quota_bucket.window_start = v_window_start;
    return query select false, coalesce(v_count, v_policy.max_count), v_policy.max_count, v_window_start;
  else
    return query select true, v_count, v_policy.max_count, v_window_start;
  end if;
end;
$$;

revoke all on function public.consume_pcd_access_quota(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.consume_pcd_access_quota(uuid, uuid, text, text, text) to authenticated, service_role;

create table public.shopify_dsar_download_authorization (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  tenant_id uuid not null references public.merchant_account(id) on delete cascade,
  shop_id uuid not null references public.shop(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  artifact_id uuid not null references public.shopify_dsar_artifact(id) on delete cascade,
  purpose text not null check (purpose = 'legal_request'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

create index shopify_dsar_download_authorization_lookup_idx
  on public.shopify_dsar_download_authorization (token_hash, expires_at)
  where consumed_at is null;

alter table public.shopify_dsar_download_authorization enable row level security;
alter table public.shopify_dsar_download_authorization force row level security;
revoke all on table public.shopify_dsar_download_authorization from public, anon, authenticated;

create or replace function public.issue_shopify_dsar_download_authorization(
  p_tenant_id uuid,
  p_shop_id uuid,
  p_artifact_id uuid
)
returns table (download_token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires timestamptz := clock_timestamp() + interval '10 minutes';
begin
  if auth.role() <> 'authenticated' or v_uid is null
     or not exists (
       select 1 from public.merchant_member
       where merchant_account_id = p_tenant_id and user_id = v_uid and role in ('owner','manager')
     )
     or not exists (select 1 from public.shop where id = p_shop_id and merchant_account_id = p_tenant_id)
    or not exists (
       select 1 from public.shopify_dsar_artifact artifact
       where artifact.id = p_artifact_id and artifact.merchant_account_id = p_tenant_id and artifact.shop_id = p_shop_id and artifact.status = 'ready' and artifact.expires_at > clock_timestamp()
     ) then
    raise exception using errcode = '42501', message = 'dsar_download_authorization_forbidden';
  end if;

  insert into public.shopify_dsar_download_authorization (
    token_hash, tenant_id, shop_id, actor_user_id, artifact_id, purpose, expires_at
  ) values (
    encode(extensions.digest(v_token, 'sha256'), 'hex'), p_tenant_id, p_shop_id, v_uid, p_artifact_id, 'legal_request', v_expires
  );

  return query select v_token, v_expires;
end;
$$;

create or replace function public.consume_shopify_dsar_download_authorization(
  p_download_token text,
  p_tenant_id uuid,
  p_shop_id uuid,
  p_artifact_id uuid
)
returns table (authorization_id uuid, storage_bucket text, storage_path text, byte_size bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if auth.role() <> 'authenticated' or v_uid is null or length(p_download_token) <> 64 or p_download_token !~ '^[0-9a-f]+$' then
    raise exception using errcode = '42501', message = 'dsar_download_authorization_forbidden';
  end if;

  update public.shopify_dsar_download_authorization
  set consumed_at = clock_timestamp()
  where token_hash = encode(extensions.digest(p_download_token, 'sha256'), 'hex')
    and tenant_id = p_tenant_id
    and shop_id = p_shop_id
    and artifact_id = p_artifact_id
    and actor_user_id = v_uid
    and consumed_at is null
    and expires_at > clock_timestamp()
  returning id into v_id;

  if v_id is null then
    raise exception using errcode = '42501', message = 'dsar_download_authorization_forbidden';
  end if;

  return query
    select v_id, artifact.storage_bucket, artifact.storage_path, coalesce(artifact.byte_size, 0)::bigint
    from public.shopify_dsar_artifact artifact
    where artifact.id = p_artifact_id
      and artifact.merchant_account_id = p_tenant_id
      and artifact.shop_id = p_shop_id
      and artifact.status = 'ready';
end;
$$;

revoke all on function public.issue_shopify_dsar_download_authorization(uuid, uuid, uuid) from public, anon;
revoke all on function public.consume_shopify_dsar_download_authorization(text, uuid, uuid, uuid) from public, anon;
grant execute on function public.issue_shopify_dsar_download_authorization(uuid, uuid, uuid) to authenticated;
grant execute on function public.consume_shopify_dsar_download_authorization(text, uuid, uuid, uuid) to authenticated;

create or replace function public.purge_pcd_access_controls(
  p_before timestamptz,
  p_batch_size integer default 100
)
returns table (quota_rows integer, authorization_rows integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quota integer := 0;
  v_authorizations integer := 0;
begin
  if auth.role() <> 'service_role' or p_batch_size is null or p_batch_size not between 1 and 500 then
    raise exception using errcode = '42501', message = 'pcd_access_controls_maintenance_forbidden';
  end if;

  with removed as (
    delete from public.pcd_access_quota_bucket
    where id in (select id from public.pcd_access_quota_bucket where window_start < p_before order by window_start limit p_batch_size)
    returning 1
  ) select count(*) into v_quota from removed;

  with removed as (
    delete from public.shopify_dsar_download_authorization
    where id in (select id from public.shopify_dsar_download_authorization where expires_at < p_before order by expires_at limit p_batch_size)
    returning 1
  ) select count(*) into v_authorizations from removed;

  return query select v_quota, v_authorizations;
end;
$$;

revoke all on function public.purge_pcd_access_controls(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.purge_pcd_access_controls(timestamptz, integer) to service_role;

comment on table public.pcd_access_quota_bucket is
  'S1C-2 bounded counters only; no PCD, no direct client writes; limits are provisional product decisions.';
comment on table public.shopify_dsar_download_authorization is
  'S1C-2 one-shot DSAR authorization; only a SHA-256 token hash is stored, never the opaque token or artifact content.';
comment on function public.purge_pcd_access_controls(timestamptz, integer) is
  'Local/service-only bounded cleanup; no remote cron is activated by this migration.';
