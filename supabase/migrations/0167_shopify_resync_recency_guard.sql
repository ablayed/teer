-- 0167 — Resynchronisation d'une commande Shopify : la garde de date est revérifiée sous le verrou.
--
-- Défaut mesuré en local le 2026-10-14 : l'import compare la date de la charge à celle de la
-- commande en base, puis écrit — deux étapes, sans verrou entre elles. Une charge ancienne
-- (une reprise interne restée en attente) qui a lu « plus récent que la base » peut écrire APRÈS
-- une livraison plus récente de la même commande, et l'écraser. Entrelacement reproduit de façon
-- déterministe par tests/rls/shopify-webhook-replay.integration.test.ts.
--
-- Contrat : `resync_shopify_order_cart` prend déjà le verrou de la commande. Elle compare
-- maintenant, SOUS ce verrou, la date de la charge (`p_order_update.shopify_updated_at`) à celle
-- de la commande. Une charge antérieure ou égale n'écrit rien et rend 'stale'. Un des deux
-- instants absent : on ne peut pas décider, la charge est appliquée (même règle que l'import).
--
-- `CREATE OR REPLACE` à signature identique : l'ACL de 0165 est conservée ; elle est pourtant
-- redite ici, rôle par rôle (règle 11). Mode de sécurité, `search_path` et rôle réservé au
-- service restent ceux de 0165. Aucune table, aucune colonne.

create or replace function public.resync_shopify_order_cart(
  p_order_id uuid,
  p_lines jsonb,
  p_order_update jsonb
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_incoming timestamptz;
begin
  select *
    into v_order
    from public.orders
   where id = p_order_id
     for update;

  if not found then
    raise exception 'order_not_found'
      using errcode = 'P0002';
  end if;

  -- Garde hors-ordre, sous verrou : une charge plus ancienne (ou égale) que celle déjà appliquée
  -- n'écrit rien, même si elle était plus récente à la lecture de l'import.
  v_incoming := nullif(p_order_update ->> 'shopify_updated_at', '')::timestamptz;
  if v_incoming is not null
     and v_order.shopify_updated_at is not null
     and v_incoming <= v_order.shopify_updated_at
  then
    return 'stale';
  end if;

  -- Même prédicat que repair_shopify_order_lines, évalué sous verrou.
  if not exists (select 1 from public.order_line ol where ol.order_id = v_order.id)
     and (
       v_order.order_state is distinct from 'open'
       or v_order.call_state is not distinct from 'validated'
       or v_order.delivery_state is distinct from 'unassigned'
       or v_order.cash_state is distinct from 'not_due'
       or v_order.cart_locally_modified_at is not null
     )
  then
    return 'lines_missing';
  end if;

  perform public.replace_shopify_order_cart(p_order_id, p_lines, p_order_update);
  return 'resynced';
end;
$$;

revoke all on function public.resync_shopify_order_cart(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.resync_shopify_order_cart(uuid, jsonb, jsonb) to service_role;
