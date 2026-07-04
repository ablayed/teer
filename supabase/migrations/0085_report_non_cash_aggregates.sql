-- 0085 — Lot 4 : agrégats non-cash du rapport PDF en SQL (suite H2, dernier sous-lot de la
-- série cash/report, après 0083 cash livreur cross-boutique et 0084 cash pending PDF).
--
-- Call-site : lib/report/data.ts:getReportData → app/api/rapport/route.tsx (rapport PDF).
--
-- Bug corrigé (même famille H2 que 0080/0084, docs/PERFORMANCE_AUDIT_AND_OPTIMIZATION_PLAN.md
-- §H2) : `scopedOrdersQuery` (data.ts:303-312) sélectionne `orders` fenêtré [from,to] +
-- shop optionnel SANS `.range()`/`.limit()` → cap silencieux PostgREST à 1000 lignes
-- (config.toml max_rows). Sur un gros tenant ou une période large, 4 agrégats calculés
-- CÔTÉ JS sur ce résultat tronqué deviennent faux : `statuses[]`, `kpis.margin_estimee`
-- (via deliveredOrdersCount), `revenue[]`, `topProducts[]`. `drivers[].pendingMinor` était
-- le 5e (corrigé en 0084) ; `settledMinor`/`shortfallMinor` restent en TS (hors pattern H2,
-- selects simples bornés, non touchés).
--
-- Après ce lot, `scopedOrdersQuery`/`ordersResult`/le type `ReportOrderRow` disparaissent
-- entièrement de getReportData : plus aucun select `orders` non paginé sur ce chemin.
--
-- 3 RPC, une par agrégat, zéro ligne `orders` rapatriée côté client :
--
-- 1) get_report_status_breakdown — count(*)/sum(total_amount) group by cod_status, fenêtre
--    created_at [from,to] inclusive des deux côtés (même convention que 0084, PAS celle
--    exclusive-haute de 0083), shop optionnel. Sortie = seuls les statuts présents (comme
--    get_dashboard_cod_breakdown, 0080) ; le TS remappe sur la liste canonique des 8 statuts
--    avec 0 par défaut (comportement `codStatuses.map(...)` actuel inchangé). Alimente aussi
--    `kpis.margin_estimee` (deliveredOrdersCount = count de la ligne LIVREE, 0 si absente) et
--    le dénominateur `percent` (= somme des counts, ou 1 si vide — même règle que
--    `orders.length || 1` actuel).
--
-- 2) get_report_revenue_by_day — Σ round(total_amount) des commandes cod_status='LIVREE'
--    (même filtre created_at [from,to] inclusive, PAS de filtre sur la date de bucket : une
--    commande créée dans la fenêtre mais livrée/mise à jour après `to` reste comptée, sur un
--    jour de bucket qui peut dépasser [from,to] — réplique exactement le comportement actuel
--    où `aggregateRevenue` ajoute une clé hors pré-population si `updated_at` déborde), groupé
--    par jour CALENDAIRE UTC de coalesce(updated_at, created_at) via
--    `(coalesce(updated_at,created_at) at time zone 'utc')::date`. Choix validé : reproduire le
--    comportement PROD/CI (Node TZ=UTC sur Vercel et sur les runners CI, donc
--    `toISOString().slice(0,10)` actuel ≡ jour calendaire UTC) plutôt que préserver une
--    ambiguïté locale non contractualisée. Sortie `day` en `text` formaté 'YYYY-MM-DD' (évite
--    tout aller-retour de parsing de type `date` côté client). Le TS garde la pré-population
--    de la série continue [from,to] à 0 (logique actuelle inchangée) et fusionne les lignes
--    retournées par clé de jour.
--
-- 3) get_report_top_products — parse items_summary (jsonb array), AUCUN filtre cod_status
--    (contrat actuel `aggregateTopProducts` : toutes commandes de la fenêtre, contrairement à
--    get_dashboard_top_products/0080 qui filtre 4 statuts — NE PAS copier ce filtre ici).
--    Prix unitaire = price_minor si > 0 sinon price (règle `itemPriceMinor` exacte, différente
--    de 0080 qui n'utilise que `price`). Quantité = round(quantity), clampée ≥ 0. Titre manquant/
--    non-string/vide → groupé sous le libellé littéral 'Produit' (contrat actuel — 0080 exclut
--    ces éléments, ne pas reproduire cette exclusion ici). Tri montant desc puis quantité desc,
--    top 10 (pas 5).
--
-- Hors scope de cette migration :
--   - `currency` (data.ts:507, `orders[0]?.currency ?? 'XOF'`) : PAS une RPC. Le comportement
--     actuel est un pick non déterministe sur un résultat non ordonné — remplacé côté TS par
--     un select `orders` dédié `.select('currency')` même filtre merchant+période+shop,
--     `.order('created_at', {ascending:false}).order('id')` puis `.limit(1)`, fallback 'XOF'
--     inchangé si aucune commande. Documenté ici pour traçabilité, pas de migration requise
--     (simple select PostgREST borné à 1 ligne, RLS standard, pas de security definer).
--   - `get_report_driver_cash_pending` (0084), `get_driver_cash_consolidation` /
--     `get_driver_cash_outstanding_orders` (0083) : non modifiées.
--   - `settledMinor`/`shortfallMinor`, le Compte de résultat P&L (`fetchFinanceReport`,
--     lib/finance/report-data.ts) : non touchés par ce lot.
--
-- Sécurité : security definer (choix explicite malgré le garde owner/manager déjà fait en
-- amont dans getReportContext, data.ts:264-276 — défense en profondeur si la RPC est appelée
-- hors de ce chemin), aligné 0083/0084/finance_kpis/cash_aging : garde de rôle NULL-safe
-- (`v_role IS NULL OR v_role NOT IN ('owner','manager')`), refus par exception 42501,
-- `set search_path = public`, `grant execute` à `authenticated` uniquement (jamais `anon`).
-- Appel TS attendu avec le client Supabase authentifié (cookie-based), pas le client
-- service-role — la garde dépend de `current_member_role`/`auth.uid()`.

create or replace function public.get_report_status_breakdown(
  p_merchant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns table (
  cod_status text,
  count bigint,
  amount_minor bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := public.current_member_role(p_merchant_id);

  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  return query
  select
    o.cod_status::text,
    count(*)::bigint as count,
    coalesce(sum(round(o.total_amount)), 0)::bigint as amount_minor
  from public.orders o
  where o.merchant_account_id = p_merchant_id
    and o.created_at >= p_from
    and o.created_at <= p_to
    and (p_shop_id is null or o.shop_id = p_shop_id)
  group by o.cod_status;
end;
$$;

create or replace function public.get_report_revenue_by_day(
  p_merchant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns table (
  day text,
  amount_minor bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := public.current_member_role(p_merchant_id);

  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  return query
  select
    to_char(
      (coalesce(o.updated_at, o.created_at) at time zone 'utc')::date,
      'YYYY-MM-DD'
    ) as day,
    coalesce(sum(round(o.total_amount)), 0)::bigint as amount_minor
  from public.orders o
  where o.merchant_account_id = p_merchant_id
    and o.cod_status = 'LIVREE'
    and o.created_at >= p_from
    and o.created_at <= p_to
    and (p_shop_id is null or o.shop_id = p_shop_id)
  group by 1;
end;
$$;

create or replace function public.get_report_top_products(
  p_merchant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns table (
  title text,
  quantity bigint,
  amount_minor bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := public.current_member_role(p_merchant_id);

  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  return query
  with items as (
    select
      case
        when jsonb_typeof(elem -> 'title') = 'string'
             and length(trim(both from (elem ->> 'title'))) > 0
          then trim(both from (elem ->> 'title'))
        else 'Produit'
      end as title,
      greatest(
        round(
          case when jsonb_typeof(elem -> 'quantity') = 'number'
               then (elem ->> 'quantity')::numeric else 0 end
        ),
        0
      ) as quantity,
      case when jsonb_typeof(elem -> 'price_minor') = 'number'
           then (elem ->> 'price_minor')::numeric else 0 end as price_minor_raw,
      case when jsonb_typeof(elem -> 'price') = 'number'
           then (elem ->> 'price')::numeric else 0 end as price_raw
    from public.orders o
    cross join lateral jsonb_array_elements(o.items_summary) as elem
    where o.merchant_account_id = p_merchant_id
      and o.created_at >= p_from
      and o.created_at <= p_to
      and (p_shop_id is null or o.shop_id = p_shop_id)
      and jsonb_typeof(o.items_summary) = 'array'
      and jsonb_typeof(elem) = 'object'
  ),
  priced as (
    select
      title,
      quantity,
      round(case when price_minor_raw > 0 then price_minor_raw else price_raw end)
        as item_price_minor
    from items
  )
  select
    p.title,
    sum(p.quantity)::bigint as quantity,
    sum(p.quantity * p.item_price_minor)::bigint as amount_minor
  from priced p
  group by p.title
  order by amount_minor desc, quantity desc
  limit 10;
end;
$$;

revoke all on function public.get_report_status_breakdown(
  uuid, timestamptz, timestamptz, uuid
) from public, anon;

grant execute on function public.get_report_status_breakdown(
  uuid, timestamptz, timestamptz, uuid
) to authenticated;

revoke all on function public.get_report_revenue_by_day(
  uuid, timestamptz, timestamptz, uuid
) from public, anon;

grant execute on function public.get_report_revenue_by_day(
  uuid, timestamptz, timestamptz, uuid
) to authenticated;

revoke all on function public.get_report_top_products(
  uuid, timestamptz, timestamptz, uuid
) from public, anon;

grant execute on function public.get_report_top_products(
  uuid, timestamptz, timestamptz, uuid
) to authenticated;
