-- ============================================================================
-- 0145 — Lot F1 : Socle de données Finances v2 (rentabilité par arrivage)
-- ============================================================================
-- Additive uniquement. Rien de l'existant (cash collecté, cash livreur, cash à
-- remettre, écarts, retours, rapprochement, purchase_lot/purchase_lot_line,
-- unit_cost, CUMP) n'est retiré ni renommé. Ce lot ajoute une couche de
-- rentabilité au-dessus du module de trésorerie existant.
--
-- CE QUI EXISTE DÉJÀ (vérifié par lecture, non dupliqué ici) :
--   * purchase_lot.transport_total (0053) — montant total transport d'un
--     arrivage. Déjà là.
--   * purchase_lot.allocation_method (0033) — check in ('value','quantity',
--     'weight'), déjà un attribut modifiable de l'arrivage. Déjà là.
--   * purchase_lot_line.landed_unit_cost / purchase_price_total (0033/0053) —
--     coût de revient figé À LA RÉCEPTION (alimente product_stock.unit_cost,
--     le CUMP). Frozen, jamais retouché ici.
--   * product.unit_cost / product_stock.unit_cost (CUMP, 0033) — inchangés.
-- Seul manque réel : AUCUNE colonne de poids nulle part → la méthode 'weight'
-- existe en base comme libellé autorisé mais n'a jamais eu de donnée derrière.
--
-- ÉVÉNEMENT TERMINAL « livrée et encaissée » (établi par lecture du code, pas
-- supposé) : order_state='completed' AND call_state='validated' AND
-- delivery_state='delivered' AND cash_state='collected'. C'est exactement la
-- condition qui garde l'écriture de cash_collected_at dans transition_order
-- (0096/0114/0116/0139 : `v_next_delivery_state='delivered' and
-- v_next_cash_state='collected' and cash_collected_at is null`) — la même garde
-- d'idempotence est réutilisée ici pour l'allocation FIFO (une seule fois par
-- commande, jamais réécrite par une transition ultérieure).
-- Sorties de cet état, déjà gardées par transition_order :
--   * mark_returned (RTO réel) : condition déjà utilisée pour la reprise de
--     cash (`v_order.order_state='completed' and v_order.delivery_state=
--     'delivered' and v_next_order_state='returned' and
--     v_next_delivery_state='returned'`) — pose une ligne order_state_transition
--     normale.
--   * invalider (`p_invalidate_delivered`) — n'écrit NI audit_log NI
--     order_state_transition (exception délibérée, 0116/CLAUDE.md). L'allocation
--     FIFO suit le même régime que le ledger de stock sur ce chemin :
--     v_movement_transition_id vaut NULL (jamais un UUID fantôme, qui violerait
--     la FK vers order_state_transition).
--
-- ARCHITECTURE DU LOT :
--   1. purchase_lot_line.weight_grams — colonne manquante identifiée ci-dessus.
--   2. product_ad_spend — dépenses publicitaires, manuel aujourd'hui, champs
--      source/external_ref posés pour un futur connecteur (F2a reste 100% manuel).
--   3. purchase_lot_line_allocation — allocation FIFO persistée (quantité, pas
--      coût). Table de LEDGER signé (même motif que stock_movement/0116 pour
--      les contre-passations) : jamais de suppression, une sortie de l'état
--      reconnu insère une ligne négative compensatoire.
--   4. purchase_lot_cost_correction — piste d'audit des corrections de prix
--      d'achat / transport, jamais des quantités.
--   5. correct_purchase_lot_cost — RPC SECURITY DEFINER owner-only qui écrit la
--      correction ET son audit dans la même transaction. Ne touche jamais qty,
--      landed_unit_cost figé, product_stock ni le CUMP — la marge se RE-DÉRIVE
--      à la lecture (couche TS de ce lot), jamais un montant réparti figé.
--   6. transition_order — CREATE OR REPLACE À SIGNATURE IDENTIQUE (20 arguments,
--      inchangée), donc l'ACL existante (0067/0114/0139) est préservée
--      automatiquement (règle du projet : un CREATE OR REPLACE à signature
--      identique ne rouvre PAS l'EXECUTE à PUBLIC — seuls DROP+CREATE le
--      feraient). SECURITY/VOLATILITY/PARALLEL/SEARCH_PATH sont réaffirmés
--      explicitement ci-dessous car CREATE OR REPLACE ne les préserve pas.
--      Corps repris VERBATIM de 0139 (dernière version vivante), deux blocs
--      ajoutés : allocation à l'entrée dans l'état reconnu, réversion à la
--      sortie (retour ou invalidation). Aucune autre ligne modifiée.
--
-- PAS DE BACKFILL — donc pas de préflight bloquant : toutes les colonnes
-- nouvelles sont nullables sur les tables existantes, toutes les tables
-- nouvelles démarrent vides. Une commande déjà « livrée et encaissée » avant ce
-- lot n'obtient PAS d'allocation FIFO rétroactive — seule la PROCHAINE
-- transition d'une commande (nouvelle livraison, ou sortie d'un état déjà
-- atteint) en pose une. Gap connu et accepté, cohérent avec le hors-périmètre
-- du lot (aucun nettoyage, aucun backfill).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1. purchase_lot_line.weight_grams — nullable, conditionne la disponibilité de
--    la méthode de répartition 'weight' (vérifié côté TS, jamais en base : la
--    méthode reste un simple libellé autorisé par le check existant, la donnée
--    manquante rend seulement le calcul dérivé incapable de produire un
--    résultat pour cette méthode — décision déjà actée par le check existant).
-- ────────────────────────────────────────────────────────────────────────────

alter table public.purchase_lot_line
  add column if not exists weight_grams integer;

alter table public.purchase_lot_line
  add constraint purchase_lot_line_weight_grams_nonnegative
  check (weight_grams is null or weight_grams >= 0)
  not valid;

grant select (weight_grams) on public.purchase_lot_line to authenticated;
grant insert (weight_grams) on public.purchase_lot_line to authenticated;
grant update (weight_grams) on public.purchase_lot_line to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2. product_ad_spend — dépenses publicitaires par produit, sur la fenêtre de
--    vie d'un arrivage. F2a est entièrement manuel (source='manuel' partout) ;
--    source/external_ref existent pour ne pas fermer la porte à un connecteur
--    (Meta/TikTok) sans migration de données plus tard.
-- ────────────────────────────────────────────────────────────────────────────

create table public.product_ad_spend (
  id                    uuid primary key default gen_random_uuid(),
  merchant_account_id   uuid not null references public.merchant_account(id) on delete cascade,
  shop_id               uuid not null,
  product_id            uuid not null references public.product(id) on delete cascade,
  -- Attribution à un arrivage précis (facultative — le chevauchement de deux
  -- arrivages du même produit n'arrive pas, cf. décision du fondateur ; ce lien
  -- reste nullable pour couvrir une dépense saisie avant qu'un arrivage existe,
  -- ou volontairement rattachée par fenêtre explicite plutôt que par lot).
  purchase_lot_id       uuid references public.purchase_lot(id) on delete set null,
  -- Fenêtre explicite, modifiable — par défaut dérivée à la lecture de
  -- purchase_lot.received_at → épuisement du lot (calcul TS, jamais stocké
  -- figé ici). Un override explicite prime quand renseigné.
  window_start          date,
  window_end            date,
  amount_minor           bigint not null check (amount_minor >= 0),
  spent_at               date not null,
  source                 text not null default 'manuel' check (source in ('manuel', 'connecteur')),
  external_ref            text,
  created_by              uuid not null references auth.users(id),
  created_at              timestamptz not null default now(),
  constraint product_ad_spend_window_order_check
    check (window_end is null or window_start is null or window_end >= window_start),
  constraint product_ad_spend_shop_tenant_fk
    foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id)
);

-- Unicité de external_ref dans son périmètre (compte + boutique) quand fourni ;
-- aucune contrainte quand il est nul (plusieurs saisies manuelles sans ref).
create unique index product_ad_spend_external_ref_unique
  on public.product_ad_spend (merchant_account_id, shop_id, external_ref)
  where external_ref is not null;

create index product_ad_spend_product_idx
  on public.product_ad_spend (product_id);

create index product_ad_spend_purchase_lot_idx
  on public.product_ad_spend (purchase_lot_id)
  where purchase_lot_id is not null;

create index product_ad_spend_merchant_account_idx
  on public.product_ad_spend (merchant_account_id, shop_id);

-- Intégrité produit/lot ↔ compte/boutique — même motif que
-- assert_purchase_lot_line_integrity (0138) : le produit (et le lot, s'il est
-- renseigné) sont chargés PAR LE TRIGGER, jamais déduits des colonnes new.*
-- envoyées par le client, qui ne prouvent jamais l'appartenance réelle.
create or replace function public.assert_product_ad_spend_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product_merchant_account_id uuid;
  v_product_shop_id             uuid;
  v_lot_merchant_account_id     uuid;
  v_lot_shop_id                 uuid;
begin
  select merchant_account_id, shop_id
    into v_product_merchant_account_id, v_product_shop_id
    from public.product
   where id = new.product_id;

  if not found then
    raise exception 'product_id % not found', new.product_id
      using errcode = 'P0002';
  end if;

  if v_product_merchant_account_id <> new.merchant_account_id then
    raise exception 'product_ad_spend.merchant_account_id must match product_id'
      using errcode = 'P0001';
  end if;

  if v_product_shop_id is distinct from new.shop_id then
    raise exception 'product_ad_spend.shop_id must match product_id'
      using errcode = 'P0001';
  end if;

  if new.purchase_lot_id is not null then
    select merchant_account_id, shop_id
      into v_lot_merchant_account_id, v_lot_shop_id
      from public.purchase_lot
     where id = new.purchase_lot_id;

    if not found then
      raise exception 'purchase_lot_id % not found', new.purchase_lot_id
        using errcode = 'P0002';
    end if;

    if v_lot_merchant_account_id <> new.merchant_account_id then
      raise exception 'product_ad_spend.purchase_lot_id must belong to the same merchant_account_id'
        using errcode = 'P0001';
    end if;

    if v_lot_shop_id is distinct from new.shop_id then
      raise exception 'product_ad_spend.purchase_lot_id must belong to the same shop_id'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create trigger product_ad_spend_assert_integrity
  before insert or update on public.product_ad_spend
  for each row execute function public.assert_product_ad_spend_integrity();

alter table public.product_ad_spend enable row level security;
alter table public.product_ad_spend force row level security;

-- Owner-only : une dépense publicitaire est une donnée de marge, au même titre
-- que purchase_lot (déjà owner-only, cf. 0033/0127).
create policy product_ad_spend_select on public.product_ad_spend
  for select
  using (
    public.current_member_role(merchant_account_id) is not null
    and public.current_shop_role(shop_id) = 'owner'
  );

create policy product_ad_spend_insert on public.product_ad_spend
  for insert
  with check (
    public.current_member_role(merchant_account_id) is not null
    and public.current_shop_role(shop_id) = 'owner'
    and created_by = auth.uid()
  );

create policy product_ad_spend_update on public.product_ad_spend
  for update
  using (
    public.current_member_role(merchant_account_id) is not null
    and public.current_shop_role(shop_id) = 'owner'
  )
  with check (
    public.current_member_role(merchant_account_id) is not null
    and public.current_shop_role(shop_id) = 'owner'
  );

revoke all on public.product_ad_spend from public, anon, authenticated;

grant select (
  id, merchant_account_id, shop_id, product_id, purchase_lot_id,
  window_start, window_end, amount_minor, spent_at, source, external_ref,
  created_by, created_at
) on public.product_ad_spend to authenticated;

grant insert (
  merchant_account_id, shop_id, product_id, purchase_lot_id,
  window_start, window_end, amount_minor, spent_at, source, external_ref,
  created_by
) on public.product_ad_spend to authenticated;

grant update (
  purchase_lot_id, window_start, window_end, amount_minor, spent_at,
  source, external_ref
) on public.product_ad_spend to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3. purchase_lot_line_allocation — allocation FIFO persistée (contrat F0).
--    Ledger SIGNÉ : une ligne posée à l'événement terminal (reason='sale'),
--    jamais supprimée ; une sortie de l'état reconnu (retour, invalidation)
--    pose une ligne compensatoire de signe opposé (reason='return'/
--    'invalidation'). Invariant permanent : pour un order_line donné,
--    sum(qty) = quantité actuellement reconnue vendue (0 si non reconnue,
--    qty de la ligne si reconnue) — prouvé par test, pas par contrainte SQL
--    (invariant agrégé, pas exprimable en CHECK par ligne).
-- ────────────────────────────────────────────────────────────────────────────

create table public.purchase_lot_line_allocation (
  id                       uuid primary key default gen_random_uuid(),
  merchant_account_id      uuid not null references public.merchant_account(id) on delete cascade,
  shop_id                  uuid not null,
  order_id                 uuid not null references public.orders(id) on delete cascade,
  order_line_id            uuid not null references public.order_line(id) on delete cascade,
  purchase_lot_line_id     uuid not null references public.purchase_lot_line(id) on delete restrict,
  qty                      integer not null check (qty <> 0),
  reason                   text not null check (reason in ('sale', 'return', 'invalidation')),
  -- NULL uniquement sur le chemin d'invalidation (0116 : aucune ligne
  -- order_state_transition n'existe pour ce geste — même régime que
  -- stock_movement.transition_id sur ce chemin).
  recognized_transition_id uuid references public.order_state_transition(id) on delete set null,
  created_by               uuid not null references auth.users(id),
  created_at               timestamptz not null default now(),
  constraint purchase_lot_line_allocation_shop_tenant_fk
    foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id)
);

create index purchase_lot_line_allocation_order_line_idx
  on public.purchase_lot_line_allocation (order_line_id);

create index purchase_lot_line_allocation_lot_line_idx
  on public.purchase_lot_line_allocation (purchase_lot_line_id);

create index purchase_lot_line_allocation_order_idx
  on public.purchase_lot_line_allocation (order_id);

create index purchase_lot_line_allocation_merchant_account_idx
  on public.purchase_lot_line_allocation (merchant_account_id, shop_id);

-- Intégrité : order_line et purchase_lot_line référencés doivent partager le
-- même compte/boutique que la ligne d'allocation elle-même — chargés PAR LE
-- TRIGGER depuis leurs parents autoritaires (order_line → orders, purchase_lot_line
-- → purchase_lot), jamais déduits des colonnes new.* du client. Cette table
-- n'est cependant jamais alimentée par un appel PostgREST direct dans ce lot
-- (seul transition_order, SECURITY INVOKER, y écrit) — le trigger reste une
-- défense en profondeur, sur le modèle 0138.
create or replace function public.assert_purchase_lot_line_allocation_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_line_merchant_account_id uuid;
  v_order_line_shop_id             uuid;
  v_order_line_order_id            uuid;
  v_lot_line_merchant_account_id   uuid;
  v_lot_line_shop_id               uuid;
begin
  select merchant_account_id, shop_id, order_id
    into v_order_line_merchant_account_id, v_order_line_shop_id, v_order_line_order_id
    from public.order_line
   where id = new.order_line_id;

  if not found then
    raise exception 'order_line_id % not found', new.order_line_id
      using errcode = 'P0002';
  end if;

  if v_order_line_order_id <> new.order_id then
    raise exception 'purchase_lot_line_allocation.order_id must match order_line_id'
      using errcode = 'P0001';
  end if;

  if v_order_line_merchant_account_id <> new.merchant_account_id then
    raise exception 'purchase_lot_line_allocation.merchant_account_id must match order_line_id'
      using errcode = 'P0001';
  end if;

  if v_order_line_shop_id is distinct from new.shop_id then
    raise exception 'purchase_lot_line_allocation.shop_id must match order_line_id'
      using errcode = 'P0001';
  end if;

  select merchant_account_id, shop_id
    into v_lot_line_merchant_account_id, v_lot_line_shop_id
    from public.purchase_lot_line
   where id = new.purchase_lot_line_id;

  if not found then
    raise exception 'purchase_lot_line_id % not found', new.purchase_lot_line_id
      using errcode = 'P0002';
  end if;

  if v_lot_line_merchant_account_id <> new.merchant_account_id then
    raise exception 'purchase_lot_line_allocation.merchant_account_id must match purchase_lot_line_id'
      using errcode = 'P0001';
  end if;

  if v_lot_line_shop_id is distinct from new.shop_id then
    raise exception 'purchase_lot_line_allocation.shop_id must match purchase_lot_line_id'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger purchase_lot_line_allocation_assert_integrity
  before insert or update on public.purchase_lot_line_allocation
  for each row execute function public.assert_purchase_lot_line_allocation_integrity();

alter table public.purchase_lot_line_allocation enable row level security;
alter table public.purchase_lot_line_allocation force row level security;

-- Visible à owner/manager/agent (comme stock_movement, 0028) : la quantité
-- allouée n'est pas en elle-même une donnée de coût — le coût vit dans
-- purchase_lot_line (owner-only), jamais exposé par cette table de jonction.
-- INSERT ouvert aux trois rôles car transition_order (SECURITY INVOKER)
-- s'exécute sous le rôle de l'acteur qui livre la commande — souvent un agent.
-- Aucune policy UPDATE/DELETE : table de ledger append-only, une sortie de
-- l'état reconnu pose une ligne compensatoire, jamais une modification.
create policy purchase_lot_line_allocation_select on public.purchase_lot_line_allocation
  for select
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  );

create policy purchase_lot_line_allocation_insert on public.purchase_lot_line_allocation
  for insert
  with check (
    public.current_member_role(merchant_account_id) in ('owner', 'manager', 'agent')
  );

revoke all on public.purchase_lot_line_allocation from public, anon, authenticated;

grant select (
  id, merchant_account_id, shop_id, order_id, order_line_id, purchase_lot_line_id,
  qty, reason, recognized_transition_id, created_by, created_at
) on public.purchase_lot_line_allocation to authenticated;

grant insert (
  merchant_account_id, shop_id, order_id, order_line_id, purchase_lot_line_id,
  qty, reason, recognized_transition_id, created_by
) on public.purchase_lot_line_allocation to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4. purchase_lot_cost_correction — piste d'audit des corrections de prix
--    d'achat (purchase_lot_line.purchase_price_total) et de transport
--    (purchase_lot.transport_total). Jamais écrite par un insert direct
--    authenticated — uniquement par correct_purchase_lot_cost (§5), SECURITY
--    DEFINER, dans la même transaction que la correction elle-même.
-- ────────────────────────────────────────────────────────────────────────────

create table public.purchase_lot_cost_correction (
  id                     uuid primary key default gen_random_uuid(),
  merchant_account_id    uuid not null references public.merchant_account(id) on delete cascade,
  shop_id                uuid not null,
  purchase_lot_id        uuid not null references public.purchase_lot(id) on delete cascade,
  -- NULL pour une correction de transport (portée par le lot) ; renseigné pour
  -- une correction de prix d'achat (portée par la ligne).
  purchase_lot_line_id   uuid references public.purchase_lot_line(id) on delete cascade,
  field                  text not null check (field in ('purchase_price_total', 'transport_total')),
  previous_value         bigint not null,
  new_value              bigint not null,
  corrected_by           uuid not null references auth.users(id),
  corrected_at           timestamptz not null default now(),
  constraint purchase_lot_cost_correction_shop_tenant_fk
    foreign key (merchant_account_id, shop_id) references public.shop (merchant_account_id, id),
  constraint purchase_lot_cost_correction_field_scope_check
    check (
      (field = 'transport_total' and purchase_lot_line_id is null)
      or (field = 'purchase_price_total' and purchase_lot_line_id is not null)
    )
);

create index purchase_lot_cost_correction_lot_idx
  on public.purchase_lot_cost_correction (purchase_lot_id);

create index purchase_lot_cost_correction_merchant_account_idx
  on public.purchase_lot_cost_correction (merchant_account_id, shop_id);

alter table public.purchase_lot_cost_correction enable row level security;
alter table public.purchase_lot_cost_correction force row level security;

-- Owner-only lecture. Aucune policy INSERT/UPDATE/DELETE pour authenticated :
-- seule correct_purchase_lot_cost (SECURITY DEFINER, contourne RLS) y écrit.
create policy purchase_lot_cost_correction_select on public.purchase_lot_cost_correction
  for select
  using (
    public.current_member_role(merchant_account_id) is not null
    and public.current_shop_role(shop_id) = 'owner'
  );

revoke all on public.purchase_lot_cost_correction from public, anon, authenticated;

grant select (
  id, merchant_account_id, shop_id, purchase_lot_id, purchase_lot_line_id,
  field, previous_value, new_value, corrected_by, corrected_at
) on public.purchase_lot_cost_correction to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5. correct_purchase_lot_cost — corrige transport_total (lot) ou
--    purchase_price_total (ligne), écrit l'audit, MÊME TRANSACTION. Owner-only
--    (garde NULL-safe, cf. current_member_role() = NULL pour un non-membre).
--    Ne touche JAMAIS qty, landed_unit_cost figé, product_stock ni le CUMP —
--    la marge se re-dérive à la lecture (couche TS de ce lot).
-- ────────────────────────────────────────────────────────────────────────────

create function public.correct_purchase_lot_cost(
  p_merchant_account_id  uuid,
  p_purchase_lot_id      uuid,
  p_purchase_lot_line_id uuid,
  p_field                text,
  p_new_value            bigint,
  p_actor_id             uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role     text;
  v_lot      public.purchase_lot%rowtype;
  v_line     public.purchase_lot_line%rowtype;
  v_previous bigint;
begin
  v_role := public.current_member_role(p_merchant_account_id);
  if v_role is null or v_role <> 'owner' then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if p_field not in ('purchase_price_total', 'transport_total') then
    raise exception 'invalid_field: %', p_field
      using errcode = '22023';
  end if;

  if p_new_value < 0 then
    raise exception 'negative_amount'
      using errcode = '22023';
  end if;

  select * into v_lot
    from public.purchase_lot
   where id = p_purchase_lot_id
     for update;

  if not found or v_lot.merchant_account_id <> p_merchant_account_id then
    raise exception 'purchase_lot not found: %', p_purchase_lot_id
      using errcode = 'P0002';
  end if;

  if p_field = 'transport_total' then
    if p_purchase_lot_line_id is not null then
      raise exception 'transport_total correction must not name a line'
        using errcode = '22023';
    end if;

    v_previous := coalesce(v_lot.transport_total, 0);

    update public.purchase_lot
       set transport_total = p_new_value
     where id = p_purchase_lot_id;
  else
    if p_purchase_lot_line_id is null then
      raise exception 'purchase_price_total correction requires a line'
        using errcode = '22023';
    end if;

    select * into v_line
      from public.purchase_lot_line
     where id = p_purchase_lot_line_id
       and purchase_lot_id = p_purchase_lot_id
       for update;

    if not found then
      raise exception 'purchase_lot_line not found or wrong lot: %', p_purchase_lot_line_id
        using errcode = 'P0002';
    end if;

    v_previous := coalesce(v_line.purchase_price_total, 0);

    update public.purchase_lot_line
       set purchase_price_total = p_new_value
     where id = p_purchase_lot_line_id;
  end if;

  insert into public.purchase_lot_cost_correction (
    merchant_account_id,
    shop_id,
    purchase_lot_id,
    purchase_lot_line_id,
    field,
    previous_value,
    new_value,
    corrected_by
  )
  values (
    p_merchant_account_id,
    v_lot.shop_id,
    p_purchase_lot_id,
    p_purchase_lot_line_id,
    p_field,
    v_previous,
    p_new_value,
    p_actor_id
  );
end;
$$;

revoke all on function public.correct_purchase_lot_cost(
  uuid, uuid, uuid, text, bigint, uuid
) from public, anon, authenticated;

grant execute on function public.correct_purchase_lot_cost(
  uuid, uuid, uuid, text, bigint, uuid
) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6. transition_order — CREATE OR REPLACE, signature IDENTIQUE à 0139 (20
--    arguments). Corps repris VERBATIM de 0139, deux blocs ajoutés :
--      (a) allocation FIFO à l'entrée dans « livrée et encaissée » — même
--          garde que cash_collected_at (v_order.cash_collected_at is null),
--          posée juste après l'insert order_state_transition / v_transition_id ;
--      (b) réversion FIFO à la sortie de cet état — retour (v_transition_id
--          réel) ou invalidation (v_movement_transition_id = NULL, régime
--          déjà en vigueur pour stock_movement.transition_id sur ce chemin).
--    Aucune autre ligne modifiée. SECURITY/VOLATILITY/PARALLEL/SEARCH_PATH
--    réaffirmés explicitement (CREATE OR REPLACE ne les préserve pas).
-- ────────────────────────────────────────────────────────────────────────────

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
          p_actor
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
        p_actor
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
