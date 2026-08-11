-- 0121 — Cycle de vie durable des traitements GDPR Shopify.
--
-- Cette migration ne met en place aucun cron. Elle fournit les invariants SQL
-- utilisés par les traitements locaux et par les tests :
--   * état/rejeu des webhooks avec lease et SKIP LOCKED ;
--   * redaction multi-table dans une seule transaction ;
--   * tombstones anti-réimport, limités à une boutique ;
--   * métadonnées DSAR sans contenu PCD.

alter table public.webhook_event
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_until timestamptz,
  add column if not exists last_error_code text,
  add column if not exists completed_at timestamptz,
  add column if not exists processing_proof jsonb;

-- Les anciens états `error` et `processing` sont récupérables. Les payloads des
-- événements déjà terminés ne sont plus nécessaires et sont supprimés ici.
update public.webhook_event
   set status = 'retryable',
       processed = false,
       attempt_count = greatest(attempt_count, 1),
       next_attempt_at = coalesce(next_attempt_at, now()),
       last_error_code = coalesce(last_error_code, 'legacy_processing_recovery'),
       lease_until = null
 where status in ('error', 'processing');

update public.webhook_event
   set payload = null
 where status = 'done'
   and payload is not null;

alter table public.webhook_event
  drop constraint if exists webhook_event_status_check;

alter table public.webhook_event
  add constraint webhook_event_status_check
  check (status in ('processing', 'retryable', 'terminal', 'done'));

alter table public.webhook_event
  add constraint webhook_event_attempt_count_check
  check (attempt_count between 0 and 1000),
  add constraint webhook_event_last_error_code_check
  check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$');

create index if not exists webhook_event_retry_claim_idx
  on public.webhook_event (status, next_attempt_at, lease_until, received_at);

create table public.shopify_customer_redaction_tombstone (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  shop_id uuid not null references public.shop(id) on delete cascade,
  shopify_customer_id text not null check (btrim(shopify_customer_id) <> ''),
  redacted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint shopify_customer_redaction_tombstone_expiry_check
    check (expires_at > redacted_at),
  constraint shopify_customer_redaction_tombstone_unique
    unique (merchant_account_id, shop_id, shopify_customer_id)
);

create index shopify_customer_redaction_tombstone_lookup_idx
  on public.shopify_customer_redaction_tombstone
    (merchant_account_id, shop_id, shopify_customer_id, expires_at);

alter table public.shopify_customer_redaction_tombstone enable row level security;
alter table public.shopify_customer_redaction_tombstone force row level security;
revoke all on table public.shopify_customer_redaction_tombstone
  from public, anon, authenticated;
grant all on table public.shopify_customer_redaction_tombstone to service_role;

create table public.shopify_dsar_artifact (
  id uuid primary key default gen_random_uuid(),
  webhook_event_id uuid not null references public.webhook_event(id) on delete restrict,
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  shop_id uuid not null references public.shop(id) on delete cascade,
  storage_bucket text not null default 'shopify-dsar'
    check (storage_bucket = 'shopify-dsar'),
  storage_path text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'ready', 'expired', 'failed')),
  byte_size bigint,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint shopify_dsar_artifact_expiry_check
    check (expires_at > created_at),
  constraint shopify_dsar_artifact_event_unique
    unique (webhook_event_id)
);

create index shopify_dsar_artifact_lookup_idx
  on public.shopify_dsar_artifact (merchant_account_id, shop_id, expires_at);

alter table public.shopify_dsar_artifact enable row level security;
alter table public.shopify_dsar_artifact force row level security;
revoke all on table public.shopify_dsar_artifact
  from public, anon, authenticated;
grant all on table public.shopify_dsar_artifact to service_role;

-- Le bucket est privé. Aucun droit Storage n'est accordé à `authenticated` :
-- l'application génère éventuellement une URL signée après contrôle serveur du rôle.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shopify-dsar', 'shopify-dsar', false, 5242880, array['application/json']::text[])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

do $$
declare
  v_before bigint;
  v_after bigint;
begin
  select count(*) into v_before
    from public.audit_log
   where action = 'gdpr.customers/data_request'
     and payload ? 'compiled';

  raise notice '0121 historical DSAR audit payloads before=%', v_before;

  update public.audit_log
     set payload = jsonb_build_object(
       'status', 'historical_dsar_payload_redacted',
       'migration', '0121'
     )
   where action = 'gdpr.customers/data_request'
     and payload ? 'compiled';

  select count(*) into v_after
    from public.audit_log
   where action = 'gdpr.customers/data_request'
     and payload ? 'compiled';

  raise notice '0121 historical DSAR audit payloads after=%', v_after;
end;
$$;

create or replace function public.claim_shopify_webhook_events(
  p_limit integer,
  p_event_id uuid default null,
  p_now timestamptz default now()
)
returns table (
  id uuid,
  topic text,
  shop_domain text,
  shop_id uuid,
  merchant_account_id uuid,
  payload jsonb,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_claim_limit' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select e.id
      from public.webhook_event e
     where (p_event_id is null or e.id = p_event_id)
       and (
         (e.status = 'retryable' and e.next_attempt_at <= p_now)
         or (e.status = 'processing' and (e.lease_until is null or e.lease_until < p_now))
       )
     order by coalesce(e.next_attempt_at, e.received_at), e.id
     for update skip locked
     limit p_limit
  ), claimed as (
    update public.webhook_event e
       set status = 'processing',
           processed = false,
           attempt_count = e.attempt_count + 1,
           lease_until = p_now + interval '5 minutes',
           next_attempt_at = null
      from candidates c
     where e.id = c.id
     returning e.id, e.topic, e.shop_domain, e.shop_id,
               e.merchant_account_id, e.payload, e.attempt_count
  )
  select c.id, c.topic, c.shop_domain, c.shop_id,
         c.merchant_account_id, c.payload, c.attempt_count
    from claimed c;
end;
$$;

revoke all on function public.claim_shopify_webhook_events(integer, uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_shopify_webhook_events(integer, uuid, timestamptz)
  to service_role;

create or replace function public.finish_shopify_webhook_event(
  p_event_id uuid,
  p_outcome text,
  p_error_code text default null,
  p_proof jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
  v_next_attempt timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_outcome not in ('done', 'retryable', 'terminal') then
    raise exception 'invalid_webhook_outcome' using errcode = '22023';
  end if;

  if p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'invalid_webhook_error_code' using errcode = '22023';
  end if;

  update public.webhook_event e
     set status = p_outcome,
         processed = p_outcome = 'done',
         payload = case when p_outcome in ('done', 'terminal') then null else e.payload end,
         next_attempt_at = case
           when p_outcome = 'retryable' then
             now() + make_interval(secs => least(3600, (2 ^ least(greatest(e.attempt_count, 1), 12))::integer))
           else null
         end,
         lease_until = null,
         last_error_code = case when p_outcome = 'done' then null else p_error_code end,
         completed_at = case when p_outcome in ('done', 'terminal') then now() else null end,
         processing_proof = case when p_outcome = 'done' then p_proof else null end
   where e.id = p_event_id
     and e.status = 'processing';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.finish_shopify_webhook_event(uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_shopify_webhook_event(uuid, text, text, jsonb)
  to service_role;

-- Redaction transactionnelle : toutes les tables ciblées sont modifiées dans
-- la même exécution SQL. Un échec lève une exception et annule toute la transaction.
create or replace function public.redact_shopify_customer_copies(
  p_merchant_account_id uuid,
  p_shop_id uuid,
  p_shopify_customer_id text,
  p_topic text,
  p_webhook_event_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_ids uuid[] := '{}'::uuid[];
  v_global_ids uuid[] := '{}'::uuid[];
  v_target_ids uuid[] := '{}'::uuid[];
  v_order_ids uuid[] := '{}'::uuid[];
  v_tombstone_ids text[] := '{}'::text[];
  v_customer_count integer := 0;
  v_order_count integer := 0;
  v_delivery_count integer := 0;
  v_tombstone_count integer := 0;
  v_webhook_payload_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_topic not in ('customers/redact', 'shop/redact') then
    raise exception 'invalid_gdpr_topic' using errcode = '22023';
  end if;

  if p_shop_id is null or p_merchant_account_id is null then
    raise exception 'missing_gdpr_scope' using errcode = '22023';
  end if;

  if p_topic = 'customers/redact' and nullif(btrim(p_shopify_customer_id), '') is null then
    raise exception 'missing_shopify_customer_id' using errcode = '22023';
  end if;

  if p_topic = 'customers/redact' then
    select coalesce(array_agg(c.id), '{}'::uuid[])
      into v_customer_ids
      from public.customer c
     where c.merchant_account_id = p_merchant_account_id
       and (
         c.shopify_customer_id = p_shopify_customer_id
         or c.shopify_customer_gids @> jsonb_build_array(p_shopify_customer_id)
       );
    v_target_ids := v_customer_ids;
  else
    select coalesce(array_agg(distinct o.customer_id), '{}'::uuid[])
      into v_customer_ids
      from public.orders o
     where o.merchant_account_id = p_merchant_account_id
       and o.shop_id = p_shop_id
       and o.customer_id is not null;

    -- Si la provenance boutique ne peut pas être séparée, la PCD du client
    -- est redacted globalement pour ce merchant, conformément à la décision S1B.
    select coalesce(array_agg(distinct o.customer_id), '{}'::uuid[])
      into v_global_ids
      from public.orders o
     where o.merchant_account_id = p_merchant_account_id
       and o.customer_id = any(v_customer_ids)
       and o.shop_id is distinct from p_shop_id;

    select coalesce(array_agg(x.id), '{}'::uuid[])
      into v_target_ids
      from unnest(v_customer_ids) as x(id);
  end if;

  select coalesce(array_agg(distinct o.id), '{}'::uuid[])
    into v_order_ids
    from public.orders o
   where o.merchant_account_id = p_merchant_account_id
     and (
       (p_topic = 'customers/redact' and o.customer_id = any(v_target_ids))
       or (p_topic = 'shop/redact' and (
         o.shop_id = p_shop_id and o.customer_id = any(v_target_ids)
       or o.customer_id = any(v_global_ids)
       ))
     );

  -- Les identifiants Shopify sont techniques et restent disponibles pour le
  -- tombstone, mais aucune PCD directe ne survit.
  update public.customer c
     set full_name = '[client supprimé]',
         first_name = null,
         last_name = null,
         phone = null,
         phone_e164 = null,
         address = null,
         shipping_address = null,
         updated_at = now()
   where c.merchant_account_id = p_merchant_account_id
     and c.id = any(v_target_ids);
  get diagnostics v_customer_count = row_count;

  update public.orders o
     set shipping_address = null,
         note = null,
         shopify_order_attributes = null,
         shopify_line_item_attributes = null,
         updated_at = now()
   where o.merchant_account_id = p_merchant_account_id
     and o.id = any(v_order_ids);
  get diagnostics v_order_count = row_count;

  delete from public.delivery_address d
   where d.merchant_account_id = p_merchant_account_id
     and (
       d.customer_id = any(v_target_ids)
       or d.order_id = any(v_order_ids)
     );
  get diagnostics v_delivery_count = row_count;

  if p_topic = 'customers/redact' then
    v_tombstone_ids := array[p_shopify_customer_id];
  else
    select coalesce(array_agg(distinct gid), '{}'::text[])
      into v_tombstone_ids
      from (
        select c.shopify_customer_id as gid
          from public.customer c
         where c.merchant_account_id = p_merchant_account_id
           and c.id = any(v_target_ids)
           and c.shopify_customer_id is not null
        union all
        select jsonb_array_elements_text(c.shopify_customer_gids)
          from public.customer c
         where c.merchant_account_id = p_merchant_account_id
           and c.id = any(v_target_ids)
      ) ids;
  end if;

  insert into public.shopify_customer_redaction_tombstone (
    merchant_account_id, shop_id, shopify_customer_id, redacted_at, expires_at
  )
  select p_merchant_account_id,
         case when p_topic = 'customers/redact' then s.id else p_shop_id end,
         gid,
         now(),
         now() + interval '12 months'
    from unnest(v_tombstone_ids) as t(gid)
    cross join public.shop s
   where s.merchant_account_id = p_merchant_account_id
     and (p_topic = 'customers/redact' or s.id = p_shop_id)
     and nullif(btrim(gid), '') is not null
  on conflict (merchant_account_id, shop_id, shopify_customer_id)
  do update set
    redacted_at = greatest(public.shopify_customer_redaction_tombstone.redacted_at, excluded.redacted_at),
    expires_at = greatest(public.shopify_customer_redaction_tombstone.expires_at, excluded.expires_at);
  get diagnostics v_tombstone_count = row_count;

  -- Les payloads bruts qui contiennent le client redacted sont eux-mêmes des
  -- copies PCD. L'événement courant est laissé au finalizeur, qui le nullifie
  -- après `done`; les autres tâches sont terminalisées sans payload afin de ne
  -- pas pouvoir réintroduire la PCD lors d'un rejeu ultérieur.
  update public.webhook_event e
     set payload = null,
         status = case when e.status in ('processing', 'retryable') then 'terminal' else e.status end,
         processed = case when e.status in ('processing', 'retryable') then false else e.processed end,
         last_error_code = case
           when e.status in ('processing', 'retryable') then 'redacted_customer_payload_removed'
           else e.last_error_code
         end,
         completed_at = case
           when e.status in ('processing', 'retryable') then now()
           else e.completed_at
         end,
         lease_until = null,
         next_attempt_at = null
   where e.id is distinct from p_webhook_event_id
     and e.merchant_account_id = p_merchant_account_id
     and (p_topic = 'customers/redact' or e.shop_id = p_shop_id)
     and e.payload -> 'customer' ->> 'id' = any(v_tombstone_ids);
  get diagnostics v_webhook_payload_count = row_count;

  return jsonb_build_object(
    'customer_count', v_customer_count,
    'order_count', v_order_count,
    'delivery_address_count', v_delivery_count,
    'tombstone_count', v_tombstone_count,
    'webhook_payload_count', v_webhook_payload_count
  );
end;
$$;

revoke all on function public.redact_shopify_customer_copies(uuid, uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.redact_shopify_customer_copies(uuid, uuid, text, text, uuid)
  to service_role;
