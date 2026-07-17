-- 0103 — Raccorde les trois agrégats Tableau historiques au PeriodPicker.
-- Les prédicats métier et le filtre boutique existants sont conservés ; seules
-- les bornes effectives [from, to] sont ajoutées.

drop function if exists public.get_dashboard_top_products(uuid, uuid);
drop function if exists public.get_dashboard_shop_performance(uuid, uuid);
drop function if exists public.get_dashboard_cod_breakdown(uuid, uuid);

create function public.get_dashboard_cod_breakdown(
  p_merchant_id uuid,
  p_shop_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('cod_status', t.cod_status, 'count', t.count)), '[]'::jsonb)
  from (
    select o.cod_status, count(*) as count
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and o.cod_status is not null
      and o.created_at >= p_from and o.created_at <= p_to
      and (p_shop_id is null or o.shop_id = p_shop_id)
    group by o.cod_status
  ) t;
$$;

create function public.get_dashboard_shop_performance(
  p_merchant_id uuid,
  p_shop_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'name', s.shop_domain, 'status', s.status,
    'orders_count', coalesce(agg.orders_count, 0), 'revenue', coalesce(agg.revenue, 0)
  ) order by s.installed_at asc nulls last), '[]'::jsonb)
  from public.shop s
  left join (
    select o.shop_id, count(*) as orders_count, sum(o.total_amount) as revenue
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and o.shop_id is not null
      and o.created_at >= p_from and o.created_at <= p_to
      and (p_shop_id is null or o.shop_id = p_shop_id)
    group by o.shop_id
  ) agg on agg.shop_id = s.id
  where s.merchant_account_id = p_merchant_id
    and (p_shop_id is null or s.id = p_shop_id);
$$;

create function public.get_dashboard_top_products(
  p_merchant_id uuid,
  p_shop_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'name', t.name, 'units', t.units, 'revenue', t.revenue
  ) order by t.units desc, t.revenue desc), '[]'::jsonb)
  from (
    select
      elem->>'title' as name,
      sum(case when jsonb_typeof(elem->'quantity') = 'number' then (elem->>'quantity')::numeric else 0 end) as units,
      sum(
        (case when jsonb_typeof(elem->'quantity') = 'number' then (elem->>'quantity')::numeric else 0 end)
        * (case when jsonb_typeof(elem->'price') = 'number' then (elem->>'price')::numeric else 0 end)
      ) as revenue
    from public.orders o
    cross join lateral jsonb_array_elements(o.items_summary) as elem
    where o.merchant_account_id = p_merchant_id
      and o.cod_status in ('CONFIRMEE', 'PROGRAMMEE', 'EN_LIVRAISON', 'LIVREE')
      and o.created_at >= p_from and o.created_at <= p_to
      and (p_shop_id is null or o.shop_id = p_shop_id)
      and jsonb_typeof(o.items_summary) = 'array'
      and jsonb_typeof(elem) = 'object'
      and jsonb_typeof(elem->'title') = 'string'
      and (elem->>'title') <> ''
    group by elem->>'title'
    order by units desc, revenue desc
    limit 5
  ) t;
$$;

revoke all on function public.get_dashboard_cod_breakdown(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_dashboard_cod_breakdown(uuid, uuid, timestamptz, timestamptz) to authenticated;
revoke all on function public.get_dashboard_shop_performance(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_dashboard_shop_performance(uuid, uuid, timestamptz, timestamptz) to authenticated;
revoke all on function public.get_dashboard_top_products(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_dashboard_top_products(uuid, uuid, timestamptz, timestamptz) to authenticated;
