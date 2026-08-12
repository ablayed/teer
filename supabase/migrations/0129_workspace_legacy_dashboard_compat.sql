-- Keep the pre-workspace dashboard's unfiltered performance list compatible
-- with its Shopify-store contract.  A manual store remains visible when the
-- caller explicitly selects it, while legacy "all connected stores" calls do
-- not gain a synthetic row merely because the workspace foundation exists.

create or replace function public.get_dashboard_shop_performance(
  p_merchant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := public.current_member_role(p_merchant_id);

  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.shop_domain, 'status', s.status,
      'orders_count', coalesce(agg.orders_count, 0),
      'revenue', coalesce(agg.revenue, 0)
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
      and (p_shop_id is null or s.id = p_shop_id)
      and (p_shop_id is not null or s.store_kind = 'shopify')
  );
end;
$$;

revoke all on function public.get_dashboard_shop_performance(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.get_dashboard_shop_performance(uuid, timestamptz, timestamptz, uuid) to authenticated;
