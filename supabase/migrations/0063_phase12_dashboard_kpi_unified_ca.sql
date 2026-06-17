-- 0063 — Phase 12 : « Chiffre d'affaires » unifié (net livraison + net retours) au Tableau.
--
-- CREATE OR REPLACE SEUL. Mêmes clés jsonb qu'en 0057 → toDashboardKpi (lib/actions/
-- dashboard.ts) INCHANGÉ. Type de retour inchangé → AUCUN drop nécessaire.
--
-- Corps IDENTIQUE byte-for-byte à 0057 SAUF v_ca_collecte_7j et v_sparkline, réécrits
-- pour MIROITER profit.ts / report-data.ts À L'IDENTIQUE (même ancre, même contre-valeur) :
--
--   CA net = Σ(total_amount − coalesce(delivery_fee_minor,0))  sur cash_collected_at ∈ fenêtre
--          − Σ(total_amount − coalesce(delivery_fee_minor,0))  sur returned_at ∈ fenêtre
--              ET cash_collected_at IS NOT NULL
--
--   • Ancre CA encaissé        : cash_collected_at        (= report-data.ts collectedRaw)
--   • Ancre contre-valeur retour: returned_at + cash_collected_at not null
--                                                          (= report-data.ts returnedRaw)
--   • Contre-valeur            : total_amount − delivery_fee_minor, présentation A
--                                                          (= computeReturnContraRevenue)
--   → Tableau et Finances partagent LA MÊME définition ; seules les fenêtres diffèrent
--     (Tableau = 7 j fixes, libellé honnête « CA collecté (7 j) » ; Finances = période
--     choisie). Pas d'égalité de chiffre prétendue hors période = 7 j.
--
-- v_ca_en_attente : INCHANGÉ (cash_state='expected', plein collectable). C'est le cash
--   que le livreur va remettre, PAS un CA → on ne le nette pas de la livraison, sinon on
--   casse la parité Tableau ↔ Livreurs (cash-consolidation.ts expectedMinor) bâtie en 0057.
--
-- NON rejoués (déjà en prod depuis 0057, hors périmètre, risqués à rejouer) :
--   • la réparation UPDATE des dispatch orphelins (assigned/out_for_delivery sans livreur) ;
--   • la contrainte CHECK orders_dispatch_requires_driver.
-- a_appeler / taux_confirmation / taux_livraison : INCHANGÉS (hors périmètre).

create or replace function get_dashboard_kpi(p_merchant_id uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_a_appeler_count     integer;
  v_a_appeler_yesterday integer;
  v_ca_collecte_7j      numeric;
  v_ca_en_attente       numeric;
  v_taux_confirmation   numeric;
  v_taux_livraison      numeric;
  v_sparkline           jsonb;
begin

  select count(*) into v_a_appeler_count
  from orders
  where merchant_account_id = p_merchant_id
    and cod_status = 'A_APPELER';

  select count(*) into v_a_appeler_yesterday
  from orders
  where merchant_account_id = p_merchant_id
    and cod_status = 'A_APPELER'
    and created_at < now() - interval '1 day';

  -- CA collecté (7 j) — « Chiffre d'affaires » unifié : NET livraison ET NET retours,
  -- miroir exact de profit.ts (netCAMinor = caMinor − deliveryFees − returnContraRevenue).
  select
    coalesce((
      select sum(total_amount - coalesce(delivery_fee_minor, 0))
      from orders
      where merchant_account_id = p_merchant_id
        and cash_collected_at is not null
        and cash_collected_at >= now() - interval '7 days'
    ), 0)
    -
    coalesce((
      select sum(total_amount - coalesce(delivery_fee_minor, 0))
      from orders
      where merchant_account_id = p_merchant_id
        and returned_at is not null
        and returned_at >= now() - interval '7 days'
        and cash_collected_at is not null
    ), 0)
  into v_ca_collecte_7j;

  -- CA à livrer (attendu) — dimension cash : cash_state='expected'. Même formule
  -- de montant collectable que Livreurs (stored minor sinon total arrondi).
  -- INCHANGÉ vs 0057 : cash attendu = plein collectable, jamais net de livraison.
  select coalesce(sum(coalesce(cash_collectable_minor, round(total_amount))), 0)
    into v_ca_en_attente
  from orders
  where merchant_account_id = p_merchant_id
    and cash_state = 'expected';

  select
    case
      when count(*) = 0 then 0
      else round(
        count(*) filter (
          where exists (
            select 1 from order_state_transition ost
            where ost.order_id = o.id
              and ost.to_status = 'CONFIRMEE'
          )
        ) * 100.0 / count(*), 2
      )
    end into v_taux_confirmation
  from orders o
  where o.merchant_account_id = p_merchant_id
    and o.created_at >= now() - interval '30 days';

  select
    case
      when (
        count(*) filter (where cod_status = 'LIVREE') +
        count(*) filter (
          where cod_status in ('REFUSEE', 'ANNULEE')
          and exists (
            select 1 from order_state_transition ost
            where ost.order_id = id
              and ost.to_status = 'CONFIRMEE'
          )
        )
      ) = 0 then 0
      else round(
        count(*) filter (where cod_status = 'LIVREE') * 100.0 /
        (
          count(*) filter (where cod_status = 'LIVREE') +
          count(*) filter (
            where cod_status in ('REFUSEE', 'ANNULEE')
            and exists (
              select 1 from order_state_transition ost
              where ost.order_id = id
                and ost.to_status = 'CONFIRMEE'
            )
          )
        ), 2
      )
    end into v_taux_livraison
  from orders
  where merchant_account_id = p_merchant_id;

  -- Sparkline 7 j — CA NET par jour, cohérent avec v_ca_collecte_7j : encaissé net
  -- livraison (sur cash_collected_at) MOINS contre-valeur retours net livraison
  -- (sur returned_at, cash_collected_at not null). Σ jours = v_ca_collecte_7j.
  select jsonb_agg(
    jsonb_build_object(
      'date', day::date,
      'value', coalesce(collected_net, 0) - coalesce(returned_net, 0)
    )
    order by day
  ) into v_sparkline
  from (
    select generate_series(
      date_trunc('day', now()) - interval '6 days',
      date_trunc('day', now()),
      interval '1 day'
    ) as day
  ) days
  left join (
    select date_trunc('day', cash_collected_at) as order_day,
           sum(total_amount - coalesce(delivery_fee_minor, 0)) as collected_net
    from orders
    where merchant_account_id = p_merchant_id
      and cash_collected_at is not null
      and cash_collected_at >= now() - interval '7 days'
    group by 1
  ) collected on collected.order_day = days.day
  left join (
    select date_trunc('day', returned_at) as order_day,
           sum(total_amount - coalesce(delivery_fee_minor, 0)) as returned_net
    from orders
    where merchant_account_id = p_merchant_id
      and returned_at is not null
      and returned_at >= now() - interval '7 days'
      and cash_collected_at is not null
    group by 1
  ) returned on returned.order_day = days.day;

  return jsonb_build_object(
    'a_appeler_count',   v_a_appeler_count,
    'a_appeler_delta',   v_a_appeler_count - v_a_appeler_yesterday,
    'ca_collecte_7j',    v_ca_collecte_7j,
    'ca_en_attente',     v_ca_en_attente,
    'taux_confirmation', v_taux_confirmation,
    'taux_livraison',    v_taux_livraison,
    'sparkline_7j',      v_sparkline
  );
end;
$$;
