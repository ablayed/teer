-- 0137 : Fuite 2 — product_bundle_component ignorait la boutique.
--
-- assert_bundle_component_integrity (0107) ne comparait que merchant_account_id (tenant),
-- jamais shop_id. La policy product_bundle_component_insert (0127) ne vérifie que le rôle
-- sur la boutique DE LA LIGNE insérée, jamais celle du bundle/composant référencés. Un
-- component_product_id — ou un bundle_product_id — appartenant à une autre boutique du
-- même tenant passait donc les deux gardes : à la vente, private.post_stock_movement
-- recharge is_bundle/shop_id du COMPOSANT (0136:174-178) et poste son mouvement dans le
-- ledger de SA boutique réelle, indépendamment de la boutique où le bundle a été vendu.
--
-- Comptage de corruption exécuté en production le 2026-08-22 (lecture seule, quatre
-- égalités + orphelins + les deux invariants is_bundle) : corrupted_count = 0. Aucune
-- ligne existante à corriger — ce lot ferme uniquement l'écriture future.

-- ────────────────────────────────────────────────────────────
-- 1. Précondition — même détection complète que l'audit prod, protège contre une
--    dérive entre le comptage humain et ce déploiement. Toute anomalie fait échouer
--    la migration entière (DO block sans exception handler : une raise ici annule
--    la transaction de migration, rollback complet).
-- ────────────────────────────────────────────────────────────

do $$
declare
  v_corrupted_count integer;
begin
  select count(*)
    into v_corrupted_count
    from public.product_bundle_component pbc
    left join public.product bundle on bundle.id = pbc.bundle_product_id
    left join public.product component on component.id = pbc.component_product_id
   where bundle.id is null
      or component.id is null
      or bundle.merchant_account_id is distinct from pbc.merchant_account_id
      or component.merchant_account_id is distinct from pbc.merchant_account_id
      or bundle.shop_id is distinct from pbc.shop_id
      or component.shop_id is distinct from pbc.shop_id
      or bundle.is_bundle is distinct from true
      or component.is_bundle is distinct from false;

  if v_corrupted_count > 0 then
    raise exception 'product_bundle_component precondition failed: % incoherent row(s) found (tenant/shop/is_bundle mismatch or orphan) — migration 0137 aborted, remediate before retrying',
      v_corrupted_count
      using errcode = 'P0001';
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- 2. Trigger renforcé — quatre égalités contre NEW, pas deux. Un bundle_product_id
--    forgé est un vecteur aussi valide qu'un component_product_id forgé : le trigger
--    doit être autonome face au canal HTTP direct (surface prouvée réelle, 0130:57
--    accorde grant insert (shop_id) à authenticated). Corps repris de 0107, seuls les
--    deux `and`/comparaisons shop_id sont ajoutés — les deux invariants is_bundle
--    (bundle doit être is_bundle=true, composant ne doit pas l'être) sont conservés
--    tels quels.
--
--    CREATE OR REPLACE conserve ownership et ACL de la fonction, mais PAS security/
--    volatility/parallel/search_path/defaults : SECURITY DEFINER et
--    SET search_path = '' sont donc réécrits explicitement ci-dessous, à l'identique
--    de 0107. Ni VOLATILE ni PARALLEL n'étaient spécifiés dans 0107 (défauts Postgres :
--    VOLATILE / PARALLEL UNSAFE) — ce CREATE OR REPLACE ne les spécifie pas non plus,
--    donc les défauts réappliqués sont strictement identiques à ceux déjà en vigueur.
-- ────────────────────────────────────────────────────────────

create or replace function public.assert_bundle_component_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bundle_is_bundle boolean;
  v_bundle_merchant_account_id uuid;
  v_bundle_shop_id uuid;
  v_component_is_bundle boolean;
  v_component_merchant_account_id uuid;
  v_component_shop_id uuid;
begin
  select is_bundle, merchant_account_id, shop_id
    into v_bundle_is_bundle, v_bundle_merchant_account_id, v_bundle_shop_id
    from public.product
   where id = new.bundle_product_id;

  if not found then
    raise exception 'bundle_product_id % not found'
      , new.bundle_product_id
      using errcode = 'P0002';
  end if;

  select is_bundle, merchant_account_id, shop_id
    into v_component_is_bundle, v_component_merchant_account_id, v_component_shop_id
    from public.product
   where id = new.component_product_id;

  if not found then
    raise exception 'component_product_id % not found'
      , new.component_product_id
      using errcode = 'P0002';
  end if;

  if not v_bundle_is_bundle then
    raise exception 'bundle_product_id % is not marked is_bundle=true'
      , new.bundle_product_id
      using errcode = 'P0001';
  end if;

  if v_component_is_bundle then
    raise exception 'component_product_id % is itself a bundle (nested bundles are not supported)'
      , new.component_product_id
      using errcode = 'P0001';
  end if;

  if v_bundle_merchant_account_id <> new.merchant_account_id
     or v_component_merchant_account_id <> new.merchant_account_id
  then
    raise exception 'bundle_product_id and component_product_id must belong to the same merchant_account_id as the composition row'
      using errcode = 'P0001';
  end if;

  -- Both BEFORE INSERT triggers on this table fire in alphabetical order of trigger
  -- name: assert_integrity ('assert…') runs before default_store_context
  -- ('default…', public.assign_default_store_context(), migration 0126). A caller
  -- that omits shop_id (relying on that later trigger to backfill it) would still
  -- reach this comparison with new.shop_id = NULL, and `is distinct from` would
  -- reject every row regardless of the real shop — including legitimate same-shop
  -- compositions. Mirror the exact default-shop resolution here so the comparison
  -- below is always meaningful, independent of trigger firing order.
  if new.shop_id is null then
    select s.id
      into new.shop_id
      from public.shop s
     where s.merchant_account_id = new.merchant_account_id
       and s.is_default
     order by s.id
     limit 1;
  end if;

  if v_bundle_shop_id is distinct from new.shop_id
     or v_component_shop_id is distinct from new.shop_id
  then
    raise exception 'bundle_product_id and component_product_id must belong to the same shop_id as the composition row'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;
