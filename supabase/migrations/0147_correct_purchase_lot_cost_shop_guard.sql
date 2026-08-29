-- ============================================================================
-- 0147 — Lot S1 : garde boutique manquante sur correct_purchase_lot_cost
-- ============================================================================
-- Défaut établi par mesure (appel PostgREST direct, session owner, hors
-- l'action TypeScript) : correct_purchase_lot_cost (0145, déjà en prod)
-- confronte p_purchase_lot_id à p_merchant_account_id, mais JAMAIS à la
-- boutique de l'appelant. Un owner multi-boutiques du même tenant peut donc
-- corriger le transport/prix d'achat d'un arrivage d'une boutique à laquelle
-- il n'a plus accès (accès boutique restreint après coup, cf. CLAUDE.md
-- section Workspace). La garde ajoutée dans correctPurchaseLotTransportAction
-- (lib/actions/purchases.ts) ne protège que le chemin applicatif — tout appel
-- REST direct la contourne. C'est le motif récurrent du projet : un
-- identifiant reçu du client, jamais confronté au parent autoritaire, transmis
-- à une opération qui dérive son contexte de cet identifiant même.
--
-- Correction : porter la garde dans le corps de la RPC, avec la relation
-- d'appartenance autoritaire déjà en place pour l'accès par boutique —
-- current_shop_role(shop_id) (0126), le même mécanisme qui gate déjà
-- get_purchase_lot_profitability et la policy purchase_lot_cost_correction_select
-- (0145 lui-même, §4). Aucun shop_id fourni par le client n'entre dans cette
-- décision : le lot porte déjà sa boutique (v_lot.shop_id), chargée par la
-- fonction elle-même, jamais déduite d'un argument.
--
-- CREATE OR REPLACE à signature strictement identique (6 arguments,
-- inchangés) — l'ACL existante est préservée automatiquement (revoke/grant
-- non requis par la règle du projet, qui ne s'applique qu'à un CREATE FUNCTION
-- plein ou à un changement de signature). Corps repris VERBATIM de 0145, une
-- seule condition ajoutée dans le bloc de garde du lot.
--
-- Message de refus : les trois causes (lot inexistant, lot d'un autre tenant,
-- lot d'une autre boutique du même tenant) restent indissociables — même
-- message, même errcode P0002 — jamais de distinction qui confirmerait
-- l'existence d'un arrivage hors de portée de l'appelant. `current_shop_role`
-- est NULL-safe par construction : IS DISTINCT FROM traite NULL (aucun
-- shop_member pour cette boutique) comme distinct de 'owner', jamais comme
-- une égalité indéterminée (cf. gotcha NULL-safety du projet — `NULL <>
-- 'owner'` serait NULL, pas TRUE, et laisserait passer l'appel).
--
-- Audit des autres fonctions de 0145/0146 pour la même lacune (constat, pas
-- correction, cf. prompt) :
--   - assert_product_ad_spend_integrity (0145 §2, trigger) : confronte déjà
--     shop_id au produit chargé par le trigger. Pas de lacune.
--   - assert_purchase_lot_line_allocation_integrity (0145 §3, trigger) :
--     confronte déjà shop_id à order_line ET purchase_lot_line chargés par le
--     trigger. Pas de lacune.
--   - get_purchase_lot_profitability (0146) : SECURITY INVOKER, aucune garde
--     de rôle propre — s'appuie entièrement sur les policies RLS de
--     purchase_lot/purchase_lot_line (owner-only, déjà scopées shop via
--     current_shop_role dans leurs policies). Pas de lacune : cette fonction
--     n'a jamais eu de garde à porter, elle hérite de RLS.
--   - transition_order (0145 §6) : hors périmètre de ce lot, gouverné par la
--     stack de transition (order_state_machine / transition_catalog / RLS
--     orders), déjà audité ailleurs.
--   → correct_purchase_lot_cost est la seule fonction de 0145/0146 qui pose
--     une garde de rôle explicite tout en oubliant la boutique.
-- ============================================================================

create or replace function public.correct_purchase_lot_cost(
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

  -- Trois causes de refus indissociables : lot inexistant, lot d'un autre
  -- tenant, lot d'une boutique à laquelle l'appelant n'a pas (ou plus) accès
  -- owner. current_shop_role() est SECURITY DEFINER/NULL-safe (0126) ; IS
  -- DISTINCT FROM couvre le cas NULL (aucun shop_member) sans jamais laisser
  -- passer l'appel par une comparaison NULL indéterminée.
  if not found
     or v_lot.merchant_account_id <> p_merchant_account_id
     or public.current_shop_role(v_lot.shop_id) is distinct from 'owner'
  then
    raise exception 'purchase_lot not found or not accessible: %', p_purchase_lot_id
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
