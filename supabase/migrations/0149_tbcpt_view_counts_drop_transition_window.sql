-- 0149 — TB-CPT : le compteur du Tableau doit égaler la population au clic.
--
-- Défaut mesuré en production le 31 août 2026, par boutique :
--   En cours de livraison : 24 commandes dans l'état, 4 comptées (20 masquées, 83 %)
--   Annulées / Retours    : 130 commandes dans l'état, 9 comptées (121 masquées, 93 %)
--
-- Cause : `en-livraison`/`annulees-retours` exigeaient un AND composé — état courant
-- (delivery_state='out_for_delivery' / order_state in (cancelled,returned)) ET une transition
-- vers ce statut dans une fenêtre de 7 jours (order_state_transition.created_at). Une commande
-- dans l'état visé depuis plus de 7 jours n'était donc jamais comptée, alors qu'elle reste bien
-- dans l'état — c'est justement celle qui traîne le plus qui disparaissait.
--
-- Décision produit (fondateur, figée) : la fenêtre de sept jours disparaît des compteurs.
-- L'ancienneté devient un signal de priorité (traité séparément par UX-COD-01, hors scope ici),
-- jamais un critère d'invisibilité. `matchesOrderSavedView` (lib/domain/order-saved-views.ts,
-- INCHANGÉ par ce lot) définit déjà `en-livraison`/`annulees-retours` sur le seul état courant,
-- sans aucune notion de date — c'est la référence à laquelle les compteurs se rallient.
--
-- Périmètre établi par lecture intégrale de 0088/0081 (+0082, qui a redéfini
-- get_dashboard_priority_counts en 4 args) et de lib/domain/order-saved-views.ts :
-- SEULES `en-livraison` et `annulees-retours` divergent, dans les TROIS RPC qui en dépendent —
-- `toutes`/`a-appeler`/`tentee-a-rappeler`/`confirmee`/`valide` bornent sur la date de LA
-- COMMANDE (created_at/created_at_shopify), jamais sur une transition ; `tentee-a-rappeler` côté
-- Tableau (a_rappeler) a déjà été aligné sans filtre de date par 0082 (issue #58, même motif,
-- précédent direct de ce lot pour les deux compteurs restants).
--
-- Périmètre étendu (arbitré avec le fondateur, hors lecture initialement demandée) :
-- `list_orders_keyset` (0089) porte le MÊME AND composé sur ces deux vues et sert réellement la
-- liste rendue à `/commandes` quand aucune recherche n'est active (chemin majoritaire, y compris
-- au clic depuis le Tableau). Son propre commentaire dit explicitement avoir répliqué le
-- contrat de 0088 pour ne pas diverger. Ne corriger que 0088/0081 aurait donc INVERSÉ le défaut
-- (compteur à 24/130, liste rendue toujours à 4/9) au lieu de le fermer. Les trois RPC sont
-- donc alignées ensemble dans cette seule migration.
--
-- lib/domain/order-saved-views.ts (matchesOrderSavedView) N'EST PAS TOUCHÉ : c'est déjà la
-- référence exacte vers laquelle les compteurs se rallient — la liste ne bouge pas, les
-- compteurs et la RPC qui sert la liste (0089) la rejoignent.
--
-- Paramètres de fenêtre devenus inutiles : AUCUN. `p_from`/`p_to` (0088, 0089) et
-- `p_since`/`p_until` (0081/0082) restent activement utilisés par les 5 autres vues de chaque
-- RPC (bornées sur la date de commande, inchangées) — aucune signature ne change dans ce lot.
--
-- Index `order_state_transition_merchant_status_created_idx` (0088) : devient inutilisé par les
-- trois RPC ci-dessous (plus aucune n'y joint pour ces deux vues). Conservé sans y toucher —
-- suppression d'index hors périmètre de ce lot (append-only, un objectif).
--
-- Sécurité : signatures inchangées sur les trois fonctions (`create or replace` à signature
-- identique) — ACL préservée automatiquement, revérifiée par lecture directe de `pg_proc.proacl`
-- après application, `security invoker`/`set search_path = public` réécrits explicitement dans
-- chaque corps (non hérités par CREATE OR REPLACE, cf. CLAUDE.md).

-- 1) get_order_view_counts (0088) — /commandes, badges de vues.
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
  with scoped_orders as (
    select
      o.id,
      o.order_state,
      o.call_state,
      o.delivery_state,
      o.created_at,
      o.created_at_shopify
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and (p_shop_id is null or o.shop_id = p_shop_id)
  )
  select 'toutes'::text as view_id, count(*) as count
  from scoped_orders so
  where coalesce(so.created_at_shopify, so.created_at) >= p_from
    and coalesce(so.created_at_shopify, so.created_at) <= p_to

  union all

  select 'a-appeler', count(*)
  from scoped_orders so
  where so.order_state = 'open'
    and so.call_state = 'to_call'
    and so.created_at >= p_from
    and so.created_at <= p_to

  union all

  select 'tentee-a-rappeler', count(*)
  from scoped_orders so
  where so.order_state = 'open'
    and so.call_state = 'callback'
    and coalesce(so.created_at_shopify, so.created_at) >= p_from
    and coalesce(so.created_at_shopify, so.created_at) <= p_to

  union all

  select 'confirmee', count(*)
  from scoped_orders so
  where so.order_state = 'open'
    and so.call_state = 'validated'
    and so.delivery_state in ('unassigned', 'scheduled', 'assigned')
    and coalesce(so.created_at_shopify, so.created_at) >= p_from
    and coalesce(so.created_at_shopify, so.created_at) <= p_to

  union all

  -- TB-CPT : état courant seul, plus de transition récente exigée (0148 masquait 83 % en prod).
  select 'en-livraison', count(*)
  from scoped_orders so
  where so.delivery_state = 'out_for_delivery'

  union all

  select 'valide', count(*)
  from scoped_orders so
  where so.order_state = 'completed'
    and coalesce(so.created_at_shopify, so.created_at) >= p_from
    and coalesce(so.created_at_shopify, so.created_at) <= p_to

  union all

  -- TB-CPT : état courant seul, plus de transition récente exigée (masquait 93 % en prod).
  select 'annulees-retours', count(*)
  from scoped_orders so
  where so.order_state in ('cancelled', 'returned');
$$;

-- 2) list_orders_keyset (0089) — /commandes, liste rendue (chemin sans recherche active).
create or replace function public.list_orders_keyset(
  p_merchant_id uuid,
  p_view text,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null,
  p_cursor_sort timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  id uuid,
  customer_id uuid,
  order_number text,
  total_amount numeric,
  currency text,
  cod_status text,
  order_state text,
  call_state text,
  delivery_state text,
  cash_state text,
  assigned_driver_id uuid,
  items_summary jsonb,
  shipping_address jsonb,
  created_at timestamptz,
  created_at_shopify timestamptz,
  next_contact_at timestamptz,
  scheduled_for timestamptz,
  source text,
  sort_at timestamptz,
  next_action_at timestamptz,
  customer_full_name text,
  customer_phone text
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      p_merchant_id as merchant_id,
      coalesce(nullif(btrim(p_view), ''), 'toutes') as view_id,
      p_from as period_from,
      p_to as period_to,
      p_shop_id as shop_id,
      p_cursor_sort as cursor_sort,
      p_cursor_id as cursor_id,
      least(greatest(p_limit, 1), 100) as page_limit
  ),
  scoped_orders as (
    select
      o.id,
      o.customer_id,
      o.order_number,
      o.total_amount,
      o.currency,
      o.cod_status,
      o.order_state,
      o.call_state,
      o.delivery_state,
      o.cash_state,
      o.assigned_driver_id,
      o.items_summary,
      o.shipping_address,
      o.created_at,
      o.created_at_shopify,
      o.next_contact_at,
      o.scheduled_for,
      o.source,
      o.sort_at,
      o.next_action_at,
      c.full_name as customer_full_name,
      c.phone as customer_phone,
      p.view_id,
      p.cursor_sort,
      p.cursor_id
    from public.orders o
    cross join params p
    left join public.customer c
      on c.id = o.customer_id
     and c.merchant_account_id = p.merchant_id
    where o.merchant_account_id = p.merchant_id
      and (p.shop_id is null or o.shop_id = p.shop_id)
      and case p.view_id
        when 'toutes' then
          o.sort_at >= p.period_from and o.sort_at <= p.period_to
        when 'a-appeler' then
          o.order_state = 'open' and o.call_state = 'to_call'
          and o.created_at >= p.period_from and o.created_at <= p.period_to
        when 'tentee-a-rappeler' then
          o.order_state = 'open' and o.call_state = 'callback'
          and o.sort_at >= p.period_from and o.sort_at <= p.period_to
        when 'confirmee' then
          o.order_state = 'open' and o.call_state = 'validated'
          and o.delivery_state in ('unassigned', 'scheduled', 'assigned')
          and o.sort_at >= p.period_from and o.sort_at <= p.period_to
        -- TB-CPT : état courant seul, plus de transition récente exigée (alignée 0088).
        when 'en-livraison' then
          o.delivery_state = 'out_for_delivery'
        when 'valide' then
          o.order_state = 'completed'
          and o.sort_at >= p.period_from and o.sort_at <= p.period_to
        -- TB-CPT : état courant seul, plus de transition récente exigée (alignée 0088).
        when 'annulees-retours' then
          o.order_state in ('cancelled', 'returned')
        else
          o.sort_at >= p.period_from and o.sort_at <= p.period_to
      end
  )
  select
    s.id,
    s.customer_id,
    s.order_number,
    s.total_amount,
    s.currency,
    s.cod_status,
    s.order_state,
    s.call_state,
    s.delivery_state,
    s.cash_state,
    s.assigned_driver_id,
    s.items_summary,
    s.shipping_address,
    s.created_at,
    s.created_at_shopify,
    s.next_contact_at,
    s.scheduled_for,
    s.source,
    s.sort_at,
    s.next_action_at,
    s.customer_full_name,
    s.customer_phone
  from scoped_orders s
  where case
    when s.view_id = 'tentee-a-rappeler' then
      s.cursor_sort is null
      or s.cursor_id is null
      or (s.next_action_at, s.id) > (s.cursor_sort, s.cursor_id)
    else
      s.cursor_sort is null
      or s.cursor_id is null
      or (s.sort_at, s.id) < (s.cursor_sort, s.cursor_id)
  end
  order by
    case when s.view_id = 'tentee-a-rappeler' then s.next_action_at end asc,
    case when s.view_id = 'tentee-a-rappeler' then s.id end asc,
    case when s.view_id <> 'tentee-a-rappeler' then s.sort_at end desc,
    case when s.view_id <> 'tentee-a-rappeler' then s.id end desc
  limit (select page_limit from params);
$$;

-- 3) get_dashboard_priority_counts (0081, redéfinie 4-args par 0082) — Tableau, « Priorités à traiter ».
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
    -- À appeler : A_APPELER + created_at dans la fenêtre 7j (inchangé, hors périmètre TB-CPT).
    'a_appeler', (
      select count(*)
      from public.orders o
      where o.merchant_account_id = p_merchant_id
        and o.cod_status = 'A_APPELER'
        and o.created_at >= p_since
        and o.created_at <= p_until
        and (p_shop_id is null or o.shop_id = p_shop_id)
    ),
    -- À rappeler : toutes les tentées open + callback, sans filtre de date (inchangé, déjà
    -- aligné par 0082 — issue #58, précédent direct de ce lot).
    'a_rappeler', (
      select count(*)
      from public.orders o
      where o.merchant_account_id = p_merchant_id
        and o.order_state = 'open'
        and o.call_state = 'callback'
        and (p_shop_id is null or o.shop_id = p_shop_id)
    ),
    -- TB-CPT : état courant seul, plus de transition récente exigée (masquait 83 % en prod).
    'en_livraison', (
      select count(*)
      from public.orders o
      where o.merchant_account_id = p_merchant_id
        and o.delivery_state = 'out_for_delivery'
        and (p_shop_id is null or o.shop_id = p_shop_id)
    ),
    -- TB-CPT : état courant seul, plus de transition récente exigée (masquait 93 % en prod).
    'annulees_retours', (
      select count(*)
      from public.orders o
      where o.merchant_account_id = p_merchant_id
        and o.order_state in ('cancelled', 'returned')
        and (p_shop_id is null or o.shop_id = p_shop_id)
    )
  );
$$;
