-- ════════════════════════════════════════════════════════════════════════
-- Phase 8 — Outils finance de l'assistant IA (lecture seule)
--
-- get_cogs / get_margin / get_net_profit doivent calculer le COGS, qui repose
-- sur stock_movement.unit_cost ET product_stock.unit_cost — deux colonnes
-- VOLONTAIREMENT hors GRANT pour le rôle DB `authenticated` (coût caché côté
-- API ; seules les lectures service-role y accédaient via report-data.ts).
--
-- Décision Phase 8 : AUCUNE lecture IA ne passe par le service-role. On expose
-- donc ces deux colonnes via des fonctions SECURITY DEFINER qui re-vérifient
-- current_member_role (owner/manager uniquement). Le reste des données
-- (commandes, charges, paramètres, produits) reste lu sous le JWT (RLS), et le
-- calcul réutilise la fonction PURE déjà testée computeFinanceReport — aucune
-- logique financière n'est ré-implémentée en SQL.
--
-- Gate de rôle : agent (et non-membre) → 0 ligne. La marge/le profit restent
-- en plus filtrés côté TS (couche A : pas d'outil ; couche B : runTool).
-- ════════════════════════════════════════════════════════════════════════

-- Mouvements porteurs de coût (sold + courier_return) pour un ensemble de
-- commandes — débloque unit_cost, owner/manager seulement.
create or replace function public.ia_finance_cost_movements(
  p_merchant   uuid,
  p_order_ids  uuid[]
)
returns table (
  order_id      uuid,
  product_id    uuid,
  qty           integer,
  unit_cost     bigint,
  movement_type text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.current_member_role(p_merchant) not in ('owner', 'manager') then
    return;
  end if;

  return query
    select sm.order_id, sm.product_id, sm.qty, sm.unit_cost, sm.movement_type
    from public.stock_movement sm
    where sm.merchant_account_id = p_merchant
      and sm.movement_type in ('sold', 'courier_return')
      and sm.order_id = any (p_order_ids);
end;
$$;

revoke all on function public.ia_finance_cost_movements(uuid, uuid[]) from public;
grant execute on function public.ia_finance_cost_movements(uuid, uuid[]) to authenticated;

-- CUMP courant par produit (fallback d'estimation du COGS) — débloque
-- product_stock.unit_cost, owner/manager seulement.
create or replace function public.ia_product_cump(
  p_merchant     uuid,
  p_product_ids  uuid[]
)
returns table (
  product_id uuid,
  unit_cost  bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.current_member_role(p_merchant) not in ('owner', 'manager') then
    return;
  end if;

  return query
    select ps.product_id, ps.unit_cost
    from public.product_stock ps
    where ps.merchant_account_id = p_merchant
      and ps.product_id = any (p_product_ids);
end;
$$;

revoke all on function public.ia_product_cump(uuid, uuid[]) from public;
grant execute on function public.ia_product_cump(uuid, uuid[]) to authenticated;
