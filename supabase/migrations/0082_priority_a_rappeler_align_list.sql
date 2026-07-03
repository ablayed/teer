-- 0082 — Tableau « Priorités à traiter » (Ticket 3, Option A) : aligner le compteur
-- « À rappeler » sur sa liste-cible /commandes?vue=tentee-a-rappeler.
--
-- Bug corrigé (issue #58) : la ligne « À rappeler aujourd'hui » comptait
--   open + callback + next_contact_at = AUJOURD'HUI. Or le geste « À rappeler »
--   (journaliser_appel) ne demande jamais de date de rappel → next_contact_at reste
--   TOUJOURS null → compteur structurellement à 0, alors que la liste (tentee-a-rappeler =
--   open + callback, sans filtre de date) affiche bien les tentées. Compteur ≠ liste.
--
-- Fix : le compteur « À rappeler » compte désormais TOUTES les tentées open + callback
--   (univers exact du lien cible) → compteur = liste. On retire le filtre de date, donc
--   les paramètres p_today_start / p_today_end deviennent inutiles → nouvelle signature
--   à 4 args (drop de la version 6 args de 0081, puis recréation).
--
-- Les 3 autres compteurs sont INCHANGÉS (mêmes règles, mêmes bornes 7j p_since/p_until
--   calculées côté TS et passées en timestamptz). security invoker, tenant + shop-scopé.
--
-- ⚠️ Clé jsonb renommée : `a_rappeler_aujourdhui` → `a_rappeler` (consommée par
--   lib/actions/dashboard.ts). Le TS bascule en conséquence.

drop function if exists public.get_dashboard_priority_counts(
  uuid, timestamptz, timestamptz, timestamptz, timestamptz, uuid
);

create or replace function public.get_dashboard_priority_counts(
  p_merchant_id uuid,
  p_since timestamptz,
  p_until timestamptz,
  p_shop_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    -- À appeler : A_APPELER + created_at dans la fenêtre 7j (inchangé).
    'a_appeler', (
      select count(*)
      from public.orders o
      where o.merchant_account_id = p_merchant_id
        and o.cod_status = 'A_APPELER'
        and o.created_at >= p_since
        and o.created_at <= p_until
        and (p_shop_id is null or o.shop_id = p_shop_id)
    ),
    -- À rappeler : TOUTES les tentées open + callback (= liste tentee-a-rappeler), sans
    -- filtre de date (next_contact_at n'est jamais renseigné par le geste « À rappeler »).
    'a_rappeler', (
      select count(*)
      from public.orders o
      where o.merchant_account_id = p_merchant_id
        and o.order_state = 'open'
        and o.call_state = 'callback'
        and (p_shop_id is null or o.shop_id = p_shop_id)
    ),
    -- En cours de livraison : transition EN_LIVRAISON 7j ET état courant out_for_delivery (inchangé).
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
    -- Annulées / Retours : transition ANNULEE/REFUSEE 7j ET état courant cancelled/returned (inchangé).
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

revoke all on function public.get_dashboard_priority_counts(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.get_dashboard_priority_counts(uuid, timestamptz, timestamptz, uuid) to authenticated;
