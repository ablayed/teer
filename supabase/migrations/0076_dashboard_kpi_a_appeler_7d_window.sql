-- 0076 — Tableau : borne la carte « À appeler » aux 7 derniers jours + delta 7j-vs-7j-précédents.
--
-- Contexte (Bug 2) :
--   La carte « À appeler » du Tableau affichait le décompte de TOUTES les commandes
--   A_APPELER depuis toujours (aucune borne temporelle) => valeur cumulée irréaliste
--   (ex. 1012). On borne le compteur aux commandes A_APPELER créées dans les 7 derniers
--   jours (fenêtre glissante `now()`, UTC — MVP, pas de date_trunc / timezone métier).
--
-- Décision produit (Option A) : on borne UNIQUEMENT la carte KPI du Tableau. La liste
--   /commandes?vue=a-appeler reste le backlog complet (matchesOrderSavedView, non modifié).
--
-- Delta cohérent :
--   avant, `a_appeler_delta` comparait le total au sous-total « created_at < now()-1j »
--   (v_a_appeler_yesterday), ce qui, une fois le compteur borné à 7 j, produirait un delta
--   négatif géant. On redéfinit la référence sur les 7 JOURS PRÉCÉDENTS (J-14 → J-7) :
--     delta = A_APPELER (7 j courants) − A_APPELER (7 j précédents).
--
-- Clés jsonb PUBLIQUES INCHANGÉES : `a_appeler_count`, `a_appeler_delta` (consommées par
--   lib/actions/dashboard.ts::toDashboardKpi et components/kpi/dashboard-kpi-refresh.tsx).
--   `a_appeler_yesterday` n'a JAMAIS été exposé en jsonb — variable interne uniquement,
--   ici renommée `v_a_appeler_prev_7d` (référence = previous_7_days). Aucun code TS impacté.
--
-- Signature 2 args INCHANGÉE (p_merchant_id, p_shop_id) ; security invoker INCHANGÉ ;
--   filtres merchant_account_id / shop_id INCHANGÉS. Simple CREATE OR REPLACE.
--   Seuls les deux blocs de comptage A_APPELER et la formule du delta changent vs 0064 ;
--   le reste du corps (CA, taux, sparkline) est repris à l'identique.

create or replace function public.get_dashboard_kpi(
  p_merchant_id uuid,
  p_shop_id uuid default null
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_a_appeler_count     integer;
  v_a_appeler_prev_7d   integer;  -- référence delta = 7 jours précédents (previous_7_days)
  v_ca_collecte_7j      numeric;
  v_ca_en_attente       numeric;
  v_taux_confirmation   numeric;
  v_taux_livraison      numeric;
  v_sparkline           jsonb;
begin

  -- Carte « À appeler » : bornée aux 7 derniers jours (fenêtre glissante now(), UTC).
  select count(*) into v_a_appeler_count
  from orders
  where merchant_account_id = p_merchant_id
    and cod_status = 'A_APPELER'
    and created_at >= now() - interval '7 days'
    and (p_shop_id is null or shop_id = p_shop_id);

  -- Référence du delta = 7 jours PRÉCÉDENTS (J-14 → J-7), pour un delta 7j-vs-7j.
  select count(*) into v_a_appeler_prev_7d
  from orders
  where merchant_account_id = p_merchant_id
    and cod_status = 'A_APPELER'
    and created_at >= now() - interval '14 days'
    and created_at <  now() - interval '7 days'
    and (p_shop_id is null or shop_id = p_shop_id);

  -- CA collecté (7 j) — « Chiffre d'affaires » unifié : NET livraison ET NET retours,
  -- miroir exact de profit.ts (netCAMinor = caMinor − deliveryFees − returnContraRevenue).
  select
    coalesce((
      select sum(total_amount - coalesce(delivery_fee_minor, 0))
      from orders
      where merchant_account_id = p_merchant_id
        and cash_collected_at is not null
        and cash_collected_at >= now() - interval '7 days'
        and (p_shop_id is null or shop_id = p_shop_id)
    ), 0)
    -
    coalesce((
      select sum(total_amount - coalesce(delivery_fee_minor, 0))
      from orders
      where merchant_account_id = p_merchant_id
        and returned_at is not null
        and returned_at >= now() - interval '7 days'
        and cash_collected_at is not null
        and (p_shop_id is null or shop_id = p_shop_id)
    ), 0)
  into v_ca_collecte_7j;

  -- CA à livrer (attendu) — dimension cash : cash_state='expected'. Même formule
  -- de montant collectable que Livreurs (stored minor sinon total arrondi).
  -- INCHANGÉ vs 0057 : cash attendu = plein collectable, jamais net de livraison.
  select coalesce(sum(coalesce(cash_collectable_minor, round(total_amount))), 0)
    into v_ca_en_attente
  from orders
  where merchant_account_id = p_merchant_id
    and cash_state = 'expected'
    and (p_shop_id is null or shop_id = p_shop_id);

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
    and o.created_at >= now() - interval '30 days'
    and (p_shop_id is null or o.shop_id = p_shop_id);

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
  where merchant_account_id = p_merchant_id
    and (p_shop_id is null or shop_id = p_shop_id);

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
      and (p_shop_id is null or shop_id = p_shop_id)
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
      and (p_shop_id is null or shop_id = p_shop_id)
    group by 1
  ) returned on returned.order_day = days.day;

  return jsonb_build_object(
    'a_appeler_count',   v_a_appeler_count,
    -- delta = A_APPELER (7 j courants) − A_APPELER (7 j précédents / previous_7_days).
    'a_appeler_delta',   v_a_appeler_count - v_a_appeler_prev_7d,
    'ca_collecte_7j',    v_ca_collecte_7j,
    'ca_en_attente',     v_ca_en_attente,
    'taux_confirmation', v_taux_confirmation,
    'taux_livraison',    v_taux_livraison,
    'sparkline_7j',      v_sparkline
  );
end;
$$;

revoke all on function public.get_dashboard_kpi(uuid, uuid) from public, anon;
grant execute on function public.get_dashboard_kpi(uuid, uuid) to authenticated;
