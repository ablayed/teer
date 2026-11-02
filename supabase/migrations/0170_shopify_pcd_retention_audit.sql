-- Trace chaque suppression d’identité effectuée par la purge de rétention.
-- La définition, SECURITY DEFINER, search_path et les ACL sont conservées par
-- CREATE OR REPLACE ; aucun nouvel objet ni nouveau droit n’est introduit.

create or replace function public.execute_shopify_pcd_retention(
  p_limit integer,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_retryable_payload_count integer := 0;
  v_historical_payload_count integer := 0;
  v_tombstone_count integer := 0;
  v_order_count integer := 0;
  v_delivery_count integer := 0;
  v_identity_count integer := 0;
  v_identity_error_count integer := 0;
  v_error_count integer := 0;
  v_customer record;
  v_summary jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_retention_limit' using errcode = '22023';
  end if;

  insert into public.shopify_pcd_purge_run (id, mode, status, limit_requested, started_at, last_attempt_at)
  values (v_run_id, 'execute', 'running', p_limit, p_now, p_now);

  with targets as (
    select e.id
      from public.webhook_event e
     where e.status = 'retryable'
       and e.received_at <= p_now - interval '7 days'
     order by e.received_at, e.id
     for update skip locked
     limit p_limit
  )
  update public.webhook_event e
     set status = 'terminal',
         processed = false,
         payload = null,
         next_attempt_at = null,
         lease_until = null,
         completed_at = p_now,
         last_error_code = 'retention_payload_expired',
         retention_attempt_count = e.retention_attempt_count + 1,
         retention_last_attempt_at = p_now,
         retention_last_success_at = p_now,
         retention_last_error_code = null,
         retention_next_attempt_at = null
    from targets t
   where e.id = t.id;
  get diagnostics v_retryable_payload_count = row_count;

  with targets as (
    select e.id
      from public.webhook_event e
     where e.status in ('done', 'terminal')
       and e.payload is not null
     order by e.received_at, e.id
     for update skip locked
     limit p_limit
  )
  update public.webhook_event e
     set payload = null,
         retention_attempt_count = e.retention_attempt_count + 1,
         retention_last_attempt_at = p_now,
         retention_last_success_at = p_now,
         retention_last_error_code = null
    from targets t
   where e.id = t.id;
  get diagnostics v_historical_payload_count = row_count;

  with targets as (
    select t.id
      from public.shopify_customer_redaction_tombstone t
     where t.expires_at <= p_now
     order by t.expires_at, t.id
     for update skip locked
     limit p_limit
  )
  delete from public.shopify_customer_redaction_tombstone t
   using targets x
   where t.id = x.id;
  get diagnostics v_tombstone_count = row_count;

  with targets as (
    select o.id
      from public.orders o
      join public.shopify_pcd_retention_candidates(p_now) c
        on c.target_id = o.id
       and c.category = 'expired_order_address'
       and c.blocked_reason is null
     order by c.expires_at, o.id
     for update of o skip locked
     limit p_limit
  )
  update public.orders o
     set shipping_address = null,
         updated_at = p_now
    from targets t
   where o.id = t.id;
  get diagnostics v_order_count = row_count;

  with targets as (
    select d.id
      from public.delivery_address d
      join public.orders o on o.id = d.order_id
      join public.shopify_pcd_retention_candidates(p_now) c
        on c.target_id = o.id
       and c.category = 'expired_order_address'
       and c.blocked_reason is null
     order by c.expires_at, d.id
     for update of d skip locked
     limit p_limit
  )
  delete from public.delivery_address d
   using targets t
   where d.id = t.id;
  get diagnostics v_delivery_count = row_count;

  for v_customer in
    select c.id,
           c.merchant_account_id,
           scope.shop_id,
           coalesce(c.shopify_customer_id, c.shopify_customer_gids ->> 0) as shopify_customer_id
      from public.customer c
      join lateral (
        select candidate.shop_id
          from public.shopify_pcd_retention_candidates(p_now) candidate
         where candidate.category = 'expired_customer_identity'
           and candidate.target_id = c.id
           and candidate.blocked_reason is null
         limit 1
      ) scope on true
     order by c.shopify_last_activity_at, c.id
     for update of c skip locked
     limit p_limit
  loop
    begin
      perform public.redact_shopify_customer_copies(
        v_customer.merchant_account_id,
        v_customer.shop_id,
        v_customer.shopify_customer_id,
        'customers/redact',
        null
      );
      update public.customer
         set shopify_last_activity_at = null
       where id = v_customer.id;

      insert into public.audit_log (
        merchant_account_id,
        actor_user_id,
        action,
        resource_type,
        resource_id,
        payload
      ) values (
        v_customer.merchant_account_id,
        null,
        'retention.customer_identity_purged',
        'shop',
        v_customer.shop_id,
        jsonb_build_object(
          'status', 'done',
          'counts', jsonb_build_object('customer_identity_count', 1)
        )
      );

      v_identity_count := v_identity_count + 1;
    exception when others then
      v_identity_error_count := v_identity_error_count + 1;
    end;
  end loop;

  v_error_count := v_identity_error_count;
  v_summary := jsonb_build_object(
    'run_id', v_run_id,
    'retryable_payload_count', v_retryable_payload_count,
    'historical_payload_count', v_historical_payload_count,
    'tombstone_count', v_tombstone_count,
    'order_address_count', v_order_count,
    'delivery_address_count', v_delivery_count,
    'customer_identity_count', v_identity_count,
    'error_count', v_error_count
  );

  update public.shopify_pcd_purge_run
     set status = case when v_error_count = 0 then 'done' else 'partial' end,
         summary = v_summary,
         completed_at = p_now,
         last_success_at = case when v_error_count = 0 then p_now else null end
   where id = v_run_id;

  return v_summary;
exception when others then
  update public.shopify_pcd_purge_run
     set status = 'failed',
         error_code = 'retention_execution_failed',
         completed_at = p_now,
         summary = jsonb_build_object('run_id', v_run_id, 'error_count', 1)
   where id = v_run_id;
  raise exception 'retention_execution_failed';
end;
$$;
