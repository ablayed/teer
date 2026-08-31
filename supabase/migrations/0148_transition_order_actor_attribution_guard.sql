-- ============================================================================
-- 0148 — Lot S2 : attribution non falsifiable sur transition_order
-- ============================================================================
-- Défaut établi par reproduction (S2-D, stack locale, appel PostgREST direct) :
-- `p_actor` était un paramètre reçu de l'appelant, jamais confronté à
-- auth.uid(). Session réelle de l'utilisateur A (JWT valide, `authenticated`),
-- p_actor = utilisateur B (non membre de la boutique de A) → l'appel réussit
-- et order_state_transition.actor_user_id porte B, jamais A. p_actor traverse
-- aussi jusqu'à chaque écriture dérivée qui en dépend dans cette même fonction
-- (purchase_lot_line_allocation.created_by, cash_settlement.created_by) —
-- toutes héritent donc de la même falsification.
--
-- Ce n'est PAS une élévation de privilège : `security invoker` s'applique déjà
-- RLS (orders_update borne un agent aux quatre statuts autorisés), et ACL
-- production mesurée confirme authenticated=EXECUTE/anon=aucun. C'est la
-- valeur probante du journal qui était en cause — order_state_transition est
-- la trace qui dit qui a livré, qui a annulé, qui a encaissé, sur un produit
-- où le marchand arbitre des écarts de cash entre livreurs.
--
-- C'est le même motif récurrent du projet que 0147 : un identifiant reçu du
-- client, jamais confronté au parent autoritaire (ici, la session elle-même),
-- transmis à une opération qui en dérive son contexte. Le garde-fou
-- équivalent existe déjà pour post_stock_movement depuis 0136
-- (`v_actor := auth.uid(); ... if p_created_by <> v_actor then raise
-- exception 'forbidden'`) — transition_order appelait le cœur privé
-- directement et contournait cette garde. Ce lot porte le même contrôle,
-- au même endroit dans le flux (avant tout accès à la commande, puisqu'il ne
-- dépend d'aucune donnée métier), avec le même code d'exception ('forbidden',
-- errcode 42501) pour rester cohérent avec le seul autre garde-fou
-- d'attribution du projet.
--
-- Échec bruyant, jamais correction silencieuse : un p_actor qui diffère de
-- auth.uid() est refusé, jamais réécrit à la valeur réelle — un appelant qui
-- envoie un mauvais acteur a un défaut, le masquer le rendrait indétectable.
-- auth.uid() nul (hors session authentifiée) est également un refus : aucun
-- appelant système n'existe aujourd'hui pour cette RPC (inventaire S2-D :
-- lib/actions/transitions.ts:404-405 est l'unique appelant réel, client
-- cookie-based clé anon, toujours une session validée par
-- authActionClient/getUser() — p_actor = ctx.user.id = auth.uid() déjà,
-- cette garde ne change donc rien à son comportement).
--
-- Garde NULL-safe : `is distinct from`, jamais `<>`. `false or (p_actor <>
-- v_actor)` vaudrait NULL — pas TRUE — dès que p_actor est explicitement NULL,
-- et un `if NULL then` ne s'exécute pas : la garde aurait laissé passer un
-- p_actor NULL avec une session valide, effaçant l'auteur au lieu de
-- l'usurper. Même gotcha NULL-safety que documenté ailleurs dans le projet
-- pour les gardes de rôle SECURITY DEFINER (CLAUDE.md, section Postgres/
-- RLS/grants) — `is distinct from` couvre NULL des deux côtés sans jamais le
-- traiter comme une égalité indéterminée.
--
-- Défense en profondeur : toutes les écritures d'attribution de cette
-- fonction (order_state_transition.actor_user_id,
-- purchase_lot_line_allocation.created_by, cash_settlement.created_by, et
-- chaque p_created_by des appels à post_stock_movement) utilisent désormais
-- v_actor, jamais p_actor. Après la garde ci-dessus les deux valeurs sont
-- égales par construction — aucun changement de comportement — mais
-- l'attribution devient structurellement dérivée de la session plutôt que de
-- dépendre de la seule présence de la garde en amont. p_actor reste dans la
-- signature (aucun changement de signature) et n'est plus lu ailleurs que
-- dans cette comparaison initiale.
--
-- CREATE OR REPLACE à signature strictement identique (vingt arguments, mêmes
-- noms, mêmes types, même ordre, mêmes défauts) — l'ACL existante est
-- préservée automatiquement (revoke/grant non requis par la règle du projet,
-- qui ne s'applique qu'à un CREATE FUNCTION plein ou à un changement de
-- signature). security invoker / volatile / parallel unsafe / search_path=''
-- réaffirmés explicitement (CREATE OR REPLACE ne les préserve pas). Corps
-- repris VERBATIM de 0145, avec : une déclaration, un bloc de garde NULL-safe
-- en tête (avant tout accès à public.orders), et la substitution p_actor →
-- v_actor dans les seules écritures d'attribution listées ci-dessus — aucune
-- autre ligne modifiée.
-- ============================================================================

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
  -- 0145 — allocation FIFO (Lot F1). v_fifo_order_line parcourt les lignes de
  -- la commande à l'entrée dans l'état reconnu ; v_fifo_lot_line porte le
  -- premier purchase_lot_line du produit avec du reste disponible (FIFO par
  -- purchase_lot.received_at) ; v_fifo_reversal parcourt les allocations nettes
  -- existantes à la sortie de l'état reconnu.
  v_fifo_order_line           record;
  v_fifo_lot_line             record;
  v_fifo_reversal             record;
  -- 0148 — attribution non falsifiable (S2). Même variable/même contrôle que le
  -- garde-fou déjà en place sur post_stock_movement (auth.uid(), 0136) : p_actor
  -- ne peut plus jamais différer de l'appelant réel de la session, y compris
  -- pour un appel PostgREST direct forgé hors interface.
  v_actor                     uuid;
begin
  -- 0148 — S2 : `p_actor` était jusqu'ici un paramètre reçu de l'appelant,
  -- jamais confronté à la session réelle — falsifiable par tout appel PostgREST
  -- direct (JWT valide de A, p_actor = B), preuve locale S2-D. auth.uid() est
  -- nul hors session authentifiée (aucun appelant système n'existe aujourd'hui,
  -- cf. rapport S2-D) ; un p_actor qui diffère de l'appelant réel est refusé,
  -- jamais silencieusement corrigé. Contrôle avant tout accès à la commande :
  -- il ne dépend d'aucune donnée métier.
  v_actor := auth.uid();

  if v_actor is null or p_actor is distinct from v_actor then
    raise exception 'forbidden'
      using errcode = '42501';
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
      v_actor,
      p_note,
      now()
    )
    returning id into v_transition_id;

    v_movement_transition_id := v_transition_id;
  end if;

  -- 0145 — Lot F1 : allocation FIFO à l'entrée dans « livrée et encaissée ».
  -- MÊME garde que l'écriture de cash_collected_at ci-dessus (une seule fois
  -- par commande, jamais réécrite par une transition ultérieure) — v_order.*
  -- porte la valeur AVANT cet appel, exactement ce que lit ce garde-fou dans
  -- l'UPDATE au-dessus. Une commande dont order_line ne référence aucun
  -- produit résolu (match_status <> 'matched' ou product_id null) n'obtient
  -- simplement aucune ligne — le stock n'est jamais une précondition (règle
  -- #8 du projet), la rentabilité par arrivage non plus.
  if v_next_delivery_state = 'delivered'
     and v_next_cash_state = 'collected'
     and v_order.cash_collected_at is null
  then
    for v_fifo_order_line in
      select ol.id as order_line_id, ol.product_id, ol.qty
        from public.order_line ol
       where ol.order_id = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id is not null
    loop
      -- Premier purchase_lot_line du produit, du plus ancien réceptionné au
      -- plus récent, avec du reste disponible (qty reçue − déjà alloué). Le
      -- chevauchement de deux arrivages du même produit n'arrive pas (décision
      -- du fondateur) : au plus un lot a du reste à un instant donné — cette
      -- requête ne fait qu'exprimer ce fait, jamais un arbitrage entre lots.
      select pll.id as purchase_lot_line_id,
             pll.qty - coalesce(alloc.allocated, 0) as remaining
        into v_fifo_lot_line
        from public.purchase_lot_line pll
        join public.purchase_lot pl on pl.id = pll.purchase_lot_id
        left join (
          select purchase_lot_line_id, sum(qty) as allocated
            from public.purchase_lot_line_allocation
           group by purchase_lot_line_id
        ) alloc on alloc.purchase_lot_line_id = pll.id
       where pll.product_id = v_fifo_order_line.product_id
         and pl.merchant_account_id = v_order.merchant_account_id
         and pl.status = 'received'
         and (pll.qty - coalesce(alloc.allocated, 0)) > 0
       order by pl.received_at asc nulls last, pl.created_at asc
       limit 1;

      if found then
        insert into public.purchase_lot_line_allocation (
          merchant_account_id,
          shop_id,
          order_id,
          order_line_id,
          purchase_lot_line_id,
          qty,
          reason,
          recognized_transition_id,
          created_by
        )
        values (
          v_order.merchant_account_id,
          v_order.shop_id,
          p_order_id,
          v_fifo_order_line.order_line_id,
          v_fifo_lot_line.purchase_lot_line_id,
          least(v_fifo_order_line.qty, v_fifo_lot_line.remaining),
          'sale',
          v_transition_id,
          v_actor
        );
      end if;
    end loop;
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
        v_actor,
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

  -- 0145 — Lot F1 : réversion FIFO à la sortie de « livrée et encaissée ».
  -- Retour réel (v_transition_id réel, pose une ligne order_state_transition
  -- normale) OU invalidation (v_movement_transition_id = NULL, même régime que
  -- le ledger de stock sur ce chemin, cf. en-tête 0116). Par NÉGATION EXACTE
  -- des allocations nettes existantes du ledger — jamais recalculée depuis
  -- order_line — même principe que la contre-passation de stock ci-dessous.
  if (
       v_order.order_state = 'completed'
       and v_order.delivery_state = 'delivered'
       and v_next_order_state = 'returned'
       and v_next_delivery_state = 'returned'
     )
     or p_invalidate_delivered
  then
    for v_fifo_reversal in
      select a.order_line_id, a.purchase_lot_line_id, sum(a.qty)::integer as net_qty
        from public.purchase_lot_line_allocation a
        join public.order_line ol on ol.id = a.order_line_id
       where ol.order_id = p_order_id
         and a.merchant_account_id = v_order.merchant_account_id
       group by a.order_line_id, a.purchase_lot_line_id
      having sum(a.qty) <> 0
    loop
      insert into public.purchase_lot_line_allocation (
        merchant_account_id,
        shop_id,
        order_id,
        order_line_id,
        purchase_lot_line_id,
        qty,
        reason,
        recognized_transition_id,
        created_by
      )
      values (
        v_order.merchant_account_id,
        v_order.shop_id,
        p_order_id,
        v_fifo_reversal.order_line_id,
        v_fifo_reversal.purchase_lot_line_id,
        -v_fifo_reversal.net_qty,
        case when p_invalidate_delivered then 'invalidation' else 'return' end,
        v_movement_transition_id,
        v_actor
      );
    end loop;
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
            p_created_by          := v_actor,
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
            p_created_by          := v_actor,
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
          p_created_by          := v_actor,
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
        p_created_by          := v_actor,
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
        p_created_by          := v_actor,
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
        p_created_by          := v_actor,
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
          p_created_by          := v_actor,
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
        p_created_by          := v_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_movement_transition_id,
        p_driver_id           := v_line.driver_id
      );
    end loop;
  end if;

  return v_next_status;
end;
$function$;
