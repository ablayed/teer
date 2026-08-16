-- Customer reliability RPCs now accept the active store explicitly.  The
-- legacy tenant-wide functions remain available for organization reports, but
-- workspace surfaces must use these membership-checked variants.

create or replace function public.get_store_customer_reliability(
  p_merchant_id uuid,
  p_shop_id uuid,
  p_customer_id uuid
)
returns table (
  customer_id uuid,
  full_name text,
  phone text,
  decided integer,
  delivered_count integer,
  refused_count integer,
  cancelled_count integer,
  order_count integer,
  delivered_lifetime numeric,
  delivered_weighted numeric,
  refused_weighted numeric,
  confirmed_weighted numeric,
  attempts_weighted numeric,
  no_response_weighted numeric,
  delivery_score numeric,
  confirm_score numeric,
  score integer,
  tier text,
  is_provisional boolean,
  flag_confirms_then_refuses boolean,
  flag_hard_to_reach boolean,
  flag_cancels_often boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with customer_scope as (
    select c.id, c.full_name, c.phone
    from public.customer c
    where c.merchant_account_id = p_merchant_id
      and c.id = p_customer_id
      and c.shop_id = p_shop_id
      and public.is_shop_member_of(p_shop_id)
  ),
  order_metrics as (
    select
      c.id as customer_id,
      count(o.id)::integer as order_count,
      count(o.id) filter (where o.cod_status = 'LIVREE')::integer as delivered_count,
      count(o.id) filter (where o.cod_status = 'REFUSEE')::integer as refused_count,
      count(o.id) filter (
        where o.cod_status = 'ANNULEE'
          and exists (
            select 1
            from public.order_state_transition ost
            left join public.merchant_member mm
              on mm.merchant_account_id = o.merchant_account_id
             and mm.user_id = ost.actor_user_id
            where ost.order_id = o.id
              and ost.shop_id = p_shop_id
              and ost.to_status = 'ANNULEE'
              and mm.user_id is null
          )
      )::integer as cancelled_count,
      coalesce(sum(o.total_amount) filter (where o.cod_status = 'LIVREE'), 0)::numeric
        as delivered_lifetime,
      coalesce(sum(
        case when o.cod_status = 'LIVREE' then
          power(0.5, greatest(extract(epoch from (now() - o.created_at)) / 86400.0, 0) / 180.0)
        else 0 end
      ), 0)::numeric as delivered_weighted,
      coalesce(sum(
        case when o.cod_status = 'REFUSEE' then
          power(0.5, greatest(extract(epoch from (now() - o.created_at)) / 86400.0, 0) / 180.0)
        else 0 end
      ), 0)::numeric as refused_weighted
    from customer_scope c
    left join public.orders o
      on o.customer_id = c.id
     and o.merchant_account_id = p_merchant_id
     and o.shop_id = p_shop_id
    group by c.id
  ),
  call_metrics as (
    select
      c.id as customer_id,
      coalesce(sum(
        case when cl.outcome = 'CONFIRMEE' then
          power(0.5, greatest(extract(epoch from (now() - cl.created_at)) / 86400.0, 0) / 180.0)
        else 0 end
      ), 0)::numeric as confirmed_weighted,
      coalesce(sum(
        case when cl.id is not null then
          power(0.5, greatest(extract(epoch from (now() - cl.created_at)) / 86400.0, 0) / 180.0)
        else 0 end
      ), 0)::numeric as attempts_weighted,
      coalesce(sum(
        case when cl.outcome = 'SANS_REPONSE' then
          power(0.5, greatest(extract(epoch from (now() - cl.created_at)) / 86400.0, 0) / 180.0)
        else 0 end
      ), 0)::numeric as no_response_weighted
    from customer_scope c
    left join public.orders o
      on o.customer_id = c.id
     and o.merchant_account_id = p_merchant_id
     and o.shop_id = p_shop_id
    left join public.call_log cl
      on cl.order_id = o.id
     and cl.merchant_account_id = p_merchant_id
     and cl.shop_id = p_shop_id
    group by c.id
  ),
  base_scores as (
    select
      om.*,
      cm.confirmed_weighted,
      cm.attempts_weighted,
      cm.no_response_weighted,
      (om.delivered_count + om.refused_count)::integer as decided,
      ((om.delivered_weighted + (5.0 * 0.70)) /
        (om.delivered_weighted + om.refused_weighted + 5.0))::numeric as delivery_score,
      case when cm.attempts_weighted = 0 then null
        else ((cm.confirmed_weighted + (3.0 * 0.60)) /
          (cm.attempts_weighted + 3.0))::numeric
      end as confirm_score
    from order_metrics om
    join call_metrics cm on cm.customer_id = om.customer_id
  ),
  final_scores as (
    select
      bs.*,
      case when bs.attempts_weighted = 0 then round(100.0 * bs.delivery_score)::integer
        else round(100.0 * ((0.70 * bs.delivery_score) + (0.30 * bs.confirm_score)))::integer
      end as final_score
    from base_scores bs
  )
  select
    c.id as customer_id,
    c.full_name,
    c.phone,
    fs.decided,
    fs.delivered_count,
    fs.refused_count,
    fs.cancelled_count,
    fs.order_count,
    fs.delivered_lifetime,
    fs.delivered_weighted,
    fs.refused_weighted,
    fs.confirmed_weighted,
    fs.attempts_weighted,
    fs.no_response_weighted,
    fs.delivery_score,
    fs.confirm_score,
    fs.final_score as score,
    case
      when fs.decided < 3 then 'new'
      when fs.final_score >= 75 then 'reliable'
      when fs.final_score >= 50 then 'watch'
      else 'risk'
    end as tier,
    (fs.decided >= 3 and fs.decided < 5) as is_provisional,
    (coalesce(fs.confirm_score, 0) >= 0.7 and fs.delivery_score < 0.5)
      as flag_confirms_then_refuses,
    (fs.attempts_weighted > 0
      and (fs.no_response_weighted / fs.attempts_weighted) >= 0.5
      and fs.delivered_count > 0
      and fs.delivery_score >= 0.5) as flag_hard_to_reach,
    (fs.cancelled_count >= 3
      and fs.order_count > 0
      and (fs.cancelled_count::numeric / fs.order_count::numeric) > 0.40)
      as flag_cancels_often
  from customer_scope c
  join final_scores fs on fs.customer_id = c.id;
$$;

create or replace function public.list_store_customer_reliability(
  p_merchant_id uuid,
  p_shop_id uuid,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_sort_by_risk boolean default false
)
returns table (
  customer_id uuid,
  full_name text,
  phone text,
  decided integer,
  delivered_count integer,
  refused_count integer,
  cancelled_count integer,
  order_count integer,
  delivered_lifetime numeric,
  delivered_weighted numeric,
  refused_weighted numeric,
  confirmed_weighted numeric,
  attempts_weighted numeric,
  no_response_weighted numeric,
  delivery_score numeric,
  confirm_score numeric,
  score integer,
  tier text,
  is_provisional boolean,
  flag_confirms_then_refuses boolean,
  flag_hard_to_reach boolean,
  flag_cancels_often boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  select r.*
  from public.customer c
  cross join lateral public.get_store_customer_reliability(p_merchant_id, p_shop_id, c.id) r
  where c.merchant_account_id = p_merchant_id
    and c.shop_id = p_shop_id
    and public.is_shop_member_of(p_shop_id)
    and (
      p_search is null
      or p_search = ''
      or lower(coalesce(c.full_name, '')) like '%' || lower(p_search) || '%'
      or coalesce(c.phone, '') like '%' || p_search || '%'
    )
  order by
    case when p_sort_by_risk then
      case r.tier when 'risk' then 0 when 'watch' then 1 when 'new' then 2 when 'reliable' then 3 else 4 end
      else 0 end,
    case when p_sort_by_risk then r.score end asc nulls last,
    r.full_name asc nulls last,
    r.customer_id
  limit least(greatest(p_limit, 1), 100)
  offset greatest(p_offset, 0);
$$;

revoke all on function public.get_store_customer_reliability(uuid, uuid, uuid) from public, anon;
grant execute on function public.get_store_customer_reliability(uuid, uuid, uuid) to authenticated;
revoke all on function public.list_store_customer_reliability(uuid, uuid, text, integer, integer, boolean)
  from public, anon;
grant execute on function public.list_store_customer_reliability(uuid, uuid, text, integer, integer, boolean)
  to authenticated;
