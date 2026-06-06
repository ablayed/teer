-- ============================================================
-- 0035 : phase6 — finance : dates encaissement/retour + dépenses
-- ============================================================
-- 1. orders.cash_collected_at / returned_at : timestamps pour les
--    agrégats CA mensuel encaissé (finance phase 6).
-- 2. transition_order : set ces deux dates dans la même UPDATE que
--    les dimensions. Seule la clause SET est modifiée — corps copié
--    à l'identique depuis 0031.
-- 3. expense_category : catégories de dépenses par marchand
--    (5 système + catégories libres owner), RLS FORCE owner-only.
-- 4. expense : dépenses manuelles datées, RLS FORCE owner-only.
-- 5. Index finance : stock_movement (sold, courier_return) + orders.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. Nouvelles colonnes sur orders
-- ────────────────────────────────────────────────────────────

alter table public.orders
  add column cash_collected_at timestamptz,
  add column returned_at       timestamptz;

-- Backfill cash_collected_at depuis order_state_transition
-- pour les commandes déjà livrées+encaissées avant 0035.
update public.orders o
   set cash_collected_at = (
     select max(t.created_at)
       from public.order_state_transition t
      where t.order_id = o.id
        and t.to_status = 'LIVREE'
   )
 where o.delivery_state = 'delivered'
   and o.cash_state in ('collected', 'remitted', 'discrepancy')
   and o.cash_collected_at is null;

-- Backfill returned_at depuis order_state_transition
-- pour les commandes déjà retournées avant 0035.
update public.orders o
   set returned_at = (
     select max(t.created_at)
       from public.order_state_transition t
      where t.order_id = o.id
        and t.to_status = 'REFUSEE'
   )
 where o.order_state = 'returned'
   and o.returned_at is null;

-- Index partiels pour les agrégats CA mensuel.
create index orders_cash_collected_idx
  on public.orders (merchant_account_id, cash_collected_at)
  where cash_collected_at is not null;

create index orders_returned_at_idx
  on public.orders (merchant_account_id, returned_at)
  where returned_at is not null;

-- ────────────────────────────────────────────────────────────
-- 2. transition_order : set cash_collected_at + returned_at
-- ────────────────────────────────────────────────────────────
-- Seule la clause SET du UPDATE orders est modifiée par rapport à 0031.
-- Le reste (signature, declares, guards, stock loop) est copié à l'identique.
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

-- ────────────────────────────────────────────────────────────
-- 3. expense_category
-- ────────────────────────────────────────────────────────────

create table public.expense_category (
  id                  uuid        primary key default gen_random_uuid(),
  merchant_account_id uuid        not null references public.merchant_account(id) on delete cascade,
  code                text        not null,
  label_fr            text        not null,
  syscohada_account   text,
  is_system           boolean     not null default false,
  is_active           boolean     not null default true,
  sort_order          integer     not null default 0,
  created_at          timestamptz not null default now(),
  constraint expense_category_code_per_merchant unique (merchant_account_id, code),
  constraint expense_category_code_not_blank    check (btrim(code) <> ''),
  constraint expense_category_label_not_blank   check (btrim(label_fr) <> '')
);

create index expense_category_merchant_idx
  on public.expense_category (merchant_account_id, sort_order);

alter table public.expense_category enable row level security;
alter table public.expense_category force row level security;

create policy expense_category_select
  on public.expense_category
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) = 'owner');

create policy expense_category_insert
  on public.expense_category
  for insert
  to authenticated
  with check (
    public.current_member_role(merchant_account_id) = 'owner'
    and is_system = false
  );

create policy expense_category_update
  on public.expense_category
  for update
  to authenticated
  using  (public.current_member_role(merchant_account_id) = 'owner')
  with check (public.current_member_role(merchant_account_id) = 'owner');

-- Les catégories système ne peuvent pas être supprimées (is_system = false requis).
create policy expense_category_delete
  on public.expense_category
  for delete
  to authenticated
  using (
    public.current_member_role(merchant_account_id) = 'owner'
    and is_system = false
  );

-- ────────────────────────────────────────────────────────────
-- Seed des catégories système par marchand (existants + nouveaux)
-- ────────────────────────────────────────────────────────────

-- Seed pour les marchands existants.
insert into public.expense_category
  (merchant_account_id, code, label_fr, syscohada_account, is_system, sort_order)
select
  ma.id,
  cat.code,
  cat.label_fr,
  cat.syscohada_account,
  true,
  cat.sort_order
from public.merchant_account ma
cross join (values
  ('ADS',           'Publicité',    '627', 1),
  ('DRIVERS',       'Livreurs',     '612', 2),
  ('RENT',          'Loyer',        '622', 3),
  ('SUBSCRIPTIONS', 'Abonnements',  '62',  4),
  ('OTHER',         'Autres',        null,  5)
) as cat(code, label_fr, syscohada_account, sort_order)
on conflict (merchant_account_id, code) do nothing;

-- Trigger : seed automatique pour les nouveaux marchands.
create or replace function public.seed_default_expense_categories()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.expense_category
    (merchant_account_id, code, label_fr, syscohada_account, is_system, sort_order)
  values
    (new.id, 'ADS',           'Publicité',    '627', true, 1),
    (new.id, 'DRIVERS',       'Livreurs',     '612', true, 2),
    (new.id, 'RENT',          'Loyer',        '622', true, 3),
    (new.id, 'SUBSCRIPTIONS', 'Abonnements',  '62',  true, 4),
    (new.id, 'OTHER',         'Autres',        null,  true, 5)
  on conflict (merchant_account_id, code) do nothing;
  return new;
end;
$$;

create trigger merchant_account_seed_expense_categories
  after insert on public.merchant_account
  for each row
  execute function public.seed_default_expense_categories();

-- ────────────────────────────────────────────────────────────
-- 4. expense
-- ────────────────────────────────────────────────────────────

create table public.expense (
  id                  uuid        primary key default gen_random_uuid(),
  merchant_account_id uuid        not null references public.merchant_account(id) on delete cascade,
  category_id         uuid        not null references public.expense_category(id) on delete restrict,
  free_text_category  text,
  amount_minor        bigint      not null,
  spent_at            date        not null,
  note                text,
  created_by          uuid        not null references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint expense_amount_nonnegative check (amount_minor >= 0)
);

create index expense_merchant_spent_at_idx
  on public.expense (merchant_account_id, spent_at);

create index expense_merchant_category_spent_at_idx
  on public.expense (merchant_account_id, category_id, spent_at);

create trigger expense_set_updated_at
  before update on public.expense
  for each row
  execute function public.set_updated_at();

alter table public.expense enable row level security;
alter table public.expense force row level security;

create policy expense_select
  on public.expense
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) = 'owner');

create policy expense_insert
  on public.expense
  for insert
  to authenticated
  with check (public.current_member_role(merchant_account_id) = 'owner');

create policy expense_update
  on public.expense
  for update
  to authenticated
  using  (public.current_member_role(merchant_account_id) = 'owner')
  with check (public.current_member_role(merchant_account_id) = 'owner');

create policy expense_delete
  on public.expense
  for delete
  to authenticated
  using (public.current_member_role(merchant_account_id) = 'owner');

-- ────────────────────────────────────────────────────────────
-- 5. Index finance sur stock_movement
-- ────────────────────────────────────────────────────────────

-- COGS : agréger les mouvements sold (unit_cost × qty) par merchant + période.
create index stock_movement_sold_merchant_created_idx
  on public.stock_movement (merchant_account_id, created_at)
  where movement_type = 'sold';

-- Annulation COGS sur retour : retrouver le sold d'origine pour une commande.
create index stock_movement_courier_return_order_idx
  on public.stock_movement (merchant_account_id, order_id)
  where movement_type = 'courier_return';
