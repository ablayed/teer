-- ============================================================
-- 0043 : Phase 9 — durcissement des gardes de rôle DEFINER (NULL-safe)
-- ============================================================
-- Généralise le correctif 0042 (NULL NOT IN (...) ≡ NULL ≠ TRUE → garde sautée)
-- à TOUTES les fonctions SECURITY DEFINER exposées à `authenticated`.
--
-- Audit exhaustif Phase 9 / Stage 0 — gardes de rôle restantes non NULL-safe :
--   P0-1 record_cash_settlement (0018)  : `if v_role not in ('owner','manager')` → fuite write cross-tenant
--   P0-2 write_off_shortfall   (0018)  : `if v_role <> 'owner'`                 → fuite write cross-tenant
--   P1-3 post_stock_movement   (0033)  : AUCUNE garde d'appelant (defense-in-depth)
--   P1-3 receive_purchase_lot  (0034)  : AUCUNE garde d'appelant (defense-in-depth)
--   P2-6 accept_invitation     (0011)  : search_path = public, extensions → '' + noms qualifiés
--
-- Toutes les autres DEFINER exposées sont déjà NULL-safe :
--   finance_kpis / cash_aging  : filtre WHERE `... in ('owner','manager')` (NULL → 0 ligne)
--   ia_finance_cost_movements / ia_product_cump : corrigées en 0042
--   ia_count_recent_tool_calls : `is null` early-return + user_id = auth.uid()
--   current_member_role / get_customer_reliability (INVOKER) : RLS
--
-- Aucun changement de signature → lib/supabase/database.types.ts inchangé.
-- Seules les définitions de fonctions changent : pas de table/colonne/policy/RLS modifiée.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- P0-1 : record_cash_settlement — garde NULL-safe
--   `if v_role not in (...)`  →  `if v_role is null or v_role not in (...)`
--   (corps reproduit à l'identique de 0018, seule la ligne de garde change)
-- ────────────────────────────────────────────────────────────
create or replace function public.record_cash_settlement(
  p_merchant uuid,
  p_driver uuid,
  p_amount_received_minor bigint,
  p_method text,
  p_note text,
  p_client_request_id uuid,
  p_allocations jsonb default null,
  p_actor uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_driver_id uuid;
  v_settlement_id uuid;
  v_existing_settlement public.cash_settlement%rowtype;
  v_allocated_minor bigint := 0;
  v_expected_minor bigint := 0;
  v_shortfall_id uuid;
  v_order record;
  v_allocation record;
  v_remaining bigint;
  v_alloc_minor bigint;
begin
  v_role := public.current_member_role(p_merchant);

  -- NULL-safe : un non-membre obtient v_role = NULL ; sans le `is null` la garde serait sautée
  -- (NULL not in (...) ≡ NULL ≠ TRUE) → écriture cross-tenant. Cf. bug 0041→0042.
  if v_role is null or v_role not in ('owner','manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if auth.uid() is null or p_actor is distinct from auth.uid() then
    raise exception 'invalid_actor'
      using errcode = '42501';
  end if;

  if p_amount_received_minor < 0 then
    raise exception 'invalid_amount'
      using errcode = '22023';
  end if;

  if p_method not in ('ESPECES','WAVE','ORANGE_MONEY','FREE_MONEY') then
    raise exception 'invalid_method'
      using errcode = '22023';
  end if;

  select id
  into v_driver_id
  from public.driver
  where id = p_driver
    and merchant_account_id = p_merchant
    and is_active = true;

  if v_driver_id is null then
    raise exception 'driver_not_found'
      using errcode = 'P0002';
  end if;

  select *
  into v_existing_settlement
  from public.cash_settlement
  where merchant_account_id = p_merchant
    and client_request_id = p_client_request_id
  limit 1;

  if v_existing_settlement.id is not null then
    select coalesce(sum(allocated_minor), 0)
    into v_allocated_minor
    from public.settlement_allocation
    where settlement_id = v_existing_settlement.id
      and merchant_account_id = p_merchant;

    select id
    into v_shortfall_id
    from public.settlement_shortfall
    where settlement_id = v_existing_settlement.id
      and merchant_account_id = p_merchant
    limit 1;

    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'settlementId', v_existing_settlement.id,
      'allocatedMinor', v_allocated_minor,
      'expectedMinor', null,
      'shortfallId', v_shortfall_id,
      'shortfallMinor', null
    );
  end if;

  insert into public.cash_settlement (
    merchant_account_id,
    driver_id,
    amount_received_minor,
    method,
    note,
    client_request_id,
    created_by
  )
  values (
    p_merchant,
    p_driver,
    p_amount_received_minor,
    p_method,
    nullif(trim(coalesce(p_note, '')), ''),
    p_client_request_id,
    p_actor
  )
  returning id into v_settlement_id;

  if p_allocations is not null and jsonb_array_length(p_allocations) > 0 then
    for v_allocation in
      select *
      from jsonb_to_recordset(p_allocations) as allocation(
        order_id uuid,
        allocated_minor bigint
      )
    loop
      if v_allocation.allocated_minor <= 0 then
        raise exception 'invalid_allocation'
          using errcode = '22023';
      end if;

      perform 1
      from public.orders o
      where o.id = v_allocation.order_id
        and o.merchant_account_id = p_merchant
        and o.assigned_driver_id = p_driver
        and o.cod_status = 'LIVREE'
        and coalesce(o.payment_channel_at_delivery, 'INCONNU') in ('ESPECES','INCONNU')
      for update of o;

      if not found then
        raise exception 'order_not_found'
          using errcode = 'P0002';
      end if;

      select
        o.id,
        greatest(
          coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
            - coalesce((
              select sum(sa.allocated_minor)
              from public.settlement_allocation sa
              where sa.order_id = o.id
                and sa.merchant_account_id = o.merchant_account_id
            ), 0),
          0
        ) as outstanding_minor
      into v_order
      from public.orders o
      where o.id = v_allocation.order_id
        and o.merchant_account_id = p_merchant;

      if v_allocation.allocated_minor > v_order.outstanding_minor then
        raise exception 'over_allocation'
          using errcode = '22023';
      end if;

      v_expected_minor := v_expected_minor + v_order.outstanding_minor;
      v_allocated_minor := v_allocated_minor + v_allocation.allocated_minor;

      if v_allocated_minor > p_amount_received_minor then
        raise exception 'allocated_exceeds_received'
          using errcode = '22023';
      end if;

      insert into public.settlement_allocation (
        settlement_id,
        order_id,
        allocated_minor,
        merchant_account_id
      )
      values (
        v_settlement_id,
        v_order.id,
        v_allocation.allocated_minor,
        p_merchant
      );
    end loop;
  else
    v_remaining := p_amount_received_minor;

    for v_order in
      select
        o.id,
        o.updated_at,
        coalesce((
          select max(ost.created_at)
          from public.order_state_transition ost
          where ost.order_id = o.id
            and ost.to_status = 'LIVREE'
        ), o.updated_at) as delivered_at,
        greatest(
          coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
            - coalesce((
              select sum(sa.allocated_minor)
              from public.settlement_allocation sa
              where sa.order_id = o.id
                and sa.merchant_account_id = o.merchant_account_id
            ), 0),
          0
        ) as outstanding_minor
      from public.orders o
      where o.merchant_account_id = p_merchant
        and o.assigned_driver_id = p_driver
        and o.cod_status = 'LIVREE'
        and coalesce(o.payment_channel_at_delivery, 'INCONNU') in ('ESPECES','INCONNU')
        and greatest(
          coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
            - coalesce((
              select sum(sa.allocated_minor)
              from public.settlement_allocation sa
              where sa.order_id = o.id
                and sa.merchant_account_id = o.merchant_account_id
            ), 0),
          0
        ) > 0
      order by delivered_at asc, o.updated_at asc, o.id
      for update of o
    loop
      v_expected_minor := v_expected_minor + v_order.outstanding_minor;
      v_alloc_minor := least(v_order.outstanding_minor, v_remaining);

      if v_alloc_minor > 0 then
        insert into public.settlement_allocation (
          settlement_id,
          order_id,
          allocated_minor,
          merchant_account_id
        )
        values (
          v_settlement_id,
          v_order.id,
          v_alloc_minor,
          p_merchant
        );

        v_allocated_minor := v_allocated_minor + v_alloc_minor;
        v_remaining := v_remaining - v_alloc_minor;
      end if;
    end loop;
  end if;

  if p_amount_received_minor < v_expected_minor then
    insert into public.settlement_shortfall (
      settlement_id,
      merchant_account_id,
      driver_id,
      expected_minor,
      received_minor
    )
    values (
      v_settlement_id,
      p_merchant,
      p_driver,
      v_expected_minor,
      p_amount_received_minor
    )
    returning id into v_shortfall_id;
  end if;

  insert into public.audit_log (
    merchant_account_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    payload
  )
  values (
    p_merchant,
    p_actor,
    'settlement_recorded',
    'cash_settlement',
    v_settlement_id,
    jsonb_build_object(
      'driverId', p_driver,
      'amountReceivedMinor', p_amount_received_minor,
      'allocatedMinor', v_allocated_minor,
      'expectedMinor', v_expected_minor,
      'method', p_method
    )
  );

  if v_shortfall_id is not null then
    insert into public.audit_log (
      merchant_account_id,
      actor_user_id,
      action,
      resource_type,
      resource_id,
      payload
    )
    values (
      p_merchant,
      p_actor,
      'shortfall_recorded',
      'settlement_shortfall',
      v_shortfall_id,
      jsonb_build_object(
        'driverId', p_driver,
        'expectedMinor', v_expected_minor,
        'receivedMinor', p_amount_received_minor,
        'shortfallMinor', v_expected_minor - p_amount_received_minor
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'settlementId', v_settlement_id,
    'allocatedMinor', v_allocated_minor,
    'expectedMinor', v_expected_minor,
    'shortfallId', v_shortfall_id,
    'shortfallMinor', greatest(v_expected_minor - p_amount_received_minor, 0)
  );
end;
$$;

revoke all on function public.record_cash_settlement(
  uuid,
  uuid,
  bigint,
  text,
  text,
  uuid,
  jsonb,
  uuid
) from public, anon;

grant execute on function public.record_cash_settlement(
  uuid,
  uuid,
  bigint,
  text,
  text,
  uuid,
  jsonb,
  uuid
) to authenticated;

-- ────────────────────────────────────────────────────────────
-- P0-2 : write_off_shortfall — garde NULL-safe
--   `if v_role <> 'owner'`  →  `if v_role is null or v_role <> 'owner'`
--   (NULL <> 'owner' ≡ NULL ≠ TRUE → garde sautée sans le `is null`)
-- ────────────────────────────────────────────────────────────
create or replace function public.write_off_shortfall(
  p_merchant uuid,
  p_shortfall_id uuid,
  p_reason text,
  p_actor uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_shortfall public.settlement_shortfall%rowtype;
  v_settlement_id uuid;
  v_remaining bigint;
  v_allocated_minor bigint := 0;
  v_alloc_minor bigint;
  v_order record;
begin
  v_role := public.current_member_role(p_merchant);

  if v_role is null or v_role <> 'owner' then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if auth.uid() is null or p_actor is distinct from auth.uid() then
    raise exception 'invalid_actor'
      using errcode = '42501';
  end if;

  select *
  into v_shortfall
  from public.settlement_shortfall
  where id = p_shortfall_id
    and merchant_account_id = p_merchant
    and resolution = 'ROLLED_FORWARD'
  for update;

  if v_shortfall.id is null then
    raise exception 'shortfall_not_found'
      using errcode = 'P0002';
  end if;

  v_remaining := v_shortfall.shortfall_minor;

  insert into public.cash_settlement (
    merchant_account_id,
    driver_id,
    amount_received_minor,
    method,
    note,
    client_request_id,
    created_by
  )
  values (
    p_merchant,
    v_shortfall.driver_id,
    0,
    'ESPECES',
    nullif(trim(coalesce(p_reason, '')), ''),
    gen_random_uuid(),
    p_actor
  )
  returning id into v_settlement_id;

  for v_order in
    select
      o.id,
      o.updated_at,
      coalesce((
        select max(ost.created_at)
        from public.order_state_transition ost
        where ost.order_id = o.id
          and ost.to_status = 'LIVREE'
      ), o.updated_at) as delivered_at,
      greatest(
        coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
          - coalesce((
            select sum(sa.allocated_minor)
            from public.settlement_allocation sa
            where sa.order_id = o.id
              and sa.merchant_account_id = o.merchant_account_id
          ), 0),
        0
      ) as outstanding_minor
    from public.orders o
    where o.merchant_account_id = p_merchant
      and o.assigned_driver_id = v_shortfall.driver_id
      and o.cod_status = 'LIVREE'
      and coalesce(o.payment_channel_at_delivery, 'INCONNU') in ('ESPECES','INCONNU')
      and greatest(
        coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
          - coalesce((
            select sum(sa.allocated_minor)
            from public.settlement_allocation sa
            where sa.order_id = o.id
              and sa.merchant_account_id = o.merchant_account_id
          ), 0),
        0
      ) > 0
    order by delivered_at asc, o.updated_at asc, o.id
    for update of o
  loop
    exit when v_remaining <= 0;

    v_alloc_minor := least(v_order.outstanding_minor, v_remaining);

    insert into public.settlement_allocation (
      settlement_id,
      order_id,
      allocated_minor,
      merchant_account_id
    )
    values (
      v_settlement_id,
      v_order.id,
      v_alloc_minor,
      p_merchant
    );

    v_allocated_minor := v_allocated_minor + v_alloc_minor;
    v_remaining := v_remaining - v_alloc_minor;
  end loop;

  update public.settlement_shortfall
  set
    resolution = 'WRITTEN_OFF',
    reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = v_shortfall.id
    and merchant_account_id = p_merchant;

  insert into public.audit_log (
    merchant_account_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    payload
  )
  values (
    p_merchant,
    p_actor,
    'shortfall_written_off',
    'settlement_shortfall',
    v_shortfall.id,
    jsonb_build_object(
      'driverId', v_shortfall.driver_id,
      'writeOffSettlementId', v_settlement_id,
      'allocatedMinor', v_allocated_minor,
      'reason', p_reason
    )
  );

  return jsonb_build_object(
    'ok', true,
    'shortfallId', v_shortfall.id,
    'writeOffSettlementId', v_settlement_id,
    'allocatedMinor', v_allocated_minor,
    'remainingMinor', v_remaining
  );
end;
$$;

revoke all on function public.write_off_shortfall(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.write_off_shortfall(uuid, uuid, text, uuid) to authenticated;

-- ────────────────────────────────────────────────────────────
-- P1-3 : post_stock_movement — garde d'appelant NULL-safe (defense-in-depth)
--   Primitive bas niveau exposée à `authenticated`. Les appelants légitimes
--   (transition_order INVOKER+RLS, actions requireRole, receive_purchase_lot)
--   sont TOUJOURS membres → current_member_role non NULL.
--   `auth.uid()` est préservé à travers le contexte SECURITY DEFINER (GUC de session),
--   y compris quand transition_order (INVOKER) appelle cette fonction.
--   Bloque un appel RPC direct par un non-membre (sortie : 'forbidden').
--   Corps reproduit à l'identique de 0033 ; seule la garde en tête est ajoutée.
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

  -- Les mouvements lot exigent un livreur.
  if p_movement_type in ('allocate_to_courier', 'courier_return_lot')
     and p_driver_id is null
  then
    raise exception 'lot movement requires a driver'
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
-- P1-3 : receive_purchase_lot — garde d'appelant NULL-safe (owner-only)
--   Réception de lot = owner-only (cf. requireRole('owner') côté action).
--   `is distinct from 'owner'` est NULL-safe : NULL → TRUE → raise.
--   Corps reproduit à l'identique de 0034 ; seule la garde en tête est ajoutée.
-- ────────────────────────────────────────────────────────────
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
  -- Garde d'appelant NULL-safe (Phase 9 / P1-3) : owner-only.
  -- `is distinct from` traite NULL (non-membre) comme distinct → raise.
  if public.current_member_role(p_merchant_account_id) is distinct from 'owner' then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

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

-- ────────────────────────────────────────────────────────────
-- P2-6 : accept_invitation — search_path durci (cohérence avec les autres DEFINER)
--   `set search_path = public, extensions`  →  `set search_path = ''`
--   `digest(...)` (pgcrypto, schéma extensions) → `extensions.digest(...)`.
--   Les autres références sont déjà qualifiées (public.*, auth.*) ;
--   now()/lower()/jsonb_build_object() sont dans pg_catalog (toujours résolu).
--   Corps reproduit à l'identique de 0011 ; seuls search_path + digest changent.
-- ────────────────────────────────────────────────────────────
create or replace function public.accept_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token_hash bytea;
  v_invitation public.invitation%rowtype;
  v_user_email text;
  v_existing_member_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  v_token_hash := extensions.digest(p_token, 'sha256');

  select lower(email)
  into v_user_email
  from auth.users
  where id = auth.uid();

  if v_user_email is null then
    raise exception 'user_email_not_found';
  end if;

  select *
  into v_invitation
  from public.invitation
  where token_hash = v_token_hash
  for update;

  if not found then
    raise exception 'invalid_invitation';
  end if;

  if v_invitation.status = 'expired' then
    raise exception 'expired_invitation';
  end if;

  if v_invitation.status = 'revoked' then
    raise exception 'revoked_invitation';
  end if;

  if v_invitation.status <> 'pending' then
    raise exception 'invalid_invitation';
  end if;

  if v_invitation.expires_at <= now() then
    update public.invitation
    set status = 'expired',
        updated_at = now()
    where id = v_invitation.id;

    raise exception 'expired_invitation';
  end if;

  if lower(v_invitation.email) <> v_user_email then
    raise exception 'email_mismatch';
  end if;

  select id
  into v_existing_member_id
  from public.merchant_member
  where merchant_account_id = v_invitation.merchant_account_id
    and user_id = auth.uid()
  limit 1;

  if v_existing_member_id is null then
    insert into public.merchant_member (merchant_account_id, user_id, role)
    values (v_invitation.merchant_account_id, auth.uid(), v_invitation.role);
  end if;

  update public.invitation
  set status = 'accepted',
      accepted_at = now(),
      accepted_by = auth.uid(),
      updated_at = now()
  where id = v_invitation.id;

  insert into public.audit_log (
    merchant_account_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    payload
  )
  values (
    v_invitation.merchant_account_id,
    auth.uid(),
    'invite_accepted',
    'invitation',
    v_invitation.id,
    jsonb_build_object('role', v_invitation.role, 'email', v_invitation.email)
  );

  return jsonb_build_object(
    'ok', true,
    'merchant_account_id', v_invitation.merchant_account_id,
    'role', v_invitation.role
  );
end;
$$;

revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

-- ────────────────────────────────────────────────────────────
-- P1-3b : retrait du grant PUBLIC par défaut sur les fonctions de maintenance DEFINER.
--   reconcile_product_stock() / reconcile_order_cod_status() / rebuild_product_stock() :
--   SANS argument, GLOBALES (cross-tenant), SANS garde de rôle, jamais REVOKE → le grant
--   PUBLIC par défaut de Postgres les rendait exécutables par tout utilisateur authentifié
--   (`supabase.rpc(...)`) = recompute global à la demande, vecteur DoS (DEFINER, bypass RLS).
--   Elles ne tournent que via pg_cron / service-role. Aucun appelant applicatif (vérifié :
--   seules les types générées les référencent). pg_cron/owner/superuser conservent l'accès.
-- ────────────────────────────────────────────────────────────
revoke all on function public.reconcile_product_stock()    from public, anon, authenticated;
revoke all on function public.reconcile_order_cod_status()  from public, anon, authenticated;
revoke all on function public.rebuild_product_stock()       from public, anon, authenticated;
