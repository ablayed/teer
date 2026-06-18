-- 0064 — Phase 13 : filtre boutique optionnel sur Tableau + Finances.
--
-- Backfill minimal :
--   seules les commandes manuelles/sociales sans shop_id d'un tenant ayant exactement une boutique
--   reçoivent cette boutique. Les tenants sans boutique restent NULL : "Toutes" les inclut, un
--   filtre boutique les exclut, et aucun sélecteur boutique ne sera affiché pour eux.
--
-- Signatures :
--   ajout de p_shop_id uuid default null EN DERNIER PARAMÈTRE => nouvelle signature Postgres.
--   On DROP l'ancienne signature puis CREATE la nouvelle, avec re-grants explicites.
--
-- Cash livreur :
--   dans finance_kpis, p_shop_id filtre les agrégats commande/CA/refus uniquement.
--   cash_chez_livreurs / a_encaisser / encaisse restent cross-boutiques.

with single_shop as (
  select merchant_account_id, (array_agg(id order by installed_at, id))[1] as shop_id
  from public.shop
  group by merchant_account_id
  having count(*) = 1
)
update public.orders o
   set shop_id = s.shop_id
  from single_shop s
 where o.merchant_account_id = s.merchant_account_id
   and o.shop_id is null
   and o.source in ('manual', 'whatsapp', 'instagram', 'tiktok', 'facebook');

drop function if exists public.get_dashboard_kpi(uuid);

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
    and cod_status = 'A_APPELER'
    and (p_shop_id is null or shop_id = p_shop_id);

  select count(*) into v_a_appeler_yesterday
  from orders
  where merchant_account_id = p_merchant_id
    and cod_status = 'A_APPELER'
    and created_at < now() - interval '1 day'
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
    'a_appeler_delta',   v_a_appeler_count - v_a_appeler_yesterday,
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

drop function if exists public.finance_kpis(uuid, timestamptz, timestamptz);

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
  outstanding_orders as (
    select
      o.id,
      greatest(
        coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
          - coalesce(sum(sa.allocated_minor), 0),
        0
      ) as outstanding_minor
    from public.orders o
    left join public.settlement_allocation sa
      on sa.order_id = o.id
     and sa.merchant_account_id = o.merchant_account_id
    where o.merchant_account_id = p_merchant
      and o.cod_status = 'LIVREE'
      and o.assigned_driver_id is not null
      and coalesce(o.payment_channel_at_delivery, 'INCONNU') in ('ESPECES','INCONNU')
      and (select role from role_guard) in ('owner','manager')
    group by o.id, o.cash_collectable_minor, o.total_amount
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
    coalesce((select sum(outstanding_minor) from outstanding_orders), 0)::bigint
      as cash_chez_livreurs,
    coalesce((
      select sum(amount_received_minor)
      from public.cash_settlement
      where merchant_account_id = p_merchant
        and settled_at >= p_from
        and settled_at < p_to
        and (select role from role_guard) in ('owner','manager')
    ), 0)::bigint as encaisse,
    coalesce((select sum(outstanding_minor) from outstanding_orders), 0)::bigint
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
