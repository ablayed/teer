-- 0078 — Analyses (Bug 2, fix de fond) : RPC get_loss_analytics_joins.
--
-- Contexte : /analyses renvoyait « Bad Request » (400) sur les gros comptes
--   (~1000 commandes). Cause prouvée (instrumentation preview) : le 2e Promise.all de
--   lib/actions/loss-analytics.ts passait les tableaux d'UUID DANS L'URL via .in() —
--   order_line.order_id (~1000 UUID → URL ~37 KB) et customer.id (~800 UUID) → URL
--   au-delà de la limite du gateway PostgREST → rejet 400 (avant même exécution SQL,
--   d'où 1,54 s / 30 s, aucune erreur Postgres). Le compte léger (~11 UUID) passait.
--
-- Fix (Option 1) : remplacer ces .in() par une RPC (supabase.rpc = POST body JSON,
--   aucune limite d'URL) qui part de la FENÊTRE marchand+dates (jamais un tableau
--   d'UUID en paramètre) et fait les jointures order_line/customer/driver côté SQL.
--   computeLossAnalytics (metrics.ts) reste INCHANGÉ → chiffres strictement identiques.
--
-- Périmètre reproduit à l'identique du code TS actuel :
--   * orders : merchant_account_id = p_merchant_id
--              and created_at >= p_from and created_at <= p_to
--              and (p_shop_id is null or shop_id = p_shop_id)   -- shop_id NULL-safe
--   * orderLines : toutes les lignes des commandes de la fenêtre (orderIds = tous les id).
--   * customers  : clients référencés (customer_id distinct non-null) par ces commandes.
--   * drivers    : livreurs référencés (assigned_driver_id distinct non-null).
--   Le filtre merchant_account_id explicite sur order_line/customer/driver est équivalent
--   au .in(ids) actuel (les ids proviennent de commandes du même tenant) et laisse
--   Postgres utiliser les index — 0 changement de résultat.
--
-- Contrat de sortie (jsonb) — clés d'objet = EXACTEMENT les colonnes lues par le .map()
--   de loss-analytics.ts (l. 198-216), ni plus ni moins, pour que le mapping TS reste
--   identique :
--     orderLines[] : { order_id, product_id, raw_title, raw_sku, qty, match_status }
--     customers[]  : { id, full_name, address, shipping_address }
--     drivers[]    : { id, full_name }
--   Les 3 clés sont TOUJOURS des tableaux ([]::jsonb si vide, jamais null) — critique
--   pour le mapping JS. Agrégats distincts (customer/driver dédupliqués par PK ; les
--   order_line ne sont pas dédupliquées, comme le fetch actuel).
--
-- security invoker : lit via les policies RLS de l'appelant (client session owner/manager),
--   comme les requêtes remplacées. Filtre tenant merchant_account_id explicite.

create or replace function public.get_loss_analytics_joins(
  p_merchant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with scoped_orders as (
    select o.id, o.customer_id, o.assigned_driver_id
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and o.created_at >= p_from
      and o.created_at <= p_to
      and (p_shop_id is null or o.shop_id = p_shop_id)
  )
  select jsonb_build_object(
    'orderLines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', ol.order_id,
        'product_id', ol.product_id,
        'raw_title', ol.raw_title,
        'raw_sku', ol.raw_sku,
        'qty', ol.qty,
        'match_status', ol.match_status
      ))
      from public.order_line ol
      where ol.merchant_account_id = p_merchant_id
        and ol.order_id in (select so.id from scoped_orders so)
    ), '[]'::jsonb),
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'full_name', c.full_name,
        'address', c.address,
        'shipping_address', c.shipping_address
      ))
      from public.customer c
      where c.merchant_account_id = p_merchant_id
        and c.id in (
          select distinct so.customer_id
          from scoped_orders so
          where so.customer_id is not null
        )
    ), '[]'::jsonb),
    'drivers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id,
        'full_name', d.full_name
      ))
      from public.driver d
      where d.merchant_account_id = p_merchant_id
        and d.id in (
          select distinct so.assigned_driver_id
          from scoped_orders so
          where so.assigned_driver_id is not null
        )
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_loss_analytics_joins(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.get_loss_analytics_joins(uuid, timestamptz, timestamptz, uuid) to authenticated;
