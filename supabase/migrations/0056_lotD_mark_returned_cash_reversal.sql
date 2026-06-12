-- ============================================
-- 0056 : Lot D - mark_returned (retour apres livraison)
--        + reprise cash append-only signee
-- ============================================
-- Objectif :
--   * Ajouter le chemin moteur `mark_returned` via transition_order :
--       completed/delivered -> returned/returned.
--   * Poster le mouvement stock `courier_return` dans la meme transaction.
--   * Reprendre le cash deja remis par une ecriture append-only signee :
--       cash_settlement.amount_received_minor = -sum(settlement_allocation)
--       settlement_allocation.allocated_minor = meme montant negatif.
--
-- Decisions validees :
--   * settlement_allocation.allocated_minor devient signe mais jamais zero
--     (CHECK <> 0).
--   * cash_settlement.amount_received_minor devient signe et conserve zero :
--       - transition_order ecrit les montants negatifs de reprise retour ;
--       - write_off_shortfall conserve ses lignes a 0 ;
--       - record_cash_settlement continue de rejeter tout montant negatif en entree.
--   * La reprise est calculee au moment du retour sur le net courant :
--       -coalesce(sum(allocated_minor), 0) pour la commande.
--     Un double mark_returned ne peut pas creer une seconde reprise :
--       la precondition SQL exige l'etat AVANT completed/delivered, et la ligne
--       cash_settlement porte client_request_id = transition_id.
--
-- Mutuelle exclusion mouvements :
--   * sold exige next_delivery_state = 'delivered'.
--   * courier_return exige old completed/delivered ET next returned/returned.
--   * release exige old delivery in ('unassigned','scheduled').
--   => aucune collision possible dans le CASE.

alter table public.cash_settlement
  drop constraint if exists cash_settlement_amount_received_minor_check;

comment on column public.cash_settlement.amount_received_minor is
  'Montant signe. Positif via record_cash_settlement, negatif uniquement via transition_order pour reprise retour, zero conserve pour write_off_shortfall.';

alter table public.settlement_allocation
  drop constraint if exists settlement_allocation_allocated_minor_check;

alter table public.settlement_allocation
  add constraint settlement_allocation_allocated_minor_nonzero_check
  check (allocated_minor <> 0);

create or replace function public.transition_order(
  p_order_id              uuid,
  p_actor                 uuid,
  p_note                  text         default null,
  p_payment_channel       text         default 'ESPECES',
  p_order_state           text         default null,
  p_call_state            text         default null,
  p_delivery_state        text         default null,
  p_cash_state            text         default null,
  p_attempt_count         integer      default null,
  p_next_contact_at       timestamptz  default null,
  p_scheduled_for         timestamptz  default null,
  p_cancel_reason         text         default null,
  p_assigned_driver_id    uuid         default null,
  p_cancel_reasons        text[]       default null,
  p_clear_scheduled_for   boolean      default false,
  p_clear_cancel_reasons  boolean      default false
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order                     public.orders%rowtype;
  v_next_cash_state           text;
  v_next_delivery_state       text;
  v_next_order_state          text;
  v_next_status               text;
  v_payment_channel           text;
  v_transition_id             uuid;
  v_movement_type             text;
  v_effective_driver_id       uuid;
  v_cash_reversal_minor       bigint := 0;
  v_cash_reversal_method      text;
  v_cash_reversal_settlement  uuid;
  v_line                      record;
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

  -- Lot D : mark_returned est une transition terminale explicite.
  -- Elle part uniquement d'une commande livree (completed/delivered), et doit
  -- poser les deux dimensions returned ensemble. Aucun retour partiel.
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

  update public.orders
     set order_state    = coalesce(p_order_state,        order_state),
         call_state     = coalesce(p_call_state,          call_state),
         delivery_state = coalesce(p_delivery_state,      delivery_state),
         cash_state     = coalesce(p_cash_state,          cash_state),
         attempt_count  = coalesce(p_attempt_count,       attempt_count),
         next_contact_at = coalesce(p_next_contact_at,    next_contact_at),
         -- Lot B : effacement explicite (deconfirmer / desannuler) sinon coalesce.
         scheduled_for  = case
           when p_clear_scheduled_for then null
           else coalesce(p_scheduled_for, scheduled_for)
         end,
         -- Lot B : cancel_reason legacy alimente au 1er element des raisons
         -- multiples (fenetre de transition), efface par le flag.
         cancel_reason  = case
           when p_clear_cancel_reasons then null
           when p_cancel_reasons is not null then p_cancel_reasons[1]
           else coalesce(p_cancel_reason, cancel_reason)
         end,
         -- Lot B : raisons d'annulation multiples.
         cancel_reasons = case
           when p_clear_cancel_reasons then null
           else coalesce(p_cancel_reasons, cancel_reasons)
         end,
         assigned_driver_id = coalesce(p_assigned_driver_id, assigned_driver_id),
         payment_channel_at_delivery = case
           when v_next_delivery_state = 'delivered'
                and v_next_cash_state = 'collected'
             then v_payment_channel
           else payment_channel_at_delivery
         end,
         cash_collectable_minor = case
           when v_next_delivery_state <> 'delivered'
                or v_next_cash_state <> 'collected'
             then cash_collectable_minor
           when v_payment_channel in ('WAVE', 'ORANGE_MONEY', 'FREE_MONEY')
             then 0
           else round(total_amount)::bigint
         end,
         -- phase6 : horodatage de l'encaissement (une seule fois, terminal)
         cash_collected_at = case
           when v_next_delivery_state = 'delivered'
                and v_next_cash_state = 'collected'
                and cash_collected_at is null
             then now()
           else cash_collected_at
         end,
         -- phase6 : horodatage du retour (une seule fois, terminal)
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

  -- Capture l'id de transition pour les cles d'idempotence des mouvements.
  insert into public.order_state_transition (
    merchant_account_id,
    order_id,
    from_status,
    to_status,
    actor_user_id,
    note,
    created_at
  )
  values (
    v_order.merchant_account_id,
    v_order.id,
    v_order.cod_status,
    v_next_status,
    p_actor,
    p_note,
    now()
  )
  returning id into v_transition_id;

  -- Lot D : reprise cash append-only pour retour apres livraison.
  -- On neutralise uniquement ce qui a deja ete alloue/remis pour cette commande.
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

  -- -- Derivation du mouvement stock depuis le delta de dimensions --
  --
  -- v_order.* = etat AVANT (locked FOR UPDATE)
  -- v_next_delivery_state / coalesce(p_*, v_order.*) = etat APRES
  --
  -- Cas post-dispatch explicites :
  --   mark_returned apres livraison                 -> courier_return
  --   mark_failed (refuser depuis EN_LIVRAISON)     -> null (stock chez livreur)
  --   annuler apres dispatch (assigned/OFD)         -> null (courier_return separe)
  --   annuler avant dispatch (unassigned/scheduled) -> release

  v_movement_type := case

    -- dispatch : delivery -> assigned ou out_for_delivery depuis un etat pre-dispatch
    when v_next_delivery_state in ('assigned', 'out_for_delivery')
         and v_order.delivery_state not in (
           'assigned', 'out_for_delivery', 'delivered', 'failed', 'returned'
         )
      then 'dispatch'

    -- sold : delivery -> delivered
    when v_next_delivery_state = 'delivered'
         and v_order.delivery_state <> 'delivered'
      then 'sold'

    -- Lot D : retour apres livraison. Reverse physique du stock livreur :
    -- qty positive -> +qty_on_hand entrepot et -qty en main livreur.
    when v_next_order_state = 'returned'
         and v_next_delivery_state = 'returned'
         and v_order.order_state = 'completed'
         and v_order.delivery_state = 'delivered'
      then 'courier_return'

    -- reserve : call -> validated, delivery encore unassigned
    when coalesce(p_call_state, v_order.call_state) = 'validated'
         and v_order.call_state <> 'validated'
         and v_next_delivery_state = 'unassigned'
      then 'reserve'

    -- release (deconfirmer) : call validated -> to_call, commande encore OUVERTE
    --   et stock encore en entrepot (pre-dispatch). Reverse exact de `reserve`.
    when coalesce(p_call_state, v_order.call_state) = 'to_call'
         and v_order.call_state = 'validated'
         and v_order.order_state = 'open'
         and v_order.delivery_state in ('unassigned', 'scheduled')
      then 'release'

    -- release (annuler/refuser pre-dispatch) : order annulee/retournee ET
    --   stock encore en entrepot.
    when v_next_order_state in ('cancelled', 'returned')
         and v_order.order_state not in ('cancelled', 'returned')
         and v_order.delivery_state in ('unassigned', 'scheduled')
      then 'release'

    -- mark_failed, cancel post-dispatch, journaliser_appel, programmer,
    -- desannuler -> aucun mouvement
    else null

  end;

  -- Boucle sur les order_line resolues (dans la meme transaction).
  -- Lignes non resolues : ignorees proprement.
  -- Une erreur dans post_stock_movement propage et rollback toute la transition.

  if v_movement_type is not null then
    for v_line in
      select ol.id, ol.product_id, ol.qty
        from public.order_line ol
       where ol.order_id  = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id   is not null
    loop
      perform public.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_line.product_id,
        p_movement_type       := v_movement_type,
        p_qty                 := case
                                   when v_movement_type in ('dispatch', 'release')
                                     then -v_line.qty
                                   else v_line.qty
                                 end,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_line.id::text
                                 || ':' || v_movement_type,
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := v_effective_driver_id
      );
    end loop;
  end if;

  return v_next_status;
end;
$$;

grant execute on function public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid,
  text[], boolean, boolean
) to authenticated;
