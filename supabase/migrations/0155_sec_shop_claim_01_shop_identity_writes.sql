-- ============================================================================
-- 0155 — SEC-SHOP-CLAIM-01 : fermer l'écriture utilisateur de l'identité `shop`
--
-- Défaut prouvé par exécution (tests/rls/sec-shop-claim-01-domain-preemption.rls.test.ts) :
-- `authenticated` détient INSERT et UPDATE sur toutes les colonnes de `public.shop`, et
-- `shop_insert`/`shop_update` ne vérifient que le rôle. Un owner/manager d'un locataire A crée
-- (ou réécrit) une ligne portant le domaine d'une boutique qu'il ne possède pas et le client_id
-- de l'app publique ; la route de session embarquée écrit ensuite le jeton hors-ligne de la
-- victime dans cette ligne.
--
-- Correctif (option A) :
--   1. INSERT et UPDATE retirés à public, anon, authenticated sur `public.shop`, au niveau
--      table. Mesuré avant cette migration : aucune ACL de colonne n'existe sur `shop`, et aucun
--      écrivain applicatif légitime n'a besoin d'un INSERT/UPDATE utilisateur une fois les deux
--      chemins ci-dessous déplacés — la liste positive de colonnes réaccordées est donc VIDE.
--      SELECT et DELETE ne changent pas.
--   2. Deux primitives réservées à `service_role`, qui remplacent les deux seuls écrivains
--      utilisateur mesurés :
--        - link_shopify_embedded_shop    (lib/shopify/embedded-link-write.ts, insert + update)
--        - release_shopify_shop_app_identity (lib/shopify/app-release-write.ts, étape 3)
--      `security invoker` : exécutées par `service_role`, elles ne passent plus par la RLS. Les
--      gardes que `shop_insert`/`shop_update` portaient implicitement (rôle marchand au moment de
--      l'écriture, rôle de boutique `current_shop_role(id)` sur une ligne existante) sont donc
--      réécrites explicitement, à partir de `p_user_id` — `auth.uid()` est NULL sous service-role.
--   Les politiques `shop_insert`/`shop_update` restent en place : sans privilège, elles ne sont
--   plus atteignables par `authenticated` ; les supprimer n'apporte rien à ce lot.
--
-- Invariant : AUCUNE colonne de `shop` n'est insérable ni modifiable par `anon`/`authenticated`
-- (y compris `display_name`). TRUNCATE/REFERENCES/TRIGGER sont hors de ce lot.
--
-- RETOUR ARRIÈRE — AVERTISSEMENT : il ROUVRE le P0 (préemption de domaine prouvée par
-- exécution). Ne jamais l'exécuter parce qu'un déploiement TypeScript échoue : dans ce cas les
-- deux gestes (rattachement, libération) échouent fermés, et c'est le code qu'on corrige. Réservé à
-- une panne de production plus grave, irrécupérable autrement, et seulement après retrait du code
-- appelant ces deux RPC :
--   begin;
--   drop function public.link_shopify_embedded_shop(uuid, uuid, text, text);
--   drop function public.release_shopify_shop_app_identity(uuid, uuid, text);
--   grant insert, update on table public.shop to anon, authenticated;
--   commit;
-- ============================================================================

revoke insert, update on table public.shop from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Rattachement embarqué Teer Public (état « en attente » : status active, jeton NULL).
-- L'appelant (TS) a déjà vérifié l'intention signée issue d'un ID token Shopify vérifié ; le
-- domaine et le client_id viennent de cette intention, jamais du navigateur. `p_user_id` vient de
-- la session serveur. `p_merchant_account_id` est un choix du navigateur : il n'est une autorité
-- qu'après confrontation à `merchant_member` ci-dessous.
-- ----------------------------------------------------------------------------
create function public.link_shopify_embedded_shop(
  p_user_id uuid,
  p_merchant_account_id uuid,
  p_shop_domain text,
  p_client_id text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_member_role text;
  v_shop public.shop%rowtype;
  v_shop_role text;
  v_inserted_id uuid;
begin
  if p_user_id is null
     or p_merchant_account_id is null
     or p_shop_domain is null or btrim(p_shop_domain) = ''
     or p_client_id is null or btrim(p_client_id) = '' then
    return 'intent_invalid';
  end if;

  -- Garde implicite de `shop_insert` (current_member_role(merchant_account_id) in owner/manager),
  -- réévaluée au moment de l'écriture. NULL-safe : non-membre → not_a_member.
  select mm.role
    into v_member_role
  from public.merchant_member mm
  where mm.user_id = p_user_id
    and mm.merchant_account_id = p_merchant_account_id;

  if v_member_role is null then
    return 'not_a_member';
  end if;

  if v_member_role not in ('owner', 'manager') then
    return 'insufficient_role';
  end if;

  -- Création atomique : `shop_domain` est UNIQUE. Une course perdue ne crée rien et retombe sur
  -- la décision portant sur la ligne gagnante, verrouillée.
  insert into public.shop (
    merchant_account_id,
    shop_domain,
    shopify_client_id,
    status,
    access_token_encrypted,
    display_name
  )
  values (
    p_merchant_account_id,
    p_shop_domain,
    p_client_id,
    'active',
    null,
    p_shop_domain
  )
  on conflict (shop_domain) do nothing
  returning id into v_inserted_id;

  if v_inserted_id is not null then
    return 'inserted';
  end if;

  select *
    into v_shop
  from public.shop s
  where s.shop_domain = p_shop_domain
  for update;

  if not found then
    -- Ligne concurrente supprimée entre le conflit et la lecture : échec fermé.
    return 'write_failed';
  end if;

  -- Bascule d'app (même règle que decideShopAppSwitch) : NULL = aucune app, jamais une autre.
  if v_shop.shopify_client_id is not null
     and v_shop.shopify_client_id is distinct from p_client_id then
    return 'app_switch_refused';
  end if;

  -- Propriété (même règle que decideShopOwnership) : le premier locataire garde la boutique.
  if v_shop.merchant_account_id is distinct from p_merchant_account_id then
    return 'ownership_refused';
  end if;

  -- Garde implicite de `shop_update` : current_shop_role(id) in owner/manager.
  select sm.role
    into v_shop_role
  from public.shop_member sm
  where sm.shop_id = v_shop.id
    and sm.user_id = p_user_id;

  if v_shop_role is null or v_shop_role not in ('owner', 'manager') then
    return 'insufficient_role';
  end if;

  update public.shop s
  set shopify_client_id = p_client_id,
      status = 'active',
      updated_at = now()
  where s.id = v_shop.id
    and s.merchant_account_id = p_merchant_account_id;

  return 'updated';
end;
$$;

revoke all on function public.link_shopify_embedded_shop(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.link_shopify_embedded_shop(uuid, uuid, text, text)
  to service_role;

-- ----------------------------------------------------------------------------
-- Libération contrôlée d'identité d'app — étape 3 seulement (shop.shopify_client_id → NULL).
-- Les étapes 1, 2 et 4 (audit, store_connection, jeton opaque) restent dans
-- lib/shopify/app-release-write.ts, inchangées. Compare-and-set identique à l'update TS actuel.
-- ----------------------------------------------------------------------------
create function public.release_shopify_shop_app_identity(
  p_user_id uuid,
  p_shop_id uuid,
  p_old_client_id text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_shop public.shop%rowtype;
  v_member_role text;
  v_shop_role text;
begin
  if p_user_id is null or p_shop_id is null or p_old_client_id is null then
    return 'write_failed';
  end if;

  select *
    into v_shop
  from public.shop s
  where s.id = p_shop_id
  for update;

  if not found then
    return 'shop_not_found';
  end if;

  -- Garde applicative existante (owner seul), réévaluée ici, sur le locataire de la LIGNE.
  select mm.role
    into v_member_role
  from public.merchant_member mm
  where mm.user_id = p_user_id
    and mm.merchant_account_id = v_shop.merchant_account_id;

  if v_member_role is null then
    return 'not_a_member';
  end if;

  if v_member_role is distinct from 'owner' then
    return 'insufficient_role';
  end if;

  -- Garde implicite de `shop_update` : current_shop_role(id) in owner/manager.
  select sm.role
    into v_shop_role
  from public.shop_member sm
  where sm.shop_id = v_shop.id
    and sm.user_id = p_user_id;

  if v_shop_role is null or v_shop_role not in ('owner', 'manager') then
    return 'insufficient_role';
  end if;

  if v_shop.status is distinct from 'uninstalled'
     or v_shop.shopify_client_id is distinct from p_old_client_id then
    return 'state_changed';
  end if;

  update public.shop s
  set shopify_client_id = null,
      updated_at = now()
  where s.id = v_shop.id
    and s.status = 'uninstalled'
    and s.shopify_client_id = p_old_client_id;

  return 'released';
end;
$$;

revoke all on function public.release_shopify_shop_app_identity(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.release_shopify_shop_app_identity(uuid, uuid, text)
  to service_role;
