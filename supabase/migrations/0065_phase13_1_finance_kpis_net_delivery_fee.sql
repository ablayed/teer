--- ============================================================
--- Phase 13.1 / C1 — fix cash livreur : finance_kpis aligné sur deriveDriverCashConsolidation
--- ============================================================
--- Bug (prod) : la card Finances « cash chez le livreur » / « à encaisser » affichait
--- un résidu après versement complet (ex. frais=1000 → 1000 fantôme), alors que la page
--- Livreurs (deriveDriverCashConsolidation) tombait bien à 0.
---
--- Modèle (cf. commentaire orders.delivery_fee_minor, migration 0058) : le client paie
--- TOUJOURS le total complet ; le livreur GARDE les frais. Donc cash chez le livreur =
--- collecté − frais − remis. cash_collectable_minor est le BRUT (total payé), pas le net.
---
--- La v1 de ce fix ne retranchait que delivery_fee dans l'ancien outstanding_orders
--- (clamp PAR COMMANDE, filtre cod_status='LIVREE' + payment_channel). Insuffisant : les
--- ENSEMBLES divergeaient de la source de vérité TS (deriveDriverCashConsolidation) sur
--- 3 prédicats → le test d'égalité aurait passé sur frais=1000 1 commande mais divergé sur
--- les cas limites (livrée non encaissée, multi-commandes, mobile-money) :
---   1. ensemble « collecté » = cash_state ∈ {collected,remitted,discrepancy} (PAS cod_status
---      ='LIVREE' : une LIVREE cash_state='expected' n'est pas du cash en main).
---   2. collectable = coalesce(stored, canal mobile ? 0 : round(total)) — branche canal.
---   3. clamp AGRÉGÉ PAR LIVREUR (collecté_d − frais_d − remis_d, greatest 0), PAS par
---      commande : record_cash_settlement (0018) cape les allocations au BRUT et alloue
---      oldest-first → sur un livreur multi-commandes, le clamp per-order laisse un résidu
---      égal aux frais que l'agrégat annule. On réplique donc l'arithmétique agrégée du TS.
---
--- On remplace outstanding_orders par deux agrégats par livreur (collected_by_driver +
--- remitted_by_driver, jointure séparée pour éviter le fan-out des allocations) puis
--- outstanding_by_driver = greatest(collecté − frais − remis, 0) par livreur. Le total
--- cash_chez_livreurs / a_encaisser = somme sur les livreurs.
---
--- Cash livreur reste CROSS-BOUTIQUES (décision Phase 13, comme la réf. TS) : ces deux
--- agrégats N'appliquent PAS p_shop_id. Tout le reste de finance_kpis (delivered_orders/
--- ca_livre, refusal_counts/taux_refus, encaisse, role guard, filtre p_shop_id sur le CA
--- et les refus, signature, colonnes de retour, grants) est préservé À L'IDENTIQUE (0063/0064).
--- Signature inchangée (mêmes 4 paramètres) → create or replace + re-grants idempotents.
--- ============================================================

create or replace function public.finance_kpis(
  p_merchant uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns table (
  ca_livre bigint,
  cash_chez_livreurs bigint,
  encaisse bigint,
  a_encaisser bigint,
  taux_refus numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with role_guard as (
    select public.current_member_role(p_merchant) as role
  ),
  delivered_orders as (
    select
      o.id,
      o.total_amount,
      coalesce(max(ost.created_at), o.updated_at) as delivered_at
    from public.orders o
    left join public.order_state_transition ost
      on ost.order_id = o.id
     and ost.to_status = 'LIVREE'
    where o.merchant_account_id = p_merchant
      and o.cod_status = 'LIVREE'
      and (p_shop_id is null or o.shop_id = p_shop_id)
      and (select role from role_guard) in ('owner','manager')
    group by o.id, o.total_amount, o.updated_at
  ),
  -- Ensemble « collecté » = cash réellement passé entre les mains du livreur, exactement
  -- comme deriveDriverCashConsolidation : cash_state ∈ {collected,remitted,discrepancy}.
  -- collectable = coalesce(stored, canal mobile ? 0 : round(total)) — réplique cashCollectableMinor.
  -- frais = delivery_fee des commandes collectées. Cross-boutiques (pas de p_shop_id).
  collected_by_driver as (
    select
      o.assigned_driver_id as driver_id,
      sum(
        coalesce(
          o.cash_collectable_minor,
          case
            when coalesce(o.payment_channel_at_delivery, 'INCONNU')
                 in ('WAVE','ORANGE_MONEY','FREE_MONEY') then 0
            else round(o.total_amount)::bigint
          end
        )
      ) as collected_minor,
      sum(coalesce(o.delivery_fee_minor, 0)) as fees_minor
    from public.orders o
    where o.merchant_account_id = p_merchant
      and o.assigned_driver_id is not null
      and o.cash_state in ('collected','remitted','discrepancy')
      and (select role from role_guard) in ('owner','manager')
    group by o.assigned_driver_id
  ),
  -- « remis » = Σ allocations sur TOUTES les commandes du livreur (jointure séparée pour
  -- éviter que le fan-out des allocations ne multiplie collected_minor). Idem réf. TS.
  remitted_by_driver as (
    select
      o.assigned_driver_id as driver_id,
      coalesce(sum(sa.allocated_minor), 0) as remitted_minor
    from public.orders o
    join public.settlement_allocation sa
      on sa.order_id = o.id
     and sa.merchant_account_id = o.merchant_account_id
    where o.merchant_account_id = p_merchant
      and o.assigned_driver_id is not null
      and (select role from role_guard) in ('owner','manager')
    group by o.assigned_driver_id
  ),
  -- cashOnHand par livreur = greatest(collecté − frais − remis, 0), clamp AGRÉGÉ.
  outstanding_by_driver as (
    select
      c.driver_id,
      greatest(c.collected_minor - c.fees_minor - coalesce(r.remitted_minor, 0), 0)
        as outstanding_minor
    from collected_by_driver c
    left join remitted_by_driver r on r.driver_id = c.driver_id
  ),
  refusal_counts as (
    select
      count(*) filter (where cod_status in ('REFUSEE','ANNULEE'))::numeric as refused,
      count(*) filter (where cod_status in ('LIVREE','REFUSEE','ANNULEE'))::numeric as decided
    from public.orders
    where merchant_account_id = p_merchant
      and created_at >= p_from
      and created_at < p_to
      and (p_shop_id is null or shop_id = p_shop_id)
      and (select role from role_guard) in ('owner','manager')
  )
  select
    coalesce(sum(round(d.total_amount)::bigint) filter (
      where d.delivered_at >= p_from and d.delivered_at < p_to
    ), 0)::bigint as ca_livre,
    coalesce((select sum(outstanding_minor) from outstanding_by_driver), 0)::bigint
      as cash_chez_livreurs,
    coalesce((
      select sum(amount_received_minor)
      from public.cash_settlement
      where merchant_account_id = p_merchant
        and settled_at >= p_from
        and settled_at < p_to
        and (select role from role_guard) in ('owner','manager')
    ), 0)::bigint as encaisse,
    coalesce((select sum(outstanding_minor) from outstanding_by_driver), 0)::bigint
      as a_encaisser,
    coalesce((
      select 100.0 * refused / nullif(decided, 0)
      from refusal_counts
    ), 0)::numeric as taux_refus
  from delivered_orders d
  having (select role from role_guard) in ('owner','manager');
$$;

revoke all on function public.finance_kpis(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.finance_kpis(uuid, timestamptz, timestamptz, uuid)
  to authenticated;
