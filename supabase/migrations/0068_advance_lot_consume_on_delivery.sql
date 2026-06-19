-- ============================================================
-- 0068 : livraison depuis le lot d'avance (Option A) + traçabilité advance_commit
-- ============================================================
-- BUG corrigé : un livreur ayant du lot d'avance (allocate_to_courier) d'un
-- produit, quand on lui assigne/livre une commande de ce produit, voyait son
-- « stock en main » NE JAMAIS se résorber : l'assignation postait un dispatch
-- par-commande (+1 main, −1 entrepôt) et la livraison un sold (−1 main) qui se
-- nettaient à 0, laissant l'avance intacte ET décrémentant l'entrepôt deux fois
-- (allocate −N PUIS dispatch −1 = double sortie fantôme).
--
-- DÉCISION (Option A) : à l'assignation, la livraison PUISE D'ABORD dans l'avance
-- du livreur ; on ne dispatche depuis l'entrepôt que le COMPLÉMENT manquant.
--   cover     = least(qté_ligne, avance_disponible)   → consommé de l'avance
--   remainder = qté_ligne − cover                      → dispatché de l'entrepôt
-- Règle partielle : avance 2 + commande 3 → cover 2 (pas de dispatch), remainder 1.
--
-- TRAÇABILITÉ : « ne pas dispatcher la part couverte » ne suffit pas à dériver
-- l'avance restante (la main générique est gonflée par les commandes assignées
-- non encore livrées). On ajoute donc un MARQUEUR ledger append-only :
--   movement_type 'advance_commit' (qty = unités couvertes par l'avance)
--   → EFFET NUL sur l'entrepôt (qty_on_hand) ET sur la main du livreur ;
--   → compté UNIQUEMENT par la formule d'avance disponible :
--       avance_dispo(livreur, produit) =
--           (− Σ qty allocate_to_courier)   -- avance reçue (qty négative → +)
--         − ( Σ qty courier_return_lot)      -- avance invendue retournée entrepôt
--         − ( Σ qty advance_commit)          -- avance déjà engagée sur commandes
-- 'advance_commit' est volontairement ABSENT des allowlists qty_on_hand
-- (reconcile/rebuild 0032) et de DRIVER_HAND_MOVEMENT_TYPES (lib/drivers/
-- stock-on-hand.ts) → exclu des deux côtés, aucun faux écart de réconciliation.
--
-- INVARIANT (avance 6, commande 1) : main 5, entrepôt −6 (plus de −7),
--   entrepôt + Σ mains = −6 + 5 = −1 = (Σ purchase_in − Σ sold) = 0 − 1. ✔
--
-- CONCURRENCE (limite connue, documentée aussi dans CLAUDE.md) : la sérialisation
-- de l'avance par (livreur, produit) repose sur le SELECT ... FOR UPDATE de la
-- ligne product_stock du produit, posé AVANT le calcul d'avance. Cela suppose
-- une ASSIGNATION À LA FOIS pour un même couple (livreur, produit) — hypothèse
-- mono-opérateur réaliste ici. Deux assignations strictement simultanées vers le
-- même livreur+produit pourraient lire la même avance et sur-engager. À durcir
-- (verrou au grain livreur+produit) si un usage multi-opérateur concurrent
-- apparaît.
--
-- DÉSANNULER (anti-stock-fantôme) : désannuler (transition_order avec
-- p_clear_assigned_driver, cf. 0066) une commande qui avait engagé de l'avance
-- doit RENDRE cette avance au livreur d'origine, sinon les unités restent
-- « engagées » sur une commande annulée (avance sous-estimée + stock
-- inatteignable). On poste un advance_commit compensatoire négatif (= − net
-- engagé), par (produit, livreur), dérivé du ledger. Append-only, idempotent.
--
-- COGS : INCHANGÉ — pris au sold (snapshot CUMP à la livraison). L'avance est
-- valorisée au allocate, mais le COGS reste au sold ; aucun double COGS.
--
-- Contenu (1 fichier, 3 surfaces) :
--   1. contraintes stock_movement : + 'advance_commit' (type + lot-requires-driver)
--   2. post_stock_movement : branche 'advance_commit' no-op + garde driver
--      (corps reproduit byte-for-byte depuis 0043)
--   3. transition_order : boucle avance/dispatch + compensation désannulation
--      (corps reproduit byte-for-byte depuis 0066)
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. Contraintes stock_movement (DROP + re-add NOT VALID, comme 0031)
-- ────────────────────────────────────────────────────────────

alter table public.stock_movement
  drop constraint if exists stock_movement_type_check;

alter table public.stock_movement
  add constraint stock_movement_type_check
  check (
    movement_type in (
      'purchase_in',
      'reserve',
      'release',
      'dispatch',
      'sold',
      'courier_return',
      'manual_adjustment',
      'allocate_to_courier',
      'courier_return_lot',
      'advance_commit'
    )
  )
  not valid;

-- advance_commit est livreur-scopé comme les types lot.
alter table public.stock_movement
  drop constraint if exists stock_movement_lot_requires_driver_check;

alter table public.stock_movement
  add constraint stock_movement_lot_requires_driver_check
  check (
    movement_type not in ('allocate_to_courier', 'courier_return_lot', 'advance_commit')
    or driver_id is not null
  )
  not valid;

-- ────────────────────────────────────────────────────────────
-- 2. post_stock_movement : branche advance_commit (no-op position) + garde driver
--    Signature 12-arg INCHANGÉE → create or replace (ACL préservé).
--    Corps reproduit byte-for-byte depuis 0043, SEULES différences :
--      (a) garde « lot/advance requires driver » inclut advance_commit
--      (b) nouvelle branche case 'advance_commit' → null (marqueur, 0 position)
-- ────────────────────────────────────────────────────────────

create or replace function public.post_stock_movement(
  p_merchant_account_id uuid,
  p_product_id          uuid,
  p_movement_type       text,
  p_qty                 integer,          -- signé : négatif pour dispatch/release/allocate
  p_idempotency_key     text,
  p_created_by          uuid,
  p_order_id            uuid    default null,
  p_transition_id       uuid    default null,
  p_unit_cost           bigint  default null,   -- obligatoire pour purchase_in (stocké dans ledger)
  p_received_value      bigint  default null,   -- valeur atterrie exacte (purchase_in lot) → numérateur CUMP
  p_reason              text    default null,
  p_driver_id           uuid    default null    -- livreur attribué (lot ou commande)
)
returns uuid     -- id du stock_movement créé, NULL si doublon (idempotent)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_movement_id    uuid;
  v_stock          public.product_stock%rowtype;
  v_new_on_hand    integer;
  v_new_reserved   integer;
  v_new_unit_cost  bigint;
  v_cump_numerator numeric;  -- intermédiaire CUMP (évite overflow bigint × bigint)
begin
  -- Garde d'appelant NULL-safe (Phase 9 / P1-3) : l'appelant doit être membre du tenant.
  -- NULL (non-membre) → raise. Bloque les appels RPC directs cross-tenant ;
  -- l'autorisation fine (quel rôle pour quel mouvement) reste assurée par les appelants.
  if public.current_member_role(p_merchant_account_id) is null then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  -- Validation manual_adjustment : raison non vide obligatoire.
  if p_movement_type = 'manual_adjustment'
     and coalesce(nullif(btrim(coalesce(p_reason, '')), ''), null) is null
  then
    raise exception 'manual_adjustment requires a non-empty reason'
      using errcode = 'P0001';
  end if;

  -- Les mouvements lot ET advance_commit exigent un livreur.
  if p_movement_type in ('allocate_to_courier', 'courier_return_lot', 'advance_commit')
     and p_driver_id is null
  then
    raise exception 'lot/advance movement requires a driver'
      using errcode = 'P0001';
  end if;

  -- Guard tenant : le produit doit appartenir au merchant déclaré.
  -- (protège les appels RPC directs ; transition_order est déjà scopé par RLS.)
  if not exists (
    select 1 from public.product
    where id = p_product_id
      and merchant_account_id = p_merchant_account_id
  ) then
    raise exception 'product not found for this merchant account'
      using errcode = 'P0002';
  end if;

  -- Guard tenant : le livreur (si fourni) doit appartenir au merchant.
  if p_driver_id is not null and not exists (
    select 1 from public.driver
    where id = p_driver_id
      and merchant_account_id = p_merchant_account_id
  ) then
    raise exception 'driver not found for this merchant account'
      using errcode = 'P0002';
  end if;

  -- Ledger insert idempotent.
  insert into public.stock_movement (
    merchant_account_id,
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

  -- Doublon : retour sans toucher product_stock (idempotence garantie).
  if v_movement_id is null then
    return null;
  end if;

  -- Création de la ligne product_stock si première écriture pour ce produit.
  insert into public.product_stock (product_id, merchant_account_id)
  values (p_product_id, p_merchant_account_id)
  on conflict (product_id) do nothing;

  -- Verrou exclusif sur la projection (anti lost-update).
  select * into v_stock
  from public.product_stock
  where product_id = p_product_id
  for update;

  v_new_on_hand   := v_stock.qty_on_hand;
  v_new_reserved  := v_stock.qty_reserved;
  v_new_unit_cost := v_stock.unit_cost;

  case p_movement_type

    when 'reserve' then
      -- Réserve molle : uniquement qty_reserved, jamais qty_on_hand.
      v_new_reserved := v_stock.qty_reserved + p_qty;

    when 'release' then
      -- p_qty est négatif ; on clamp à 0.
      v_new_reserved := greatest(0, v_stock.qty_reserved + p_qty);

    when 'dispatch' then
      -- p_qty est négatif ; décrément physique + réserve + snapshot CUMP courant.
      v_new_on_hand  := greatest(0, v_stock.qty_on_hand  + p_qty);
      v_new_reserved := greatest(0, v_stock.qty_reserved + p_qty);
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'allocate_to_courier' then
      -- Lot d'avance : sortie physique entrepôt → livreur (p_qty négatif),
      -- hors commande, hors réserve. Snapshot CUMP (valorisation du lot).
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'advance_commit' then
      -- 0068 : marqueur de traçabilité SEUL. L'entrepôt a déjà été débité au
      -- allocate_to_courier ; la main du livreur sera débitée au sold. Ici :
      -- AUCUNE mutation de position (qty_on_hand / qty_reserved / unit_cost).
      -- Compté uniquement par la formule d'avance disponible (transition_order).
      null;

    when 'sold' then
      -- Snapshot CUMP pour COGS, aucune mutation de position.
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'purchase_in' then
      -- Recalcul CUMP (moyenne mobile pondérée, arithmétique entière).
      -- p_received_value (si fourni) = valeur atterrie EXACTE de la ligne lot :
      -- évite la dérive de qty × floor(landed_total / qty) dans le numérateur.
      -- Fallback sur p_qty × p_unit_cost pour la saisie manuelle existante.
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

    when 'courier_return_lot' then
      -- Retour de l'invendu du lot : restaure qty_on_hand entrepôt (p_qty positif).
      v_new_on_hand := v_stock.qty_on_hand + p_qty;

    when 'manual_adjustment' then
      -- p_qty signé (+/-) ; raison validée ci-dessus ; clamp à 0.
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
$$;

-- Accessible depuis transition_order (INVOKER, rôle authenticated) et
-- depuis les actions autonomes via supabase.rpc().
grant execute on function public.post_stock_movement(
  uuid, uuid, text, integer, text, uuid,
  uuid, uuid, bigint, bigint, text, uuid
) to authenticated;

-- ────────────────────────────────────────────────────────────
-- 3. transition_order : boucle avance/dispatch + compensation désannulation
--    Signature 17-arg INCHANGÉE → create or replace (ACL préservé, re-grant
--    explicite par prudence, cf. 0067).
--    Corps reproduit byte-for-byte depuis 0066, SEULES différences :
--      (a) declares : + v_advance_avail / v_cover / v_remainder
--      (b) boucle des mouvements : dispatch → cover (advance_commit) + remainder
--          (dispatch) ; sold/reserve/release/courier_return INCHANGÉS
--      (c) bloc compensation advance_commit à la désannulation
--          (p_clear_assigned_driver)
-- ────────────────────────────────────────────────────────────

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
  p_clear_cancel_reasons  boolean      default false,
  p_clear_assigned_driver boolean      default false
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
  -- 0068 : split avance/dispatch
  v_advance_avail             integer;
  v_cover                     integer;
  v_remainder                 integer;
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
         -- 0066 : effacement explicite (desannuler post-dispatch) sinon coalesce.
         assigned_driver_id = case
           when p_clear_assigned_driver then null
           else coalesce(p_assigned_driver_id, assigned_driver_id)
         end,
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

    -- reserve : call -> validated, stock encore en entrepot (PRE-DISPATCH).
    -- 0059 : inclut 'scheduled' (chemin fusionne « Programmer » depuis « A appeler » :
    -- delivery unassigned -> scheduled en une transition). Sans ca le reserve etait
    -- saute et le dispatch (-qty_reserved) faisait passer qty_reserved en negatif.
    -- Garde `v_order.call_state <> 'validated'` => un seul reserve par commande.
    when coalesce(p_call_state, v_order.call_state) = 'validated'
         and v_order.call_state <> 'validated'
         and v_next_delivery_state in ('unassigned', 'scheduled')
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
  --
  -- 0068 : pour le dispatch, la livraison PUISE D'ABORD dans l'avance du livreur
  -- (advance_commit, effet nul) et ne dispatche que le complement (remainder).
  -- Les autres types (sold/reserve/release/courier_return) restent INCHANGES.

  if v_movement_type is not null then
    for v_line in
      select ol.id, ol.product_id, ol.qty
        from public.order_line ol
       where ol.order_id  = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id   is not null
    loop
      if v_movement_type = 'dispatch' then
        -- Serialise les dispatches concurrents vers le meme (livreur, produit)
        -- par le verrou de la ligne product_stock (limite mono-assignation,
        -- cf. en-tete + CLAUDE.md).
        perform 1 from public.product_stock
         where product_id = v_line.product_id
         for update;

        -- Avance disponible du livreur pour CE produit (derivee du ledger) :
        --   (- Σ allocate_to_courier) - Σ courier_return_lot - Σ advance_commit
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

        -- Part couverte par l'avance : marqueur traçabilite (0 entrepot, 0 main).
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
            p_transition_id       := v_transition_id,
            p_driver_id           := v_effective_driver_id
          );
        end if;

        -- Complement manquant : dispatch entrepot classique (-remainder).
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
            p_transition_id       := v_transition_id,
            p_driver_id           := v_effective_driver_id
          );
        end if;

      else
        -- sold / reserve / release / courier_return : un seul mouvement
        -- (seul 'release' est negatif sur la quantite).
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
          p_transition_id       := v_transition_id,
          p_driver_id           := v_effective_driver_id
        );
      end if;
    end loop;
  end if;

  -- 0068 : compensation avance a la desannulation (anti-stock-fantome).
  -- Desannuler (p_clear_assigned_driver) une commande qui avait engage de
  -- l'avance doit RENDRE cette avance au livreur qui l'avait engagee, sinon les
  -- unites restent « engagees » sur une commande annulee (avance sous-estimee +
  -- stock inatteignable). On poste un advance_commit compensatoire = - (net
  -- engage), par (produit, livreur), derive du ledger. Aucun mouvement physique
  -- (entrepot/main inchanges). Idempotent (cle distincte ; HAVING sum<>0 evite un
  -- double-post sur desannulation repetee — le net retombe a 0).
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
        p_transition_id       := v_transition_id,
        p_driver_id           := v_line.driver_id
      );
    end loop;
  end if;

  return v_next_status;
end;
$$;

-- 0067 : la fonction reste reservee a authenticated (revoke public/anon explicite).
revoke all on function public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid,
  text[], boolean, boolean, boolean
) from public, anon;

grant execute on function public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid,
  text[], boolean, boolean, boolean
) to authenticated;
