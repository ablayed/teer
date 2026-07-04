-- 0089 — Lot 7 (Option A validée) : pagination keyset SQL pour la liste `/commandes`,
-- UNIQUEMENT quand aucune recherche texte n'est active (search === ''). Le chemin TS legacy
-- (lib/actions/orders.ts:listOrdersForPageData/fetchOrdersPageData) reste utilisé À L'IDENTIQUE
-- quand search !== '' — la recherche fait du matching flou nom/produit/téléphone sénégalais non
-- porté en SQL dans ce lot (hors scope, cf. rapport PHASE A).
--
-- Pourquoi une NOUVELLE RPC et pas la RPC dormante `list_orders_paginated` (0045→0062) :
-- auditée en entier (5 migrations), elle diverge du contrat actuel sur 3 points majeurs :
--   1. Aucune des 5 versions n'a jamais eu de fenêtre de période (p_from/p_to) — /commandes
--      filtre par période (défaut 30j) depuis son introduction, POSTÉRIEURE à cette RPC.
--   2. Aucune des 5 versions n'a jamais eu de p_shop_id — le filtre boutique n'existait pas
--      quand cette RPC a été développée (Phase 9-11).
--   3. `en-livraison`/`annulees-retours` n'y vérifient que l'état courant (delivery_state=
--      out_for_delivery / order_state cancelled|returned), SANS la condition de transition dans
--      la fenêtre — régresserait le contrat validé en Lot 6 (0088).
-- La réutiliser telle quelle aurait re-régressé silencieusement période+shop+transitions.
-- Éléments réutilisés de son historique : les colonnes générées `sort_at`/`next_action_at`
-- (migration 0044, INCHANGÉES ici) et leurs 2 index composites (0044, déjà en place — AUCUN
-- nouvel index créé dans cette migration, conformément à la validation « pas de preuve de
-- besoin pour un index créé_at seul sur a-appeler »).
--
-- Colonnes generated STORED (0044, rappel, non modifiées) :
--   sort_at        = coalesce(created_at_shopify, created_at)                    (= orderQueueDate)
--   next_action_at = coalesce(next_contact_at, created_at_shopify, created_at)
--
-- Règles par vue (reproduites à l'identique de matchesOrderSavedView + orderMatchesPeriod,
-- lib/domain/order-saved-views.ts / lib/actions/orders.ts — mêmes prédicats que get_order_view_
-- counts 0088, SÉPARÉS ici : cette RPC ne dépend pas de 0088 et 0088 n'est pas modifiée) :
--   toutes             : sort_at ∈ [p_from,p_to] (bornes INCLUSIVES des deux côtés).
--   a-appeler          : order_state='open' AND call_state='to_call' ; fenêtre sur `created_at`
--                        (PAS sort_at) — le filtre période et le tri/keyset utilisent des champs
--                        DIFFÉRENTS pour cette seule vue (piège identifié en PHASE A).
--   tentee-a-rappeler  : order_state='open' AND call_state='callback' ; fenêtre sort_at ; tri/
--                        keyset ASC sur next_action_at (seule vue non-DESC).
--   confirmee          : order_state='open' AND call_state='validated' AND delivery_state IN
--                        (unassigned,scheduled,assigned) ; fenêtre sort_at.
--   en-livraison       : delivery_state='out_for_delivery' (état COURANT) ET existence d'une
--                        transition to_status='EN_LIVRAISON' dans la fenêtre (order_state_
--                        transition.created_at, PAS sort_at) — AND composé, dédupliqué par
--                        order_id. Tri/keyset reste sort_at (comme aujourd'hui, paginateOrders
--                        ne trie pas différemment cette vue).
--   valide             : order_state='completed' ; fenêtre sort_at.
--   annulees-retours   : order_state IN (cancelled,returned) (état COURANT) ET existence d'une
--                        transition to_status IN (ANNULEE,REFUSEE) dans la fenêtre — même AND
--                        composé qu'en-livraison, tri/keyset sort_at.
--
-- Keyset : tuple (sort_at, id) DESC pour 6 vues, (next_action_at, id) ASC pour tentee-a-
-- rappeler. Tie-breaker `id` obligatoire (sort_at/next_action_at seuls ne sont pas uniques).
-- `p_limit` : plafonné [1,100] (même garde que la RPC dormante) ; le contrat de `hasMore` est
-- délégué à l'appelant TS — celui-ci passe p_limit = taille de page + 1 et calcule hasMore/
-- next_cursor à partir de la ligne surnuméraire, sans nouvelle colonne de sortie ici.
--
-- Shop : orders.shop_id = p_shop_id si fourni (NULL-safe). Pour les vues transition-based, le
-- scope shop s'applique sur `orders` (jointe), pas sur `order_state_transition` — même
-- équivalence que get_order_view_counts (0088).
--
-- Sécurité : security invoker — RLS (`orders_select`/`order_state_transition select`)
-- s'applique normalement, aucune garde de rôle applicative (tout membre du tenant peut voir
-- /commandes aujourd'hui, agent inclus — même contrat que 0088/0080). p_merchant_id combiné à
-- la RLS de l'appelant : un p_merchant_id étranger renvoie 0 ligne, jamais une fuite.
-- `set search_path = public`. `grant execute` à `authenticated` uniquement, jamais `anon`.

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
  en_livraison_orders as (
    select distinct o.id
    from public.orders o
    join public.order_state_transition t on t.order_id = o.id
    cross join params p
    where o.merchant_account_id = p.merchant_id
      and (p.shop_id is null or o.shop_id = p.shop_id)
      and o.delivery_state = 'out_for_delivery'
      and t.merchant_account_id = p.merchant_id
      and t.to_status = 'EN_LIVRAISON'
      and t.created_at >= p.period_from
      and t.created_at <= p.period_to
  ),
  annulees_retours_orders as (
    select distinct o.id
    from public.orders o
    join public.order_state_transition t on t.order_id = o.id
    cross join params p
    where o.merchant_account_id = p.merchant_id
      and (p.shop_id is null or o.shop_id = p.shop_id)
      and o.order_state in ('cancelled', 'returned')
      and t.merchant_account_id = p.merchant_id
      and t.to_status in ('ANNULEE', 'REFUSEE')
      and t.created_at >= p.period_from
      and t.created_at <= p.period_to
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
        when 'en-livraison' then
          o.id in (select el.id from en_livraison_orders el)
        when 'valide' then
          o.order_state = 'completed'
          and o.sort_at >= p.period_from and o.sort_at <= p.period_to
        when 'annulees-retours' then
          o.id in (select ar.id from annulees_retours_orders ar)
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

revoke all on function public.list_orders_keyset(
  uuid, text, timestamptz, timestamptz, uuid, timestamptz, uuid, integer
) from public, anon;

grant execute on function public.list_orders_keyset(
  uuid, text, timestamptz, timestamptz, uuid, timestamptz, uuid, integer
) to authenticated;
