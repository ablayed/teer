-- ============================================================
-- 0034 : Phase 5 — receive_purchase_lot (RPC atomique)
-- ============================================================
-- Réception d'un lot fournisseur en une seule transaction :
--   1. Verrouille le lot (guard tenant + garde contre double réception).
--   2. Pour chaque ligne passée dans p_lines (JSON) :
--        a. Vérifie l'appartenance au lot.
--        b. Écrit line_value, allocated_fees, landed_total_value, landed_unit_cost.
--        c. Poste un mouvement purchase_in via post_stock_movement si qty > 0.
--           → p_received_value = landed_total_value (valeur atterrie exacte, CUMP sans dérive).
--   3. Marque le lot received + received_at = current_date.
-- Échec à n'importe quelle étape → rollback complet (SQL transaction).
-- ============================================================

create or replace function public.receive_purchase_lot(
  p_lot_id              uuid,
  p_merchant_account_id uuid,
  p_actor_id            uuid,
  p_lines               jsonb   -- [{line_id, line_value, allocated_fees, landed_total_value, landed_unit_cost}]
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
  -- ── 1. Verrou exclusif + garde tenant ────────────────────────────────────
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

  -- ── 2. Traitement de chaque ligne ─────────────────────────────────────────
  for v_elem in select * from jsonb_array_elements(p_lines) loop
    v_line_id  := (v_elem->>'line_id')::uuid;
    v_line_val := (v_elem->>'line_value')::bigint;
    v_alloc    := (v_elem->>'allocated_fees')::bigint;
    v_landed   := (v_elem->>'landed_total_value')::bigint;
    v_ucost    := (v_elem->>'landed_unit_cost')::bigint;

    -- Vérifier que la ligne appartient bien à ce lot et verrouiller.
    select * into v_line_row
    from public.purchase_lot_line
    where id = v_line_id
      and purchase_lot_id = p_lot_id
    for update;

    if not found then
      raise exception 'purchase_lot_line not found or wrong lot: %', v_line_id
        using errcode = 'P0002';
    end if;

    -- Écrire les dérivés de réception.
    update public.purchase_lot_line
       set line_value         = v_line_val,
           allocated_fees     = v_alloc,
           landed_total_value = v_landed,
           landed_unit_cost   = v_ucost
     where id = v_line_id;

    -- Mouvement stock (ignoré si qty = 0 — ligne annulée/vide).
    if v_line_row.qty > 0 then
      perform public.post_stock_movement(
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

  -- ── 3. Marquer le lot reçu ────────────────────────────────────────────────
  update public.purchase_lot
     set status      = 'received',
         received_at = current_date
   where id = p_lot_id;
end;
$$;

grant execute on function public.receive_purchase_lot(uuid, uuid, uuid, jsonb)
  to authenticated;
