-- ============================================================
-- 0029 : atomicité stock — post_stock_movement + transition_order
-- ============================================================
-- post_stock_movement : primitive SECURITY DEFINER, idempotente,
--   verrouille product_stock FOR UPDATE → insert ledger + update
--   compteurs en une seule transaction. Jamais avale une erreur.
-- transition_order : dérive le movement_type en SQL depuis le delta
--   de dimensions (AVANT = v_order.*, APRÈS = p_*) et boucle sur
--   les order_line résolues — tout dans la transaction de la RPC.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. post_stock_movement
-- ────────────────────────────────────────────────────────────

create or replace function public.post_stock_movement(
  p_merchant_account_id uuid,
  p_product_id          uuid,
  p_movement_type       text,
  p_qty                 integer,          -- signé : négatif pour dispatch/release
  p_idempotency_key     text,
  p_created_by          uuid,
  p_order_id            uuid    default null,
  p_transition_id       uuid    default null,
  p_unit_cost           bigint  default null,  -- obligatoire pour purchase_in
  p_reason              text    default null
)
returns uuid     -- id du stock_movement créé, NULL si doublon (idempotent)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_movement_id   uuid;
  v_stock         public.product_stock%rowtype;
  v_new_on_hand   integer;
  v_new_reserved  integer;
  v_new_unit_cost bigint;
begin
  -- Validation manual_adjustment : raison non vide obligatoire.
  if p_movement_type = 'manual_adjustment'
     and coalesce(nullif(btrim(coalesce(p_reason, '')), ''), null) is null
  then
    raise exception 'manual_adjustment requires a non-empty reason'
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
    created_by
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
    p_created_by
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

    when 'sold' then
      -- Snapshot CUMP pour COGS, aucune mutation de position.
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

    when 'purchase_in' then
      -- Recalcul CUMP (moyenne mobile pondérée, arithmétique entière).
      if p_unit_cost is not null and (v_stock.qty_on_hand + p_qty) > 0 then
        v_new_unit_cost :=
          (v_stock.qty_on_hand * v_stock.unit_cost + p_qty * p_unit_cost)
          / (v_stock.qty_on_hand + p_qty);
      end if;
      v_new_on_hand := v_stock.qty_on_hand + p_qty;

    when 'courier_return' then
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
  uuid, uuid, bigint, text
) to authenticated;

-- ────────────────────────────────────────────────────────────
-- 2. transition_order — dérivation SQL + boucle order_line
-- ────────────────────────────────────────────────────────────

create or replace function public.transition_order(
  p_order_id           uuid,
  p_actor              uuid,
  p_note               text         default null,
  p_payment_channel    text         default 'ESPECES',
  p_order_state        text         default null,
  p_call_state         text         default null,
  p_delivery_state     text         default null,
  p_cash_state         text         default null,
  p_attempt_count      integer      default null,
  p_next_contact_at    timestamptz  default null,
  p_scheduled_for      timestamptz  default null,
  p_cancel_reason      text         default null,
  p_assigned_driver_id uuid         default null
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
         scheduled_for  = coalesce(p_scheduled_for,       scheduled_for),
         cancel_reason  = coalesce(p_cancel_reason,       cancel_reason),
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

    -- release : order annulée/retournée ET stock encore en entrepôt (pré-dispatch)
    when coalesce(p_order_state, v_order.order_state) in ('cancelled', 'returned')
         and v_order.order_state not in ('cancelled', 'returned')
         and v_order.delivery_state in ('unassigned', 'scheduled')
      then 'release'

    -- mark_failed, cancel post-dispatch, journaliser_appel, programmer → aucun mouvement
    else null

  end;

  -- ── Boucle sur les order_line résolues (dans la même transaction) ──
  --
  -- Lignes non résolues (match_status <> 'matched' ou product_id IS NULL)
  -- sont ignorées proprement — aucune erreur levée.
  -- Une erreur dans post_stock_movement propagera et rollbackera tout.

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
        p_transition_id       := v_transition_id
      );
    end loop;
  end if;

  return v_next_status;
end;
$$;
