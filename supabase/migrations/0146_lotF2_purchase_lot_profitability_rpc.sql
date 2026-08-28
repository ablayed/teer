-- ============================================================================
-- 0146 — Lot F2 : RPC d'agrégation pour la rentabilité par arrivage
-- ============================================================================
-- Dérogation de périmètre EXPLICITEMENT approuvée par le fondateur (2026-08-28) :
-- « aucune migration » du prompt F2 devient « aucune migration de données ou de
-- schéma, sauf une migration additive strictement limitée à la RPC d'agrégation
-- nécessaire au rendu ». Rien d'autre n'est touché ici.
--
-- Cette fonction n'AGRÈGE que — aucune formule métier (marge, marge %,
-- répartition du transport, complétude) n'est calculée en SQL. Toutes ces
-- règles restent dans lib/finance/lot-profitability.ts (Lot F1), réutilisé tel
-- quel côté TS. Si la formule était dupliquée ici, elle divergerait le jour où
-- l'une des deux copies serait corrigée sans l'autre.
--
-- SECURITY INVOKER, aucune garde de rôle : les policies RLS existantes de
-- purchase_lot/purchase_lot_line (owner-only, 0127) et de
-- purchase_lot_line_allocation (owner/manager/agent, 0145) s'appliquent déjà
-- sous l'identité de l'appelant — ajouter une garde ici serait redondant et,
-- pire, NULL-unsafe si mal écrite (cf. gotcha du projet). Un non-owner ou un
-- membre d'un autre tenant/boutique ne voit tout simplement aucune ligne :
-- la fonction renvoie NULL (lot introuvable de son point de vue), jamais une
-- erreur qui distinguerait "existe mais pas à vous" de "n'existe pas".
--
-- Ancrage strict sur l'arrivage autorisé : TOUTES les jointures partent de
-- `lot` (déjà filtré par p_purchase_lot_id ET par les policies RLS via
-- l'appelant) — jamais d'un identifiant enfant qui élargirait la portée.
-- ============================================================================

create or replace function public.get_purchase_lot_profitability(p_purchase_lot_id uuid)
returns jsonb
language sql
security invoker
stable
set search_path = ''
as $$
  with lot as (
    select id, transport_total, allocation_method
      from public.purchase_lot
     where id = p_purchase_lot_id
  ),
  lines as (
    select pll.id, pll.product_id, pll.qty as qty_received,
           pll.purchase_price_total, pll.weight_grams
      from public.purchase_lot_line pll
      join lot on lot.id = pll.purchase_lot_id
  ),
  -- Allocations FIFO nettes (sale/return/invalidation déjà signées, 0145) par
  -- (ligne de lot, commande) — jamais par ligne de commande seule : une même
  -- commande peut porter plusieurs lignes d'allocation compensatoires pour la
  -- même order_line_id (retour puis re-livraison), regroupées ici par order_id.
  alloc_by_order as (
    select a.purchase_lot_line_id, a.order_id, sum(a.qty) as qty
      from public.purchase_lot_line_allocation a
      join lines on lines.id = a.purchase_lot_line_id
     group by a.purchase_lot_line_id, a.order_id
    having sum(a.qty) <> 0
  ),
  qty_sold as (
    select purchase_lot_line_id, sum(qty) as qty_sold
      from alloc_by_order
     group by purchase_lot_line_id
  ),
  -- Quantité totale de lignes de commande matchées (tous produits confondus)
  -- par commande impliquée — sert de base de répartition du CA de la commande
  -- par unité (même principe que l'allocation des frais de livraison dans le
  -- pipeline Finances existant : parts égales par unité, jamais une formule de
  -- marge). Bornée aux commandes réellement impliquées dans CET arrivage.
  involved_orders as (
    select distinct order_id from alloc_by_order
  ),
  order_matched_qty as (
    select ol.order_id, sum(ol.qty) as matched_qty
      from public.order_line ol
      join involved_orders io on io.order_id = ol.order_id
     where ol.match_status = 'matched'
       and ol.product_id is not null
     group by ol.order_id
  ),
  -- CA imputé par ligne de lot : part au prorata des unités allouées à cette
  -- ligne sur le total_amount (déjà net des frais de livraison) de chaque
  -- commande où elle apparaît, arrondi commande par commande avant somme.
  line_cash as (
    select ao.purchase_lot_line_id,
           sum(round(ao.qty::numeric * o.total_amount / nullif(omq.matched_qty, 0)))::bigint
             as cash_collected_minor
      from alloc_by_order ao
      join public.orders o on o.id = ao.order_id
      join order_matched_qty omq on omq.order_id = ao.order_id
     group by ao.purchase_lot_line_id
  ),
  ad_spend as (
    select product_id, sum(amount_minor) as amount_minor
      from public.product_ad_spend
     where purchase_lot_id = p_purchase_lot_id
     group by product_id
  ),
  -- Un même produit peut apparaître sur plusieurs lignes de CE lot (deux
  -- arrivages du même produit dans le même arrivage — cf. commentaire
  -- toLotProductLine côté TS) : la publicité est saisie par PRODUIT, jamais
  -- par ligne, donc `ad_spend` ci-dessus ne doit JAMAIS être joint directement
  -- sur `l.product_id` sans proratisation — sinon chaque ligne du produit
  -- reçoit la dépense COMPLÈTE (double comptage). Répartition au prorata de
  -- qty_received par ligne, méthode du plus grand reste (Hamilton, identique
  -- en esprit à allocateTransportCost côté TS) : plancher entier par ligne,
  -- puis le reliquat (toujours < nombre de lignes du produit) distribué une
  -- unité à la fois aux plus grands restes, index de ligne croissant en cas
  -- d'égalité — la somme des parts égale TOUJOURS exactement le total du
  -- produit.
  product_line_qty as (
    select l.id as purchase_lot_line_id, l.product_id, l.qty_received,
           sum(l.qty_received) over (partition by l.product_id) as product_total_qty,
           row_number() over (partition by l.product_id order by l.id) as line_rank
      from lines l
  ),
  ad_spend_floor as (
    select plq.purchase_lot_line_id, plq.product_id, plq.line_rank,
           ads.amount_minor as product_amount_minor,
           -- `/` sur des bigint tronque vers zéro ; qty_received, amount_minor
           -- et product_total_qty sont tous >= 0 ici, donc troncature = floor.
           -- Cas limite product_total_qty=0 (toutes les lignes du produit à
           -- qty_received=0, possible : lineSchema autorise qty>=0) : la
           -- répartition proportionnelle n'a pas de sens, tout est affecté à
           -- la première ligne (line_rank=1) pour que la somme reste exacte,
           -- sans passer par la distribution du plus grand reste ci-dessous.
           case when coalesce(plq.product_total_qty, 0) > 0
                then (plq.qty_received::bigint * ads.amount_minor) / plq.product_total_qty
                when plq.line_rank = 1
                then ads.amount_minor
                else 0
           end as floor_share,
           case when coalesce(plq.product_total_qty, 0) > 0
                then (plq.qty_received::bigint * ads.amount_minor)
                     - ((plq.qty_received::bigint * ads.amount_minor) / plq.product_total_qty) * plq.product_total_qty
                else 0
           end as remainder
      from product_line_qty plq
      join ad_spend ads on ads.product_id = plq.product_id
  ),
  ad_spend_remainder_rank as (
    select purchase_lot_line_id, product_id, floor_share, product_amount_minor,
           row_number() over (
             partition by product_id
             order by remainder desc, line_rank asc
           ) as remainder_order,
           product_amount_minor - sum(floor_share) over (partition by product_id) as leftover
      from ad_spend_floor
  ),
  ad_spend_by_line as (
    select purchase_lot_line_id,
           floor_share + case when remainder_order <= leftover then 1 else 0 end as amount_minor
      from ad_spend_remainder_rank
  )
  select case
    when not exists (select 1 from lot) then null
    else jsonb_build_object(
      'purchaseLotId', p_purchase_lot_id,
      'transportTotalMinor', coalesce((select transport_total from lot), 0),
      'transportComplete', (select transport_total is not null from lot),
      'allocationMethod', (select allocation_method from lot),
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
          'purchaseLotLineId', l.id,
          'productId', l.product_id,
          'qtyReceived', l.qty_received,
          'qtySold', coalesce(qs.qty_sold, 0),
          'purchaseValueMinor', coalesce(l.purchase_price_total, 0),
          'weightGrams', l.weight_grams,
          'cashCollectedMinor', coalesce(lc.cash_collected_minor, 0),
          'adSpendMinor', coalesce(asl.amount_minor, 0)
        ) order by l.id)
        from lines l
        left join qty_sold qs on qs.purchase_lot_line_id = l.id
        left join line_cash lc on lc.purchase_lot_line_id = l.id
        left join ad_spend_by_line asl on asl.purchase_lot_line_id = l.id
      ), '[]'::jsonb)
    )
  end;
$$;

revoke all on function public.get_purchase_lot_profitability(uuid)
  from public, anon, authenticated;

grant execute on function public.get_purchase_lot_profitability(uuid)
  to authenticated;
