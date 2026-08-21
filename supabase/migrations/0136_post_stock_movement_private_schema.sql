-- 0136 — Déplace le cœur interne `post_stock_movement` (12 arguments) dans un schéma
-- `private`, non exposé par PostgREST, pour fermer le contournement HTTP identifié
-- après l'incident 0134/0135.
--
-- CONTEXTE
-- 0134 avait révoqué EXECUTE sur le cœur à 12 arguments pour `authenticated`, cassant
-- `transition_order` (SECURITY INVOKER, s'exécute comme `authenticated`) pendant 13 minutes
-- en production le 21 août 2026. 0135 a réouvert EXECUTE à `authenticated` en roll-forward.
-- Conséquence assumée à l'époque, non traitée depuis : n'importe quel `authenticated`
-- (agent inclus) peut appeler le cœur en HTTP direct (`/rest/v1/rpc/post_stock_movement`
-- à 12 arguments) et déclencher `manual_adjustment`, `driver_stock_set`, `purchase_in`,
-- `courier_return` sans passer par les Server Actions owner/manager de
-- lib/actions/stock.ts / lib/actions/drivers.ts.
--
-- Vérifié en production avant cette migration (API Settings du projet, pas d'hypothèse
-- locale) : schémas exposés = public, graphql_public uniquement ; `private` absent ;
-- `post_stock_movement` figure dans les fonctions actuellement exposées — le
-- contournement est réel en production, pas seulement en local. `Extra search path`
-- (public, extensions) n'ouvre l'accès à aucun schéma non listé dans les schémas exposés.
--
-- POURQUOI UN SCHÉMA PRIVÉ, PAS UN AUTRE MÉCANISME
-- Diagnostic Stage 0 complet (session précédente) :
--   • Option B (wrapper SECURITY DEFINER) n'est pas autonome : accordé à `authenticated`
--     il reste résolu en HTTP (aucun progrès) ; révoqué, il reproduit la panne 0134/0135
--     pour `transition_order`/`reassign_order_driver`. Se réduit à cette Option A ou à C.
--   • Option C (`transition_order` en SECURITY DEFINER) est DISQUALIFIÉE : la policy
--     `orders_update` (0126, WITH CHECK bornant l'agent à
--     cod_status in ('TENTEE','CONFIRMEE','PROGRAMMEE','EN_LIVRAISON')) est la SEULE
--     barrière RLS réelle sur l'écriture d'un agent. `transition_order` en DEFINER
--     s'exécuterait comme le propriétaire des fonctions (`postgres`), qui a
--     `rolbypassrls = true` (vérifié en base, documenté indépendamment dans 0051 et
--     0132) — RLS serait contournée, y compris sous FORCE ROW LEVEL SECURITY (FORCE ne
--     s'applique pas à un rôle BYPASSRLS). Un agent pourrait alors écrire n'importe
--     quelle dimension sur n'importe quelle commande de son tenant.
--   • Option A (ce fichier) ferme la voie HTTP sans toucher au SECURITY de
--     `transition_order` ni de `reassign_order_driver` : ils restent INVOKER, donc
--     `orders_update WITH CHECK` continue de s'appliquer pleinement — c'est la propriété
--     qui a fait échouer C, préservée ici intentionnellement.
--
-- MÉCANISME : `ALTER FUNCTION … SET SCHEMA`, pas suppression + recréation.
-- Ce DDL ne touche que l'espace de noms (`pronamespace`) : OID, propriétaire, ACL et
-- dépendances sont préservés tels quels — pas de fenêtre de coexistence, pas de reset de
-- grants (à la différence d'un `drop`+`create`, leçon 0067). Le grant `service_role`
-- posé par 0134 et le grant `authenticated` restauré par 0135 sur le cœur à 12 arguments
-- ne sont donc PAS reposés ici : ils survivent tels quels au déplacement.
--
-- CE QUI CHANGE, RIEN D'AUTRE
-- 1. Nouveau schéma `private`, non exposé (absent de `schemas` dans la configuration
--    PostgREST — vérifié pour la production comme pour le local), gouverné explicitement :
--    USAGE réservé à `authenticated` (nécessaire aux deux appelants SECURITY INVOKER),
--    aucun CREATE pour PUBLIC/anon/authenticated/service_role, EXECUTE révoqué par
--    défaut à PUBLIC pour toute future fonction qui y serait créée.
-- 2. Le cœur à 12 arguments déménage dans `private` par ALTER FUNCTION SET SCHEMA.
-- 3. Cinq sites d'appel sont requalifiés de `public.post_stock_movement(` vers
--    `private.post_stock_movement(` — corps VERBATIM par ailleurs, aucune autre ligne
--    touchée, aucun changement de signature :
--      • le cœur lui-même (récursion de cascade bundle, 0108) ;
--      • la surcharge publique à 13 arguments (capacité humaine owner/manager, 0134) —
--        sa propre signature, ses grants et ses gardes NE CHANGENT PAS, seule sa cible
--        interne qualifiée change, conformément à la contrainte du diagnostic ;
--      • `transition_order` (20 args, SECURITY INVOKER, ~10 sites) ;
--      • `reassign_order_driver` (SECURITY INVOKER, 1 site) ;
--      • `receive_purchase_lot` (SECURITY DEFINER, 1 site) et
--        `reduce_order_cart_post_assignment` (SECURITY DEFINER, 1 site) — ces deux-là
--        s'exécutent déjà comme `postgres`, propriétaire, donc immunisées contre toute
--        révocation de grant ; elles ont quand même besoin de la requalification, sans
--        quoi elles appelleraient un nom qui n'existe plus en `public`.
--    Ces cinq fonctions gardent une signature strictement identique : `CREATE OR REPLACE`
--    conserve leur ACL automatiquement (pas de `drop`, aucun grant reposé). `SECURITY`,
--    volatilité, `search_path` sont réaffirmés explicitement dans chaque redéfinition,
--    identiques à la version vivante.
--
-- CE QUI NE CHANGE PAS
-- Signature, grants et gardes de la surcharge publique à 13 arguments. Signature de
-- toute fonction listée ci-dessus. Mode SECURITY de `transition_order` et de
-- `reassign_order_driver` (INVOKER, inchangé — c'est le point qui disqualifiait
-- l'option C). Grants du cœur à 12 arguments (`service_role`, `authenticated`).
--
-- CONSÉQUENCE ASSUMÉE, HORS PÉRIMÈTRE DE CETTE MIGRATION
-- Les seeds de test qui appellent le cœur en HTTP via `admin.rpc('post_stock_movement',
-- …)` (service-role) cesseront de fonctionner : l'exposition de schéma PostgREST est une
-- barrière au niveau du cache, orthogonale aux privilèges SQL — `service_role` ne
-- rejoint pas plus un schéma non exposé qu'`authenticated`. Conversion vers une
-- connexion Postgres directe traitée dans le même lot applicatif (commit séparé), pas
-- dans cette migration.

-- ────────────────────────────────────────────────────────────
-- 1. Schéma privé, gouverné explicitement.
-- ────────────────────────────────────────────────────────────

create schema if not exists private;

revoke create on schema private from public, anon, authenticated, service_role;
revoke usage on schema private from public, anon;
grant usage on schema private to authenticated;

-- Toute fonction future créée dans ce schéma par le rôle propriétaire ne doit jamais
-- hériter du EXECUTE-to-PUBLIC accordé par défaut par PostgreSQL à la création.
alter default privileges in schema private revoke execute on functions from public;

-- ────────────────────────────────────────────────────────────
-- 2. Déménagement du cœur à 12 arguments. OID/propriétaire/ACL préservés tels quels.
-- ────────────────────────────────────────────────────────────

alter function public.post_stock_movement(
  uuid, uuid, text, integer, text, uuid, uuid, uuid, bigint, bigint, text, uuid
) set schema private;

-- ────────────────────────────────────────────────────────────
-- 3. Requalification du cœur lui-même — seule la ligne de récursion bundle change.
-- Corps verbatim de la version vivante (0134). Signature, SECURITY, search_path
-- réaffirmés explicitement (CREATE OR REPLACE ne les reconduit pas implicitement).
-- ────────────────────────────────────────────────────────────

create or replace function private.post_stock_movement(
  p_merchant_account_id uuid,
  p_product_id uuid,
  p_movement_type text,
  p_qty integer,
  p_idempotency_key text,
  p_created_by uuid,
  p_order_id uuid default null::uuid,
  p_transition_id uuid default null::uuid,
  p_unit_cost bigint default null::bigint,
  p_received_value bigint default null::bigint,
  p_reason text default null::text,
  p_driver_id uuid default null::uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_movement_id    uuid;
  v_stock          public.product_stock%rowtype;
  v_new_on_hand    integer;
  v_new_reserved   integer;
  v_new_unit_cost  bigint;
  v_cump_numerator numeric;
  v_is_bundle      boolean;
  v_shop_id        uuid;
  v_component      record;
begin
  -- The engine is reached either from an authenticated SQL transition or from
  -- the explicitly granted service-role seed path. It is not public.
  if coalesce(auth.role(), '') <> 'service_role'
     and public.current_member_role(p_merchant_account_id) is null
  then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_movement_type = 'manual_adjustment'
     and coalesce(nullif(btrim(coalesce(p_reason, '')), ''), null) is null
  then
    raise exception 'manual_adjustment requires a non-empty reason' using errcode = 'P0001';
  end if;

  if p_movement_type in (
       'allocate_to_courier', 'courier_return_lot', 'advance_commit',
       'order_assignment_commit', 'order_assignment_release', 'driver_stock_set'
     ) and p_driver_id is null
  then
    raise exception 'driver movement requires a driver' using errcode = 'P0001';
  end if;

  if p_movement_type in ('reassign_from_driver', 'reassign_to_driver')
     and p_driver_id is null
  then
    raise exception 'reassign movement requires a driver' using errcode = 'P0001';
  end if;

  select p.is_bundle, p.shop_id
    into v_is_bundle, v_shop_id
    from public.product p
   where p.id = p_product_id
     and p.merchant_account_id = p_merchant_account_id;

  if not found then
    raise exception 'product not found for this merchant account' using errcode = 'P0002';
  end if;

  if v_shop_id is null or not exists (
    select 1 from public.shop s
     where s.id = v_shop_id and s.merchant_account_id = p_merchant_account_id
  ) then
    raise exception 'stock_movement_store_conflict' using errcode = 'P0001';
  end if;

  -- Parent references must be from the same authoritative shop as the product.
  if p_order_id is not null and not exists (
    select 1 from public.orders o
     where o.id = p_order_id
       and o.merchant_account_id = p_merchant_account_id
       and o.shop_id = v_shop_id
  ) then
    raise exception 'stock_movement_order_store_conflict' using errcode = 'P0001';
  end if;

  if p_transition_id is not null and not exists (
    select 1 from public.order_state_transition ost
     where ost.id = p_transition_id
       and ost.merchant_account_id = p_merchant_account_id
       and ost.shop_id = v_shop_id
       and (p_order_id is null or ost.order_id = p_order_id)
  ) then
    raise exception 'stock_movement_transition_store_conflict' using errcode = 'P0001';
  end if;

  if v_is_bundle
     and p_movement_type in ('allocate_to_courier', 'courier_return_lot', 'driver_stock_set')
  then
    raise exception 'bundle product % cannot be the target of movement_type %',
      p_product_id, p_movement_type using errcode = 'P0001';
  end if;

  if p_driver_id is not null and not exists (
    select 1 from public.driver_shop ds
     where ds.merchant_account_id = p_merchant_account_id
       and ds.shop_id = v_shop_id
       and ds.driver_id = p_driver_id
  ) then
    raise exception 'driver not found in product shop' using errcode = 'P0002';
  end if;

  if v_is_bundle
     and p_movement_type in (
       'dispatch', 'sold', 'courier_return',
       'order_assignment_commit', 'order_assignment_release'
     )
  then
    for v_component in
      select pbc.component_product_id, pbc.quantity
        from public.product_bundle_component pbc
       where pbc.bundle_product_id = p_product_id
    loop
      perform private.post_stock_movement(
        p_merchant_account_id := p_merchant_account_id,
        p_product_id          := v_component.component_product_id,
        p_movement_type       := p_movement_type,
        p_qty                 := p_qty * v_component.quantity,
        p_idempotency_key     := p_idempotency_key || ':component:' || v_component.component_product_id::text,
        p_created_by          := p_created_by,
        p_order_id            := p_order_id,
        p_transition_id       := p_transition_id,
        p_unit_cost           := p_unit_cost,
        p_received_value      := p_received_value,
        p_reason              := p_reason,
        p_driver_id           := p_driver_id
      );
    end loop;

    return null;
  end if;

  insert into public.stock_movement (
    merchant_account_id, shop_id, product_id, movement_type, qty, unit_cost,
    reason, order_id, transition_id, idempotency_key, created_by, driver_id
  ) values (
    p_merchant_account_id, v_shop_id, p_product_id, p_movement_type, p_qty,
    p_unit_cost, p_reason, p_order_id, p_transition_id, p_idempotency_key,
    p_created_by, p_driver_id
  ) on conflict (idempotency_key) do nothing
  returning id into v_movement_id;

  if v_movement_id is null then
    return null;
  end if;

  if p_movement_type in (
       'order_assignment_commit', 'order_assignment_release',
       'allocate_to_courier', 'courier_return_lot', 'driver_stock_set'
     )
  then
    return v_movement_id;
  end if;

  insert into public.product_stock (product_id, merchant_account_id, shop_id)
  values (p_product_id, p_merchant_account_id, v_shop_id)
  on conflict (product_id) do nothing;

  select * into v_stock
    from public.product_stock
   where product_id = p_product_id
   for update;

  v_new_on_hand   := v_stock.qty_on_hand;
  v_new_reserved  := v_stock.qty_reserved;
  v_new_unit_cost := v_stock.unit_cost;

  case p_movement_type
    when 'reserve' then
      v_new_reserved := v_stock.qty_reserved + p_qty;
    when 'release' then
      v_new_reserved := greatest(0, v_stock.qty_reserved + p_qty);
    when 'dispatch' then
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);
      v_new_reserved := greatest(0, v_stock.qty_reserved + p_qty);
      update public.stock_movement set unit_cost = v_stock.unit_cost where id = v_movement_id;
    when 'advance_commit' then
      v_new_reserved := greatest(0, v_stock.qty_reserved - greatest(p_qty, 0));
    when 'sold' then
      update public.stock_movement set unit_cost = v_stock.unit_cost where id = v_movement_id;
    when 'purchase_in' then
      if (p_received_value is not null or p_unit_cost is not null)
         and (v_stock.qty_on_hand + p_qty) > 0
      then
        v_cump_numerator := v_stock.qty_on_hand::numeric * v_stock.unit_cost::numeric
          + coalesce(p_received_value::numeric, p_qty::numeric * p_unit_cost::numeric);
        v_new_unit_cost := (v_cump_numerator / (v_stock.qty_on_hand + p_qty))::bigint;
      end if;
      v_new_on_hand := v_stock.qty_on_hand + p_qty;
    when 'courier_return' then
      v_new_on_hand := v_stock.qty_on_hand + p_qty;
    when 'reassign_from_driver' then
      v_new_on_hand := v_stock.qty_on_hand + p_qty;
    when 'reassign_to_driver' then
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);
      update public.stock_movement set unit_cost = v_stock.unit_cost where id = v_movement_id;
    when 'manual_adjustment' then
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);
    else
      raise exception 'unknown stock movement_type: %', p_movement_type using errcode = 'P0001';
  end case;

  update public.product_stock
     set qty_on_hand = v_new_on_hand,
         qty_reserved = v_new_reserved,
         unit_cost = v_new_unit_cost,
         updated_at = now()
   where product_id = p_product_id;

  return v_movement_id;
end;
$function$;

-- ────────────────────────────────────────────────────────────
-- 4. Surcharge publique à 13 arguments — signature, grants et gardes INCHANGÉS.
-- Seul le dernier appel change de cible qualifiée.
-- ────────────────────────────────────────────────────────────

create or replace function public.post_stock_movement(
  p_merchant_account_id uuid,
  p_product_id uuid,
  p_movement_type text,
  p_qty integer,
  p_idempotency_key text,
  p_expected_shop_id uuid,
  p_created_by uuid,
  p_order_id uuid default null::uuid,
  p_transition_id uuid default null::uuid,
  p_unit_cost bigint default null::bigint,
  p_received_value bigint default null::bigint,
  p_reason text default null::text,
  p_driver_id uuid default null::uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_shop_id uuid;
  v_role text;
  v_actor uuid;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_role := public.current_shop_role(p_expected_shop_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_movement_type not in (
    'purchase_in', 'manual_adjustment', 'courier_return', 'driver_stock_set'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_created_by is not null and p_created_by <> v_actor then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select p.shop_id into v_shop_id
    from public.product p
   where p.id = p_product_id
     and p.merchant_account_id = p_merchant_account_id;

  if not found then
    raise exception 'product not found for this merchant account' using errcode = 'P0002';
  end if;

  if v_shop_id <> p_expected_shop_id then
    raise exception 'stock_movement_expected_shop_conflict' using errcode = 'P0001';
  end if;

  return private.post_stock_movement(
    p_merchant_account_id := p_merchant_account_id,
    p_product_id          := p_product_id,
    p_movement_type       := p_movement_type,
    p_qty                 := p_qty,
    p_idempotency_key     := p_idempotency_key,
    p_created_by          := v_actor,
    p_order_id            := p_order_id,
    p_transition_id       := p_transition_id,
    p_unit_cost           := p_unit_cost,
    p_received_value      := p_received_value,
    p_reason              := p_reason,
    p_driver_id           := p_driver_id
  );
end;
$function$;

-- ────────────────────────────────────────────────────────────
-- 5. reassign_order_driver — SECURITY INVOKER inchangée. Corps verbatim (0131/0109),
-- deux sites requalifiés.
-- ────────────────────────────────────────────────────────────

create or replace function public.reassign_order_driver(p_order_id uuid, p_actor uuid, p_new_driver uuid, p_note text default null::text)
 returns void
 language plpgsql
 set search_path to ''
as $function$
declare
  v_order              public.orders%rowtype;
  v_old_driver         uuid;
  v_transition_id      uuid;
  v_line               record;
  v_assignment_line    record;
  v_assignment_release record;
begin
  if p_new_driver is null then
    raise exception 'reassign_requires_driver'
      using errcode = '22023';
  end if;

  select *
    into v_order
    from public.orders
   where id = p_order_id
   for update;

  if not found then
    raise exception 'order_not_found'
      using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.driver
    where id = p_new_driver
      and merchant_account_id = v_order.merchant_account_id
  ) then
    raise exception 'driver not found for this merchant account'
      using errcode = 'P0002';
  end if;

  if v_order.delivery_state not in ('scheduled', 'assigned', 'out_for_delivery') then
    raise exception 'reassign_not_allowed_in_state'
      using errcode = '22023';
  end if;

  if v_order.shop_id is null or not exists (
    select 1
      from public.shop s
     where s.id = v_order.shop_id
       and s.merchant_account_id = v_order.merchant_account_id
  ) then
    raise exception 'order_store_conflict'
      using errcode = 'P0001';
  end if;

  v_old_driver := v_order.assigned_driver_id;

  if v_old_driver is not distinct from p_new_driver then
    return;
  end if;

  update public.orders
     set assigned_driver_id = p_new_driver,
         updated_at         = now()
   where id = p_order_id;

  insert into public.order_state_transition (
    merchant_account_id,
    shop_id,
    order_id,
    from_status,
    to_status,
    actor_user_id,
    note,
    created_at
  )
  values (
    v_order.merchant_account_id,
    v_order.shop_id,
    v_order.id,
    v_order.cod_status,
    v_order.cod_status,
    p_actor,
    coalesce(p_note, 'Reassignation livreur'),
    now()
  )
  returning id into v_transition_id;

  if v_order.delivery_state in ('assigned', 'out_for_delivery') then
    if v_old_driver is null then
      raise exception 'reassign_missing_outgoing_driver'
        using errcode = '22023';
    end if;

    for v_line in
      select ol.id, ol.product_id, ol.qty
        from public.order_line ol
       where ol.order_id     = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id   is not null
    loop
      perform private.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_line.product_id,
        p_movement_type       := 'reassign_from_driver',
        p_qty                 := v_line.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_line.id::text
                                 || ':reassign_from',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := v_old_driver
      );

      perform private.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_line.product_id,
        p_movement_type       := 'reassign_to_driver',
        p_qty                 := -v_line.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_line.id::text
                                 || ':reassign_to',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := p_new_driver
      );
    end loop;

    for v_assignment_release in
      with required as (
        select product_id, required_qty
          from public.resolve_order_required_component_quantities(p_order_id)
      ),
      open_commitments as (
        select sm.product_id,
               sm.driver_id,
               sum(case
                 when sm.movement_type = 'order_assignment_commit' then sm.qty
                 when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
                 else 0
               end)::integer as net_open
          from public.stock_movement sm
         where sm.merchant_account_id = v_order.merchant_account_id
           and sm.order_id = p_order_id
           and sm.driver_id is not null
           and sm.driver_id = v_old_driver
           and sm.movement_type in ('order_assignment_commit', 'order_assignment_release')
         group by sm.product_id, sm.driver_id
        having sum(case
          when sm.movement_type = 'order_assignment_commit' then sm.qty
          when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
          else 0
        end) > 0
      )
      select oc.product_id,
             oc.driver_id,
             least(r.required_qty, oc.net_open)::integer as qty
        from open_commitments oc
        join required r on r.product_id = oc.product_id
       where least(r.required_qty, oc.net_open) > 0
    loop
      perform private.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_assignment_release.product_id,
        p_movement_type       := 'order_assignment_release',
        p_qty                 := -v_assignment_release.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_assignment_release.product_id::text
                                 || ':' || v_assignment_release.driver_id::text
                                 || ':order_assignment_release',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := v_assignment_release.driver_id
      );
    end loop;

    for v_assignment_line in
      select ol.product_id, sum(ol.qty)::integer as qty
        from public.order_line ol
       where ol.order_id = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id is not null
       group by ol.product_id
    loop
      perform private.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_assignment_line.product_id,
        p_movement_type       := 'order_assignment_commit',
        p_qty                 := v_assignment_line.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_assignment_line.product_id::text
                                 || ':order_assignment_commit',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := p_new_driver
      );
    end loop;
  end if;
end;
$function$;

-- ────────────────────────────────────────────────────────────
-- 6. transition_order — SECURITY INVOKER inchangée (c'est le point qui disqualifiait
-- l'option C). Corps verbatim (0131/0116), dix sites requalifiés.
-- ────────────────────────────────────────────────────────────

create or replace function public.transition_order(p_order_id uuid, p_actor uuid, p_note text default null::text, p_payment_channel text default 'ESPECES'::text, p_order_state text default null::text, p_call_state text default null::text, p_delivery_state text default null::text, p_cash_state text default null::text, p_attempt_count integer default null::integer, p_next_contact_at timestamp with time zone default null::timestamp with time zone, p_scheduled_for timestamp with time zone default null::timestamp with time zone, p_cancel_reason text default null::text, p_assigned_driver_id uuid default null::uuid, p_cancel_reasons text[] default null::text[], p_clear_scheduled_for boolean default false, p_clear_cancel_reasons boolean default false, p_clear_assigned_driver boolean default false, p_call_confirmed_at timestamp with time zone default null::timestamp with time zone, p_delivered_at timestamp with time zone default null::timestamp with time zone, p_invalidate_delivered boolean default false)
 returns text
 language plpgsql
 set search_path to ''
as $function$
declare
  v_order                     public.orders%rowtype;
  v_next_cash_state           text;
  v_next_delivery_state       text;
  v_next_order_state          text;
  v_next_status                text;
  v_payment_channel           text;
  v_transition_id             uuid;
  v_movement_type             text;
  v_effective_driver_id       uuid;
  v_cash_reversal_minor       bigint := 0;
  v_cash_reversal_method      text;
  v_cash_reversal_settlement  uuid;
  v_line                      record;
  v_assignment_line           record;
  v_assignment_release        record;
  v_advance_avail             integer;
  v_cover                     integer;
  v_remainder                 integer;
  -- 0114 — bornes de cohérence des deux dates éditables.
  v_order_origin_at           timestamptz;
  v_effective_confirmed_at    timestamptz;
  v_effective_delivered_at    timestamptz;
  -- 0116 — contre-passation de stock à l'invalidation.
  v_invalidation_reversal     record;
  -- 0116 — transition_id RÉELLEMENT persisté, à passer aux mouvements de stock. Identique à
  -- v_transition_id partout, sauf à l'invalidation où aucune ligne d'historique n'existe :
  -- il vaut alors NULL, car stock_movement.transition_id est une FK vers
  -- order_state_transition(id) et n'accepterait pas un UUID inexistant.
  v_movement_transition_id    uuid;
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

  if v_order.shop_id is null or not exists (
    select 1
      from public.shop s
     where s.id = v_order.shop_id
       and s.merchant_account_id = v_order.merchant_account_id
  ) then
    raise exception 'order_store_conflict'
      using errcode = 'P0001';
  end if;

  v_payment_channel     := coalesce(p_payment_channel, 'ESPECES');
  v_next_order_state    := coalesce(p_order_state,    v_order.order_state);
  v_next_delivery_state := coalesce(p_delivery_state, v_order.delivery_state);
  v_next_cash_state     := coalesce(p_cash_state,     v_order.cash_state);
  v_effective_driver_id := coalesce(p_assigned_driver_id, v_order.assigned_driver_id);

  if v_next_delivery_state = 'delivered'
     and v_next_cash_state = 'collected'
     and v_payment_channel not in (
       'ESPECES', 'WAVE', 'ORANGE_MONEY', 'FREE_MONEY', 'INCONNU'
     )
  then
    raise exception 'invalid_payment_channel'
      using errcode = '22023';
  end if;

  if v_next_order_state = 'returned' or v_next_delivery_state = 'returned' then
    if not (
      v_order.order_state = 'completed'
      and v_order.delivery_state = 'delivered'
      and v_next_order_state = 'returned'
      and v_next_delivery_state = 'returned'
    ) then
      raise exception 'illegal_return_transition'
        using errcode = '22023';
    end if;
  end if;

  if p_invalidate_delivered then
    if v_order.order_state <> 'completed' or v_order.delivery_state <> 'delivered' then
      raise exception 'illegal_invalidation'
        using errcode = '22023';
    end if;

    if v_order.cash_state in ('remitted', 'discrepancy') then
      raise exception 'invalid_invalidate_cash_settled'
        using errcode = '22023';
    end if;
  end if;

  if p_call_confirmed_at is not null or p_delivered_at is not null then
    v_order_origin_at := least(
      v_order.created_at,
      coalesce(v_order.created_at_shopify, v_order.created_at)
    );

    if greatest(
         coalesce(p_call_confirmed_at, '-infinity'::timestamptz),
         coalesce(p_delivered_at,      '-infinity'::timestamptz)
       ) > now() + interval '5 minutes'
    then
      raise exception 'invalid_date_future'
        using errcode = '22023';
    end if;

    if least(
         coalesce(p_call_confirmed_at, 'infinity'::timestamptz),
         coalesce(p_delivered_at,      'infinity'::timestamptz)
       ) < v_order_origin_at
    then
      raise exception 'invalid_date_before_creation'
        using errcode = '22023';
    end if;

    v_effective_confirmed_at := coalesce(p_call_confirmed_at, v_order.call_confirmed_at);
    v_effective_delivered_at := coalesce(p_delivered_at,      v_order.cash_collected_at);

    if v_effective_confirmed_at is not null
       and v_effective_delivered_at is not null
       and v_effective_confirmed_at > v_effective_delivered_at
    then
      raise exception 'invalid_confirmation_after_delivery'
        using errcode = '22023';
    end if;
  end if;

  update public.orders
     set order_state    = coalesce(p_order_state,        order_state),
         call_state     = coalesce(p_call_state,          call_state),
         delivery_state = coalesce(p_delivery_state,      delivery_state),
         cash_state     = coalesce(p_cash_state,          cash_state),
         attempt_count  = coalesce(p_attempt_count,       attempt_count),
         next_contact_at = coalesce(p_next_contact_at,    next_contact_at),
         scheduled_for  = case
           when p_clear_scheduled_for then null
           else coalesce(p_scheduled_for, scheduled_for)
         end,
         cancel_reason  = case
           when p_clear_cancel_reasons then null
           when p_cancel_reasons is not null then p_cancel_reasons[1]
           else coalesce(p_cancel_reason, cancel_reason)
         end,
         cancel_reasons = case
           when p_clear_cancel_reasons then null
           else coalesce(p_cancel_reasons, cancel_reasons)
         end,
         assigned_driver_id = case
           when p_clear_assigned_driver then null
           else coalesce(p_assigned_driver_id, assigned_driver_id)
         end,
         payment_channel_at_delivery = case
           when p_invalidate_delivered then null
           when v_next_delivery_state = 'delivered'
                and v_next_cash_state = 'collected'
             then v_payment_channel
           else payment_channel_at_delivery
         end,
         cash_collectable_minor = case
           when p_invalidate_delivered then 0
           when v_next_delivery_state <> 'delivered'
                or v_next_cash_state <> 'collected'
             then cash_collectable_minor
           when v_payment_channel in ('WAVE', 'ORANGE_MONEY', 'FREE_MONEY')
             then 0
           else round(total_amount)::bigint
         end,
         call_confirmed_at = case
           when p_invalidate_delivered then null
           when coalesce(p_call_state, v_order.call_state) = 'validated'
                and v_order.call_state <> 'validated'
                and call_confirmed_at is null
             then coalesce(p_call_confirmed_at, now())
           else call_confirmed_at
         end,
         cash_collected_at = case
           when p_invalidate_delivered then null
           when v_next_delivery_state = 'delivered'
                and v_next_cash_state = 'collected'
                and cash_collected_at is null
             then coalesce(p_delivered_at, v_order.scheduled_for, now())
           else cash_collected_at
         end,
         returned_at = case
           when p_order_state = 'returned'
                and v_order.order_state <> 'returned'
                and returned_at is null
             then now()
           else returned_at
         end,
         updated_at = now()
   where id = p_order_id
   returning cod_status into v_next_status;

  if p_invalidate_delivered then
    v_transition_id := gen_random_uuid();
    v_movement_transition_id := null;
  else
    insert into public.order_state_transition (
      merchant_account_id,
      shop_id,
      order_id,
      from_status,
      to_status,
      actor_user_id,
      note,
      created_at
    )
    values (
      v_order.merchant_account_id,
      v_order.shop_id,
      v_order.id,
      v_order.cod_status,
      v_next_status,
      p_actor,
      p_note,
      now()
    )
    returning id into v_transition_id;

    v_movement_transition_id := v_transition_id;
  end if;

  if v_order.order_state = 'completed'
     and v_order.delivery_state = 'delivered'
     and v_next_order_state = 'returned'
     and v_next_delivery_state = 'returned'
  then
    select coalesce(sum(sa.allocated_minor), 0)
      into v_cash_reversal_minor
      from public.settlement_allocation sa
     where sa.order_id = v_order.id
       and sa.merchant_account_id = v_order.merchant_account_id;

    if v_cash_reversal_minor > 0 then
      if v_effective_driver_id is null then
        raise exception 'missing_driver_for_cash_reversal'
          using errcode = '22023';
      end if;

      v_cash_reversal_method := case
        when v_order.payment_channel_at_delivery in (
          'ESPECES', 'WAVE', 'ORANGE_MONEY', 'FREE_MONEY'
        )
          then v_order.payment_channel_at_delivery
        else 'ESPECES'
      end;

      insert into public.cash_settlement (
        merchant_account_id,
        driver_id,
        amount_received_minor,
        method,
        note,
        settled_at,
        created_by,
        client_request_id
      )
      values (
        v_order.merchant_account_id,
        v_effective_driver_id,
        -v_cash_reversal_minor,
        v_cash_reversal_method,
        'Reprise retour commande ' || coalesce(v_order.order_number, v_order.id::text),
        now(),
        p_actor,
        v_transition_id
      )
      returning id into v_cash_reversal_settlement;

      insert into public.settlement_allocation (
        settlement_id,
        order_id,
        allocated_minor,
        merchant_account_id
      )
      values (
        v_cash_reversal_settlement,
        v_order.id,
        -v_cash_reversal_minor,
        v_order.merchant_account_id
      );
    end if;
  end if;

  v_movement_type := case
    when v_next_delivery_state in ('assigned', 'out_for_delivery')
         and v_order.delivery_state not in (
           'assigned', 'out_for_delivery', 'delivered', 'failed', 'returned'
         )
      then 'dispatch'

    when v_next_delivery_state = 'delivered'
         and v_order.delivery_state <> 'delivered'
      then 'sold'

    when v_next_order_state = 'returned'
         and v_next_delivery_state = 'returned'
         and v_order.order_state = 'completed'
         and v_order.delivery_state = 'delivered'
      then 'courier_return'

    when coalesce(p_call_state, v_order.call_state) = 'validated'
         and v_order.call_state <> 'validated'
         and v_next_delivery_state in ('unassigned', 'scheduled')
      then 'reserve'

    when coalesce(p_call_state, v_order.call_state) = 'to_call'
         and v_order.call_state = 'validated'
         and v_order.order_state = 'open'
         and v_order.delivery_state in ('unassigned', 'scheduled')
      then 'release'

    when v_next_order_state in ('cancelled', 'returned')
         and v_order.order_state not in ('cancelled', 'returned')
         and v_order.delivery_state in ('unassigned', 'scheduled')
      then 'release'

    else null
  end;

  if v_movement_type is not null then
    for v_line in
      select ol.id, ol.product_id, ol.qty
        from public.order_line ol
       where ol.order_id  = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id   is not null
    loop
      if v_movement_type = 'dispatch' then
        select greatest(0,
            coalesce(sum(case when sm.movement_type = 'allocate_to_courier' then -sm.qty else 0 end), 0)
          - coalesce(sum(case when sm.movement_type = 'courier_return_lot'   then  sm.qty else 0 end), 0)
          - coalesce(sum(case when sm.movement_type = 'advance_commit'       then  sm.qty else 0 end), 0)
        )
          into v_advance_avail
          from public.stock_movement sm
         where sm.merchant_account_id = v_order.merchant_account_id
           and sm.product_id = v_line.product_id
           and sm.driver_id  = v_effective_driver_id;

        v_cover     := least(v_line.qty, coalesce(v_advance_avail, 0));
        v_remainder := v_line.qty - v_cover;

        if v_cover > 0 then
          perform private.post_stock_movement(
            p_merchant_account_id := v_order.merchant_account_id,
            p_product_id          := v_line.product_id,
            p_movement_type       := 'advance_commit',
            p_qty                 := v_cover,
            p_idempotency_key     := v_transition_id::text
                                     || ':' || v_line.id::text
                                     || ':advance_commit',
            p_created_by          := p_actor,
            p_order_id            := p_order_id,
            p_transition_id       := v_movement_transition_id,
            p_driver_id           := v_effective_driver_id
          );
        end if;

        if v_remainder > 0 then
          perform private.post_stock_movement(
            p_merchant_account_id := v_order.merchant_account_id,
            p_product_id          := v_line.product_id,
            p_movement_type       := 'dispatch',
            p_qty                 := -v_remainder,
            p_idempotency_key     := v_transition_id::text
                                     || ':' || v_line.id::text
                                     || ':dispatch',
            p_created_by          := p_actor,
            p_order_id            := p_order_id,
            p_transition_id       := v_movement_transition_id,
            p_driver_id           := v_effective_driver_id
          );
        end if;

      else
        perform private.post_stock_movement(
          p_merchant_account_id := v_order.merchant_account_id,
          p_product_id          := v_line.product_id,
          p_movement_type       := v_movement_type,
          p_qty                 := case
                                     when v_movement_type = 'release'
                                       then -v_line.qty
                                     else v_line.qty
                                   end,
          p_idempotency_key     := v_transition_id::text
                                   || ':' || v_line.id::text
                                   || ':' || v_movement_type,
          p_created_by          := p_actor,
          p_order_id            := p_order_id,
          p_transition_id       := v_movement_transition_id,
          p_driver_id           := v_effective_driver_id
        );
      end if;
    end loop;
  end if;

  if v_movement_type = 'dispatch' then
    for v_assignment_line in
      select ol.product_id, sum(ol.qty)::integer as qty
        from public.order_line ol
       where ol.order_id = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id is not null
       group by ol.product_id
    loop
      perform private.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_assignment_line.product_id,
        p_movement_type       := 'order_assignment_commit',
        p_qty                 := v_assignment_line.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_assignment_line.product_id::text
                                 || ':order_assignment_commit',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_movement_transition_id,
        p_driver_id           := v_effective_driver_id
      );
    end loop;
  end if;

  if (
       v_next_order_state in ('cancelled', 'returned')
       and v_order.order_state not in ('cancelled', 'returned')
     )
     or (
       v_next_order_state = 'open'
       and v_order.order_state = 'open'
       and v_order.delivery_state in ('assigned', 'out_for_delivery')
       and v_next_delivery_state = 'scheduled'
     )
     or p_invalidate_delivered
  then
    for v_assignment_release in
      with required as (
        select product_id, required_qty
          from public.resolve_order_required_component_quantities(p_order_id)
      ),
      open_commitments as (
        select sm.product_id,
               sm.driver_id,
               sum(case
                 when sm.movement_type = 'order_assignment_commit' then sm.qty
                 when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
                 else 0
               end)::integer as net_open
          from public.stock_movement sm
         where sm.merchant_account_id = v_order.merchant_account_id
           and sm.order_id = p_order_id
           and sm.driver_id is not null
           and sm.movement_type in ('order_assignment_commit', 'order_assignment_release')
         group by sm.product_id, sm.driver_id
        having sum(case
          when sm.movement_type = 'order_assignment_commit' then sm.qty
          when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
          else 0
        end) > 0
      )
      select oc.product_id,
             oc.driver_id,
             least(r.required_qty, oc.net_open)::integer as qty
        from open_commitments oc
        join required r on r.product_id = oc.product_id
       where least(r.required_qty, oc.net_open) > 0
    loop
      perform private.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_assignment_release.product_id,
        p_movement_type       := 'order_assignment_release',
        p_qty                 := -v_assignment_release.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_assignment_release.product_id::text
                                 || ':' || v_assignment_release.driver_id::text
                                 || ':order_assignment_release',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_movement_transition_id,
        p_driver_id           := v_assignment_release.driver_id
      );
    end loop;
  end if;

  if p_invalidate_delivered then
    for v_invalidation_reversal in
      select sm.product_id,
             sm.driver_id,
             sm.movement_type,
             sum(sm.qty)::integer as net_qty
        from public.stock_movement sm
       where sm.order_id = p_order_id
         and sm.merchant_account_id = v_order.merchant_account_id
         and sm.movement_type in (
           'dispatch', 'sold', 'reassign_from_driver', 'reassign_to_driver'
         )
       group by sm.product_id, sm.driver_id, sm.movement_type
      having sum(sm.qty) <> 0
    loop
      perform private.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_invalidation_reversal.product_id,
        p_movement_type       := v_invalidation_reversal.movement_type,
        p_qty                 := -v_invalidation_reversal.net_qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_invalidation_reversal.product_id::text
                                 || ':' || coalesce(v_invalidation_reversal.driver_id::text, 'none')
                                 || ':' || v_invalidation_reversal.movement_type
                                 || ':invalidate_reversal',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_movement_transition_id,
        p_driver_id           := v_invalidation_reversal.driver_id
      );

      if v_invalidation_reversal.movement_type = 'dispatch' then
        perform private.post_stock_movement(
          p_merchant_account_id := v_order.merchant_account_id,
          p_product_id          := v_invalidation_reversal.product_id,
          p_movement_type       := 'release',
          p_qty                 := v_invalidation_reversal.net_qty,
          p_idempotency_key     := v_transition_id::text
                                   || ':' || v_invalidation_reversal.product_id::text
                                   || ':' || coalesce(v_invalidation_reversal.driver_id::text, 'none')
                                   || ':invalidate_reserved_release',
          p_created_by          := p_actor,
          p_order_id            := p_order_id,
          p_transition_id       := v_movement_transition_id,
          p_driver_id           := v_invalidation_reversal.driver_id
        );
      end if;
    end loop;
  end if;

  if p_clear_assigned_driver then
    for v_line in
      select sm.product_id,
             sm.driver_id,
             sum(sm.qty)::integer as committed
        from public.stock_movement sm
       where sm.order_id = p_order_id
         and sm.merchant_account_id = v_order.merchant_account_id
         and sm.movement_type = 'advance_commit'
         and sm.driver_id is not null
       group by sm.product_id, sm.driver_id
      having sum(sm.qty) <> 0
    loop
      perform private.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_line.product_id,
        p_movement_type       := 'advance_commit',
        p_qty                 := -v_line.committed,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_line.product_id::text
                                 || ':' || v_line.driver_id::text
                                 || ':advance_commit_reversal',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_movement_transition_id,
        p_driver_id           := v_line.driver_id
      );
    end loop;
  end if;

  return v_next_status;
end;
$function$;

-- ────────────────────────────────────────────────────────────
-- 7. receive_purchase_lot — SECURITY DEFINER inchangée (s'exécute déjà comme
-- `postgres`, immunisée contre toute révocation de grant sur le cœur ; requalifiée
-- quand même, sans quoi elle appellerait un nom qui n'existe plus). Corps verbatim
-- (0043), un site requalifié.
-- ────────────────────────────────────────────────────────────

create or replace function public.receive_purchase_lot(
  p_lot_id              uuid,
  p_merchant_account_id uuid,
  p_actor_id            uuid,
  p_lines               jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lot      public.purchase_lot%rowtype;
  v_line_row public.purchase_lot_line%rowtype;
  v_elem     jsonb;
  v_line_id  uuid;
  v_line_val bigint;
  v_alloc    bigint;
  v_landed   bigint;
  v_ucost    bigint;
begin
  if public.current_member_role(p_merchant_account_id) is distinct from 'owner' then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  select * into v_lot
  from public.purchase_lot
  where id = p_lot_id
  for update;

  if not found then
    raise exception 'purchase_lot not found: %', p_lot_id
      using errcode = 'P0002';
  end if;

  if v_lot.merchant_account_id <> p_merchant_account_id then
    raise exception 'access denied: lot belongs to a different merchant'
      using errcode = 'P0002';
  end if;

  if v_lot.status = 'received' then
    raise exception 'lot already received: %', p_lot_id
      using errcode = 'P0001';
  end if;

  for v_elem in select * from jsonb_array_elements(p_lines) loop
    v_line_id  := (v_elem->>'line_id')::uuid;
    v_line_val := (v_elem->>'line_value')::bigint;
    v_alloc    := (v_elem->>'allocated_fees')::bigint;
    v_landed   := (v_elem->>'landed_total_value')::bigint;
    v_ucost    := (v_elem->>'landed_unit_cost')::bigint;

    select * into v_line_row
    from public.purchase_lot_line
    where id = v_line_id
      and purchase_lot_id = p_lot_id
    for update;

    if not found then
      raise exception 'purchase_lot_line not found or wrong lot: %', v_line_id
        using errcode = 'P0002';
    end if;

    update public.purchase_lot_line
       set line_value         = v_line_val,
           allocated_fees     = v_alloc,
           landed_total_value = v_landed,
           landed_unit_cost   = v_ucost
     where id = v_line_id;

    if v_line_row.qty > 0 then
      perform private.post_stock_movement(
        p_merchant_account_id := p_merchant_account_id,
        p_product_id          := v_line_row.product_id,
        p_movement_type       := 'purchase_in',
        p_qty                 := v_line_row.qty,
        p_idempotency_key     := 'recv:' || p_lot_id::text || ':' || v_line_id::text,
        p_created_by          := p_actor_id,
        p_unit_cost           := v_ucost,
        p_received_value      := v_landed
      );
    end if;
  end loop;

  update public.purchase_lot
     set status      = 'received',
         received_at = current_date
   where id = p_lot_id;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 8. reduce_order_cart_post_assignment — SECURITY DEFINER inchangée (même
-- immunité que receive_purchase_lot). Corps verbatim (0113), un site requalifié.
-- ────────────────────────────────────────────────────────────

create or replace function public.reduce_order_cart_post_assignment(
  p_order_id uuid,
  p_lines jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_role text;
  v_line jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_old_qty integer;
  v_price numeric;
  v_product public.product%rowtype;
  v_total numeric := 0;
  v_line_count integer := 0;
  v_items_summary jsonb := '[]'::jsonb;
  v_cash_collectable_minor bigint;
  v_price_count integer;
  v_reduction_id uuid := gen_random_uuid();
  v_release record;
begin
  if jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0
     or jsonb_array_length(p_lines) > 20
  then
    raise exception 'cart_reduction_lines_required'
      using errcode = '22023';
  end if;

  select *
    into v_order
    from public.orders
   where id = p_order_id
   for update;

  if not found then
    raise exception 'order_not_found'
      using errcode = 'P0002';
  end if;

  v_role := public.current_member_role(v_order.merchant_account_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if v_order.cash_state is null
     or v_order.cash_state in ('collected', 'remitted', 'discrepancy')
  then
    raise exception 'cart_reduction_not_allowed_after_cash_due'
      using errcode = '22023';
  end if;

  if v_order.delivery_state is null
     or v_order.delivery_state in ('unassigned', 'delivered', 'failed', 'returned')
  then
    raise exception 'cart_reduction_not_allowed_before_or_after_delivery'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_lines) as requested(value)
     group by requested.value ->> 'product_id'
    having count(*) > 1
  ) then
    raise exception 'cart_reduction_duplicate_product'
      using errcode = '22023';
  end if;

  for v_line in
    select value
      from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(v_line) <> 'object'
       or jsonb_typeof(v_line -> 'product_id') <> 'string'
       or jsonb_typeof(v_line -> 'quantity') <> 'number'
    then
      raise exception 'cart_reduction_invalid_line'
        using errcode = '22023';
    end if;

    begin
      v_product_id := (v_line ->> 'product_id')::uuid;
      v_quantity := (v_line ->> 'quantity')::integer;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'cart_reduction_invalid_line'
          using errcode = '22023';
    end;

    if v_quantity <= 0
       or v_quantity > 999
       or (v_line ->> 'quantity')::numeric <> v_quantity::numeric
    then
      raise exception 'cart_reduction_invalid_line'
        using errcode = '22023';
    end if;

    select sum(ol.qty)::integer
      into v_old_qty
      from public.order_line ol
     where ol.order_id = v_order.id
       and ol.product_id = v_product_id
       and ol.match_status = 'matched';

    if v_old_qty is null then
      raise exception 'cart_reduction_product_not_in_order'
        using errcode = '22023';
    end if;

    if v_quantity > v_old_qty then
      raise exception 'cart_reduction_quantity_increase_not_allowed'
        using errcode = '22023';
    end if;

    select *
      into v_product
      from public.product
     where id = v_product_id
       and merchant_account_id = v_order.merchant_account_id;

    if not found then
      raise exception 'cart_reduction_product_not_found'
        using errcode = 'P0002';
    end if;

    select
      count(distinct (item.value ->> 'price')::numeric)::integer,
      min((item.value ->> 'price')::numeric)
      into v_price_count, v_price
      from jsonb_array_elements(coalesce(v_order.items_summary, '[]'::jsonb))
           with ordinality as item(value, ordinal)
     where jsonb_typeof(item.value -> 'price') = 'number'
       and (
         (item.value ->> 'product_id') = v_product_id::text
         or (
           (item.value ->> 'product_id') is null
           and item.value ->> 'title' = v_product.title
         )
       );

    if coalesce(v_price_count, 0) = 0 then
      raise exception 'cart_reduction_missing_existing_price'
        using errcode = '22023';
    end if;

    if v_price_count <> 1 then
      raise exception 'cart_reduction_ambiguous_existing_price'
        using errcode = '22023';
    end if;

    v_line_count := v_line_count + 1;
    v_total := v_total + v_quantity * v_price;
    v_items_summary := v_items_summary || jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product.id,
        'title', v_product.title,
        'sku', v_product.sku,
        'quantity', v_quantity,
        'price', v_price
      )
    );
  end loop;

  if exists (
    with open_commitments as (
      select sm.product_id, sm.driver_id
      from public.stock_movement sm
      where sm.merchant_account_id = v_order.merchant_account_id
        and sm.order_id = v_order.id
        and sm.driver_id is not null
        and sm.movement_type in ('order_assignment_commit', 'order_assignment_release')
      group by sm.product_id, sm.driver_id
      having sum(case
        when sm.movement_type = 'order_assignment_commit' then sm.qty
        when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
        else 0
      end) > 0
    )
    select 1
      from open_commitments
     group by product_id
    having count(*) > 1
  ) then
    raise exception 'cart_reduction_multiple_open_commitment_drivers'
      using errcode = '22023';
  end if;

  for v_release in
    with old_required as (
      select
        coalesce(pbc.component_product_id, ol.product_id) as product_id,
        sum(ol.qty * coalesce(pbc.quantity, 1))::integer as qty
      from public.order_line ol
      left join public.product_bundle_component pbc
        on pbc.bundle_product_id = ol.product_id
      where ol.order_id = v_order.id
        and ol.match_status = 'matched'
        and ol.product_id is not null
      group by coalesce(pbc.component_product_id, ol.product_id)
    ),
    new_required as (
      select
        coalesce(pbc.component_product_id, (requested.value ->> 'product_id')::uuid) as product_id,
        sum(((requested.value ->> 'quantity')::integer) * coalesce(pbc.quantity, 1))::integer as qty
      from jsonb_array_elements(p_lines) as requested(value)
      left join public.product_bundle_component pbc
        on pbc.bundle_product_id = (requested.value ->> 'product_id')::uuid
      group by coalesce(pbc.component_product_id, (requested.value ->> 'product_id')::uuid)
    ),
    reductions as (
      select old_required.product_id, old_required.qty - coalesce(new_required.qty, 0) as qty
      from old_required
      left join new_required using (product_id)
      where old_required.qty > coalesce(new_required.qty, 0)
    ),
    open_commitments as (
      select
        sm.product_id,
        sm.driver_id,
        sum(case
          when sm.movement_type = 'order_assignment_commit' then sm.qty
          when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
          else 0
        end)::integer as net_open
      from public.stock_movement sm
      where sm.merchant_account_id = v_order.merchant_account_id
        and sm.order_id = v_order.id
        and sm.driver_id is not null
        and sm.movement_type in ('order_assignment_commit', 'order_assignment_release')
      group by sm.product_id, sm.driver_id
      having sum(case
        when sm.movement_type = 'order_assignment_commit' then sm.qty
        when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
        else 0
      end) > 0
    )
    select
      reductions.product_id,
      open_commitments.driver_id,
      least(reductions.qty, open_commitments.net_open)::integer as qty
    from reductions
    join open_commitments using (product_id)
    where least(reductions.qty, open_commitments.net_open) > 0
  loop
    perform private.post_stock_movement(
      p_merchant_account_id := v_order.merchant_account_id,
      p_product_id          := v_release.product_id,
      p_movement_type       := 'order_assignment_release',
      p_qty                 := -v_release.qty,
      p_idempotency_key     := 'cart_reduction:' || v_reduction_id::text
                               || ':' || v_release.product_id::text
                               || ':' || v_release.driver_id::text,
      p_created_by          := auth.uid(),
      p_order_id            := v_order.id,
      p_driver_id           := v_release.driver_id
    );
  end loop;

  v_cash_collectable_minor := case
    when v_order.payment_channel_at_delivery in ('WAVE', 'ORANGE_MONEY', 'FREE_MONEY') then 0
    else round(v_total)::bigint
  end;

  delete from public.order_line
   where order_id = v_order.id;

  for v_line in
    select value
      from jsonb_array_elements(p_lines)
  loop
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_quantity := (v_line ->> 'quantity')::integer;

    select *
      into v_product
      from public.product
     where id = v_product_id
       and merchant_account_id = v_order.merchant_account_id;

    insert into public.order_line (
      merchant_account_id,
      order_id,
      product_id,
      raw_title,
      raw_sku,
      raw_shopify_variant_id,
      raw_shopify_product_id,
      qty,
      match_status
    )
    values (
      v_order.merchant_account_id,
      v_order.id,
      v_product.id,
      v_product.title,
      v_product.sku,
      v_product.shopify_variant_id,
      v_product.shopify_product_id,
      v_quantity,
      'matched'
    );
  end loop;

  update public.orders
     set items_summary = v_items_summary,
         total_amount = v_total,
         cash_collectable_minor = v_cash_collectable_minor,
         cart_locally_modified_at = now(),
         updated_at = now()
   where id = v_order.id;

  insert into public.audit_log (
    merchant_account_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    payload
  )
  values (
    v_order.merchant_account_id,
    auth.uid(),
    'order.cart_reduced_post_assignment',
    'orders',
    v_order.id,
    jsonb_build_object(
      'lineCount', v_line_count,
      'totalAmount', v_total,
      'reductionId', v_reduction_id
    )
  );
end;
$$;
