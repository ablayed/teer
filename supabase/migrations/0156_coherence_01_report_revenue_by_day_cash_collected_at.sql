-- 0156 : get_report_revenue_by_day se rebase sur le MÊME axe que finance_kpis.ca_livre
-- (lot COHERENCE-01)
--
-- ============================================================
-- DÉFAUT CORRIGÉ — deux axes pour une seule série
-- ============================================================
-- `get_report_revenue_by_day` (0085:138-152) alimente le graphe « Tendance du CA livré »
-- du rapport PDF. Elle :
--   - FILTRAIT sur `o.created_at >= p_from and o.created_at <= p_to` ;
--   - BUCKAIT sur `(coalesce(o.updated_at, o.created_at) at time zone 'utc')::date`.
--
-- Deux axes différents pour la même série, et `updated_at` n'est la date de RIEN de
-- métier : c'est la dernière modification, quelle qu'elle soit. Une note d'équipe ou une
-- resynchronisation Shopify déplaçait donc une commande de barre.
--
-- LE REPLI ÉTAIT DU CODE MORT, mesuré au catalogue (local à 0155) : `orders.updated_at`
-- est `NOT NULL DEFAULT now()` (0005:46) ET entretenue par le trigger
-- `orders_set_updated_at` (0005:93, BEFORE UPDATE). `coalesce(o.updated_at, o.created_at)`
-- ne pouvait donc JAMAIS retomber sur `created_at` : le graphe datait TOUJOURS chaque
-- commande à sa dernière modification. Le défaut était pire que « un repli discutable ».
--
-- CONSÉQUENCE, DANS UN SEUL ET MÊME DOCUMENT : le KPI « Chiffre d'affaires » du PDF est
-- `finance_kpis.ca_livre`, daté depuis 0119 sur
-- `coalesce(cash_collected_at, max(ost.created_at LIVREE), updated_at)`. Le graphe juste
-- en dessous était daté autrement et fenêtré sur un troisième axe. Les deux ne pouvaient
-- ni s'additionner ni se recouper. 0119 a harmonisé les surfaces qu'elle a touchées ;
-- elle n'a jamais repassé ici.
--
-- ============================================================
-- CORRECTIF
-- ============================================================
-- Le défaut PREMIER est le désaccord entre le filtre et le bucket, avant le choix de la
-- colonne. Les deux sont donc désormais la MÊME expression, et cette expression est
-- exactement celle de `finance_kpis.ca_livre` (0119:73) :
--
--     delivered_at = coalesce(o.cash_collected_at, max(ost.created_at LIVREE), o.updated_at)
--
-- POURQUOI LE REPLI EST CONSERVÉ ICI, alors que 0157 le RETIRE de `cash_aging` — les deux
-- décisions sont opposées, et c'est délibéré :
--   - ici, l'objet est que le graphe se recoupe avec le KPI posé à deux centimètres de lui,
--     dans le même document. Un repli différent du sien rouvrirait exactement l'écart que
--     cette migration ferme : une commande livrée sans `cash_collected_at` compterait dans
--     le KPI et manquerait au graphe.
--   - dans `cash_aging`, l'objet est une ANCIENNETÉ. Un âge calculé sur une date inventée
--     est plus trompeur qu'une absence, donc la ligne est exclue.
-- Même colonne de référence, deux usages, deux traitements du NULL. Ne pas « harmoniser »
-- l'un sur l'autre sans relire ces deux raisons.
--
-- CE QUI N'EST PAS CHANGÉ, ET POURQUOI :
--   - La convention de borne reste `>= p_from and <= p_to` (fermée), là où `finance_kpis`
--     utilise `>= p_from and < p_to` (semi-ouverte). Il subsiste donc un écart théorique
--     d'UNE milliseconde entre le KPI et le graphe, sur une commande dont la date de record
--     vaudrait exactement `p_to` (soit 23:59:59.999, cf. `parseDate` dans
--     app/api/rapport/route.tsx). Ce n'est PAS l'axe, et le corriger serait une seconde
--     modification de comportement non demandée. Écart nommé plutôt que corrigé en passant :
--     le graphe et le KPI se recoupent désormais À LA CONVENTION DE BORNE PRÈS, pas au bit.
--   - `cod_status = 'LIVREE'` (état courant), la garde de rôle, le périmètre boutique, le
--     bucket en `at time zone 'utc'` et le type de retour sont repris à l'identique.
--
-- ============================================================
-- FORME
-- ============================================================
-- `create or replace function` à SIGNATURE IDENTIQUE (uuid, timestamptz, timestamptz, uuid)
-- et type de retour identique : l'ACL existante est donc PRÉSERVÉE, contrairement à un
-- DROP + CREATE qui réouvrirait `EXECUTE` à `PUBLIC`. Le `revoke`/`grant` ci-dessous est
-- une RÉ-AFFIRMATION à l'identique de ce que 0085:236-242 avait posé, pas un changement :
-- `proacl` doit être mesuré IDENTIQUE avant et après, et c'est `pg_proc.proacl` /
-- `has_function_privilege` qui font foi, jamais la présence de ces instructions.
--
-- Aucun changement TypeScript : signature, noms et types de colonnes inchangés, donc
-- `lib/supabase/database.types.ts` est inchangé et aucun appelant n'est touché.
-- ============================================================

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

  -- Garde NULL-safe : `current_member_role` rend NULL pour un non-membre, et
  -- `NULL not in (...)` n'est pas TRUE.
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  return query
  with delivered_orders as (
    -- Même CTE que finance_kpis.delivered_orders (0119:66-82) : c'est la condition pour
    -- que le graphe et le KPI « Chiffre d'affaires » du même PDF parlent de la même chose.
    select
      o.id,
      o.total_amount,
      coalesce(o.cash_collected_at, max(ost.created_at), o.updated_at) as delivered_at
    from public.orders o
    left join public.order_state_transition ost
      on ost.order_id = o.id
     and ost.to_status = 'LIVREE'
    where o.merchant_account_id = p_merchant_id
      and o.cod_status = 'LIVREE'
      and (p_shop_id is null or o.shop_id = p_shop_id)
    group by o.id, o.total_amount, o.updated_at, o.cash_collected_at
  )
  select
    -- Le bucket et le filtre ci-dessous portent sur la MÊME colonne `delivered_at` :
    -- c'est tout l'objet de cette migration.
    to_char((d.delivered_at at time zone 'utc')::date, 'YYYY-MM-DD') as day,
    coalesce(sum(round(d.total_amount)), 0)::bigint as amount_minor
  from delivered_orders d
  where d.delivered_at >= p_from
    and d.delivered_at <= p_to
  group by 1;
end;
$$;

-- Ré-affirmation à l'identique de l'ACL de 0085:236-242. À vérifier au catalogue
-- (`pg_proc.proacl`), jamais à déduire de ces deux lignes.
revoke all on function public.get_report_revenue_by_day(
  uuid, timestamptz, timestamptz, uuid
) from public, anon;

grant execute on function public.get_report_revenue_by_day(
  uuid, timestamptz, timestamptz, uuid
) to authenticated;
