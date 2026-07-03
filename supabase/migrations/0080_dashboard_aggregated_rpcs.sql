-- 0080 — Tableau : 3 RPC agrégées non plafonnées (Répartition COD / Performance boutique /
-- Top produits). Corrige les 3 blocs faussés par le plafond PostgREST `max_rows = 1000`
-- (config.toml:8).
--
-- Cause racine (auditée, non re-diagnostiquée ici) :
--   Les 3 blocs agrégeaient CÔTE JS sur des requêtes PostgREST SANS pagination `.range()`
--   → tronquées silencieusement à 1000 lignes (config.toml `max_rows = 1000`) :
--     * getCodBreakdown (dashboard.ts) : `orders.select('cod_status')` sans .limit/.order →
--       ~1000 lignes A_APPELER dans l'ordre de scan → « À appeler 1000 / reste 0 ».
--     * fetchShopPerformanceForUser : `orders.select('shop_id,total_amount')` sans .limit →
--       « 1000 commandes » pile.
--     * getTopProducts : `.limit(500)` → top calculé sur les 500 commandes les plus récentes.
--   « Activité récente » lit order_state_transition (autre table, non plafonnée) → montrait de
--   vraies livrées, d'où la contradiction avec la Répartition COD (0 livrée).
--
-- Fix : agréger EN SQL (zéro ligne rapatriée, zéro cap). Sémantique de chaque bloc reproduite
--   à l'identique du TS actuel — seuls les chiffres deviennent exacts, le contrat de sortie
--   consommé par l'UI est préservé.
--
-- security invoker : lit via les policies RLS de l'appelant (session owner/manager/agent),
--   filtre tenant merchant_account_id explicite + shop_id optionnel NULL-safe. Aucun
--   security definer, aucun contournement RLS. GRANT execute to authenticated.
--
-- Indexes : couverts par l'existant (orders_merchant_cod_status_idx (merchant, cod_status) —
--   0005 ; orders_merchant_shop_idx (merchant, shop) — 0037). Pas de nouvel index (les
--   group by/filtres retombent sur ces index ; ne pas sur-indexer).

-- RPC 1 — Répartition COD : count(*) group by cod_status, all-time, tenant + shop optionnel.
-- Sortie jsonb array [{ cod_status, count }] des seuls statuts présents ; le TS remappe sur
-- la liste canonique orderStatuses (8 catégories, 0 par défaut) → contrat UI inchangé.
create or replace function public.get_dashboard_cod_breakdown(
  p_merchant_id uuid,
  p_shop_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'cod_status', t.cod_status,
           'count', t.count
         )), '[]'::jsonb)
  from (
    select o.cod_status, count(*) as count
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and o.cod_status is not null
      and (p_shop_id is null or o.shop_id = p_shop_id)
    group by o.cod_status
  ) t;
$$;

-- RPC 2 — Performance boutique : agrégat par boutique (count commandes + sum total_amount),
-- all-time, sans filtre de statut (miroir exact du TS actuel : ordersQuery sans cod_status).
-- LEFT JOIN depuis `shop` → les boutiques sans commande apparaissent (ordersCount/revenue 0),
-- ordre par installed_at asc (identique au TS). shop_id optionnel restreint aux deux côtés.
-- Sortie jsonb array [{ id, name, status, orders_count, revenue }].
create or replace function public.get_dashboard_shop_performance(
  p_merchant_id uuid,
  p_shop_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'name', s.shop_domain,
           'status', s.status,
           'orders_count', coalesce(agg.orders_count, 0),
           'revenue', coalesce(agg.revenue, 0)
         ) order by s.installed_at asc nulls last), '[]'::jsonb)
  from public.shop s
  left join (
    select o.shop_id,
           count(*) as orders_count,
           sum(o.total_amount) as revenue
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and o.shop_id is not null
      and (p_shop_id is null or o.shop_id = p_shop_id)
    group by o.shop_id
  ) agg on agg.shop_id = s.id
  where s.merchant_account_id = p_merchant_id
    and (p_shop_id is null or s.id = p_shop_id);
$$;

-- RPC 3 — Top produits : agrège items_summary (jsonb array) sur TOUT le périmètre (plus de
-- .limit(500) sur les commandes récentes), mêmes statuts que le TS actuel
-- (CONFIRMEE/PROGRAMMEE/EN_LIVRAISON/LIVREE), groupe par titre, top 5 par unités puis CA.
-- Sémantique parseItems reproduite : title = string non vide ; quantity/price = JSON number
-- (tout le code TS lit ces champs via `typeof === 'number'`, sinon 0 — cf. parseItems /
-- parseAssignmentLines ; la création de commande écrit z.number()). Les éléments non-objet,
-- titre non-string/vide, ou quantity/price non-number sont ignorés/comptés 0, à l'identique.
-- Sortie jsonb array [{ name, units, revenue }] déjà triée (≤ 5).
create or replace function public.get_dashboard_top_products(
  p_merchant_id uuid,
  p_shop_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', t.name,
           'units', t.units,
           'revenue', t.revenue
         ) order by t.units desc, t.revenue desc), '[]'::jsonb)
  from (
    select
      elem->>'title' as name,
      sum(case when jsonb_typeof(elem->'quantity') = 'number'
               then (elem->>'quantity')::numeric else 0 end) as units,
      sum(
        (case when jsonb_typeof(elem->'quantity') = 'number'
              then (elem->>'quantity')::numeric else 0 end)
        *
        (case when jsonb_typeof(elem->'price') = 'number'
              then (elem->>'price')::numeric else 0 end)
      ) as revenue
    from public.orders o
    cross join lateral jsonb_array_elements(o.items_summary) as elem
    where o.merchant_account_id = p_merchant_id
      and o.cod_status in ('CONFIRMEE', 'PROGRAMMEE', 'EN_LIVRAISON', 'LIVREE')
      and (p_shop_id is null or o.shop_id = p_shop_id)
      and jsonb_typeof(o.items_summary) = 'array'
      and jsonb_typeof(elem) = 'object'
      and jsonb_typeof(elem->'title') = 'string'
      and (elem->>'title') <> ''
    group by elem->>'title'
    order by units desc, revenue desc
    limit 5
  ) t;
$$;

revoke all on function public.get_dashboard_cod_breakdown(uuid, uuid) from public, anon;
grant execute on function public.get_dashboard_cod_breakdown(uuid, uuid) to authenticated;

revoke all on function public.get_dashboard_shop_performance(uuid, uuid) from public, anon;
grant execute on function public.get_dashboard_shop_performance(uuid, uuid) to authenticated;

revoke all on function public.get_dashboard_top_products(uuid, uuid) from public, anon;
grant execute on function public.get_dashboard_top_products(uuid, uuid) to authenticated;
