-- ============================================================================
-- 0150 — Lot S3 (livrable 2) : garde boutique manquante sur receive_purchase_lot
-- ============================================================================
-- Défaut établi par mesure en production (catalogues, pas le texte des
-- migrations — cf. docs/phaseU/S3-INVENTAIRE-RECEIVE-PURCHASE-LOT.md §3) :
--   • receive_purchase_lot est SECURITY DEFINER, propriétaire `postgres`,
--     `rolbypassrls = true` — elle contourne RÉELLEMENT RLS, malgré FORCE ROW
--     LEVEL SECURITY actif sur purchase_lot/purchase_lot_line. Les six
--     politiques `current_shop_role(shop_id) = 'owner'` (montées en boutique
--     par 0127) ne s'appliquent jamais à l'intérieur de cette fonction.
--   • Sa garde interne est restée au niveau COMPTE
--     (`current_member_role(p_merchant_account_id) is distinct from 'owner'`,
--     0043) alors que l'isolation promise depuis 0127 est au niveau BOUTIQUE.
--   • EXECUTE est ouvert à `authenticated`, fermé à `anon` — un owner
--     multi-boutiques du même tenant peut donc appeler cette RPC en PostgREST
--     direct pour réceptionner un arrivage d'une boutique à laquelle il n'a
--     pas (ou plus) accès owner, en contournant entièrement la garde
--     applicative de receiveLotAction (lib/actions/purchases.ts, S3 livrable 1
--     — commit séparé, TypeScript uniquement).
--   • Même motif récurrent que 0147 (correct_purchase_lot_cost) : un
--     identifiant reçu du client (p_lot_id), jamais confronté à son parent
--     autoritaire réel (la boutique), transmis à une opération qui dérive son
--     contexte de cet identifiant même.
--
-- CORRECTION : porter la garde boutique dans le corps de la RPC, avec la
-- relation d'appartenance autoritaire déjà en place — current_shop_role(shop_id)
-- (0126), le même mécanisme que 0147. Aucun shop_id fourni par le client
-- n'entre dans cette décision : le lot porte déjà sa boutique (v_lot.shop_id),
-- chargée par la fonction elle-même AVANT toute comparaison, jamais déduite
-- d'un argument.
--
-- LES DEUX NIVEAUX COEXISTENT — double prédicat, pas un remplacement.
-- La garde compte préexistante (current_member_role) est CONSERVÉE telle
-- quelle, avant le chargement du lot (elle ne dépend pas de v_lot). La garde
-- boutique s'ajoute dans le bloc de vérification du lot, une fois v_lot.shop_id
-- connu — exactement la même position que dans 0147.
--
-- MESSAGE DE REFUS : les trois causes (lot inexistant, lot d'un autre tenant,
-- lot d'une autre boutique du même tenant) sont désormais FUSIONNÉES en un
-- seul message/errcode P0002 (0147 avait déjà fait ce choix ; la version 0043
-- distinguait encore "not found" de "access denied", ce qui aurait confirmé
-- l'existence d'un arrivage hors de portée de l'appelant). current_shop_role
-- est NULL-safe par construction (0126) ; IS DISTINCT FROM traite NULL (aucun
-- shop_member pour cette boutique) comme distinct de 'owner', jamais comme une
-- égalité indéterminée — jamais `<>`, qui laisserait passer un NULL par la
-- logique ternaire (cf. gotcha NULL-safety du projet).
--
-- CREATE OR REPLACE à signature strictement identique (4 arguments,
-- inchangés), SECURITY DEFINER / search_path = '' réaffirmés explicitement —
-- l'ACL existante (mesurée en production avant cette migration : owner
-- postgres/authenticated/service_role, anon fermé) est préservée
-- automatiquement, aucun revoke/grant requis par la règle du projet (qui ne
-- s'applique qu'à un CREATE FUNCTION plein ou à un changement de signature).
-- Corps repris VERBATIM de la version vivante (0136, §7), une seule condition
-- ajoutée dans le bloc de garde du lot.
--
-- AUCUN APPELANT NE CASSE (inventaire S3, §2) : un seul appelant applicatif
-- (receiveLotAction, via ctx.supabase authentifié — jamais le service-role,
-- qui n'a pas d'auth.uid() et serait rejeté par la garde de rôle existante),
-- plus des fichiers de test, tous authentifiés avec auth.uid() renseigné.
-- Aucun cron, aucun script, aucun appelant service-role. Un owner agissant sur
-- un lot de SA PROPRE boutique active n'est pas affecté : la nouvelle
-- condition n'ajoute un refus que lorsque current_shop_role(v_lot.shop_id)
-- n'est PAS 'owner' pour l'appelant courant — un cas qui, avant cette
-- migration, réussissait à tort.
--
-- SECOND DÉFAUT, MÊME FONCTION, MÊME MIGRATION (revue avant fusion) : le même
-- motif que S2 (docs/phaseU/S2-ACTOR-ATTRIBUTION-FIX.md, 0148 sur
-- transition_order) existait ici. `receive_purchase_lot` reçoit `p_actor_id`
-- du CLIENT et le transmet tel quel à `private.post_stock_movement(p_created_by
-- := p_actor_id)`, sans jamais le confronter à `auth.uid()`. Le wrapper public
-- de `post_stock_movement` (0136) porte cette garde depuis toujours
-- (`p_created_by <> v_actor` → forbidden) ; l'appel direct au cœur `private`
-- depuis `receive_purchase_lot` la contourne entièrement — la garde boutique
-- ci-dessus ferme QUI peut réceptionner un lot donné, pas QUI est inscrit
-- comme auteur du mouvement de stock qui en résulte. Un owner légitime de la
-- bonne boutique pouvait donc réceptionner un lot réel en attribuant le
-- mouvement à n'importe quel autre utilisateur (uuid arbitraire, y compris
-- celui d'un autre membre) — traçabilité financière falsifiable sur un
-- mouvement de stock réel (`purchase_in`).
--
-- Fermé en confrontant `p_actor_id` à `auth.uid()` avant toute écriture,
-- NULL-safe (`is distinct from`, jamais `<>` — un `p_actor_id` NULL traverse un
-- `<>` par la logique ternaire, exactement le défaut initial de 0148). La
-- valeur réellement écrite (`v_actor`) remplace `p_actor_id` au seul site
-- d'attribution de cette fonction (`p_created_by`). Signature inchangée :
-- `p_actor_id` reste un paramètre (l'appelant continue de le fournir
-- explicitement, comme receiveLotAction le fait déjà via `ctx.user.id` — jamais
-- une valeur reçue du client), il n'est simplement plus fait confiance sans
-- vérification.
--
-- Audité, pas d'autre site d'attribution dans cette fonction :
-- `purchase_lot.received_at` est une date, pas un acteur ; `receive_purchase_lot`
-- n'écrit aucune ligne `audit_log`. Seul `p_created_by` du mouvement de stock
-- portait le défaut.
-- ============================================================================

create or replace function public.receive_purchase_lot(
  p_lot_id              uuid,
  p_merchant_account_id uuid,
  p_actor_id            uuid,
  p_lines               jsonb
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
  v_actor    uuid;
begin
  if public.current_member_role(p_merchant_account_id) is distinct from 'owner' then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  -- Attribution : p_actor_id est reçu du client, jamais fait autorité tant
  -- qu'il n'est pas confronté à auth.uid() — même défaut que 0148 fermait sur
  -- transition_order. NULL-safe : is distinct from, jamais <>.
  v_actor := auth.uid();
  if v_actor is null or p_actor_id is distinct from v_actor then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  select * into v_lot
  from public.purchase_lot
  where id = p_lot_id
  for update;

  -- Trois causes de refus indissociables : lot inexistant, lot d'un autre
  -- tenant, lot d'une boutique à laquelle l'appelant n'a pas (ou plus) accès
  -- owner. current_shop_role() est SECURITY DEFINER/NULL-safe (0126) ; IS
  -- DISTINCT FROM couvre le cas NULL (aucun shop_member) sans jamais laisser
  -- passer l'appel par une comparaison NULL indéterminée.
  if not found
     or v_lot.merchant_account_id <> p_merchant_account_id
     or public.current_shop_role(v_lot.shop_id) is distinct from 'owner'
  then
    raise exception 'purchase_lot not found or not accessible: %', p_lot_id
      using errcode = 'P0002';
  end if;

  if v_lot.status = 'received' then
    raise exception 'lot already received: %', p_lot_id
      using errcode = 'P0001';
  end if;

  for v_elem in select * from jsonb_array_elements(p_lines) loop
    v_line_id  := (v_elem->>'line_id')::uuid;
    v_line_val := (v_elem->>'line_value')::bigint;
    v_alloc    := (v_elem->>'allocated_fees')::bigint;
    v_landed   := (v_elem->>'landed_total_value')::bigint;
    v_ucost    := (v_elem->>'landed_unit_cost')::bigint;

    select * into v_line_row
    from public.purchase_lot_line
    where id = v_line_id
      and purchase_lot_id = p_lot_id
    for update;

    if not found then
      raise exception 'purchase_lot_line not found or wrong lot: %', v_line_id
        using errcode = 'P0002';
    end if;

    update public.purchase_lot_line
       set line_value         = v_line_val,
           allocated_fees     = v_alloc,
           landed_total_value = v_landed,
           landed_unit_cost   = v_ucost
     where id = v_line_id;

    if v_line_row.qty > 0 then
      perform private.post_stock_movement(
        p_merchant_account_id := p_merchant_account_id,
        p_product_id          := v_line_row.product_id,
        p_movement_type       := 'purchase_in',
        p_qty                 := v_line_row.qty,
        p_idempotency_key     := 'recv:' || p_lot_id::text || ':' || v_line_id::text,
        p_created_by          := v_actor,
        p_unit_cost           := v_ucost,
        p_received_value      := v_landed
      );
    end if;
  end loop;

  update public.purchase_lot
     set status      = 'received',
         received_at = current_date
   where id = p_lot_id;
end;
$$;
