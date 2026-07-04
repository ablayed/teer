-- 0084 — Lot 3b perf : cash livreur "pending" du rapport PDF en SQL (suite H2, sous-lot).
--
-- Call-site : lib/report/data.ts:getReportData → app/api/rapport/route.tsx (rapport PDF).
-- Contrairement au Lot 3 (0083, cash livreur cross-boutique all-time), la section
-- `drivers[].pendingMinor` du rapport PDF a un contrat DIFFÉRENT et volontairement
-- préservé : cash-on-hand calculé UNIQUEMENT sur les commandes créées DANS LA PÉRIODE
-- du rapport [from,to], et scopé à une boutique si `shopId` est fourni. Ce n'est pas le
-- cash total en main (ça, c'est 0083) — c'est un sous-ensemble propre au PDF.
--
-- Bug latent (même famille H2 que 0083, docs/PERFORMANCE_AUDIT_AND_OPTIMIZATION_PLAN.md
-- §H2 l.271-272) : `scopedOrdersQuery` (data.ts:294-303) sélectionne `orders` fenêtré
-- SANS `.range()`/`.limit()` → cap silencieux PostgREST à 1000 lignes (max_rows) sur un
-- mois/trimestre chargé → `orderIds` tronqué → `.in('order_id', orderIds)` sur
-- `settlement_allocation` (data.ts:359-367) hérite du tronquage ET reste à risque de 400
-- gateway (classe #50/#56) si le cap venait à changer. `pendingMinor` sous-évalué sur les
-- gros tenants/grosses fenêtres.
--
-- Formule préservée À L'IDENTIQUE — même arithmétique que
-- deriveDriverCashConsolidation/consolidateCashByDriver (lib/drivers/cash-consolidation.ts),
-- déjà répliquée en SQL par get_driver_cash_consolidation (0083), mais bornée période+shop
-- ici au lieu de all-time cross-shop :
--   collectable  = coalesce(cash_collectable_minor, canal mobile-money ? 0 : round(total_amount))
--   collecté     = Σ collectable des commandes cash_state ∈ {collected,remitted,discrepancy}
--   frais collectés = Σ delivery_fee_minor des mêmes commandes (seule composante déduite)
--   remis        = Σ settlement_allocation.allocated_minor (peut être négatif, reprise
--                  retour post-livraison — migration 0056)
--   pending_minor = greatest(collecté − frais_collectés − remis, 0) — clamp AGRÉGÉ PAR
--                   LIVREUR, jamais par commande (même piège oldest-first que 0083/0065).
--
-- Convention de borne EXACTEMENT celle de data.ts:300-301 (`.gte('created_at', from)
-- .lte('created_at', to)`) : created_at >= p_from AND created_at <= p_to, DEUX bornes
-- INCLUSIVES. Ne PAS réutiliser la convention borne-haute-exclusive de get_driver_cash_-
-- consolidation (0083, p_period_to exclusif) — contrat différent, fichier différent.
--
-- Sécurité : security definer (pas invoker — orders_select autorise l'agent à tout lire,
-- une RPC invoker exposerait le cash livreur à l'agent), garde de rôle NULL-safe
-- owner/manager, refus par exception (aligné 0083/finance_kpis/cash_aging).
--
-- Hors scope de ce lot (ticket séparé "Lot 4 — report PDF, agrégats non-cash") :
--   - `scopedOrdersQuery` reste utilisé tel quel pour revenue[]/topProducts[]/statuses[]/
--     kpis.margin_estimee/currency dans getReportData — même hotspot, pas traité ici.
--   - settledMinor (cash_settlement) et shortfallMinor (settlement_shortfall) restent en
--     TS inchangés : selects simples bornés eq/gte/lte, sans `.in(orderIds)`, hors pattern H2.
--   - get_driver_cash_consolidation / get_driver_cash_outstanding_orders (0083) : non modifiées.

create or replace function public.get_report_driver_cash_pending(
  p_merchant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns table (
  driver_id uuid,
  driver_name text,
  pending_minor bigint
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
      and o.created_at >= p_from
      and o.created_at <= p_to
      and (p_shop_id is null or o.shop_id = p_shop_id)
  ),
  agg as (
    select
      do_.driver_id,
      coalesce(
        sum(do_.collectable_minor) filter (
          where do_.cash_state in ('collected', 'remitted', 'discrepancy')
        ), 0
      )::bigint as collected_minor,
      coalesce(
        sum(do_.delivery_fee_minor) filter (
          where do_.cash_state in ('collected', 'remitted', 'discrepancy')
        ), 0
      )::bigint as collected_delivery_fees_minor
    from driver_orders do_
    group by do_.driver_id
  ),
  remitted as (
    select
      do_.driver_id,
      coalesce(sum(sa.allocated_minor), 0)::bigint as remitted_minor
    from driver_orders do_
    join public.settlement_allocation sa
      on sa.order_id = do_.id
     and sa.merchant_account_id = p_merchant_id
    group by do_.driver_id
  )
  select
    a.driver_id,
    d.full_name as driver_name,
    greatest(
      a.collected_minor - a.collected_delivery_fees_minor - coalesce(r.remitted_minor, 0),
      0
    )::bigint as pending_minor
  from agg a
  join public.driver d
    on d.id = a.driver_id
   and d.merchant_account_id = p_merchant_id
  left join remitted r on r.driver_id = a.driver_id;
end;
$$;

revoke all on function public.get_report_driver_cash_pending(
  uuid, timestamptz, timestamptz, uuid
) from public, anon;

grant execute on function public.get_report_driver_cash_pending(
  uuid, timestamptz, timestamptz, uuid
) to authenticated;
