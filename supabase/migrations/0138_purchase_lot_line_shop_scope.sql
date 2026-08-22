-- 0138 : Fuite 3 — purchase_lot_line ignorait la boutique de son produit.
--
-- createPurchaseLotAction/addPurchaseLotLineAction (lib/actions/purchases.ts) posent
-- purchase_lot_line.shop_id correctement (boutique active à la création du lot, puis
-- boutique DU LOT porteur pour toute ligne ajoutée ensuite) mais n'ont jamais confronté
-- le product_id reçu du client à cette boutique. product_id n'est qu'une FK simple vers
-- product(id) (0033), sans composante tenant ni shop. La policy purchase_lot_line_insert
-- (0127) ne vérifie que le rôle sur la boutique DE LA LIGNE écrite, jamais celle du
-- produit référencé — même défaut structurel que 0137 pour product_bundle_component.
--
-- Effet à la réception : receive_purchase_lot (0136:1213-1303) appelle
-- private.post_stock_movement (0136:115-336) avec p_product_id := purchase_lot_line.product_id,
-- SANS aucun paramètre de boutique — ce cœur à 12 arguments n'a pas de notion de boutique
-- attendue, il dérive v_shop_id en relisant product.shop_id (0136:174-178). Le mouvement
-- de stock atterrit donc dans la boutique RÉELLE du produit, potentiellement différente de
-- purchase_lot.shop_id : un lot piloté depuis la boutique A peut écrire dans le ledger de
-- la boutique B si une de ses lignes référence un produit de B.
--
-- Comptage de corruption exécuté en production par le porteur (lecture seule, quatre
-- égalités + orphelins, gabarit identique à celui de 0137) avant ce lot : corrupted_count = 0.
-- Aucune ligne existante à corriger — cette migration ferme uniquement l'écriture future.
--
-- MÉCANISME : trigger, pas FK composite. Une FK composite exigerait deux contraintes
-- UNIQUE redondantes côté purchase_lot et product (index, verrous, coût de déploiement
-- sur des tables existantes) pour un invariant qu'un trigger exprime directement, sur le
-- modèle déjà éprouvé par assert_bundle_component_integrity (0107/0137).
--
-- Le trigger charge LUI-MÊME le lot et le produit référencés par la ligne et compare :
--   lot.merchant_account_id = product.merchant_account_id
--   lot.shop_id              = product.shop_id
-- purchase_lot_line.merchant_account_id/shop_id sont contrôlés séparément contre le lot,
-- mais ne servent JAMAIS de preuve d'appartenance du produit : ces deux colonnes sont
-- forgeables par un appel PostgREST direct (grant insert existant, 0033/0130), et le
-- backfill de 0126 (ligne 362-363) a peuplé purchase_lot_line.shop_id depuis le PRODUIT,
-- pas depuis le lot — la comparaison lot/produit est donc la seule qui protège réellement
-- l'invariant métier ; la comparaison ligne/lot est un contrôle de cohérence additionnel.
--
-- Second défaut fermé : receive_purchase_lot re-vérifie explicitement chaque ligne contre
-- product.shop_id AVANT tout changement de statut et tout mouvement de stock — défense en
-- profondeur, structurellement redondante avec le trigger une fois cette migration en
-- place (aucune ligne stockée ne peut plus diverger), mais indépendante de lui : si une
-- future migration désactivait ou contournait le trigger, cette vérification resterait la
-- dernière barrière avant l'écriture du ledger. private.post_stock_movement (12 arguments)
-- n'a pas de paramètre "boutique attendue" sur lequel s'appuyer — ce concept n'existe que
-- sur la surcharge PUBLIQUE à 13 arguments (0134/0136), jamais appelée par
-- receive_purchase_lot, qui appelle le cœur nu. La vérification vit donc dans
-- receive_purchase_lot elle-même, pas dans une signature qu'on ne peut pas lui passer.

-- ────────────────────────────────────────────────────────────
-- 1. Précondition — même détection complète que l'audit de production, protège contre
--    une dérive entre le comptage humain et ce déploiement. DO block sans exception
--    handler : une raise ici annule la transaction de migration, rollback complet.
-- ────────────────────────────────────────────────────────────

do $$
declare
  v_corrupted_count integer;
begin
  select count(*)
    into v_corrupted_count
    from public.purchase_lot_line pll
    left join public.purchase_lot pl on pl.id = pll.purchase_lot_id
    left join public.product prod on prod.id = pll.product_id
   where pl.id is null
      or prod.id is null
      or pl.merchant_account_id is distinct from pll.merchant_account_id
      or prod.merchant_account_id is distinct from pll.merchant_account_id
      or pl.shop_id is distinct from pll.shop_id
      or prod.shop_id is distinct from pll.shop_id;

  if v_corrupted_count > 0 then
    raise exception 'purchase_lot_line precondition failed: % incoherent row(s) found (tenant/shop mismatch or orphan) — migration 0138 aborted, remediate before retrying',
      v_corrupted_count
      using errcode = 'P0001';
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 2. Trigger — charge lot et produit référencés par la ligne, compare leur tenant et
--    leur boutique. Ne compare product.shop_id qu'à purchase_lot.shop_id (l'ancre
--    autoritaire) ; new.shop_id/new.merchant_account_id sont vérifiés séparément contre
--    le lot, jamais utilisés comme preuve d'appartenance du produit (cf. en-tête).
--    SECURITY DEFINER + search_path vide : même modèle que assert_bundle_component_integrity,
--    nécessaire pour lire purchase_lot/product indépendamment du rôle RLS de l'appelant
--    (une ligne insérée par un owner ne doit pas dépendre de sa propre visibilité RLS sur
--    le lot ou le produit référencés, qui sont déjà garantis par les policies d'INSERT
--    elles-mêmes — ce trigger valide la COHÉRENCE, pas l'autorisation).
-- ────────────────────────────────────────────────────────────

create or replace function public.assert_purchase_lot_line_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lot_merchant_account_id     uuid;
  v_lot_shop_id                 uuid;
  v_product_merchant_account_id uuid;
  v_product_shop_id             uuid;
begin
  select merchant_account_id, shop_id
    into v_lot_merchant_account_id, v_lot_shop_id
    from public.purchase_lot
   where id = new.purchase_lot_id;

  if not found then
    raise exception 'purchase_lot_id % not found'
      , new.purchase_lot_id
      using errcode = 'P0002';
  end if;

  select merchant_account_id, shop_id
    into v_product_merchant_account_id, v_product_shop_id
    from public.product
   where id = new.product_id;

  if not found then
    raise exception 'product_id % not found'
      , new.product_id
      using errcode = 'P0002';
  end if;

  -- Invariant autoritaire : le lot et le produit référencé doivent partager le même
  -- tenant ET la même boutique. C'est la seule comparaison qui protège réellement contre
  -- la fuite — new.shop_id n'y participe pas.
  if v_lot_merchant_account_id <> v_product_merchant_account_id then
    raise exception 'purchase_lot_id and product_id must belong to the same merchant_account_id'
      using errcode = 'P0001';
  end if;

  if v_lot_shop_id is distinct from v_product_shop_id then
    raise exception 'purchase_lot_id and product_id must belong to the same shop_id'
      using errcode = 'P0001';
  end if;

  -- Contrôle de cohérence additionnel : la ligne elle-même doit porter le tenant/boutique
  -- de SON lot (convention déjà respectée par addPurchaseLotLineAction). Ne remplace pas
  -- la comparaison ci-dessus — les deux colonnes ci-dessous sont forgeables par un appel
  -- PostgREST direct et ne prouvent jamais l'appartenance du produit.
  if new.merchant_account_id <> v_lot_merchant_account_id then
    raise exception 'purchase_lot_line.merchant_account_id must match its purchase_lot_id'
      using errcode = 'P0001';
  end if;

  if new.shop_id is distinct from v_lot_shop_id then
    raise exception 'purchase_lot_line.shop_id must match its purchase_lot_id'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists purchase_lot_line_assert_integrity on public.purchase_lot_line;
create trigger purchase_lot_line_assert_integrity
  before insert or update on public.purchase_lot_line
  for each row execute function public.assert_purchase_lot_line_integrity();

-- ────────────────────────────────────────────────────────────
-- 3. receive_purchase_lot — défense en profondeur. La vérification précède tout
--    changement de statut et tout mouvement : elle s'exécute avant la première mutation
--    (l'update de purchase_lot_line existant, plus bas dans la boucle). Au premier
--    conflit, échec transactionnel complet — zéro mouvement posté, lot toujours non reçu.
--
--    CREATE OR REPLACE conserve ownership et ACL de la fonction (pas de drop, aucun grant
--    reposé — leçon 0067), mais PAS security/volatility/search_path : SECURITY DEFINER et
--    SET search_path = '' sont donc réaffirmés explicitement ci-dessous, à l'identique de
--    la version vivante (0136). Corps repris verbatim de 0136:1213-1303, seule addition :
--    la boucle de pré-vérification juste après le chargement du lot.
-- ────────────────────────────────────────────────────────────

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
begin
  if public.current_member_role(p_merchant_account_id) is distinct from 'owner' then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

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

  -- Fuite 3 (0138) : re-vérifie CHAQUE ligne contre product.shop_id avant tout changement
  -- de statut et tout mouvement. Structurellement redondant avec le trigger ci-dessus une
  -- fois cette migration en place (aucune ligne stockée ne peut plus diverger), mais
  -- indépendant de lui : dernière barrière si le trigger était un jour désactivé ou
  -- contourné. p_lines ne porte pas product_id (seulement line_id + dérivés figés) :
  -- la vérification rejoint donc purchase_lot_line/product par line_id.
  for v_elem in select * from jsonb_array_elements(p_lines) loop
    v_line_id := (v_elem->>'line_id')::uuid;

    if exists (
      select 1
        from public.purchase_lot_line pll
        join public.product prod on prod.id = pll.product_id
       where pll.id = v_line_id
         and pll.purchase_lot_id = p_lot_id
         and (
           prod.merchant_account_id <> v_lot.merchant_account_id
           or prod.shop_id is distinct from v_lot.shop_id
         )
    ) then
      raise exception 'purchase_lot_line_shop_conflict: line % references a product outside the lot shop', v_line_id
        using errcode = 'P0001';
    end if;
  end loop;

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
        p_created_by          := p_actor_id,
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
