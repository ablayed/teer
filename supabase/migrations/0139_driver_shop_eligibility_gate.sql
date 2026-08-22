-- 0139 — Gap 4 : ferme le contournement de garde métier « éligibilité livreur ».
--
-- CONTEXTE
-- `transition_order` et `reassign_order_driver` ne vérifiaient l'éligibilité d'un
-- livreur QUE par `merchant_account_id` (le tenant), jamais par `driver_shop` (la
-- boutique). La seule protection existante était incidentelle : le cœur
-- `private.post_stock_movement` (0136) refuse un `p_driver_id` absent de
-- `driver_shop` pour la boutique du produit — mais ce contrôle ne s'exécute que
-- si un mouvement de stock portant ce driver_id est réellement posté, ce qui
-- n'arrive ni pour une commande sans ligne `matched`, ni pour une réassignation
-- hors `assigned`/`out_for_delivery` (le bloc de mouvement de
-- `reassign_order_driver` est alors entièrement sauté). Dans ces deux cas,
-- `orders.assigned_driver_id` est écrit sans AUCUN contrôle de boutique.
--
-- Preuve empirique déjà présente en base de tests avant ce lot, non affirmée
-- comme garde manquante à l'époque :
-- `tests/rls/workspace-store-function-derivation.rls.test.ts:399-435` crée deux
-- livreurs SANS AUCUNE ligne `driver_shop`, force `delivery_state='scheduled'`
-- par écriture directe (donc hors du bloc de mouvement), et réassigne — le test
-- attendait un SUCCÈS. Ce n'est pas une fuite de données (les deux fonctions
-- restent SECURITY INVOKER, RLS s'applique toujours à l'écriture finale de
-- `orders`) : c'est une règle métier de la Phase 1 (0133) non appliquée là où
-- elle compte.
--
-- CE QUI EST DÉCIDÉ (porteur, Stage 0)
-- 1. Un livreur sans AUCUNE ligne `driver_shop` est inéligible PARTOUT — cohérent
--    avec `is_driver_in_shop` (0133), qui renvoie déjà `false` dans ce cas.
-- 2. Le seul chemin de création d'un livreur en production,
--    `createDriverAction` (`lib/actions/team.ts:723-788`), insère toujours une
--    ligne `driver_shop` immédiatement après le livreur (repli boutique par
--    défaut hors contexte de boutique) — vérifié par grep exhaustif de tout
--    insert dans `public.driver`, aucun autre site TS ni fonction SQL n'en crée.
--    La garde ci-dessous ne peut donc casser aucun chemin de création réel.
-- 3. `reassign_order_driver` a toujours été exécutable en HTTP direct par `anon`
--    (aucun `revoke` n'a jamais été écrit pour cette fonction, seuls des `grant
--    execute … to authenticated` en 0058/0091) — dette de la même classe que
--    celle fermée pour `transition_order` par 0067/0115. Fermée dans CE lot
--    puisqu'il modifie déjà cette fonction (une ligne, sur une fonction déjà
--    touchée).
--
-- PORTE DE CONTRÔLE PRODUCTION (exécutée par le porteur avant cette migration)
-- Comptage production : mismatched_other_shop = 0, orphan_no_shop = 0. Migration
-- autorisée, aucune remédiation de données nécessaire. Le bloc de précondition
-- ci-dessous rejoue la même détection en tête de cette migration (sur la base
-- LOCALE au moment du `db push`/`migration up`), pour échouer bruyamment plutôt
-- que d'appliquer une garde qui casserait silencieusement une commande déjà
-- incohérente.
--
-- OÙ LA GARDE EST PLACÉE
-- Dans les deux fonctions, immédiatement après que `v_order` est chargée et que
-- `v_order.shop_id` est validé par le contrôle `order_store_conflict` déjà
-- existant (donc AVANT toute mutation liée au livreur) : `order.shop_id` sert de
-- référence autoritative, jamais une valeur d'entrée. La garde ne se déclenche
-- QUE quand un NOUVEAU livreur est effectivement en train d'être écrit :
--   • `transition_order` : uniquement si `p_assigned_driver_id is not null`
--     (c'est exactement le cas de l'action `assigner`, déjà gardée côté TS —
--     cette garde SQL est le filet incontournable, y compris par appel RPC
--     direct). Aucune autre action ne passe `p_assigned_driver_id` : `reprogrammer`
--     /`deconfirmer`/`desannuler`/`invalider` RETIRENT le livreur
--     (`p_clear_assigned_driver`), ce qui ne requiert aucune éligibilité.
--   • `reassign_order_driver` : sur `p_new_driver`, avant l'`UPDATE`, après le
--     court-circuit d'idempotence (même driver = no-op, comme avant ce lot) —
--     donc y compris pour une commande `scheduled`/`unassigned`, le trou réel
--     identifié en Stage 0.
--
-- CE QUI NE CHANGE PAS
-- Aucune transition sans rapport avec un livreur n'est affectée : la garde est
-- conditionnée à l'écriture effective d'un nouveau `driver_id`, jamais posée en
-- tête de fonction. Un livreur déjà correctement rattaché à la boutique de la
-- commande voit un comportement strictement identique à avant ce lot — la garde
-- ne fait que refuser un cas qui, avant ce lot, n'était protégé qu'accidentellement.
-- Corps des deux fonctions repris VERBATIM par ailleurs (diff limité aux lignes
-- de garde ajoutées). `CREATE OR REPLACE` ne conserve ni `SECURITY`, ni
-- volatilité, ni parallélisme, ni `search_path` : les trois sont réaffirmés
-- explicitement ci-dessous, identiques aux valeurs vivantes mesurées avant ce
-- lot (`prosecdef=false` → INVOKER, `provolatile='v'` → VOLATILE,
-- `proparallel='u'` → PARALLEL UNSAFE, `proconfig={search_path=""}`).

-- ────────────────────────────────────────────────────────────
-- 0. Précondition — même détection que la requête d'audit Stage 0. Échoue
--    bruyamment plutôt que de poser une garde qui casserait silencieusement une
--    commande déjà incohérente sur CETTE base (locale au moment du push).
-- ────────────────────────────────────────────────────────────

do $$
declare
  v_bad_count bigint;
begin
  select count(*)
    into v_bad_count
    from public.orders o
   where o.assigned_driver_id is not null
     and not exists (
       select 1
         from public.driver_shop ds
        where ds.merchant_account_id = o.merchant_account_id
          and ds.driver_id = o.assigned_driver_id
          and ds.shop_id = o.shop_id
     );

  if v_bad_count > 0 then
    raise exception 'gap4_driver_shop_precondition_failed orders=%', v_bad_count;
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 1. reassign_order_driver — anon n'a jamais dû exécuter cette fonction (dette
--    pré-existante, fermée ici puisque cette fonction est déjà modifiée par ce
--    lot). `authenticated`/`service_role`/`postgres` (propriétaire) inchangés.
-- ────────────────────────────────────────────────────────────

revoke execute on function public.reassign_order_driver(uuid, uuid, uuid, text) from anon;

-- ────────────────────────────────────────────────────────────
-- 2. reassign_order_driver — garde d'éligibilité sur p_new_driver, boutique de
--    la commande. Corps verbatim (0136), une garde ajoutée avant l'UPDATE.
-- ────────────────────────────────────────────────────────────

create or replace function public.reassign_order_driver(p_order_id uuid, p_actor uuid, p_new_driver uuid, p_note text default null::text)
 returns void
 language plpgsql
 security invoker
 volatile
 parallel unsafe
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

  -- 0139 — Gap 4 : le nouveau livreur doit servir la boutique de LA COMMANDE
  -- (référence autoritative, jamais une valeur d'entrée), avant toute mutation.
  -- Couvre en particulier le cas qui échappait à toute protection : une
  -- commande hors assigned/out_for_delivery (ex. scheduled), où le bloc de
  -- mouvement de stock ci-dessous est entièrement sauté et n'aurait jamais posé
  -- de contrôle, même incidentel.
  if not public.is_driver_in_shop(v_order.merchant_account_id, p_new_driver, v_order.shop_id) then
    raise exception 'driver_not_in_store'
      using errcode = 'P0002';
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
-- 3. transition_order — garde d'éligibilité sur p_assigned_driver_id, boutique
--    de la commande. Corps verbatim (0136/0116), une garde ajoutée après la
--    validation order_store_conflict, avant toute autre logique.
-- ────────────────────────────────────────────────────────────

create or replace function public.transition_order(p_order_id uuid, p_actor uuid, p_note text default null::text, p_payment_channel text default 'ESPECES'::text, p_order_state text default null::text, p_call_state text default null::text, p_delivery_state text default null::text, p_cash_state text default null::text, p_attempt_count integer default null::integer, p_next_contact_at timestamp with time zone default null::timestamp with time zone, p_scheduled_for timestamp with time zone default null::timestamp with time zone, p_cancel_reason text default null::text, p_assigned_driver_id uuid default null::uuid, p_cancel_reasons text[] default null::text[], p_clear_scheduled_for boolean default false, p_clear_cancel_reasons boolean default false, p_clear_assigned_driver boolean default false, p_call_confirmed_at timestamp with time zone default null::timestamp with time zone, p_delivered_at timestamp with time zone default null::timestamp with time zone, p_invalidate_delivered boolean default false)
 returns text
 language plpgsql
 security invoker
 volatile
 parallel unsafe
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

  -- 0139 — Gap 4 : un nouveau livreur (p_assigned_driver_id non nul — seule
  -- l'action « assigner » le passe) doit servir la boutique DE LA COMMANDE
  -- (v_order.shop_id, référence autoritative, jamais une valeur d'entrée),
  -- avant toute mutation. Filet incontournable, y compris par appel RPC direct
  -- contournant la garde TS de lib/actions/transitions.ts. Ne se déclenche
  -- jamais pour un retrait de livreur (p_clear_assigned_driver) ni pour une
  -- transition qui ne touche pas au livreur.
  if p_assigned_driver_id is not null
     and not public.is_driver_in_shop(v_order.merchant_account_id, p_assigned_driver_id, v_order.shop_id)
  then
    raise exception 'driver_not_in_store'
      using errcode = 'P0002';
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
