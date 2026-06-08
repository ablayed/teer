-- ════════════════════════════════════════════════════════════════════════
-- Phase 8 — Correctif sécurité : garde de rôle NULL-safe sur les RPC finance
--
-- BUG (introduit en 0041) : le garde s'écrivait
--     if public.current_member_role(p_merchant) not in ('owner','manager') then return;
-- Or current_member_role renvoie NULL pour un NON-membre (ex. appel cross-tenant).
-- En SQL, `NULL not in (...)` vaut NULL — donc `if NULL then` est FAUX, le `return`
-- est SAUTÉ, et le corps s'exécute. Comme la fonction est SECURITY DEFINER exécutée
-- comme superuser (RLS contournée à l'intérieur), un owner du tenant A pouvait lire
-- le coût du tenant B en passant l'id de B. Fuite cross-tenant.
--
-- CORRECTIF : on capture le rôle puis on refuse explicitement si NULL ou hors
-- (owner, manager). Les fonctions d'audit (0040) utilisaient déjà `is null` et ne
-- sont pas concernées. Signatures inchangées (CREATE OR REPLACE).
-- ════════════════════════════════════════════════════════════════════════

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
declare
  v_role text := public.current_member_role(p_merchant);
begin
  if v_role is null or v_role not in ('owner', 'manager') then
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
declare
  v_role text := public.current_member_role(p_merchant);
begin
  if v_role is null or v_role not in ('owner', 'manager') then
    return;
  end if;

  return query
    select ps.product_id, ps.unit_cost
    from public.product_stock ps
    where ps.merchant_account_id = p_merchant
      and ps.product_id = any (p_product_ids);
end;
$$;
