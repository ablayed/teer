-- 0081 — Tableau « Priorités à traiter » : RPC groupée non plafonnée (Ticket 2, Volet A).
--
-- Cause racine (auditée) : 3 des 4 lignes de « Priorités à traiter » agrégeaient CÔTE JS sur
--   des requêtes PostgREST SANS pagination → tronquées silencieusement à 1000 (config.toml
--   max_rows = 1000). Cap latent (rarement > 1000 sur 7j aujourd'hui) mais même classe de bug
--   que le Ticket 1 → corrigé préventivement. Lignes concernées (fetchPriorityCountsForUser) :
--     * à-rappeler-aujourd'hui : orders(next_contact_at) callback sans .limit
--     * en-livraison           : order_state_transition EN_LIVRAISON 7j sans .limit
--     * annulées/retours       : order_state_transition ANNULEE/REFUSEE 7j sans .limit
--   (« À appeler » était déjà un count(head) non plafonné — folded ici à l'identique.)
--
-- Fix : une seule RPC agrégée (4 count(*) / count(distinct) en un appel, zéro ligne rapatriée).
--
-- ⚠️ Bornes de dates NON réimplémentées en SQL. Les helpers TS restent la source de vérité du
--   « jour métier » (resolvePeriodRange('7j') et startOfLocalDay = heure locale du process
--   serveur). On PASSE les bornes déjà calculées en timestamptz → aucune dépendance au TZ de
--   la session Postgres, jour métier strictement identique à l'existant :
--     * p_since / p_until           : fenêtre 7j (resolvePeriodRange, TS)
--     * p_today_start / p_today_end : jour local [startOfLocalDay(now), +1 jour[ (TS)
--   Règles métier reproduites à l'identique (états courants + dédup order_id), on retire
--   UNIQUEMENT le cap.
--
-- security invoker : lit via les policies RLS de l'appelant ; filtre tenant merchant_account_id
--   explicite + shop_id optionnel NULL-safe. GRANT execute to authenticated.
-- Indexes : couverts par l'existant (order_state_transition_order_to_status_created_idx 0009,
--   order_state_transition_merchant_account_idx 0007, orders_merchant_cod_status_idx 0005).

create or replace function public.get_dashboard_priority_counts(
  p_merchant_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_today_start timestamptz,
  p_today_end timestamptz,
  p_shop_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    -- À appeler : A_APPELER + created_at dans la fenêtre 7j (identique au count head actuel).
    'a_appeler', (
      select count(*)
      from public.orders o
      where o.merchant_account_id = p_merchant_id
        and o.cod_status = 'A_APPELER'
        and o.created_at >= p_since
        and o.created_at <= p_until
        and (p_shop_id is null or o.shop_id = p_shop_id)
    ),
    -- À rappeler aujourd'hui : open + callback + next_contact_at sur le jour local de now.
    -- [p_today_start, p_today_end[ = équivalent instant-exact de isSameLocalDate (exclut NULL).
    'a_rappeler_aujourdhui', (
      select count(*)
      from public.orders o
      where o.merchant_account_id = p_merchant_id
        and o.order_state = 'open'
        and o.call_state = 'callback'
        and o.next_contact_at >= p_today_start
        and o.next_contact_at < p_today_end
        and (p_shop_id is null or o.shop_id = p_shop_id)
    ),
    -- En cours de livraison : transition EN_LIVRAISON dans 7j ET état courant out_for_delivery.
    -- count(distinct order_id) = dédup du Set() actuel (plusieurs transitions possibles / cmd).
    'en_livraison', (
      select count(distinct ost.order_id)
      from public.order_state_transition ost
      join public.orders o on o.id = ost.order_id
      where ost.merchant_account_id = p_merchant_id
        and ost.to_status = 'EN_LIVRAISON'
        and ost.created_at >= p_since
        and ost.created_at <= p_until
        and o.delivery_state = 'out_for_delivery'
        and (p_shop_id is null or o.shop_id = p_shop_id)
    ),
    -- Annulées / Retours : transition ANNULEE/REFUSEE dans 7j ET état courant cancelled/returned.
    'annulees_retours', (
      select count(distinct ost.order_id)
      from public.order_state_transition ost
      join public.orders o on o.id = ost.order_id
      where ost.merchant_account_id = p_merchant_id
        and ost.to_status in ('ANNULEE', 'REFUSEE')
        and ost.created_at >= p_since
        and ost.created_at <= p_until
        and o.order_state in ('cancelled', 'returned')
        and (p_shop_id is null or o.shop_id = p_shop_id)
    )
  );
$$;

revoke all on function public.get_dashboard_priority_counts(uuid, timestamptz, timestamptz, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.get_dashboard_priority_counts(uuid, timestamptz, timestamptz, timestamptz, timestamptz, uuid) to authenticated;
