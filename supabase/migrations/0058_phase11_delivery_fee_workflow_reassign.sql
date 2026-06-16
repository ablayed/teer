-- ============================================================
-- 0058 : phase11 — frais de livraison + réassignation livreur
-- ============================================================
-- Trois livrables schéma (le reste de la Phase 11 est du code TS) :
--
--   (1) orders.delivery_fee_minor (bigint, défaut 0) : prix de livraison
--       par commande. Le client paie TOUJOURS le total complet ; le livreur
--       GARDE les frais. Donc cash chez le livreur = collecté − frais. Le CA
--       (Finances + Tableau) se calcule net de livraison : Σ(total − frais).
--       NOT NULL + DEFAULT 0 : sûr (le défaut remplit l'existant, aucune
--       transition ne peut être silencieusement rejetée — ce n'est pas une
--       dimension d'état, juste un montant).
--
--   (2) Deux movement_type RÉSERVE-NEUTRES pour la réassignation livreur :
--         reassign_from_driver : stock repris au livreur sortant X (+on_hand)
--         reassign_to_driver   : stock confié au livreur entrant   Y (−on_hand)
--       Ils NE touchent PAS qty_reserved (≠ dispatch). La réservation a déjà
--       été consommée au dispatch initial ; réutiliser le delta de `dispatch`
--       redécrémenterait à tort les réservations des AUTRES commandes du même
--       produit (la projection product_stock.qty_reserved est partagée).
--       Net entrepôt = 0 (return X puis dispatch Y) ; l'attribution livreur
--       passe de X à Y → invariant « Σ stock-en-main livreurs + entrepôt =
--       ledger » préservé. Finance ignore ces types (ne lit que sold /
--       courier_return) ; la dérivation stock-en-main (lib/drivers/
--       stock-on-hand.ts) les ajoutera côté TS (Stage 4).
--
--   (3) RPC reassign_order_driver(...) SECURITY INVOKER : swap atomique de
--       assigned_driver_id + compensation stock (si dispatch déjà posté).
--       Interdit après delivered. Le retransfert cash/livraison est AUTOMATIQUE
--       par dérivation du assigned_driver_id courant (aucune écriture cash).
--
--   (+) get_dashboard_kpi réécrit : CA collecté NET de livraison. Mêmes clés
--       jsonb → toDashboardKpi inchangé. Tout le reste de 0057 préservé.
--
-- RLS orders_update INCHANGÉE : owner/manager écrivent déjà toute colonne
-- (montants + assigned_driver_id) ; l'agent reste borné par cod_status. La
-- restriction « agent ne peut pas éditer les montants ni voir delivery_fee_minor »
-- est applicative (requireRole + gating UI), comme unit_cost — un GRANT colonne
-- ne sait pas distinguer owner/agent (tous = rôle Postgres `authenticated`).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- (1) orders.delivery_fee_minor
-- ────────────────────────────────────────────────────────────
alter table public.orders
  add column if not exists delivery_fee_minor bigint not null default 0;

alter table public.orders
  add constraint orders_delivery_fee_minor_nonnegative
  check (delivery_fee_minor >= 0)
  not valid;

comment on column public.orders.delivery_fee_minor is
  'Frais de livraison (minor units FCFA). Le client paie le total complet ; '
  'le livreur garde ces frais. CA net = total − delivery_fee_minor ; '
  'cash chez le livreur = collecté − delivery_fee_minor − remis.';

-- ────────────────────────────────────────────────────────────
-- (2) movement_type réassignation : CHECK type + CHECK livreur requis
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
      'reassign_from_driver',
      'reassign_to_driver'
    )
  )
  not valid;

-- Les mouvements de réassignation exigent un livreur (sortant pour _from,
-- entrant pour _to). NOT VALID : n'invalide pas l'existant.
alter table public.stock_movement
  add constraint stock_movement_reassign_requires_driver_check
  check (
    movement_type not in ('reassign_from_driver', 'reassign_to_driver')
    or driver_id is not null
  )
  not valid;

-- ────────────────────────────────────────────────────────────
-- (2b) post_stock_movement : + branches reassign_from_driver / reassign_to_driver
--   Corps reproduit À L'IDENTIQUE de 0043 (garde NULL-safe, p_received_value,
--   CUMP) ; seules les deux nouvelles branches CASE et la garde « reassign
--   requires a driver » sont ajoutées. create or replace PRÉSERVE les grants.
-- ────────────────────────────────────────────────────────────
create or replace function public.post_stock_movement(
  p_merchant_account_id uuid,
  p_product_id          uuid,
  p_movement_type       text,
  p_qty                 integer,          -- signé : négatif pour dispatch/release/allocate/reassign_to
  p_idempotency_key     text,
  p_created_by          uuid,
  p_order_id            uuid    default null,
  p_transition_id       uuid    default null,
  p_unit_cost           bigint  default null,   -- obligatoire pour purchase_in (stocké dans ledger)
  p_received_value      bigint  default null,   -- valeur atterrie exacte (purchase_in lot) → numérateur CUMP
  p_reason              text    default null,
  p_driver_id           uuid    default null    -- livreur attribué (lot, commande ou réassignation)
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

  -- Les mouvements de réassignation exigent un livreur (sortant / entrant).
  if p_movement_type in ('reassign_from_driver', 'reassign_to_driver')
     and p_driver_id is null
  then
    raise exception 'reassign movement requires a driver'
      using errcode = 'P0001';
  end if;

  -- Guard tenant : le produit doit appartenir au merchant déclaré.
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

    when 'reassign_from_driver' then
      -- Réassignation : stock repris au livreur sortant → retour entrepôt.
      -- p_qty POSITIF. RÉSERVE INTACTE : la réservation a déjà été consommée
      -- au dispatch initial (un courier_return standard la laisse aussi intacte).
      v_new_on_hand := v_stock.qty_on_hand + p_qty;

    when 'reassign_to_driver' then
      -- Réassignation : stock confié au livreur entrant → sortie entrepôt.
      -- p_qty NÉGATIF. RÉSERVE INTACTE — NE PAS redécrémenter qty_reserved
      -- (≠ dispatch) : la projection est partagée entre toutes les commandes du
      -- produit, et la réservation de CETTE commande a déjà été consommée au
      -- dispatch d'origine. Snapshot CUMP (parité dispatch, valorisation).
      v_new_on_hand := greatest(0, v_stock.qty_on_hand + p_qty);
      update public.stock_movement
         set unit_cost = v_stock.unit_cost
       where id = v_movement_id;

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

-- ────────────────────────────────────────────────────────────
-- (2c) reconcile_product_stock / rebuild_product_stock : + types réassignation
--   Corps reproduit de 0032 ; ajout de reassign_from_driver / reassign_to_driver
--   aux listes IN (ils NETtent à zéro sur qty_on_hand mais doivent être comptés
--   pour que le ledger reste la source de vérité complète). create or replace
--   PRÉSERVE les revoke de 0043 (public/anon/authenticated) → pas de re-grant.
-- ────────────────────────────────────────────────────────────
create or replace function public.reconcile_product_stock()
returns table (
  product_id           uuid,
  merchant_account_id  uuid,
  stored_qty_on_hand   integer,
  ledger_qty_on_hand   integer,
  delta                integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with ledger as (
    select
      sm.product_id,
      sm.merchant_account_id,
      coalesce(sum(sm.qty), 0)::integer as ledger_qty
    from public.stock_movement sm
    where sm.movement_type in (
      'purchase_in',
      'dispatch',
      'courier_return',
      'manual_adjustment',
      'allocate_to_courier',
      'courier_return_lot',
      'reassign_from_driver',
      'reassign_to_driver'
    )
    group by sm.product_id, sm.merchant_account_id
  ),
  discrepancies as (
    select
      ps.product_id,
      ps.merchant_account_id,
      ps.qty_on_hand                              as stored,
      coalesce(l.ledger_qty, 0)                   as ledger,
      ps.qty_on_hand - coalesce(l.ledger_qty, 0)  as delta
    from public.product_stock ps
    left join ledger l
      on l.product_id          = ps.product_id
     and l.merchant_account_id = ps.merchant_account_id
    where ps.qty_on_hand <> coalesce(l.ledger_qty, 0)
  )
  select
    d.product_id,
    d.merchant_account_id,
    d.stored,
    d.ledger,
    d.delta
  from discrepancies d;

  -- Persiste les écarts dans la table d'alerte.
  insert into public.stock_reconciliation_alert (
    merchant_account_id, product_id,
    stored_qty_on_hand, ledger_qty_on_hand, delta
  )
  with ledger as (
    select
      sm.product_id,
      sm.merchant_account_id,
      coalesce(sum(sm.qty), 0)::integer as ledger_qty
    from public.stock_movement sm
    where sm.movement_type in (
      'purchase_in',
      'dispatch',
      'courier_return',
      'manual_adjustment',
      'allocate_to_courier',
      'courier_return_lot',
      'reassign_from_driver',
      'reassign_to_driver'
    )
    group by sm.product_id, sm.merchant_account_id
  )
  select
    ps.merchant_account_id,
    ps.product_id,
    ps.qty_on_hand,
    coalesce(l.ledger_qty, 0),
    ps.qty_on_hand - coalesce(l.ledger_qty, 0)
  from public.product_stock ps
  left join ledger l
    on l.product_id          = ps.product_id
   and l.merchant_account_id = ps.merchant_account_id
  where ps.qty_on_hand <> coalesce(l.ledger_qty, 0);
end;
$$;

create or replace function public.rebuild_product_stock()
returns integer   -- nombre de lignes reconstruites
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with ledger as (
    select
      sm.product_id,
      sm.merchant_account_id,
      coalesce(sum(sm.qty), 0)::integer as ledger_qty
    from public.stock_movement sm
    where sm.movement_type in (
      'purchase_in',
      'dispatch',
      'courier_return',
      'manual_adjustment',
      'allocate_to_courier',
      'courier_return_lot',
      'reassign_from_driver',
      'reassign_to_driver'
    )
    group by sm.product_id, sm.merchant_account_id
  )
  update public.product_stock ps
     set qty_on_hand = l.ledger_qty,
         updated_at  = now()
    from ledger l
   where l.product_id          = ps.product_id
     and l.merchant_account_id = ps.merchant_account_id
     and ps.qty_on_hand        <> l.ledger_qty;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- (3) reassign_order_driver : swap atomique + compensation stock
-- ────────────────────────────────────────────────────────────
-- SECURITY INVOKER : l'UPDATE orders et l'INSERT order_state_transition passent
-- sous la RLS de l'appelant (owner/manager — borne agent via cod_status, mais
-- l'action TS exige déjà requireRole('owner','manager')). post_stock_movement
-- (DEFINER) re-vérifie l'appartenance tenant via current_member_role.
--
-- Règles :
--   * delivery_state ∈ {scheduled, assigned, out_for_delivery} ; JAMAIS delivered
--     (cash figé sur X), ni failed/returned (terminal).
--   * scheduled (pré-dispatch) → simple swap, AUCUN mouvement.
--   * assigned / out_for_delivery (dispatch déjà posté) → par ligne matched :
--       reassign_from_driver (livreur sortant, +qty)  PUIS
--       reassign_to_driver   (livreur entrant,  −qty)
--     dans la MÊME transaction. Net entrepôt = 0 ; attribution X→Y.
--   * Clés d'idempotence ancrées sur un transition_id FRAIS (uuid par
--     réassignation) → uniques par événement, jamais dédupliquées contre le
--     dispatch d'origine.
--   * Retransfert cash/livraison : automatique par dérivation du
--     assigned_driver_id courant (aucune écriture cash ici).
create or replace function public.reassign_order_driver(
  p_order_id   uuid,
  p_actor      uuid,
  p_new_driver uuid,
  p_note       text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order         public.orders%rowtype;
  v_old_driver    uuid;
  v_transition_id uuid;
  v_line          record;
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

  -- Le nouveau livreur doit appartenir au tenant (le chemin scheduled n'appelle
  -- pas post_stock_movement, donc on valide explicitement ici aussi).
  if not exists (
    select 1 from public.driver
    where id = p_new_driver
      and merchant_account_id = v_order.merchant_account_id
  ) then
    raise exception 'driver not found for this merchant account'
      using errcode = 'P0002';
  end if;

  -- Réassignation autorisée uniquement en cours de livraison (jamais terminale).
  if v_order.delivery_state not in ('scheduled', 'assigned', 'out_for_delivery') then
    raise exception 'reassign_not_allowed_in_state'
      using errcode = '22023';
  end if;

  v_old_driver := v_order.assigned_driver_id;

  -- No-op : même livreur (idempotent, aucune écriture).
  if v_old_driver is not distinct from p_new_driver then
    return;
  end if;

  -- Swap du livreur. assigned_driver_id n'est PAS une dimension d'état : aucune
  -- des 4 dimensions ne change, cod_status reste identique (trigger re-dérive
  -- la même valeur) → WITH CHECK orders_update satisfait pour owner/manager.
  update public.orders
     set assigned_driver_id = p_new_driver,
         updated_at         = now()
   where id = p_order_id;

  -- Ancre d'audit + idempotence (cod_status inchangé : from = to).
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
    v_order.cod_status,
    p_actor,
    coalesce(p_note, 'Réassignation livreur'),
    now()
  )
  returning id into v_transition_id;

  -- Compensation stock UNIQUEMENT si le dispatch est déjà posté
  -- (assigned / out_for_delivery). En scheduled : simple swap, rien d'autre.
  if v_order.delivery_state in ('assigned', 'out_for_delivery') then
    -- Garde : un état dispatché DOIT avoir eu un livreur (invariant 0057).
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
      -- 1. Reprise au livreur sortant X → retour entrepôt (+qty, réserve intacte).
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

      -- 2. Remise au livreur entrant Y → sortie entrepôt (−qty, réserve intacte).
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
  end if;
end;
$$;

grant execute on function public.reassign_order_driver(uuid, uuid, uuid, text)
  to authenticated;

-- ────────────────────────────────────────────────────────────
-- (+) get_dashboard_kpi : CA collecté NET de livraison
--   Réécriture de 0057 — SEUL changement : v_ca_collecte_7j soustrait
--   delivery_fee_minor. Tout le reste (fixes dimensionnels/dispatch, a_appeler,
--   taux, sparkline, clés jsonb) reproduit À L'IDENTIQUE → toDashboardKpi inchangé.
-- ────────────────────────────────────────────────────────────
create or replace function get_dashboard_kpi(p_merchant_id uuid)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_a_appeler_count     integer;
  v_a_appeler_yesterday integer;
  v_ca_collecte_7j      numeric;
  v_ca_en_attente       numeric;
  v_taux_confirmation   numeric;
  v_taux_livraison      numeric;
  v_sparkline           jsonb;
begin

  select count(*) into v_a_appeler_count
  from orders
  where merchant_account_id = p_merchant_id
    and cod_status = 'A_APPELER';

  select count(*) into v_a_appeler_yesterday
  from orders
  where merchant_account_id = p_merchant_id
    and cod_status = 'A_APPELER'
    and created_at < now() - interval '1 day';

  -- CA collecté (7 j) NET de livraison : encaissement réel (cash_collected_at),
  -- moins les frais de livraison (le livreur garde ces frais → hors CA marchand).
  select coalesce(sum(total_amount - coalesce(delivery_fee_minor, 0)), 0)
    into v_ca_collecte_7j
  from orders
  where merchant_account_id = p_merchant_id
    and cash_collected_at is not null
    and cash_collected_at >= now() - interval '7 days';

  -- CA à livrer (attendu) — dimension cash : cash_state='expected'.
  select coalesce(sum(coalesce(cash_collectable_minor, round(total_amount))), 0)
    into v_ca_en_attente
  from orders
  where merchant_account_id = p_merchant_id
    and cash_state = 'expected';

  select
    case
      when count(*) = 0 then 0
      else round(
        count(*) filter (
          where exists (
            select 1 from order_state_transition ost
            where ost.order_id = o.id
              and ost.to_status = 'CONFIRMEE'
          )
        ) * 100.0 / count(*), 2
      )
    end into v_taux_confirmation
  from orders o
  where o.merchant_account_id = p_merchant_id
    and o.created_at >= now() - interval '30 days';

  select
    case
      when (
        count(*) filter (where cod_status = 'LIVREE') +
        count(*) filter (
          where cod_status in ('REFUSEE', 'ANNULEE')
          and exists (
            select 1 from order_state_transition ost
            where ost.order_id = id
              and ost.to_status = 'CONFIRMEE'
          )
        )
      ) = 0 then 0
      else round(
        count(*) filter (where cod_status = 'LIVREE') * 100.0 / (
          count(*) filter (where cod_status = 'LIVREE') +
          count(*) filter (
            where cod_status in ('REFUSEE', 'ANNULEE')
            and exists (
              select 1 from order_state_transition ost
              where ost.order_id = id
                and ost.to_status = 'CONFIRMEE'
            )
          )
        ), 2
      )
    end into v_taux_livraison
  from orders
  where merchant_account_id = p_merchant_id;

  -- Sparkline 7 j — CA collecté par jour, indexé sur cash_collected_at (net livraison).
  select jsonb_agg(
    jsonb_build_object('date', day::date, 'value', coalesce(daily_total, 0))
    order by day
  ) into v_sparkline
  from (
    select generate_series(
      date_trunc('day', now()) - interval '6 days',
      date_trunc('day', now()),
      interval '1 day'
    ) as day
  ) days
  left join (
    select date_trunc('day', cash_collected_at) as order_day,
           sum(total_amount - coalesce(delivery_fee_minor, 0)) as daily_total
    from orders
    where merchant_account_id = p_merchant_id
      and cash_collected_at is not null
      and cash_collected_at >= now() - interval '7 days'
    group by 1
  ) totals on totals.order_day = days.day;

  return jsonb_build_object(
    'a_appeler_count', v_a_appeler_count,
    'a_appeler_delta', v_a_appeler_count - v_a_appeler_yesterday,
    'ca_collecte_7j', v_ca_collecte_7j,
    'ca_en_attente', v_ca_en_attente,
    'taux_confirmation', v_taux_confirmation,
    'taux_livraison', v_taux_livraison,
    'sparkline_7j', v_sparkline
  );
end;
$$;
