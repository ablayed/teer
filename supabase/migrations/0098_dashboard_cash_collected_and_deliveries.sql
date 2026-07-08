-- 0098 — Tableau / PR C1 : CA encaissé + livraisons période-aware.
--
-- Périmètre validé :
--   1) CA encaissé dashboard = base Finances P&L, donc orders.cash_collected_at ∈ [from,to]
--      (+ shop optionnel), JAMAIS finance_kpis.ca_livre (delivered_at) ni
--      shop_performance.revenue (all-time, tous statuts).
--   2) Livraisons par produit = count(distinct order_id) par product_id, limité Top 10,
--      uniquement via order_line résolues (match_status='matched' AND product_id IS NOT NULL),
--      fenêtré sur cash_collected_at et statut courant LIVREE strict.
--   3) RBAC : défense en profondeur.
--      - CA encaissé : owner/manager uniquement.
--      - Livraisons : owner/manager/agent, non-membre refusé.
--
-- Vérification préalable (voir Phase B) : le chemin canonique `livrer` force
-- delivery_state='delivered' ET cash_state='collected' en même temps, et transition_order ne
-- pose cash_collected_at que dans cette branche (0096). Une commande réellement LIVREE via
-- performTransition/transition_order ne reste donc pas avec cash_collected_at NULL. Le filtre
-- cash_collected_at est donc cohérent pour dater la livraison réalisée.

create or replace function public.get_dashboard_cash_collected_total(
  p_merchant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns table (
  ca_encaisse_minor bigint,
  return_contra_revenue_minor bigint,
  net_ca_minor bigint
)
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

  return query
  with collected_orders as (
    select
      coalesce(sum(o.total_amount), 0)::bigint as ca_encaisse_minor
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and o.cash_collected_at >= p_from
      and o.cash_collected_at <= p_to
      and (p_shop_id is null or o.shop_id = p_shop_id)
  ),
  returned_orders as (
    select
      coalesce(sum(o.total_amount - coalesce(o.delivery_fee_minor, 0)), 0)::bigint
        as return_contra_revenue_minor
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and o.returned_at >= p_from
      and o.returned_at <= p_to
      and o.cash_collected_at is not null
      and (p_shop_id is null or o.shop_id = p_shop_id)
  )
  select
    c.ca_encaisse_minor,
    r.return_contra_revenue_minor,
    (c.ca_encaisse_minor - r.return_contra_revenue_minor)::bigint as net_ca_minor
  from collected_orders c
  cross join returned_orders r;
end;
$$;

revoke all on function public.get_dashboard_cash_collected_total(
  uuid, timestamptz, timestamptz, uuid
) from public, anon;

grant execute on function public.get_dashboard_cash_collected_total(
  uuid, timestamptz, timestamptz, uuid
) to authenticated;

create or replace function public.get_dashboard_deliveries_by_product(
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

  if v_role is null or v_role not in ('owner', 'manager', 'agent') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  return (
    with scoped_orders as (
      select o.id
      from public.orders o
      where o.merchant_account_id = p_merchant_id
        and o.cod_status = 'LIVREE'
        and o.cash_collected_at >= p_from
        and o.cash_collected_at <= p_to
        and (p_shop_id is null or o.shop_id = p_shop_id)
    ),
    per_product as (
      select
        ol.product_id,
        coalesce(p.title, min(ol.raw_title)) as title,
        count(distinct ol.order_id)::bigint as delivered_orders_count
      from public.order_line ol
      join scoped_orders so
        on so.id = ol.order_id
      left join public.product p
        on p.id = ol.product_id
       and p.merchant_account_id = p_merchant_id
      where ol.merchant_account_id = p_merchant_id
        and ol.match_status = 'matched'
        and ol.product_id is not null
      group by
        ol.product_id,
        p.title
    ),
    top_products as (
      select
        pp.product_id,
        pp.title,
        pp.delivered_orders_count
      from per_product pp
      order by
        pp.delivered_orders_count desc,
        pp.title asc,
        pp.product_id asc
      limit 10
    )
    select jsonb_build_object(
      'total_deliveries',
      coalesce((select count(*)::bigint from scoped_orders), 0),
      'products',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'product_id', tp.product_id,
            'title', tp.title,
            'delivered_orders_count', tp.delivered_orders_count
          )
          order by
            tp.delivered_orders_count desc,
            tp.title asc,
            tp.product_id asc
        )
        from top_products tp
      ), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.get_dashboard_deliveries_by_product(
  uuid, timestamptz, timestamptz, uuid
) from public, anon;

grant execute on function public.get_dashboard_deliveries_by_product(
  uuid, timestamptz, timestamptz, uuid
) to authenticated;
