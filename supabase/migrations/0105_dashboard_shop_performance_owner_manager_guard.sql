-- 0105 — get_dashboard_shop_performance (0080 → 0103 → 0104) était accessible à agent :
-- security invoker, grant execute to authenticated, aucune garde de rôle SQL ni TS. La carte
-- "Performance par boutique" affiche un CA par boutique en FCFA — incohérent avec le masquage
-- déjà appliqué à "CA total"/"CA par produit" (owner/manager only). Alignement sur le même
-- pattern NULL-safe que get_dashboard_cash_collected_total (0098) : security definer +
-- current_member_role + raise exception 'forbidden'. Signature, formule et sortie inchangées
-- pour owner/manager.

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
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  return (
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
      and (p_shop_id is null or s.id = p_shop_id)
  );
end;
$$;

revoke all on function public.get_dashboard_shop_performance(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.get_dashboard_shop_performance(uuid, timestamptz, timestamptz, uuid) to authenticated;
