-- 0123 — S1C-1 : journal immuable des accès et exports PCD
--
-- Ce journal est distinct de public.audit_log : il ne stocke aucune valeur PCD,
-- n'accepte aucune écriture directe applicative et est lisible uniquement par
-- les owners du tenant dans le MVP.

create or replace function public.validate_pcd_access_audit_metadata(p_metadata jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
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
      'provider',
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
  end loop;

  return true;
end;
$$;

create table public.pcd_access_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.merchant_account(id) on delete cascade,
  shop_id uuid references public.shop(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_kind text not null check (actor_kind in ('human', 'service')),
  service_kind text,
  action text not null check (action in (
    'view_detail',
    'search',
    'list_access',
    'generate_export',
    'download_export',
    'generate_signed_url',
    'external_share',
    'privileged_read',
    'ai_processing',
    'support_submission'
  )),
  data_category text not null check (data_category in (
    'customer_identity',
    'customer_contact',
    'delivery_address',
    'shopify_payload',
    'dsar_artifact',
    'member_data',
    'merchant_data'
  )),
  purpose text not null check (purpose in (
    'order_fulfillment',
    'customer_support',
    'delivery_execution',
    'cash_reconciliation',
    'fraud_review',
    'legal_request',
    'external_share',
    'system_processing'
  )),
  outcome text not null check (outcome in ('allowed', 'denied', 'succeeded', 'failed')),
  resource_type text not null check (resource_type in (
    'order',
    'customer',
    'delivery_address',
    'dsar_artifact',
    'export',
    'assistant',
    'feedback',
    'shopify_payload',
    'support_submission',
    'whatsapp_share'
  )),
  resource_id uuid,
  surface text not null check (surface in (
    'server_action',
    'route_handler',
    'rpc',
    'assistant',
    'dsar',
    'whatsapp',
    'feedback',
    'shopify',
    'worker',
    'sentry',
    'posthog',
    'resend',
    'groq'
  )),
  occurred_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb,
  constraint pcd_access_audit_service_consistency check (
    (actor_kind = 'human' and actor_user_id is not null and service_kind is null)
    or
    (actor_kind = 'service' and actor_user_id is null and service_kind in (
      'webhook',
      'cron',
      'worker',
      'service_role',
      'shopify_sync',
      'dsar_worker'
    ))
  ),
  constraint pcd_access_audit_metadata_safe check (
    public.validate_pcd_access_audit_metadata(metadata)
  )
);

create index pcd_access_audit_tenant_occurred_idx
  on public.pcd_access_audit (tenant_id, occurred_at desc);

create index pcd_access_audit_tenant_shop_occurred_idx
  on public.pcd_access_audit (tenant_id, shop_id, occurred_at desc);

create index pcd_access_audit_tenant_actor_occurred_idx
  on public.pcd_access_audit (tenant_id, actor_user_id, occurred_at desc);

alter table public.pcd_access_audit enable row level security;
alter table public.pcd_access_audit force row level security;

revoke all on table public.pcd_access_audit from public, anon, authenticated;
grant select on table public.pcd_access_audit to authenticated;

create policy pcd_access_audit_owner_select
  on public.pcd_access_audit
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.merchant_member member
      where member.merchant_account_id = pcd_access_audit.tenant_id
        and member.user_id = auth.uid()
        and member.role = 'owner'
    )
  );

create or replace function public.prevent_pcd_access_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Maintenance n'est pas exposée à l'application. Elle nécessite un rôle
  -- service_role et un GUC explicitement positionné par un opérateur DB.
  if auth.role() = 'service_role'
     and current_setting('app.pcd_access_audit_maintenance', true) = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  raise exception using
    errcode = '42501',
    message = 'pcd_access_audit_is_append_only';
end;
$$;

revoke all on function public.prevent_pcd_access_audit_mutation() from public;

create trigger pcd_access_audit_prevent_update
  before update on public.pcd_access_audit
  for each row
  execute function public.prevent_pcd_access_audit_mutation();

create trigger pcd_access_audit_prevent_delete
  before delete on public.pcd_access_audit
  for each row
  execute function public.prevent_pcd_access_audit_mutation();

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
  p_metadata jsonb default '{}'::jsonb
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
    raise exception using
      errcode = '22023',
      message = 'pcd_access_audit_metadata_rejected';
  end if;

  if p_actor_kind = 'human' then
    if auth.role() <> 'authenticated' or auth.uid() is null then
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
    if auth.role() <> 'service_role' then
      raise exception using errcode = '42501', message = 'pcd_access_audit_service_actor_required';
    end if;
  else
    raise exception using errcode = '22023', message = 'pcd_access_audit_actor_kind_rejected';
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
    tenant_id,
    shop_id,
    actor_user_id,
    actor_kind,
    service_kind,
    action,
    data_category,
    purpose,
    outcome,
    resource_type,
    resource_id,
    surface,
    metadata
  ) values (
    p_tenant_id,
    p_shop_id,
    v_actor_user_id,
    p_actor_kind,
    p_service_kind,
    p_action,
    p_data_category,
    p_purpose,
    p_outcome,
    p_resource_type,
    p_resource_id,
    p_surface,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.log_pcd_access_event(
  uuid, uuid, text, text, text, text, text, text, text, uuid, text, jsonb
) from public;
grant execute on function public.log_pcd_access_event(
  uuid, uuid, text, text, text, text, text, text, text, uuid, text, jsonb
) to authenticated, service_role;

comment on table public.pcd_access_audit is
  'S1C-1 append-only audit of protected customer-data access and exports; values are forbidden.';
comment on column public.pcd_access_audit.metadata is
  'Strict technical allow-list only; never store PCD, URLs, payloads, messages, args or errors.';
comment on function public.prevent_pcd_access_audit_mutation() is
  'Only explicit DB maintenance with service_role and app.pcd_access_audit_maintenance=on may mutate rows.';

-- IA : le journal historique conserve sa forme pour compatibilitÃ©, mais les
-- arguments sont vidÃ©s et ne peuvent plus contenir autre chose que {}.
alter table public.ia_tool_audit
  add column if not exists data_category text not null default 'merchant_data';

update public.ia_tool_audit
set tool_args = '{}'::jsonb,
    data_category = case
      when data_category in (
        'customer_identity',
        'customer_contact',
        'delivery_address',
        'shopify_payload',
        'dsar_artifact',
        'member_data',
        'merchant_data'
      ) then data_category
      else 'merchant_data'
    end,
    denied_reason = case
      when denied_reason is null then null
      when denied_reason in ('unknown_tool', 'forbidden_role', 'invalid_args', 'execution_error')
        then denied_reason
      else 'execution_error'
    end;

alter table public.ia_tool_audit
  add constraint ia_tool_audit_tool_args_empty
  check (tool_args = '{}'::jsonb);

alter table public.ia_tool_audit
  add constraint ia_tool_audit_data_category_allowed
  check (data_category in (
    'customer_identity',
    'customer_contact',
    'delivery_address',
    'shopify_payload',
    'dsar_artifact',
    'member_data',
    'merchant_data'
  ));

alter table public.ia_tool_audit
  add constraint ia_tool_audit_denied_reason_allowed
  check (denied_reason is null or denied_reason in (
    'unknown_tool',
    'forbidden_role',
    'invalid_args',
    'execution_error'
  ));

drop function public.log_ia_tool_audit(uuid, text, text, jsonb, boolean, uuid, text, integer);

create function public.log_ia_tool_audit(
  p_merchant_account_id uuid,
  p_user_role           text,
  p_tool_name           text,
  p_tool_args           jsonb,
  p_allowed             boolean,
  p_conversation_id     uuid    default null,
  p_denied_reason       text    default null,
  p_latency_ms          integer default null,
  p_data_category       text    default 'merchant_data'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_denied_reason text := case
    when p_denied_reason in ('unknown_tool', 'forbidden_role', 'invalid_args', 'execution_error')
      then p_denied_reason
    when p_denied_reason is null then null
    else 'execution_error'
  end;
begin
  if v_uid is null or public.current_member_role(p_merchant_account_id) is null then
    return null;
  end if;

  if p_data_category not in (
    'customer_identity',
    'customer_contact',
    'delivery_address',
    'shopify_payload',
    'dsar_artifact',
    'member_data',
    'merchant_data'
  ) then
    return null;
  end if;

  insert into public.ia_tool_audit (
    merchant_account_id,
    user_id,
    user_role,
    conversation_id,
    tool_name,
    tool_args,
    data_category,
    allowed,
    denied_reason,
    latency_ms
  ) values (
    p_merchant_account_id,
    v_uid,
    p_user_role,
    p_conversation_id,
    p_tool_name,
    '{}'::jsonb,
    p_data_category,
    p_allowed,
    v_denied_reason,
    p_latency_ms
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.log_ia_tool_audit(
  uuid, text, text, jsonb, boolean, uuid, text, integer, text
) from public;
grant execute on function public.log_ia_tool_audit(
  uuid, text, text, jsonb, boolean, uuid, text, integer, text
) to authenticated;

-- Rétention technique provisoire : la date est fournie par l'appelant local,
-- avec une valeur produit recommandée de 12 mois documentée côté serveur.
-- Aucun cron ni appel distant n'est créé dans S1C-1.
create or replace function public.purge_pcd_access_audit(
  p_before timestamptz,
  p_batch_size integer default 500
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'pcd_access_audit_service_only';
  end if;

  if p_before is null or p_batch_size < 1 or p_batch_size > 500 then
    raise exception using errcode = '22023', message = 'pcd_access_audit_purge_arguments_rejected';
  end if;

  perform set_config('app.pcd_access_audit_maintenance', 'on', true);
  with victims as (
    select id
    from public.pcd_access_audit
    where occurred_at < p_before
    order by occurred_at asc, id asc
    limit p_batch_size
  )
  delete from public.pcd_access_audit audit
  using victims
  where audit.id = victims.id;
  get diagnostics v_deleted = row_count;
  perform set_config('app.pcd_access_audit_maintenance', 'off', true);
  return v_deleted;
exception
  when others then
    perform set_config('app.pcd_access_audit_maintenance', 'off', true);
    raise;
end;
$$;

revoke all on function public.purge_pcd_access_audit(timestamptz, integer) from public;
grant execute on function public.purge_pcd_access_audit(timestamptz, integer) to service_role;
