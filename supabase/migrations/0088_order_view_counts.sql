-- 0088 — Lot 6 : compteurs de vues /commandes en SQL.
--
-- Call-site : lib/actions/orders.ts:fetchOrdersPageData. Aujourd'hui, `listOrdersForPageData`
-- charge TOUT l'historique du tenant (paginé `.range()` par 500, sans fenêtre de date en base),
-- puis les 7 compteurs de vues sont recalculés en JS à chaque chargement de page 1 (période +
-- recherche + prédicat d'état filtrés séquentiellement sur l'intégralité des commandes déjà
-- chargées). O(commandes × vues) répété à chaque visite de /commandes.
--
-- Portée de ce lot (validée) : SEULS les 7 compteurs de vues passent en SQL, et UNIQUEMENT quand
-- aucune recherche texte n'est active (`search === ''`, cas ultra-majoritaire — la frappe
-- interactive est shallow côté client sans round-trip serveur, cf. commentaire
-- orders-page-loader.tsx). Quand `search !== ''` (rare, lien avec `?q=`), le calcul TS actuel
-- sur `scopedOrders` (déjà chargé pour la liste) reste utilisé À L'IDENTIQUE — la recherche fait
-- du matching flou nom/produit/téléphone sénégalais non trivial à reproduire en SQL, hors scope.
-- La LISTE (`listOrdersForPageData`, pagination, tri) n'est PAS touchée par ce lot — seuls les
-- compteurs affichés dans le sélecteur de vues changent de source.
--
-- Contrat de sortie : returns table (view_id text, count bigint) — 7 lignes fixes, aucun risque
-- `max_rows=1000` (cardinalité bornée aux 7 vues, pas aux commandes). TS remappe par view_id sur
-- la liste canonique `orderSavedViewIds`, même style que get_dashboard_cod_breakdown (0080).
--
-- Prédicats reproduits À L'IDENTIQUE de matchesOrderSavedView + orderMatchesPeriod
-- (lib/domain/order-saved-views.ts, lib/actions/orders.ts) :
--   toutes             : aucun prédicat d'état ; fenêtre = orderQueueDate (coalesce
--                        created_at_shopify, created_at), bornes INCLUSIVES.
--   a-appeler          : order_state='open' AND call_state='to_call' ; fenêtre sur `created_at`
--                        (PAS orderQueueDate — aligné get_dashboard_kpi 0076, cf. #55/#59).
--   tentee-a-rappeler  : order_state='open' AND call_state='callback' ; fenêtre orderQueueDate.
--   confirmee          : order_state='open' AND call_state='validated' AND delivery_state IN
--                        (unassigned,scheduled,assigned) ; fenêtre orderQueueDate
--                        (Phase 11.1 / migration 0062 : « assignée » reste dans Programmer).
--   en-livraison       : delivery_state='out_for_delivery' (état COURANT) ET existence d'une
--                        transition order_state_transition.to_status='EN_LIVRAISON' dans la
--                        fenêtre — AND composé, pas juste l'un ou l'autre (migration 0061).
--                        Dédupliqué par order_id (une commande peut transiter plusieurs fois
--                        vers le même statut dans la fenêtre).
--   valide             : order_state='completed' ; fenêtre orderQueueDate.
--   annulees-retours   : order_state IN (cancelled,returned) (état COURANT) ET existence d'une
--                        transition to_status IN (ANNULEE,REFUSEE) dans la fenêtre — même AND
--                        composé qu'en-livraison, dédupliqué par order_id.
--
-- Shop : orders.shop_id = p_shop_id si fourni (NULL-safe, comme scopedOrders actuel). Le filtre
-- shop s'applique aussi aux vues transition-based via la jointure sur `orders` déjà shop-scopée
-- (fetchTransitionOrderIds actuel ne filtre PAS shop sur order_state_transition directement —
-- le scope shop vient de l'intersection avec scopedOrders déjà shop-filtré ; même effet ici via
-- la jointure explicite, résultat identique).
--
-- Sécurité : security invoker (RLS orders_select/order_state_transition select respectées —
-- l'agent voit tout le tenant, sans restriction de rôle sur les compteurs, comme le TS actuel qui
-- n'applique aucun filtre de rôle sur viewCounts). p_merchant_id combiné à la RLS de l'appelant :
-- un p_merchant_id étranger renvoie 0 ligne (RLS filtre déjà sur le tenant réel de la session),
-- jamais une fuite. Aligné get_dashboard_cod_breakdown/get_dashboard_shop_performance (0080).
--
-- Index : composite (merchant_account_id, to_status, created_at) sur order_state_transition —
-- couvre exactement le prédicat des 2 vues transition-based (aucun index existant ne combine
-- ces 3 colonnes ; les index actuels sont (order_id, created_at desc), (merchant_account_id)
-- seul, (order_id, to_status, created_at) — aucun n'a merchant_account_id en tête pour ce filtre).

create index if not exists order_state_transition_merchant_status_created_idx
  on public.order_state_transition (merchant_account_id, to_status, created_at);

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
  ),
  en_livraison_orders as (
    select distinct so.id
    from scoped_orders so
    join public.order_state_transition t on t.order_id = so.id
    where t.merchant_account_id = p_merchant_id
      and t.to_status = 'EN_LIVRAISON'
      and t.created_at >= p_from
      and t.created_at <= p_to
      and so.delivery_state = 'out_for_delivery'
  ),
  annulees_retours_orders as (
    select distinct so.id
    from scoped_orders so
    join public.order_state_transition t on t.order_id = so.id
    where t.merchant_account_id = p_merchant_id
      and t.to_status in ('ANNULEE', 'REFUSEE')
      and t.created_at >= p_from
      and t.created_at <= p_to
      and so.order_state in ('cancelled', 'returned')
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

  select 'en-livraison', count(*)
  from en_livraison_orders

  union all

  select 'valide', count(*)
  from scoped_orders so
  where so.order_state = 'completed'
    and coalesce(so.created_at_shopify, so.created_at) >= p_from
    and coalesce(so.created_at_shopify, so.created_at) <= p_to

  union all

  select 'annulees-retours', count(*)
  from annulees_retours_orders;
$$;

revoke all on function public.get_order_view_counts(
  uuid, timestamptz, timestamptz, uuid
) from public, anon;

grant execute on function public.get_order_view_counts(
  uuid, timestamptz, timestamptz, uuid
) to authenticated;
