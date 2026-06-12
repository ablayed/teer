-- ============================================================
-- 0053 : Lot C - simplification du modèle Achats (add + backfill only)
-- ============================================================
-- Contexte :
--   Lot C simplifie la saisie d'un lot fournisseur SANS toucher au moteur
--   financier. Trois regroupements de champs :
--     1. Frais : les 4 colonnes (freight/customs/transit/local_transport)
--        deviennent UN seul « Transport » → purchase_lot.transport_total.
--     2. ETA : les 3 délais (supplier_prep + transport + local_buffer) + override
--        deviennent UN seul « délai estimé » → purchase_lot.estimated_lead_time_days.
--     3. Prix : le prix unitaire de ligne devient un prix global de ligne
--        → purchase_lot_line.purchase_price_total.
--
-- INTÉGRITÉ FINANCIÈRE (vérifiée) :
--   * post_stock_movement / receive_purchase_lot / CUMP ne lisent AUCUNE de ces
--     colonnes : ils reçoivent des valeurs déjà calculées par le TS et figées
--     par ligne (line_value, allocated_fees, landed_total_value, landed_unit_cost).
--   * Cette migration n'appelle jamais post_stock_movement → aucun product_stock
--     ni CUMP recalculé. Les lots DÉJÀ REÇUS conservent leurs dérivés figés.
--   * Backfill = somme/produit exact des colonnes existantes (pas d'arrondi).
--
-- STRATÉGIE DROP DIFFÉRÉ :
--   On AJOUTE + BACKFILLE uniquement. Les anciennes colonnes sont CONSERVÉES
--   (et rendues nullable là où nécessaire) pour ne pas casser le build entre le
--   push de 0053 et la réécriture du front (Étape 2/3). Le DROP des colonnes
--   remplacées se fera dans une migration de cleanup ultérieure (0054), une fois
--   le front ne les lisant plus. `unit_purchase_price` est conservé durablement
--   (affichage historique « prix achat/u »).
--
-- Aucune RLS / policy modifiée : mêmes tables, mêmes politiques owner-only.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. purchase_lot : transport_total + estimated_lead_time_days
-- ────────────────────────────────────────────────────────────
-- Nullable d'abord (règle projet). Backfill exact ci-dessous.

alter table public.purchase_lot
  add column if not exists transport_total bigint;

alter table public.purchase_lot
  add column if not exists estimated_lead_time_days int;

-- Backfill : « Transport » unique = somme exacte des 4 frais existants.
update public.purchase_lot
   set transport_total = coalesce(freight_total, 0)
                       + coalesce(customs_total, 0)
                       + coalesce(transit_total, 0)
                       + coalesce(local_transport_total, 0)
 where transport_total is null;

-- Backfill : « délai estimé » en jours ouvrés.
-- L'ETA se recalculant désormais depuis ordered_at + estimated_lead_time_days en
-- jours ouvrés, on PRÉSERVE l'ETA des lots qui avaient un eta_override en dérivant
-- le délai = nombre de jours ouvrés (lun–ven) dans (ordered_at ; eta_override].
-- C'est l'inverse exact de addBusinessDays(ordered_at, N) = eta_override, donc
-- l'ETA affichée reste identique (inclut les lots non encore reçus). Pour les lots
-- sans override valide : somme des 3 composantes de jours existantes.
update public.purchase_lot
   set estimated_lead_time_days = case
     when eta_override is not null and eta_override >= ordered_at then (
       select count(*)::int
       from generate_series(ordered_at + 1, eta_override, interval '1 day') as g(d)
       where extract(isodow from g.d) < 6   -- 1=lundi … 5=vendredi
     )
     else coalesce(supplier_prep_days, 0)
        + coalesce(transport_days, 0)
        + coalesce(local_buffer_days, 0)
   end
 where estimated_lead_time_days is null;

alter table public.purchase_lot
  add constraint purchase_lot_transport_total_nonnegative
  check (transport_total is null or transport_total >= 0)
  not valid;

alter table public.purchase_lot
  add constraint purchase_lot_estimated_lead_time_days_nonnegative
  check (estimated_lead_time_days is null or estimated_lead_time_days >= 0)
  not valid;

-- Grants : aligner les nouvelles colonnes sur le pattern existant (owner via RLS).
grant select (transport_total, estimated_lead_time_days)
  on public.purchase_lot to authenticated;

grant insert (transport_total, estimated_lead_time_days)
  on public.purchase_lot to authenticated;

grant update (transport_total, estimated_lead_time_days)
  on public.purchase_lot to authenticated;

-- ────────────────────────────────────────────────────────────
-- 2. purchase_lot_line : purchase_price_total (prix global de ligne)
-- ────────────────────────────────────────────────────────────
-- Le prix de ligne se saisit désormais en global (montant total de la ligne)
-- plutôt qu'en unitaire × qté. Backfill = qty × unit_purchase_price, ce qui
-- égale exactement le line_value actuel → la répartition des frais (au prorata
-- de line_value) reste identique pour les lots non encore reçus.

alter table public.purchase_lot_line
  add column if not exists purchase_price_total bigint;

update public.purchase_lot_line
   set purchase_price_total = coalesce(qty, 0) * coalesce(unit_purchase_price, 0)
 where purchase_price_total is null;

alter table public.purchase_lot_line
  add constraint purchase_lot_line_purchase_price_total_nonnegative
  check (purchase_price_total is null or purchase_price_total >= 0)
  not valid;

-- unit_purchase_price devient nullable : les nouvelles lignes saisissent un prix
-- global et peuvent omettre l'unitaire. La colonne est conservée (affichage
-- historique). receive_purchase_lot ne lit que qty/product_id → non impacté.
alter table public.purchase_lot_line
  alter column unit_purchase_price drop not null;

grant select (purchase_price_total)
  on public.purchase_lot_line to authenticated;

grant insert (purchase_price_total)
  on public.purchase_lot_line to authenticated;

grant update (purchase_price_total)
  on public.purchase_lot_line to authenticated;
