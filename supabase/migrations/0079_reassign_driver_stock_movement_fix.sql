-- ============================================================
-- 0079 : fix réassignation livreur — reassign_from_driver/reassign_to_driver
--        perdus par 0068/0069 (contrainte + post_stock_movement)
-- ============================================================
-- BUG (diag/reassignation-livreur, instrumentation [reassign]) : reassign_order_driver
-- (0058) insère des stock_movement de type 'reassign_from_driver'/'reassign_to_driver'.
-- 0058 avait élargi stock_movement_type_check ET post_stock_movement (guard + 2
-- branches case) pour ces deux types. 0068 puis 0069 ont recréé les deux objets
-- (create/replace or drop+add) depuis une base ANTÉRIEURE à 0058, perdant
-- silencieusement ces ajouts :
--   - stock_movement_type_check (en vigueur, 0068) : liste sans les 2 types
--     → INSERT stock_movement échoue en 23514 (check violation).
--   - post_stock_movement (en vigueur, 0069) : case sans les 2 branches
--     → si la contrainte seule était élargie, tomberait dans
--       `else raise exception 'unknown stock movement_type: %'` (P0001).
-- Les deux doivent être corrigés ENSEMBLE (corriger l'un sans l'autre laisse la
-- réassignation cassée, juste avec un code d'erreur différent).
--
-- Sens métier (confirmé) : réassigner déplace physiquement le colis d'un livreur
-- à l'autre. reassign_from_driver (+qty, entrepôt reprend le stock de l'ancien
-- livreur) / reassign_to_driver (−qty, l'entrepôt le confie au nouveau) —
-- effet net nul sur qty_on_hand total, réserve intacte des deux côtés (déjà
-- consommée au dispatch initial de la commande).
--
-- Contenu (1 fichier, 2 surfaces) :
--   1. stock_movement_type_check : réintègre reassign_from_driver/reassign_to_driver
--      (liste actuelle 0068/0069 + les 2 types, DROP + ADD comme 0031/0068).
--   2. post_stock_movement : corps repris VERBATIM de 0069 (dernière définition
--      en vigueur) + réintégration du guard « réassignation exige un livreur »
--      et des 2 branches case `reassign_from_driver`/`reassign_to_driver`,
--      reprises VERBATIM de 0058. Signature 12-arg INCHANGÉE → create or replace
--      (ACL préservé ; re-grant explicite par prudence, comme 0068/0069).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. stock_movement_type_check : réintègre les 2 types réassignation
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
      'advance_commit',
      'reassign_from_driver',
      'reassign_to_driver'
    )
  )
  not valid;

-- ────────────────────────────────────────────────────────────
-- 2. post_stock_movement : corps 0069 verbatim + guard/branches reassign (0058)
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

  -- 0079 (réintégré depuis 0058) : les mouvements de réassignation exigent un
  -- livreur (sortant / entrant).
  if p_movement_type in ('reassign_from_driver', 'reassign_to_driver')
     and p_driver_id is null
  then
    raise exception 'reassign movement requires a driver'
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
      -- 0069 : traçabilité avance (compté par avance_dispo) + libération de la
      -- réserve molle correspondant à la part couverte. JAMAIS de mutation de
      -- qty_on_hand (entrepôt déjà débité au allocate_to_courier) ; advance_commit
      -- reste exclu de la main livreur et des allowlists qty_on_hand.
      -- p_qty > 0 (cover à l'assignation) → libère cover de qty_reserved (le
      --   reserve de confirmation est consommé au dispatch, depuis l'avance ici).
      -- p_qty < 0 (compensation désannulation) → greatest(p_qty,0)=0 : la réserve
      --   n'est PAS touchée (le mouvement ne sert qu'à restaurer l'avance dispo).
      v_new_reserved := greatest(0, v_stock.qty_reserved - greatest(p_qty, 0));

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
      -- 0079 (réintégré depuis 0058) : réassignation, stock repris au livreur
      -- sortant → retour entrepôt. p_qty POSITIF. RÉSERVE INTACTE : la
      -- réservation a déjà été consommée au dispatch initial (un courier_return
      -- standard la laisse aussi intacte).
      v_new_on_hand := v_stock.qty_on_hand + p_qty;

    when 'reassign_to_driver' then
      -- 0079 (réintégré depuis 0058) : réassignation, stock confié au livreur
      -- entrant → sortie entrepôt. p_qty NÉGATIF. RÉSERVE INTACTE — NE PAS
      -- redécrémenter qty_reserved (≠ dispatch) : la projection est partagée
      -- entre toutes les commandes du produit, et la réservation de CETTE
      -- commande a déjà été consommée au dispatch d'origine. Snapshot CUMP
      -- (parité dispatch, valorisation).
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

-- Accessible depuis transition_order / reassign_order_driver (INVOKER, rôle
-- authenticated) et depuis les actions autonomes via supabase.rpc().
grant execute on function public.post_stock_movement(
  uuid, uuid, text, integer, text, uuid,
  uuid, uuid, bigint, bigint, text, uuid
) to authenticated;
