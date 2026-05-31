create index if not exists order_state_transition_order_to_status_created_idx
  on public.order_state_transition (order_id, to_status, created_at);

create or replace function public.get_dashboard_kpi(p_merchant_id uuid)
returns table (
  a_appeler_count integer,
  a_appeler_delta integer,
  ca_collecte_7j bigint,
  ca_en_attente bigint,
  taux_confirmation numeric(5, 2),
  taux_livraison numeric(5, 2),
  sparkline_7j json
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status_column text;
  v_amount_expr text;
  v_sql text;
begin
  select case
    when exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'orders'
        and column_name = 'status'
    ) then 'status'
    when exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'orders'
        and column_name = 'cod_status'
    ) then 'cod_status'
    else null
  end
  into v_status_column;

  if v_status_column is null then
    raise exception 'orders_status_column_not_found'
      using errcode = '42703';
  end if;

  select case
    when exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'orders'
        and column_name = 'total_xof'
    ) then 'coalesce(o.total_xof, 0)::bigint'
    when exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'orders'
        and column_name = 'total_amount'
    ) then 'coalesce(round(o.total_amount), 0)::bigint'
    else null
  end
  into v_amount_expr;

  if v_amount_expr is null then
    raise exception 'orders_amount_column_not_found'
      using errcode = '42703';
  end if;

  v_sql := format(
    $query$
      with orders_scoped as (
        select
          o.id,
          o.created_at,
          o.%1$I as current_status,
          %2$s as amount
        from public.orders o
        where o.merchant_account_id = $1
      ),
      snapshot_status as (
        select
          os.id,
          coalesce(
            (
              select ost.to_status
              from public.order_state_transition ost
              where ost.order_id = os.id
                and ost.created_at <= now() - interval '1 day'
              order by ost.created_at desc
              limit 1
            ),
            'A_APPELER'
          ) as status_at_snapshot
        from orders_scoped os
        where os.created_at <= now() - interval '1 day'
      ),
      created_30d as (
        select os.id
        from orders_scoped os
        where os.created_at >= now() - interval '30 days'
      ),
      confirmed_30d as (
        select distinct ost.order_id
        from public.order_state_transition ost
        join created_30d c on c.id = ost.order_id
        where ost.to_status = 'CONFIRMEE'
          and ost.created_at >= now() - interval '30 days'
      ),
      delivered_7d as (
        select distinct ost.order_id
        from public.order_state_transition ost
        join orders_scoped os on os.id = ost.order_id
        where ost.to_status = 'LIVREE'
          and ost.created_at >= now() - interval '7 days'
      ),
      livraison_base as (
        select
          count(*) filter (where os.current_status = 'LIVREE')::integer as livree_count,
          count(*) filter (
            where os.current_status in ('REFUSEE', 'ANNULEE')
              and exists (
                select 1
                from public.order_state_transition confirmed
                where confirmed.order_id = os.id
                  and confirmed.to_status = 'CONFIRMEE'
              )
          )::integer as post_failed_count
        from orders_scoped os
      ),
      sparkline_days as (
        select generate_series(
          current_date - interval '6 days',
          current_date,
          interval '1 day'
        )::date as day
      ),
      delivered_by_day as (
        select distinct
          ost.order_id,
          ost.created_at::date as delivered_date
        from public.order_state_transition ost
        join orders_scoped os on os.id = ost.order_id
        where ost.to_status = 'LIVREE'
          and ost.created_at >= current_date - interval '6 days'
          and ost.created_at < current_date + interval '1 day'
      ),
      sparkline as (
        select
          sd.day,
          coalesce(sum(os.amount), 0)::bigint as ca_collecte
        from sparkline_days sd
        left join delivered_by_day dbd on dbd.delivered_date = sd.day
        left join orders_scoped os on os.id = dbd.order_id
        group by sd.day
      )
      select
        (select count(*)::integer from orders_scoped where current_status = 'A_APPELER') as a_appeler_count,
        (
          (select count(*)::integer from orders_scoped where current_status = 'A_APPELER')
          - (select count(*)::integer from snapshot_status where status_at_snapshot = 'A_APPELER')
        ) as a_appeler_delta,
        coalesce(
          (
            select sum(os.amount)::bigint
            from orders_scoped os
            join delivered_7d d on d.order_id = os.id
          ),
          0
        ) as ca_collecte_7j,
        coalesce(
          (
            select sum(amount)::bigint
            from orders_scoped
            where current_status in ('CONFIRMEE', 'PROGRAMMEE', 'EN_LIVRAISON')
          ),
          0
        ) as ca_en_attente,
        case
          when (select count(*) from created_30d) = 0 then 0::numeric(5, 2)
          else round(
            ((select count(*) from confirmed_30d)::numeric / (select count(*) from created_30d)::numeric) * 100,
            2
          )::numeric(5, 2)
        end as taux_confirmation,
        case
          when (select livree_count + post_failed_count from livraison_base) = 0 then 0::numeric(5, 2)
          else round(
            ((select livree_count from livraison_base)::numeric / (select livree_count + post_failed_count from livraison_base)::numeric) * 100,
            2
          )::numeric(5, 2)
        end as taux_livraison,
        coalesce(
          (
            select json_agg(
              json_build_object(
                'date',
                to_char(day, 'YYYY-MM-DD'),
                'ca_collecte',
                ca_collecte
              )
              order by day
            )
            from sparkline
          ),
          '[]'::json
        ) as sparkline_7j
    $query$,
    v_status_column,
    v_amount_expr
  );

  return query execute v_sql using p_merchant_id;
end;
$$;
