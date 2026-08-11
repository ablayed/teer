-- 0122 — Rétention temporelle et purge Shopify PCD.
--
-- Les durées ci-dessous sont des décisions produit à valider juridiquement :
--   * adresses de commande : 90 jours après une transition finale certaine ;
--   * identité Shopify : 12 mois après la dernière activité Shopify certaine ;
--   * payload GDPR retryable : 7 jours après réception ;
--   * artefact DSAR : 24 heures après finalisation ;
--   * tombstone : suppression après expiration de ses 12 mois.
--
-- Toute la sélection de candidats passe par shopify_pcd_retention_candidates().
-- Aucun contenu PCD n'est retourné par les fonctions publiques de preview/purge.

alter table public.orders
  add column if not exists pcd_finalized_at timestamptz;

alter table public.customer
  add column if not exists shopify_last_activity_at timestamptz;

-- Backfill strict : uniquement une transition métier finale connue. Une ligne
-- finale sans transition reste NULL et ne pourra pas être purgée par ce lot.
update public.orders o
   set pcd_finalized_at = (
     select max(t.created_at)
       from public.order_state_transition t
      where t.order_id = o.id
        and t.merchant_account_id = o.merchant_account_id
        and t.to_status in ('LIVREE', 'REFUSEE', 'ANNULEE')
   )
 where o.pcd_finalized_at is null
   and (o.order_state in ('completed', 'cancelled', 'returned')
     or o.delivery_state in ('delivered', 'failed', 'returned'))
   and exists (
     select 1
       from public.order_state_transition t
      where t.order_id = o.id
        and t.merchant_account_id = o.merchant_account_id
        and t.to_status in ('LIVREE', 'REFUSEE', 'ANNULEE')
   );

-- Activité Shopify certaine : création ou dernière modification Shopify d'une
-- commande. Les commandes locales et updated_at local ne sont jamais utilisées.
update public.customer c
   set shopify_last_activity_at = activity.last_activity_at
  from (
    select o.customer_id, max(coalesce(o.shopify_updated_at, o.created_at_shopify)) as last_activity_at
      from public.orders o
     where o.customer_id is not null
       and o.shopify_order_id is not null
     group by o.customer_id
  ) activity
 where c.id = activity.customer_id
   and c.shopify_last_activity_at is null
   and activity.last_activity_at is not null;

create index if not exists orders_pcd_finalized_idx
  on public.orders (merchant_account_id, pcd_finalized_at, id)
  where pcd_finalized_at is not null;

create index if not exists customer_shopify_last_activity_idx
  on public.customer (merchant_account_id, shopify_last_activity_at, id)
  where shopify_last_activity_at is not null;

create or replace function public.set_orders_pcd_finalized_at()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old_final boolean := false;
  v_new_final boolean := false;
begin
  if tg_op = 'UPDATE' then
    v_old_final := old.order_state in ('completed', 'cancelled', 'returned')
      or old.delivery_state in ('delivered', 'failed', 'returned');
  end if;

  v_new_final := new.order_state in ('completed', 'cancelled', 'returned')
    or new.delivery_state in ('delivered', 'failed', 'returned');

  if v_new_final and not v_old_final then
    -- Une nouvelle entrée finale établit toujours une nouvelle date fiable.
    -- Le backfill historique a déjà été exécuté avant la création du trigger.
    new.pcd_finalized_at := clock_timestamp();
  elsif not v_new_final then
    -- Quitter un état final révoque l'ancienne échéance. Une nouvelle entrée
    -- finale reçoit une nouvelle date via la branche précédente.
    new.pcd_finalized_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists orders_set_pcd_finalized_at on public.orders;
create trigger orders_set_pcd_finalized_at
  before insert or update on public.orders
  for each row
  execute function public.set_orders_pcd_finalized_at();

alter table public.webhook_event
  add column if not exists retention_attempt_count integer not null default 0,
  add column if not exists retention_last_attempt_at timestamptz,
  add column if not exists retention_last_success_at timestamptz,
  add column if not exists retention_last_error_code text,
  add column if not exists retention_next_attempt_at timestamptz;

alter table public.webhook_event
  add constraint webhook_event_retention_attempt_count_check
  check (retention_attempt_count between 0 and 1000),
  add constraint webhook_event_retention_error_code_check
  check (retention_last_error_code is null or retention_last_error_code ~ '^[a-z0-9_]{1,64}$');

alter table public.shopify_dsar_artifact
  drop constraint if exists shopify_dsar_artifact_status_check;

alter table public.shopify_dsar_artifact
  add column if not exists purge_attempt_count integer not null default 0,
  add column if not exists purge_lease_until timestamptz,
  add column if not exists purge_last_attempt_at timestamptz,
  add column if not exists purge_last_success_at timestamptz,
  add column if not exists purge_last_error_code text,
  add column if not exists purge_next_attempt_at timestamptz,
  add column if not exists purged_at timestamptz;

alter table public.shopify_dsar_artifact
  add constraint shopify_dsar_artifact_status_check
  check (status in ('pending', 'ready', 'expired', 'purging', 'purge_retryable', 'purged', 'failed')),
  add constraint shopify_dsar_artifact_purge_attempt_count_check
  check (purge_attempt_count between 0 and 1000),
  add constraint shopify_dsar_artifact_purge_error_code_check
  check (purge_last_error_code is null or purge_last_error_code ~ '^[a-z0-9_]{1,64}$');

create index if not exists shopify_dsar_artifact_purge_claim_idx
  on public.shopify_dsar_artifact (status, expires_at, purge_next_attempt_at, purge_lease_until, id);

create table public.shopify_pcd_purge_run (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('dry_run', 'execute')),
  status text not null default 'running'
    check (status in ('running', 'done', 'partial', 'failed')),
  limit_requested integer not null check (limit_requested between 1 and 100),
  summary jsonb not null default '{}'::jsonb,
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{1,64}$'),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_attempt_at timestamptz not null default now(),
  last_success_at timestamptz
);

alter table public.shopify_pcd_purge_run enable row level security;
alter table public.shopify_pcd_purge_run force row level security;
revoke all on table public.shopify_pcd_purge_run from public, anon, authenticated;
grant all on table public.shopify_pcd_purge_run to service_role;

-- Source SQL commune du dry-run et de l'exécution. target_id reste interne et
-- n'est jamais exposé par les wrappers publics.
create or replace function public.shopify_pcd_retention_candidates(
  p_now timestamptz default now()
)
returns table (
  category text,
  target_id uuid,
  merchant_account_id uuid,
  shop_id uuid,
  expires_at timestamptz,
  blocked_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select 'gdpr_retryable_payload', e.id, e.merchant_account_id, e.shop_id,
         e.received_at + interval '7 days', null::text
    from public.webhook_event e
   where e.status = 'retryable'
     and e.received_at <= p_now - interval '7 days'
  union all
  select 'gdpr_historical_payload', e.id, e.merchant_account_id, e.shop_id,
         e.received_at, null::text
    from public.webhook_event e
   where e.status in ('done', 'terminal')
     and e.payload is not null
  union all
  select 'expired_tombstone', t.id, t.merchant_account_id, t.shop_id,
         t.expires_at, null::text
    from public.shopify_customer_redaction_tombstone t
   where t.expires_at <= p_now
  union all
  select 'expired_order_address', o.id, o.merchant_account_id, o.shop_id,
         o.pcd_finalized_at + interval '90 days', null::text
    from public.orders o
   where o.pcd_finalized_at is not null
     and o.pcd_finalized_at <= p_now - interval '90 days'
     and (o.order_state in ('completed', 'cancelled', 'returned')
       or o.delivery_state in ('delivered', 'failed', 'returned'))
     and (
       o.shipping_address is not null
       or exists (select 1 from public.delivery_address d where d.order_id = o.id)
     )
  union all
  select 'expired_customer_identity', c.id, c.merchant_account_id, shop_scope.shop_id,
         c.shopify_last_activity_at + interval '12 months',
         case
           when shop_scope.shop_id is null then 'missing_shop_provenance'
           when exists (
             select 1
               from public.orders o
              where o.merchant_account_id = c.merchant_account_id
                and o.customer_id = c.id
                 and (
                   o.order_state is null
                   or o.delivery_state is null
                   or o.order_state not in ('completed', 'cancelled', 'returned')
                   or o.delivery_state in ('unassigned', 'scheduled', 'assigned', 'out_for_delivery')
                   or (o.order_state = 'returned'
                     and (o.returned_at is null or o.cash_state not in ('not_due', 'remitted')))
                   or o.cash_state in ('expected', 'collected', 'discrepancy')
                 )
           ) then 'operational_dependency'
           else null
         end
    from public.customer c
    left join lateral (
      select o.shop_id
        from public.orders o
       where o.merchant_account_id = c.merchant_account_id
         and o.customer_id = c.id
         and o.shop_id is not null
       order by o.created_at desc, o.id desc
       limit 1
    ) shop_scope on true
   where c.shopify_last_activity_at is not null
     and c.shopify_last_activity_at <= p_now - interval '12 months'
     and (c.shopify_customer_id is not null or jsonb_array_length(c.shopify_customer_gids) > 0)
  union all
  select 'expired_dsar_artifact', a.id, a.merchant_account_id, a.shop_id,
         a.expires_at, null::text
    from public.shopify_dsar_artifact a
   where a.expires_at <= p_now
     and (
       a.status in ('ready', 'expired', 'purge_retryable')
       and coalesce(a.purge_next_attempt_at, p_now) <= p_now
       or a.status = 'purging' and a.purge_lease_until < p_now
     );
$$;

revoke all on function public.shopify_pcd_retention_candidates(timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.shopify_pcd_retention_candidates(timestamptz)
  to service_role;

create or replace function public.preview_shopify_pcd_retention(
  p_now timestamptz default now()
)
returns table (
  category text,
  candidate_count bigint,
  shop_count bigint,
  earliest_expiry timestamptz,
  latest_expiry timestamptz,
  blocked_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select c.category,
         count(*)::bigint,
         count(distinct c.shop_id)::bigint,
         min(c.expires_at),
         max(c.expires_at),
         count(*) filter (where c.blocked_reason is not null)::bigint
    from public.shopify_pcd_retention_candidates(p_now) c
   group by c.category
   order by c.category;
end;
$$;

revoke all on function public.preview_shopify_pcd_retention(timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.preview_shopify_pcd_retention(timestamptz)
  to service_role;

-- Purge DSAR : le claim SQL ne supprime jamais l'objet Storage.
create or replace function public.claim_shopify_dsar_artifacts(
  p_limit integer,
  p_now timestamptz default now()
)
returns table (
  id uuid,
  storage_bucket text,
  storage_path text,
  purge_attempt_count integer
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
    raise exception 'invalid_retention_limit' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select a.id
      from public.shopify_dsar_artifact a
     where a.expires_at <= p_now
       and (
         (a.status in ('ready', 'expired', 'purge_retryable')
           and coalesce(a.purge_next_attempt_at, p_now) <= p_now)
         or (a.status = 'purging' and a.purge_lease_until < p_now)
       )
     order by a.expires_at, a.id
     for update skip locked
     limit p_limit
  ), claimed as (
    update public.shopify_dsar_artifact a
       set status = 'purging',
           purge_attempt_count = a.purge_attempt_count + 1,
           purge_lease_until = p_now + interval '10 minutes',
           purge_last_attempt_at = p_now,
           purge_next_attempt_at = null
      from candidates c
     where a.id = c.id
     returning a.id, a.storage_bucket, a.storage_path, a.purge_attempt_count
  )
  select c.id, c.storage_bucket, c.storage_path, c.purge_attempt_count
    from claimed c;
end;
$$;

revoke all on function public.claim_shopify_dsar_artifacts(integer, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_shopify_dsar_artifacts(integer, timestamptz)
  to service_role;

create or replace function public.finalize_shopify_dsar_artifact_purge(
  p_id uuid,
  p_success boolean,
  p_error_code text default null,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'invalid_retention_error_code' using errcode = '22023';
  end if;
  if p_success and p_error_code is not null then
    raise exception 'success_cannot_have_error' using errcode = '22023';
  end if;

  update public.shopify_dsar_artifact a
     set status = case when p_success then 'purged' else 'purge_retryable' end,
         purge_lease_until = null,
         purge_next_attempt_at = case
           when p_success then null
           else p_now + make_interval(secs => least(3600, (2 ^ least(greatest(a.purge_attempt_count, 1), 12))::integer))
         end,
         purge_last_success_at = case when p_success then p_now else a.purge_last_success_at end,
         purged_at = case when p_success then p_now else a.purged_at end,
         purge_last_error_code = case when p_success then null else p_error_code end
   where a.id = p_id
     and a.status = 'purging'
     and a.purge_lease_until >= p_now;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.finalize_shopify_dsar_artifact_purge(uuid, boolean, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_shopify_dsar_artifact_purge(uuid, boolean, text, timestamptz)
  to service_role;

-- Exécution bornée des catégories purement SQL. Les objets DSAR sont claimés
-- séparément car leur suppression nécessite l'API Storage.
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

revoke all on function public.execute_shopify_pcd_retention(integer, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.execute_shopify_pcd_retention(integer, timestamptz)
  to service_role;
