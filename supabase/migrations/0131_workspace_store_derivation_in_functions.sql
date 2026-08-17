-- 0131 — Attribution de boutique dérivée du PARENT AUTORITAIRE dans les 3 fonctions
-- qui écrivaient jusqu'ici sans `shop_id`.
--
-- CONTEXTE
-- Depuis 0126/0127, douze tables portent `shop_id NOT NULL` + un trigger BEFORE INSERT
-- `assign_default_store_context` qui, lorsque la colonne est omise, la renseigne avec la
-- boutique PAR DÉFAUT du marchand. Trois fonctions vivantes omettaient `shop_id` sur
-- quatre sites d'insertion et dépendaient donc de ce repli :
--
--   post_stock_movement   → stock_movement           (boutique autoritaire = le PRODUIT)
--   post_stock_movement   → product_stock            (boutique autoritaire = le PRODUIT)
--   transition_order      → order_state_transition   (boutique autoritaire = la COMMANDE)
--   reassign_order_driver → order_state_transition   (boutique autoritaire = la COMMANDE)
--
-- Pour un tenant multi-boutiques, une écriture émise depuis une boutique non-défaut
-- atterrissait donc dans la boutique par défaut — sans erreur, sans contrainte violée,
-- simplement invisible là où l'utilisateur travaillait. Les trois fonctions sont
-- ATTEIGNABLES depuis le code de production (lib/actions/stock.ts, lib/actions/drivers.ts,
-- lib/actions/transitions.ts, lib/actions/orders.ts) : ce n'est pas de la dette théorique.
--
-- CE QUE FAIT CETTE MIGRATION
-- 1. `post_stock_movement` lit désormais `p.shop_id` dans le SELECT du produit qu'elle
--    faisait DÉJÀ (aucune requête supplémentaire) et le passe explicitement aux deux
--    insertions.
-- 2. `transition_order` et `reassign_order_driver` passent `v_order.shop_id`, issu du
--    `select ... for update` de la commande qu'elles faisaient DÉJÀ.
-- 3. Chacune refuse explicitement (`stock_movement_store_conflict` / `order_store_conflict`)
--    une boutique parente qui n'appartient pas au marchand de l'appel. Jamais de
--    substitution silencieuse par une autre boutique.
--
-- Le trigger `assign_default_store_context` reste en place : il ne se déclenche que si
-- `shop_id` est NULL, donc une valeur explicite gagne toujours. Il continue de couvrir les
-- éventuels autres appelants.
--
-- COMPATIBILITÉ
-- `CREATE OR REPLACE` à signature STRICTEMENT identique pour les trois fonctions : les
-- privilèges (`proacl`), le `SECURITY DEFINER` de `post_stock_movement`, le durcissement
-- `SET search_path TO ''` et les frontières RLS sont préservés tels quels. AUCUN `drop`,
-- donc aucun reset de grants (leçon 0067). Le corps est repris VERBATIM depuis la
-- définition vivante en production ; le diff programmatique se limite aux lignes ci-dessus.
--
-- DONNÉES HISTORIQUES — aucune réparation ici, volontairement.
-- Mesuré en lecture seule sur la production, TOUS tenants confondus, avant cette migration :
--   stock_movement          vs product : 1563 lignes, 0 divergence
--   product_stock           vs product :   22 lignes, 0 divergence
--   order_state_transition  vs commande: 1692 lignes, 0 divergence
-- Les backfills 0126/0127 avaient sourcé `shop_id` depuis l'enregistrement porteur : la
-- dérivation autoritaire introduite ici est donc déjà vraie pour 100 % des lignes
-- existantes. Cette migration est une correction de l'ÉCRITURE FUTURE, pas un rattrapage.

CREATE OR REPLACE FUNCTION public.post_stock_movement(p_merchant_account_id uuid, p_product_id uuid, p_movement_type text, p_qty integer, p_idempotency_key text, p_created_by uuid, p_order_id uuid DEFAULT NULL::uuid, p_transition_id uuid DEFAULT NULL::uuid, p_unit_cost bigint DEFAULT NULL::bigint, p_received_value bigint DEFAULT NULL::bigint, p_reason text DEFAULT NULL::text, p_driver_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_movement_id    uuid;
  v_stock          public.product_stock%rowtype;
  v_new_on_hand    integer;
  v_new_reserved   integer;
  v_new_unit_cost  bigint;
  v_cump_numerator numeric;
  v_is_bundle      boolean;
  -- 0131 — boutique autoritaire du mouvement, dérivée du PRODUIT.
  v_shop_id        uuid;
  v_component      record;
begin
  if public.current_member_role(p_merchant_account_id) is null then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if p_movement_type = 'manual_adjustment'
     and coalesce(nullif(btrim(coalesce(p_reason, '')), ''), null) is null
  then
    raise exception 'manual_adjustment requires a non-empty reason'
      using errcode = 'P0001';
  end if;

  if p_movement_type in (
       'allocate_to_courier',
       'courier_return_lot',
       'advance_commit',
       'order_assignment_commit',
       'order_assignment_release',
       'driver_stock_set'
     )
     and p_driver_id is null
  then
    raise exception 'driver movement requires a driver'
      using errcode = 'P0001';
  end if;

  if p_movement_type in ('reassign_from_driver', 'reassign_to_driver')
     and p_driver_id is null
  then
    raise exception 'reassign movement requires a driver'
      using errcode = 'P0001';
  end if;

  select p.is_bundle, p.shop_id
    into v_is_bundle, v_shop_id
    from public.product p
   where p.id = p_product_id
     and p.merchant_account_id = p_merchant_account_id;

  if not found then
    raise exception 'product not found for this merchant account'
      using errcode = 'P0002';
  end if;

  -- 0131 — garde de cohérence tenant/boutique : la boutique dérivée du parent doit
  -- appartenir au marchand de l'appel. On refuse explicitement plutôt que de retomber
  -- sur une autre boutique (le trigger assign_default_store_context ne doit plus jamais
  -- décider de l'attribution sur ce chemin).
  -- HONNÊTETÉ : cette garde est une défense en profondeur STRUCTURELLEMENT INATTEIGNABLE
  -- en l'état du schéma — `shop_id` est NOT NULL et la FK composite
  -- `(merchant_account_id, shop_id) → shop (merchant_account_id, id)` (0126/0127) interdit
  -- déjà de pointer vers la boutique d'un autre tenant, tandis que
  -- `prevent_store_context_change` interdit d'en changer après insertion. Elle est
  -- conservée parce qu'elle rend le refus EXPLICITE au niveau de la fonction si l'une de
  -- ces contraintes venait à être relâchée.
  if v_shop_id is null or not exists (
    select 1
      from public.shop s
     where s.id = v_shop_id
       and s.merchant_account_id = p_merchant_account_id
  ) then
    raise exception 'stock_movement_store_conflict'
      using errcode = 'P0001';
  end if;

  -- Garde explicite (Phase B décision #4) : un bundle n'existe jamais physiquement en main
  -- d'un livreur ni comme lot entrepôt distinct — rejet au niveau fonction, pas seulement UI.
  if v_is_bundle
     and p_movement_type in ('allocate_to_courier', 'courier_return_lot', 'driver_stock_set')
  then
    raise exception 'bundle product % cannot be the target of movement_type %'
      , p_product_id, p_movement_type
      using errcode = 'P0001';
  end if;

  if p_driver_id is not null and not exists (
    select 1 from public.driver
    where id = p_driver_id
      and merchant_account_id = p_merchant_account_id
  ) then
    raise exception 'driver not found for this merchant account'
      using errcode = 'P0002';
  end if;

  -- Cascade bundle → composants (Phase B décision #3). Aucun stock_movement n'est jamais
  -- inséré sur p_product_id (le bundle) dans ce cas : on reboucle sur post_stock_movement
  -- lui-même, une fois par composant, avec une idempotency_key dérivée (append composant)
  -- pour éviter toute collision on-conflict entre composants d'un même order_line/mouvement.
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
      perform public.post_stock_movement(
        p_merchant_account_id := p_merchant_account_id,
        p_product_id          := v_component.component_product_id,
        p_movement_type       := p_movement_type,
        p_qty                 := p_qty * v_component.quantity,
        p_idempotency_key     := p_idempotency_key
                                 || ':component:' || v_component.component_product_id::text,
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
    merchant_account_id,
    shop_id,
    product_id,
    movement_type,
    qty,
    unit_cost,
    reason,
    order_id,
    transition_id,
    idempotency_key,
    created_by,
    driver_id
  )
  values (
    p_merchant_account_id,
    v_shop_id,
    p_product_id,
    p_movement_type,
    p_qty,
    p_unit_cost,
    p_reason,
    p_order_id,
    p_transition_id,
    p_idempotency_key,
    p_created_by,
    p_driver_id
  )
  on conflict (idempotency_key) do nothing
  returning id into v_movement_id;

  if v_movement_id is null then
    return null;
  end if;

  -- Ledger-only movement types: no product_stock mutation.
  if p_movement_type in (
       'order_assignment_commit',
       'order_assignment_release',
       'allocate_to_courier',
       'courier_return_lot',
       'driver_stock_set'
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
      v_new_on_hand  := greatest(0, v_stock.qty_on_hand  + p_qty);
      v_new_reserved := greatest(0, v_stock.qty_reserved + p_qty);
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'advance_commit' then
      v_new_reserved := greatest(0, v_stock.qty_reserved - greatest(p_qty, 0));

    when 'sold' then
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'purchase_in' then
      if (p_received_value is not null or p_unit_cost is not null)
         and (v_stock.qty_on_hand + p_qty) > 0
      then
        v_cump_numerator :=
          v_stock.qty_on_hand::numeric * v_stock.unit_cost::numeric
          + coalesce(
              p_received_value::numeric,
              p_qty::numeric * p_unit_cost::numeric
            );
        v_new_unit_cost :=
          (v_cump_numerator / (v_stock.qty_on_hand + p_qty))::bigint;
      end if;
      v_new_on_hand := v_stock.qty_on_hand + p_qty;

    when 'courier_return' then
      v_new_on_hand := v_stock.qty_on_hand + p_qty;

    when 'reassign_from_driver' then
      v_new_on_hand := v_stock.qty_on_hand + p_qty;

    when 'reassign_to_driver' then
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'manual_adjustment' then
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);

    else
      raise exception 'unknown stock movement_type: %', p_movement_type
        using errcode = 'P0001';
  end case;

  update public.product_stock
     set qty_on_hand  = v_new_on_hand,
         qty_reserved = v_new_reserved,
         unit_cost    = v_new_unit_cost,
         updated_at   = now()
   where product_id = p_product_id;

  return v_movement_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reassign_order_driver(p_order_id uuid, p_actor uuid, p_new_driver uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

  -- 0131 — garde de cohérence tenant/boutique : la boutique dérivée du parent doit
  -- appartenir au marchand de l'appel. On refuse explicitement plutôt que de retomber
  -- sur une autre boutique (le trigger assign_default_store_context ne doit plus jamais
  -- décider de l'attribution sur ce chemin).
  -- HONNÊTETÉ : cette garde est une défense en profondeur STRUCTURELLEMENT INATTEIGNABLE
  -- en l'état du schéma — `shop_id` est NOT NULL et la FK composite
  -- `(merchant_account_id, shop_id) → shop (merchant_account_id, id)` (0126/0127) interdit
  -- déjà de pointer vers la boutique d'un autre tenant, tandis que
  -- `prevent_store_context_change` interdit d'en changer après insertion. Elle est
  -- conservée parce qu'elle rend le refus EXPLICITE au niveau de la fonction si l'une de
  -- ces contraintes venait à être relâchée.
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
      perform public.post_stock_movement(
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

      perform public.post_stock_movement(
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
      perform public.post_stock_movement(
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
      perform public.post_stock_movement(
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

CREATE OR REPLACE FUNCTION public.transition_order(p_order_id uuid, p_actor uuid, p_note text DEFAULT NULL::text, p_payment_channel text DEFAULT 'ESPECES'::text, p_order_state text DEFAULT NULL::text, p_call_state text DEFAULT NULL::text, p_delivery_state text DEFAULT NULL::text, p_cash_state text DEFAULT NULL::text, p_attempt_count integer DEFAULT NULL::integer, p_next_contact_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_scheduled_for timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cancel_reason text DEFAULT NULL::text, p_assigned_driver_id uuid DEFAULT NULL::uuid, p_cancel_reasons text[] DEFAULT NULL::text[], p_clear_scheduled_for boolean DEFAULT false, p_clear_cancel_reasons boolean DEFAULT false, p_clear_assigned_driver boolean DEFAULT false, p_call_confirmed_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_delivered_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_invalidate_delivered boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

  -- 0131 — garde de cohérence tenant/boutique : la boutique dérivée du parent doit
  -- appartenir au marchand de l'appel. On refuse explicitement plutôt que de retomber
  -- sur une autre boutique (le trigger assign_default_store_context ne doit plus jamais
  -- décider de l'attribution sur ce chemin).
  -- HONNÊTETÉ : cette garde est une défense en profondeur STRUCTURELLEMENT INATTEIGNABLE
  -- en l'état du schéma — `shop_id` est NOT NULL et la FK composite
  -- `(merchant_account_id, shop_id) → shop (merchant_account_id, id)` (0126/0127) interdit
  -- déjà de pointer vers la boutique d'un autre tenant, tandis que
  -- `prevent_store_context_change` interdit d'en changer après insertion. Elle est
  -- conservée parce qu'elle rend le refus EXPLICITE au niveau de la fonction si l'une de
  -- ces contraintes venait à être relâchée.
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

  -- 0116 — gardes de l'invalidation. Vérifiées ICI, dans l'unique porte d'écriture de
  -- l'état d'une commande : elles tiennent même face à un appel RPC direct, pas seulement
  -- depuis le menu. Les deux sont placées AVANT l'UPDATE : une invalidation refusée ne
  -- laisse aucune écriture partielle derrière elle.
  if p_invalidate_delivered then
    if v_order.order_state <> 'completed' or v_order.delivery_state <> 'delivered' then
      raise exception 'illegal_invalidation'
        using errcode = '22023';
    end if;

    -- Cash déjà remis (ou en écart) : des lignes cash_settlement/settlement_allocation
    -- existent, l'argent a physiquement changé de mains. L'invalidation n'a aucun
    -- mécanisme de contre-passation de cash (contrairement à « Marquer retournée ») et
    -- ne laisse aucune trace d'audit : on refuse plutôt que de désynchroniser en silence.
    if v_order.cash_state in ('remitted', 'discrepancy') then
      raise exception 'invalid_invalidate_cash_settled'
        using errcode = '22023';
    end if;
  end if;

  -- 0114 — bornes de cohérence des deux dates éditables. Vérifiées ICI, dans l'unique
  -- porte d'écriture de l'état d'une commande : une saisie hors bornes est rejetée même
  -- si elle arrive par un appel RPC direct, pas seulement depuis le formulaire.
  if p_call_confirmed_at is not null or p_delivered_at is not null then
    -- Borne basse = origine réelle de la commande. Pour une commande Shopify importée
    -- après coup, `created_at` est la date d'IMPORT et peut être postérieure à la
    -- commande réelle (`created_at_shopify`) : borner sur `created_at` seul rejetterait
    -- des corrections légitimes. On prend donc la plus ancienne des deux, ce qui reste
    -- strictement « jamais avant la création de la commande ».
    v_order_origin_at := least(
      v_order.created_at,
      coalesce(v_order.created_at_shopify, v_order.created_at)
    );

    -- Tolérance de 5 minutes : l'horodatage vient d'un navigateur dont l'horloge peut
    -- devancer celle du serveur. Sans elle, une saisie « maintenant » serait rejetée.
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

    -- Confirmation ≤ livraison, quel que soit le sens de la saisie : corriger la
    -- confirmation d'une commande déjà livrée, ou corriger la livraison d'une commande
    -- déjà confirmée, sont tous les deux couverts par ce même test.
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
         -- 0116 : à l'invalidation, le canal de paiement et le montant encaissable de la
         -- livraison sont effacés — ils sont lus en repli par get_driver_cash_consolidation
         -- (0100) et survivraient sinon en montant fantôme sur une commande « jamais livrée ».
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
         -- 0114 — date de confirmation client. Condition DIMENSIONNELLE (call_state
         -- devient 'validated'), pas une liste d'actions : couvre donc `confirmer` ET
         -- `programmer`, qui pose validated+scheduled en un seul geste et qui est le
         -- seul des deux réellement visible dans le menu. Même garde d'idempotence que
         -- cash_collected_at : une commande déjà confirmée ne voit jamais sa date
         -- réécrite par une transition ultérieure.
         call_confirmed_at = case
           -- 0116 : l'invalidation remet la commande « jamais confirmée, jamais livrée ».
           -- Cette remise à NULL est ce qui fait sortir la commande des fenêtres de tous
           -- les rapports, qui recalculent alors sans elle sans aucune correction manuelle.
           when p_invalidate_delivered then null
           when coalesce(p_call_state, v_order.call_state) = 'validated'
                and v_order.call_state <> 'validated'
                and call_confirmed_at is null
             then coalesce(p_call_confirmed_at, now())
           else call_confirmed_at
         end,
         -- 0114 — `p_delivered_at` (saisie explicite au moment de livrer) s'insère EN
         -- TÊTE du coalesce posé par 0096 : saisie utilisateur > scheduled_for > now().
         -- Le mécanisme PR #81 reste intact quand aucune saisie n'est faite.
         cash_collected_at = case
           -- 0116 : idem — c'est la colonne que lisent le CA encaissé du Tableau, les
           -- Livraisons par produit et tout le P&L Finances.
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

  -- 0116 — SEULE branche de la fonction qui ne pose PAS sa ligne d'historique (point 7 de
  -- l'en-tête). L'UUID généré ici n'est jamais inséré : il ne sert qu'à rendre les clés
  -- d'idempotence de CET appel uniques. `v_movement_transition_id` reste NULL pour ne pas
  -- violer la FK stock_movement.transition_id → order_state_transition(id).
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
          perform public.post_stock_movement(
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
          perform public.post_stock_movement(
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
        perform public.post_stock_movement(
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

  -- Availability commit is grouped by product because order_line does not have
  -- a unique (order_id, product_id) constraint.
  if v_movement_type = 'dispatch' then
    for v_assignment_line in
      select ol.product_id, sum(ol.qty)::integer as qty
        from public.order_line ol
       where ol.order_id = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id is not null
       group by ol.product_id
    loop
      perform public.post_stock_movement(
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

  -- Availability releases are targeted from the ledger, not from orders.assigned_driver_id.
  -- The release quantity is capped to min(required_qty, net_open) per product+driver.
  -- 0109 : `required` résout bundle→composants (0107/0108) — la même granularité que le
  -- ledger, qui contient désormais des mouvements par COMPOSANT pour un bundle, jamais par
  -- bundle lui-même. Sans ce fix, `required` (product_id = bundle) ne matchait jamais
  -- `open_commitments` (product_id = composant) pour une order_line bundle.
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
     -- 0116 : l'invalidation libère elle aussi l'engagement de disponibilité du livreur.
     -- Elle réutilise ce bloc TEL QUEL plutôt que d'en dupliquer un : le ciblage part du
     -- ledger (jamais d'orders.assigned_driver_id) et plafonne à least(required, net_open),
     -- il est donc structurellement incapable de sur-libérer.
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
      perform public.post_stock_movement(
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

  -- 0116 — contre-passation de stock de l'invalidation, par NÉGATION EXACTE dérivée du
  -- LEDGER (jamais d'order_line). Rejouer order_line serait faux dans deux cas réels :
  -- un dispatch partiellement couvert par du stock d'avance (advance_commit) rendrait trop
  -- de stock au central, et une commande réassignée verrait la contre-passation atterrir
  -- sur le mauvais livreur. Le ledger, lui, dit exactement ce qui a été posé et pour qui.
  --
  -- Les lignes de ledger d'un bundle sont DÉJÀ à la granularité composant (cascade de
  -- post_stock_movement, 0108) : les rejouer ne re-cascade pas (un composant ne peut pas
  -- être lui-même un bundle, contrainte 0107) — la cascade bundle est donc gérée sans
  -- aucun code dédié ici.
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
      perform public.post_stock_movement(
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

      -- `dispatch` mute qty_on_hand ET qty_reserved (post_stock_movement). Contre-passer
      -- le dispatch rend bien le stock au central, mais RÉ-ARME aussi la réserve — alors
      -- que le `reserve` d'origine avait déjà été entièrement consommé par ce dispatch.
      -- Ce `release` apparié annule ce seul effet de bord ; c'est aussi pourquoi le
      -- `reserve` d'origine n'est volontairement pas contre-passé.
      if v_invalidation_reversal.movement_type = 'dispatch' then
        perform public.post_stock_movement(
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
      perform public.post_stock_movement(
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
