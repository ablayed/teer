-- 0057 — Fix KPI Tableau (modèle dimensionnel) + intégrité dispatch/livreur.
--
-- Trois corrections issues de la passe manuelle (#5a / #5b / #6) :
--   (a) Réparation données : commandes delivery_state=assigned|out_for_delivery
--       sans livreur (cash orphelin, ex. #1002) → ramenées à 'scheduled'.
--   (b) CHECK d'intégrité : on ne peut plus être assigned|out_for_delivery sans
--       assigned_driver_id (filet base ; la garde moteur donne le bon message).
--   (c) get_dashboard_kpi réécrit sur le modèle dimensionnel (cash_collected_at +
--       cash_state) au lieu du legacy cod_status + created_at, pour coïncider avec
--       Finances (CA encaissé) et Livreurs (cash attendu).
--
-- L'ordre compte : réparer AVANT d'ajouter le CHECK (sinon il échoue sur les lignes
-- existantes en violation).

-- ────────────────────────────────────────────────────────────────────────────
-- (a) Réparation des données orphelines — AVANT la contrainte.
-- Écriture directe de delivery_state : exception « backfill/réparation » (le trigger
-- BEFORE UPDATE derive_legacy_cod_status re-dérive cod_status : EN_LIVRAISON → PROGRAMMEE,
-- zéro drift). cash_state laissé tel quel : 'expected' reste valide pour 'scheduled'.
-- Aucun livreur deviné, rien supprimé.
update public.orders
set delivery_state = 'scheduled'
where delivery_state in ('assigned', 'out_for_delivery')
  and assigned_driver_id is null;

-- ────────────────────────────────────────────────────────────────────────────
-- (b) Contrainte d'intégrité — invariante : dispatch ⇒ livreur.
-- NULL-safe. Scope limité à assigned|out_for_delivery (vraie anomalie). Exclut
-- delivered|failed|returned qui CONSERVENT assigned_driver_id (attribution cash
-- historique Livreurs) et pourraient légitimement être à livreur nul en legacy.
alter table public.orders
  add constraint orders_dispatch_requires_driver
  check (
    delivery_state is null
    or delivery_state not in ('assigned', 'out_for_delivery')
    or assigned_driver_id is not null
  );

-- ────────────────────────────────────────────────────────────────────────────
-- (c) get_dashboard_kpi — réécrit sur le modèle dimensionnel.
-- Mêmes clés jsonb qu'en 0010 → toDashboardKpi (lib/actions/dashboard.ts) inchangé.
-- Reste SECURITY INVOKER : scopé par RLS + p_merchant_id (parité 0010).
--
-- Changements vs 0010 :
--   ca_collecte_7j : cash_collected_at >= now()-7j (encaissement réel), PAS created_at
--                    ni cod_status='LIVREE'. Mirror exact de Finances (report-data.ts).
--   ca_en_attente  : cash_state='expected', SUM(coalesce(cash_collectable_minor,
--                    round(total_amount))) — identique au calcul Livreurs
--                    (cash-consolidation.ts) pour que les deux chiffres coïncident.
--   sparkline_7j   : agrégé par jour sur cash_collected_at.
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

  -- CA collecté (7 j) — encaissement réel : cash_collected_at, fenêtre 7 jours.
  select coalesce(sum(total_amount), 0) into v_ca_collecte_7j
  from orders
  where merchant_account_id = p_merchant_id
    and cash_collected_at is not null
    and cash_collected_at >= now() - interval '7 days';

  -- CA à livrer (attendu) — dimension cash : cash_state='expected'. Même formule
  -- de montant collectable que Livreurs (stored minor sinon total arrondi).
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

  -- Sparkline 7 j — CA collecté par jour, indexé sur cash_collected_at.
  select jsonb_agg(
    jsonb_build_object('date', day::date, 'value', coalesce(daily_total, 0))
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
    select date_trunc('day', cash_collected_at) as order_day, sum(total_amount) as daily_total
    from orders
    where merchant_account_id = p_merchant_id
      and cash_collected_at is not null
      and cash_collected_at >= now() - interval '7 days'
    group by 1
  ) totals on totals.order_day = days.day;

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
