-- 0083 — Lot 3 perf : consolidation cash livreur en SQL (H2/H6, MT1).
--
-- Bug latent (docs/PERFORMANCE_AUDIT_AND_OPTIMIZATION_PLAN.md §H2/H6) : sur un gros
-- tenant, `getDriversCashOnHandTotal`, `getDriverCashConsolidation` (lib/actions/drivers.ts)
-- et le total de `buildDriverSettlements` (lib/finance/driver-settlements.ts) font un
-- select `orders` all-time SANS `.range()` (cap silencieux PostgREST à 1000 lignes,
-- `config.toml:max_rows`) puis un `.in('order_id', orderIds)` sur `settlement_allocation`
-- pouvant dépasser la limite d'URL du gateway (classe 400 du bug #50) — cash total faux
-- et/ou page morte sur les gros comptes. C'est du cash réel (Tableau, Finances, versements).
--
-- Formule préservée À L'IDENTIQUE (aucun changement métier) — source de vérité TS
-- `deriveDriverCashConsolidation`/`consolidateCashByDriver` (lib/drivers/cash-consolidation.ts),
-- déjà répliquée et testée en parité pour l'agrégat tenant dans `finance_kpis` (migration 0065,
-- tests/rls/finance-driver-cash.rls.test.ts) :
--   collecté  = Σ cashCollectable des commandes cash_state ∈ {collected,remitted,discrepancy}
--               (collectable = coalesce(stored, canal mobile-money ? 0 : round(total)))
--   frais     = Σ delivery_fee_minor (toutes commandes du livreur pour le total "frais
--               prévisionnel" ; "collected_delivery_fees" ne compte que les commandes
--               collectées, seule composante déduite du cash à remettre)
--   remis     = Σ settlement_allocation.allocated_minor (peut être négatif, reprise
--               retour post-livraison — migration 0056)
--   cashOnHand = greatest(collecté − frais_collectés − remis, 0)  — clamp AGRÉGÉ PAR LIVREUR
--                (jamais par commande : record_cash_settlement alloue oldest-first capé
--                au brut → un clamp par commande laisserait un résidu fantôme, cf. 0065).
-- Cash livreur reste CROSS-BOUTIQUE (décision Phase 13 actée dans 0065) : aucun p_shop_id.
--
-- Sécurité : `security definer` + garde de rôle explicite NULL-safe (owner/manager),
-- PAS `security invoker` — `orders_select` (migration 0020) autorise `agent` à lire
-- TOUTES les commandes du tenant ; une RPC invoker sur `orders` exposerait le cash
-- livreur à l'agent. Suit le précédent du domaine (finance_kpis, cash_aging,
-- record_cash_settlement, write_off_shortfall), avec refus explicite par exception
-- (comme record_cash_settlement/write_off_shortfall) plutôt que la garde "having" muette
-- de finance_kpis/cash_aging.
--
-- Deux fonctions :
--   1. get_driver_cash_consolidation   — agrégats par livreur (remplace le select all-time
--      de getDriversCashOnHandTotal ET getDriverCashConsolidation, y compris le sous-total
--      période de ce dernier, calculé sur les MÊMES bornes timestamptz déjà résolues côté TS
--      — jamais de date_trunc/résolution de période réimplémentée en SQL).
--   2. get_driver_cash_outstanding_orders — lignes par commande informatives consommées par
--      buildDriverSettlements (le panneau Finances affichait ces lignes sous le total ; les
--      laisser sur l'ancien pattern .in(orderIds) après un fix du total seul aurait laissé
--      la page Finances risquée). Reproduit la même garde "un livreur n'apparaît que s'il
--      détient encore du cash NET agrégé > 0" (buildDriverSettlements: `if (!entry) continue`).
--
-- Explicitement HORS SCOPE de ce lot (ticket séparé) :
--   - listDriverOutstandingAction (lib/actions/finance.ts) : code mort, formule DIVERGENTE
--     (cod_status='LIVREE' au lieu de cash_state, pas de déduction des frais, clamp par
--     commande) — décision produit à prendre avant tout alignement, pas dans ce lot.
--   - report-data.ts / product-cost.ts / driver-cost.ts : famille margin/P&L (coûts/marge
--     sur fenêtre cash_collected_at), autre grandeur métier que le cash en main.

create or replace function public.get_driver_cash_consolidation(
  p_merchant_id uuid,
  p_driver_id uuid default null,
  p_period_from timestamptz default null,
  p_period_to timestamptz default null
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
  uuid, uuid, timestamptz, timestamptz
) from public, anon;

grant execute on function public.get_driver_cash_consolidation(
  uuid, uuid, timestamptz, timestamptz
) to authenticated;

create or replace function public.get_driver_cash_outstanding_orders(
  p_merchant_id uuid,
  p_driver_id uuid default null
)
returns table (
  driver_id uuid,
  order_id uuid,
  order_number text,
  delivered_at timestamptz,
  outstanding_minor bigint
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
      o.order_number,
      coalesce(o.updated_at, o.created_at) as delivered_at,
      o.cash_state,
      o.delivery_fee_minor,
      o.payment_channel_at_delivery,
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
  ),
  allocated as (
    select
      sa.order_id,
      sum(sa.allocated_minor) as allocated_minor
    from public.settlement_allocation sa
    where sa.merchant_account_id = p_merchant_id
    group by sa.order_id
  ),
  -- Même arithmétique agrégée que get_driver_cash_consolidation (dupliquée
  -- intentionnellement — pas de fonction privée partagée dans ce lot, cf.
  -- rapport de migration) : porte la garde "un livreur n'apparaît que s'il
  -- détient encore du cash NET" (buildDriverSettlements: `if (!entry) continue`).
  driver_totals as (
    select
      do_.driver_id,
      greatest(
        coalesce(
          sum(do_.collectable_minor) filter (
            where do_.cash_state in ('collected', 'remitted', 'discrepancy')
          ), 0
        )
        - coalesce(
          sum(do_.delivery_fee_minor) filter (
            where do_.cash_state in ('collected', 'remitted', 'discrepancy')
          ), 0
        )
        - coalesce((
            select sum(a.allocated_minor)
            from allocated a
            join driver_orders do2 on do2.id = a.order_id
            where do2.driver_id = do_.driver_id
          ), 0),
        0
      ) as cash_on_hand_minor
    from driver_orders do_
    group by do_.driver_id
  )
  select
    do_.driver_id,
    do_.id as order_id,
    do_.order_number,
    do_.delivered_at,
    greatest(do_.collectable_minor - coalesce(a.allocated_minor, 0), 0)::bigint
      as outstanding_minor
  from driver_orders do_
  join driver_totals dt
    on dt.driver_id = do_.driver_id
   and dt.cash_on_hand_minor > 0
  left join allocated a on a.order_id = do_.id
  where do_.cash_state in ('collected', 'remitted', 'discrepancy')
    and coalesce(do_.payment_channel_at_delivery, 'INCONNU') in ('ESPECES', 'INCONNU')
    and greatest(do_.collectable_minor - coalesce(a.allocated_minor, 0), 0) > 0;
end;
$$;

revoke all on function public.get_driver_cash_outstanding_orders(
  uuid, uuid
) from public, anon;

grant execute on function public.get_driver_cash_outstanding_orders(
  uuid, uuid
) to authenticated;
