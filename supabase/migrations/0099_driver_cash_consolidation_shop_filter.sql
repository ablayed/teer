-- 0099 — Fix dashboard / PR C1 : support optionnel de p_shop_id sur
-- get_driver_cash_consolidation.
--
-- Bug validé en Phase A :
--   /tableau filtre déjà shop sur les métriques période-aware, mais "Cash total chez les
--   livreurs" appelait get_driver_cash_consolidation sans aucun scope boutique. Le total restait
--   cross-boutiques même avec ?shop=<id>.
--
-- Contrat à préserver :
--   - p_shop_id est OPTIONNEL pour ne pas casser les appelants existants
--     (/livreurs, buildDriverSettlements) qui ne le fournissent pas et doivent rester
--     cross-boutiques.
--   - le reste de la formule est inchangé.

drop function if exists public.get_driver_cash_consolidation(
  uuid, uuid, timestamptz, timestamptz
);

create or replace function public.get_driver_cash_consolidation(
  p_merchant_id uuid,
  p_driver_id uuid default null,
  p_period_from timestamptz default null,
  p_period_to timestamptz default null,
  p_shop_id uuid default null
)
returns table (
  driver_id uuid,
  driver_name text,
  expected_minor bigint,
  collected_minor bigint,
  delivery_fees_minor bigint,
  collected_delivery_fees_minor bigint,
  remitted_minor bigint,
  cash_on_hand_minor bigint,
  period_collected_minor bigint,
  period_delivery_fees_minor bigint,
  period_collected_delivery_fees_minor bigint
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
  with driver_orders as (
    select
      o.id,
      o.assigned_driver_id as driver_id,
      o.cash_state,
      o.created_at,
      o.delivery_fee_minor,
      coalesce(
        o.cash_collectable_minor,
        case
          when coalesce(o.payment_channel_at_delivery, 'INCONNU')
               in ('WAVE', 'ORANGE_MONEY', 'FREE_MONEY') then 0
          else round(o.total_amount)::bigint
        end
      ) as collectable_minor
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and o.assigned_driver_id is not null
      and (p_driver_id is null or o.assigned_driver_id = p_driver_id)
      and (p_shop_id is null or o.shop_id = p_shop_id)
  ),
  agg as (
    select
      do_.driver_id,
      coalesce(
        sum(do_.collectable_minor) filter (where do_.cash_state = 'expected'), 0
      )::bigint as expected_minor,
      coalesce(
        sum(do_.collectable_minor) filter (
          where do_.cash_state in ('collected', 'remitted', 'discrepancy')
        ), 0
      )::bigint as collected_minor,
      coalesce(sum(do_.delivery_fee_minor), 0)::bigint as delivery_fees_minor,
      coalesce(
        sum(do_.delivery_fee_minor) filter (
          where do_.cash_state in ('collected', 'remitted', 'discrepancy')
        ), 0
      )::bigint as collected_delivery_fees_minor,
      coalesce(
        sum(do_.collectable_minor) filter (
          where do_.cash_state in ('collected', 'remitted', 'discrepancy')
            and p_period_from is not null
            and p_period_to is not null
            and do_.created_at >= p_period_from
            and do_.created_at < p_period_to
        ), 0
      )::bigint as period_collected_minor,
      coalesce(
        sum(do_.delivery_fee_minor) filter (
          where p_period_from is not null
            and p_period_to is not null
            and do_.created_at >= p_period_from
            and do_.created_at < p_period_to
        ), 0
      )::bigint as period_delivery_fees_minor,
      coalesce(
        sum(do_.delivery_fee_minor) filter (
          where do_.cash_state in ('collected', 'remitted', 'discrepancy')
            and p_period_from is not null
            and p_period_to is not null
            and do_.created_at >= p_period_from
            and do_.created_at < p_period_to
        ), 0
      )::bigint as period_collected_delivery_fees_minor
    from driver_orders do_
    group by do_.driver_id
  ),
  remitted as (
    select
      o.assigned_driver_id as driver_id,
      coalesce(sum(sa.allocated_minor), 0)::bigint as remitted_minor
    from public.orders o
    join public.settlement_allocation sa
      on sa.order_id = o.id
     and sa.merchant_account_id = o.merchant_account_id
    where o.merchant_account_id = p_merchant_id
      and o.assigned_driver_id is not null
      and (p_driver_id is null or o.assigned_driver_id = p_driver_id)
      and (p_shop_id is null or o.shop_id = p_shop_id)
    group by o.assigned_driver_id
  )
  select
    a.driver_id,
    d.full_name as driver_name,
    a.expected_minor,
    a.collected_minor,
    a.delivery_fees_minor,
    a.collected_delivery_fees_minor,
    coalesce(r.remitted_minor, 0)::bigint as remitted_minor,
    greatest(
      a.collected_minor - a.collected_delivery_fees_minor - coalesce(r.remitted_minor, 0),
      0
    )::bigint as cash_on_hand_minor,
    a.period_collected_minor,
    a.period_delivery_fees_minor,
    a.period_collected_delivery_fees_minor
  from agg a
  join public.driver d
    on d.id = a.driver_id
   and d.merchant_account_id = p_merchant_id
  left join remitted r on r.driver_id = a.driver_id;
end;
$$;

revoke all on function public.get_driver_cash_consolidation(
  uuid, uuid, timestamptz, timestamptz, uuid
) from public, anon;

grant execute on function public.get_driver_cash_consolidation(
  uuid, uuid, timestamptz, timestamptz, uuid
) to authenticated;
