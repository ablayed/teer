-- 0166 — L11B-2 : get_order_view_counts en un seul passage.
--
-- À appliquer après 0164 (L11B-1). Aucun droit ne change, aucun résultat ne change.
--
-- Avant : les commandes du compte étaient lues dans une CTE référencée sept fois. PostgreSQL
-- matérialise une CTE référencée plus d'une fois : une lecture de la table, puis sept parcours
-- de la copie, un par compteur.
-- Après : une seule lecture, sept agrégats filtrés (`count(*) filter (where …)`).
--
-- Équivalence, vérifiée par tests/rls/l11b2-order-view-counts.rls.test.ts contre le texte de
-- l'ancienne requête (0149), sous le même rôle et sur les mêmes données :
--   * les sept vues, dans le même ordre, toujours sept lignes, 0 compris ;
--   * les bornes sont inclusives des deux côtés (>= p_from, <= p_to) ;
--   * « a-appeler » date sur created_at SEUL ; les quatre autres vues à fenêtre datent sur
--     coalesce(created_at_shopify, created_at) ;
--   * « en-livraison » et « annulees-retours » n'ont pas de fenêtre (état courant, TB-CPT) ;
--   * un seul prédicat de boutique, `p_shop_id is null or o.shop_id = p_shop_id` : pas de
--     branche par valeur de p_shop_id.
--
-- Signature, type de retour, langage, volatilité, SECURITY INVOKER et search_path identiques à
-- 0149 : CREATE OR REPLACE conserve l'ACL (à revérifier sur pg_proc.proacl). La visibilité reste
-- celle de la RLS de l'appelant.
create or replace function public.get_order_view_counts(
  p_merchant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns table (
  view_id text,
  count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with totals as (
    select
      count(*) filter (
        where coalesce(o.created_at_shopify, o.created_at) >= p_from
          and coalesce(o.created_at_shopify, o.created_at) <= p_to
      ) as toutes,
      count(*) filter (
        where o.order_state = 'open'
          and o.call_state = 'to_call'
          and o.created_at >= p_from
          and o.created_at <= p_to
      ) as a_appeler,
      count(*) filter (
        where o.order_state = 'open'
          and o.call_state = 'callback'
          and coalesce(o.created_at_shopify, o.created_at) >= p_from
          and coalesce(o.created_at_shopify, o.created_at) <= p_to
      ) as tentee_a_rappeler,
      count(*) filter (
        where o.order_state = 'open'
          and o.call_state = 'validated'
          and o.delivery_state in ('unassigned', 'scheduled', 'assigned')
          and coalesce(o.created_at_shopify, o.created_at) >= p_from
          and coalesce(o.created_at_shopify, o.created_at) <= p_to
      ) as confirmee,
      -- TB-CPT : état courant seul, sans fenêtre.
      count(*) filter (
        where o.delivery_state = 'out_for_delivery'
      ) as en_livraison,
      count(*) filter (
        where o.order_state = 'completed'
          and coalesce(o.created_at_shopify, o.created_at) >= p_from
          and coalesce(o.created_at_shopify, o.created_at) <= p_to
      ) as valide,
      -- TB-CPT : état courant seul, sans fenêtre.
      count(*) filter (
        where o.order_state in ('cancelled', 'returned')
      ) as annulees_retours
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and (p_shop_id is null or o.shop_id = p_shop_id)
  )
  select v.view_id, v.total as count
  from totals t
  cross join lateral (
    values
      (1, 'toutes'::text, t.toutes),
      (2, 'a-appeler', t.a_appeler),
      (3, 'tentee-a-rappeler', t.tentee_a_rappeler),
      (4, 'confirmee', t.confirmee),
      (5, 'en-livraison', t.en_livraison),
      (6, 'valide', t.valide),
      (7, 'annulees-retours', t.annulees_retours)
  ) as v(position, view_id, total)
  order by v.position;
$$;
