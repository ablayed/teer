-- ============================================================
-- 0054 : Lot B - machine d'états (déconfirmer / désannuler + raisons multiples)
-- ============================================================
-- Contexte :
--   Lot B est le seul lot qui touche le moteur de transitions. Trois ajouts :
--     1. orders.cancel_reasons text[] : raisons d'annulation multiples
--        (allow-list appliquée côté serveur en Zod, PAS de CHECK en base).
--     2. transition_order étendu pour exprimer DEUX nouvelles actions reverse,
--        toutes deux dérivées purement du delta de dimensions (le RPC n'a
--        toujours aucune notion d'« action ») :
--          * deconfirmer  (open ∧ validated ∧ delivery∈{unassigned,scheduled})
--              → call→to_call, scheduled_for→NULL, delivery scheduled→unassigned,
--                poste un mouvement `release` (reverse exact de `reserve`).
--          * desannuler   (order_state = cancelled)
--              → order→open, call→to_call, delivery→unassigned, cash→not_due,
--                cancel_reason(s)→NULL, scheduled_for→NULL, AUCUN mouvement stock.
--
-- INTÉGRITÉ STOCK (vérifiée) :
--   * `release` reverse `reserve` : post_stock_movement (0043) fait
--     qty_reserved = greatest(0, qty_reserved + p_qty) avec p_qty négatif,
--     symétrique au reserve (qty_reserved += p_qty). qty_on_hand jamais touché.
--   * La nouvelle branche release (déconfirmer) est GARDÉE par
--     `v_order.order_state = 'open'` : la réserve n'existe que tant que la
--     commande est ouverte (à l'annulation elle a déjà été libérée). Donc
--     desannuler (venant de `cancelled`) ne poste RIEN.
--   * Mutuelle exclusion des deux branches `release` du CASE (vérifiée) :
--       - cancel-release exige coalesce(p_order_state, order_state) ∈
--         {cancelled,returned} → faux pour déconfirmer (reste 'open').
--       - deconfirm-release exige coalesce(p_call_state, call_state)='to_call'
--         ET call_state(avant)='validated' → faux pour annuler (qui ne touche
--         jamais p_call_state, coalesce resterait 'validated').
--     Aucun chevauchement possible ; l'ordre des `when` est sûr.
--
-- CONTRAINTE RPC : transition_order n'écrivait jusqu'ici qu'en coalesce(p_x, x)
--   → impossible de remettre une colonne à NULL. Or déconfirmer/désannuler
--   doivent effacer scheduled_for (et désannuler aussi cancel_reason(s)).
--   → on ajoute des FLAGS d'effacement explicites
--     (p_clear_scheduled_for / p_clear_cancel_reasons), pas un param NULL.
--   Ajouter des arguments change la signature → DROP puis CREATE
--   (CREATE OR REPLACE créerait une surcharge ambiguë). Même pattern que 0049.
--
-- STRATÉGIE DROP DIFFÉRÉ : on AJOUTE cancel_reasons et on CONSERVE le legacy
--   cancel_reason (alimenté au 1ᵉʳ élément pendant la fenêtre de transition ;
--   drop dans une migration de cleanup ultérieure).
--
-- Aucune RLS / policy modifiée : mêmes tables, mêmes politiques.
--   orders_update WITH CHECK : déconfirmer/désannuler produisent
--   cod_status = 'A_APPELER', autorisé pour tous les rôles (re-vérifié en RLS).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. orders.cancel_reasons (nullable) + backfill
-- ────────────────────────────────────────────────────────────

alter table public.orders
  add column cancel_reasons text[];

-- Backfill : on enveloppe la raison existante dans un tableau, MAIS on EXCLUT
-- les valeurs système legacy 'cancelled' / 'refused' (ce ne sont pas des
-- raisons métier Lot B : indisponibilite/prix/concurrence/erreur/autres).
-- En pratique l'ancienne UI ne saisissait aucune vraie raison → backfill quasi
-- vide, ce qui est attendu.
update public.orders
   set cancel_reasons = array[cancel_reason]
 where cancel_reason is not null
   and btrim(cancel_reason) <> ''
   and cancel_reason not in ('cancelled', 'refused')
   and cancel_reasons is null;

-- ────────────────────────────────────────────────────────────
-- 2. transition_order : DROP + CREATE
-- ────────────────────────────────────────────────────────────
-- Corps copié À L'IDENTIQUE depuis 0035. Seuls ajouts :
--   (a) 3 nouveaux params : p_cancel_reasons, p_clear_scheduled_for,
--       p_clear_cancel_reasons.
--   (b) clause SET : scheduled_for / cancel_reason / cancel_reasons gérés
--       avec les flags d'effacement.
--   (c) nouvelle branche `release` (déconfirmer) dans v_movement_type.
-- Le reste (declares, guards paiement, dates phase6, boucle order_line,
-- NULL-safety driver) est inchangé.
-- ────────────────────────────────────────────────────────────

drop function if exists public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid
);

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
  v_order               public.orders%rowtype;
  v_next_cash_state     text;
  v_next_delivery_state text;
  v_next_status         text;
  v_payment_channel     text;
  v_transition_id       uuid;
  v_movement_type       text;
  v_effective_driver_id uuid;
  v_line                record;
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

  update public.orders
     set order_state    = coalesce(p_order_state,        order_state),
         call_state     = coalesce(p_call_state,          call_state),
         delivery_state = coalesce(p_delivery_state,      delivery_state),
         cash_state     = coalesce(p_cash_state,          cash_state),
         attempt_count  = coalesce(p_attempt_count,       attempt_count),
         next_contact_at = coalesce(p_next_contact_at,    next_contact_at),
         -- Lot B : effacement explicite (déconfirmer / désannuler) sinon coalesce.
         scheduled_for  = case
           when p_clear_scheduled_for then null
           else coalesce(p_scheduled_for, scheduled_for)
         end,
         -- Lot B : cancel_reason legacy alimenté au 1ᵉʳ élément des raisons
         -- multiples (fenêtre de transition), effacé par le flag.
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

  -- Capture l'id de transition pour les clés d'idempotence des mouvements.
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

  -- ── Dérivation du mouvement stock depuis le delta de dimensions ──
  --
  -- v_order.* = état AVANT (locked FOR UPDATE)
  -- v_next_delivery_state / coalesce(p_*, v_order.*) = état APRÈS
  --
  -- Cas post-dispatch explicites (ordre intentionnel — lus avant release) :
  --   mark_failed (refuser depuis EN_LIVRAISON)          → null (stock chez livreur)
  --   annuler après dispatch (delivery in assigned/OFD)  → null (courier_return séparé)
  --   annuler avant dispatch (delivery in unassigned/sched) → release

  v_movement_type := case

    -- dispatch : delivery → assigned ou out_for_delivery depuis un état pré-dispatch
    when v_next_delivery_state in ('assigned', 'out_for_delivery')
         and v_order.delivery_state not in (
           'assigned', 'out_for_delivery', 'delivered', 'failed', 'returned'
         )
      then 'dispatch'

    -- sold : delivery → delivered
    when v_next_delivery_state = 'delivered'
         and v_order.delivery_state <> 'delivered'
      then 'sold'

    -- reserve : call → validated, delivery encore unassigned
    when coalesce(p_call_state, v_order.call_state) = 'validated'
         and v_order.call_state <> 'validated'
         and v_next_delivery_state = 'unassigned'
      then 'reserve'

    -- release (déconfirmer) : call validated → to_call, commande encore OUVERTE
    --   et stock encore en entrepôt (pré-dispatch). Reverse exact de `reserve`.
    --   Garde order_state='open' : exclut désannuler (vient de 'cancelled', la
    --   réserve y a déjà été libérée à l'annulation → aucun mouvement).
    --   Mutuellement exclusif de la branche cancel-release ci-dessous (annuler
    --   ne pose jamais p_call_state).
    when coalesce(p_call_state, v_order.call_state) = 'to_call'
         and v_order.call_state = 'validated'
         and v_order.order_state = 'open'
         and v_order.delivery_state in ('unassigned', 'scheduled')
      then 'release'

    -- release (annuler/refuser pré-dispatch) : order annulée/retournée ET
    --   stock encore en entrepôt.
    when coalesce(p_order_state, v_order.order_state) in ('cancelled', 'returned')
         and v_order.order_state not in ('cancelled', 'returned')
         and v_order.delivery_state in ('unassigned', 'scheduled')
      then 'release'

    -- mark_failed, cancel post-dispatch, journaliser_appel, programmer,
    -- desannuler → aucun mouvement
    else null

  end;

  -- ── Boucle sur les order_line résolues (dans la même transaction) ──
  --
  -- Lignes non résolues (match_status <> 'matched' ou product_id IS NULL)
  -- sont ignorées proprement — aucune erreur levée.
  -- Une erreur dans post_stock_movement propagera et rollbackera tout.
  --
  -- p_driver_id : livreur effectif de la commande, attribué à chaque
  -- mouvement de commande (dispatch/sold/release/reserve) — dérivation
  -- du stock en main par un seul group by driver_id.

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

-- Re-grant (DROP a supprimé les grants de l'ancienne signature).
grant execute on function public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid,
  text[], boolean, boolean
) to authenticated;
