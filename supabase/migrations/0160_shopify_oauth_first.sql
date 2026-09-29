-- ============================================================================
-- 0160 — SHOPIFY-OAUTH-FIRST-01 : l'autorisation Shopify avant le compte Tëër
--
-- Objet. L'entrée `application_url` lance l'OAuth AVANT toute session Tëër. Au callback, le
-- locataire n'est donc plus connu : un jeton valide peut exister sans propriétaire. Cette
-- migration pose les structures et les primitives qui encadrent ce moment, SANS aucun code
-- applicatif (règle 3 : le schéma en production avant le code).
--
-- Surfaces :
--   1. table public.shopify_pending_installation      — attente d'un jeton sans propriétaire
--   2. colonne public.shop.reauthorization_required_at — D17, refresh définitivement invalide
--   3. persist_shopify_credentials_fenced              — CREATE OR REPLACE, signature identique,
--      seul ajout : remise à NULL de la colonne 2 à chaque persistance réussie
--   4. classify_shopify_entry                          — D16a, classification à l'entrée
--   5. decide_and_write_shopify_authorization          — D16b, branche décidée EN BASE
--   6. consume_shopify_pending_installation            — rattachement (POST explicite)
--   7. read_shopify_pending_installation               — lecture seule (GET de confirmation)
--   8. uninstall_shopify_pending_or_shop               — app/uninstalled sur une attente
--   9. mark_shopify_reauthorization_required           — D17, écrivain fencé
--  10. purge_expired_shopify_pending_installations     — purge (branchement : phase 2)
--
-- Chiffrement. Les credentials arrivent DÉJÀ chiffrés (AES-256-GCM côté serveur,
-- lib/shopify/crypto.ts). La base ne chiffre ni ne déchiffre rien : la table d'attente reprend
-- la représentation de `shop` (text, chiffré applicatif).
--
-- Ordre des verrous : BAIL, puis ATTENTE, puis SHOP, dans toutes les fonctions de ce fichier —
-- prolongement de la règle de 0159 (bail puis shop). Une fonction adressée par ticket lit le
-- domaine sans verrou, prend le bail, puis relit l'attente sous verrou.
--
-- Gardes NULL-safe : `is distinct from` partout où un NULL peut paraître. En particulier, la
-- propriété n'est confrontée QUE si la ligne `shop` existe (variable v_shop_exists) : pour une
-- boutique neuve, `NULL is distinct from x` serait vrai et refuserait toute première
-- installation.
--
-- ACL : toutes les fonctions sont security invoker, search_path vide, EXECUTE au seul
-- service_role. La table n'a aucune policy (RLS forcée, deny-by-default) et n'accorde de
-- privilèges qu'au service_role, en colonnes nommées pour INSERT et UPDATE (motif 0158).
-- La colonne ajoutée à `shop` hérite des grants de TABLE existants de `shop` : aucun grant de
-- colonne n'est posé ici.
--
-- RETOUR ARRIÈRE (aucun code applicatif n'y fait référence à la date de ce lot) :
--   begin;
--   drop function public.purge_expired_shopify_pending_installations();
--   drop function public.mark_shopify_reauthorization_required(text, text, bigint);
--   drop function public.uninstall_shopify_pending_or_shop(text, text, integer);
--   drop function public.read_shopify_pending_installation(text);
--   drop function public.consume_shopify_pending_installation(text, uuid, uuid, bigint);
--   drop function public.decide_and_write_shopify_authorization(
--     text, text, bigint, text, text, timestamptz, timestamptz, text, text, timestamptz);
--   drop function public.classify_shopify_entry(text, text);
--   -- rejouer le CREATE OR REPLACE de persist_shopify_credentials_fenced tel que dans 0158
--   alter table public.shop drop column reauthorization_required_at;
--   drop table public.shopify_pending_installation;
--   commit;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Attente d'installation.
--
-- Une ligne ACTIVE (consumed_at NULL) porte les credentials chiffrés reçus au callback. Une
-- ligne CONSOMMÉE n'en porte plus aucun : la consommation les efface dans la transaction qui
-- les copie dans `shop`, pour ne jamais garder deux copies d'un même secret. Elle ne garde que
-- l'empreinte du ticket et les dates, jusqu'à la purge.
--
-- Une seule attente active par couple (domaine, app) : index unique PARTIEL, sans prédicat
-- temporel (now() n'est pas immuable). L'expiration est vérifiée par les fonctions, jamais par
-- l'index ; le remplacement supprime l'attente active avant d'insérer la nouvelle.
-- ----------------------------------------------------------------------------
create table public.shopify_pending_installation (
  id uuid primary key default gen_random_uuid(),
  shop_domain text not null
    check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  shopify_client_id text not null
    check (btrim(shopify_client_id) <> ''),
  access_token_encrypted text,
  refresh_token_encrypted text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scopes text not null,
  -- Empreinte sha256 (hexadécimal) du ticket ; le ticket en clair n'est jamais stocké.
  ticket_hash text not null
    check (ticket_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint shopify_pending_installation_ticket_hash_key unique (ticket_hash),
  -- D3 : durée de vie du ticket bornée à 60 minutes.
  constraint shopify_pending_installation_expiry_window
    check (expires_at > created_at and expires_at <= created_at + interval '60 minutes'),
  constraint shopify_pending_installation_credentials_lifecycle
    check (
      (consumed_at is null and access_token_encrypted is not null)
      or (
        consumed_at is not null
        and access_token_encrypted is null
        and refresh_token_encrypted is null
        and access_token_expires_at is null
        and refresh_token_expires_at is null
      )
    )
);

create unique index shopify_pending_installation_active_couple_key
  on public.shopify_pending_installation (shop_domain, shopify_client_id)
  where consumed_at is null;

alter table public.shopify_pending_installation enable row level security;
alter table public.shopify_pending_installation force row level security;
-- Aucune policy : deny-by-default pour tout rôle soumis à la RLS. service_role la contourne.

revoke all on table public.shopify_pending_installation from public;
revoke all on table public.shopify_pending_installation from anon, authenticated, service_role;
grant select on table public.shopify_pending_installation to service_role;
grant insert (
  shop_domain,
  shopify_client_id,
  access_token_encrypted,
  refresh_token_encrypted,
  access_token_expires_at,
  refresh_token_expires_at,
  scopes,
  ticket_hash,
  expires_at
) on table public.shopify_pending_installation to service_role;
grant update (
  access_token_encrypted,
  refresh_token_encrypted,
  access_token_expires_at,
  refresh_token_expires_at,
  consumed_at
) on table public.shopify_pending_installation to service_role;
-- DELETE : remplacement d'une attente active (D16b), refus au rattachement, désinstallation
-- d'une attente, purge.
grant delete on table public.shopify_pending_installation to service_role;

-- ----------------------------------------------------------------------------
-- 2. D17 — refresh définitivement invalide.
--
-- Non NULL : Shopify a répondu `401 invalid_request` (« requires an active refresh_token ») au
-- rafraîchissement ; la prochaine ouverture doit lancer un grant. Nullable, sans défaut, sans
-- backfill (règle 9). Remise à NULL par toute persistance réussie (surface 3).
-- ----------------------------------------------------------------------------
alter table public.shop add column reauthorization_required_at timestamptz;

-- ----------------------------------------------------------------------------
-- 3. persist_shopify_credentials_fenced — CREATE OR REPLACE à signature IDENTIQUE.
--
-- Corps repris à l'identique de 0158 ; seul ajout : `reauthorization_required_at = null` dans
-- chaque branche de persistance réussie (insertion, et mise à jour des trois modes). Un
-- CREATE OR REPLACE à signature identique conserve l'ACL ; security invoker et search_path
-- sont redéclarés, puisqu'il ne les conserve pas.
-- ----------------------------------------------------------------------------
create or replace function public.persist_shopify_credentials_fenced(
  p_mode text,
  p_shop_domain text,
  p_generation bigint,
  p_merchant_account_id uuid,
  p_client_id text,
  p_access_token_encrypted text,
  p_refresh_token_encrypted text,
  p_access_token_expires_at timestamptz,
  p_refresh_token_expires_at timestamptz,
  p_scopes text
)
returns table (outcome text, shop_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lease_generation bigint;
  v_lease_expires_at timestamptz;
  v_shop public.shop%rowtype;
  v_inserted_id uuid;
begin
  if p_mode is null
     or p_mode not in ('authorization_code', 'token_exchange', 'refresh')
     or p_shop_domain is null
     or p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
     or p_generation is null
     or p_merchant_account_id is null
     or p_client_id is null or btrim(p_client_id) = ''
     or p_access_token_encrypted is null or btrim(p_access_token_encrypted) = ''
     or (p_mode <> 'refresh' and p_scopes is null) then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

  -- (a) Fencing. Verrou sur la ligne de bail : aucune reprise ne peut s'intercaler entre ce
  -- contrôle et l'écriture ci-dessous.
  select l.generation, l.lease_expires_at
    into v_lease_generation, v_lease_expires_at
  from public.shopify_token_lease l
  where l.shop_domain = p_shop_domain
  for update;

  if not found
     or v_lease_generation is distinct from p_generation
     or v_lease_expires_at is null then
    return query select 'lease_lost'::text, null::uuid;
    return;
  end if;

  -- (b) Propriété et identité d'app, sur la ligne verrouillée.
  select *
    into v_shop
  from public.shop s
  where s.shop_domain = p_shop_domain
  for update;

  if not found then
    if p_mode <> 'authorization_code' then
      return query select 'shop_not_found'::text, null::uuid;
      return;
    end if;

    -- Création pour le seul locataire attendu. Une ligne créée concurrement par un écrivain
    -- non soumis au bail (rattachement embarqué, 0155) ne lève pas 23505 : elle est reprise
    -- ci-dessous et passe par les mêmes gardes.
    insert into public.shop as s (
      merchant_account_id,
      shop_domain,
      shopify_client_id,
      access_token_encrypted,
      refresh_token_encrypted,
      access_token_expires_at,
      refresh_token_expires_at,
      scopes,
      status,
      uninstalled_at,
      reauthorization_required_at,
      updated_at
    )
    values (
      p_merchant_account_id,
      p_shop_domain,
      p_client_id,
      p_access_token_encrypted,
      p_refresh_token_encrypted,
      p_access_token_expires_at,
      p_refresh_token_expires_at,
      p_scopes,
      'active',
      null,
      null,
      now()
    )
    on conflict (shop_domain) do nothing
    returning s.id into v_inserted_id;

    if v_inserted_id is not null then
      return query select 'inserted'::text, v_inserted_id;
      return;
    end if;

    select *
      into v_shop
    from public.shop s
    where s.shop_domain = p_shop_domain
    for update;

    if not found then
      return query select 'write_failed'::text, null::uuid;
      return;
    end if;
  end if;

  -- Propriété (decideShopOwnership) : le premier locataire garde la boutique.
  if v_shop.merchant_account_id is distinct from p_merchant_account_id then
    return query select 'ownership_refused'::text, null::uuid;
    return;
  end if;

  if p_mode = 'authorization_code' then
    -- Bascule d'app (decideShopAppSwitch) : NULL = aucune app rattachée, jamais une autre.
    if v_shop.shopify_client_id is not null
       and v_shop.shopify_client_id is distinct from p_client_id then
      return query select 'app_switch_refused'::text, null::uuid;
      return;
    end if;

    update public.shop s
    set shopify_client_id = p_client_id,
        access_token_encrypted = p_access_token_encrypted,
        refresh_token_encrypted = p_refresh_token_encrypted,
        access_token_expires_at = p_access_token_expires_at,
        refresh_token_expires_at = p_refresh_token_expires_at,
        scopes = p_scopes,
        status = 'active',
        uninstalled_at = null,
        reauthorization_required_at = null,
        updated_at = now()
    where s.id = v_shop.id;

    return query select 'updated'::text, v_shop.id;
    return;
  end if;

  -- token_exchange et refresh : identité d'app stricte, NULL compris.
  if v_shop.shopify_client_id is distinct from p_client_id then
    return query select 'app_identity_mismatch'::text, null::uuid;
    return;
  end if;

  if p_mode = 'token_exchange' then
    update public.shop s
    set access_token_encrypted = p_access_token_encrypted,
        refresh_token_encrypted = p_refresh_token_encrypted,
        access_token_expires_at = p_access_token_expires_at,
        refresh_token_expires_at = p_refresh_token_expires_at,
        scopes = p_scopes,
        status = 'active',
        reauthorization_required_at = null,
        updated_at = now()
    where s.id = v_shop.id;

    return query select 'updated'::text, v_shop.id;
    return;
  end if;

  -- refresh
  if v_shop.status is distinct from 'active' then
    return query select 'shop_inactive'::text, null::uuid;
    return;
  end if;

  update public.shop s
  set access_token_encrypted = p_access_token_encrypted,
      refresh_token_encrypted = coalesce(p_refresh_token_encrypted, s.refresh_token_encrypted),
      access_token_expires_at = p_access_token_expires_at,
      refresh_token_expires_at = coalesce(p_refresh_token_expires_at, s.refresh_token_expires_at),
      reauthorization_required_at = null,
      updated_at = now()
  where s.id = v_shop.id;

  return query select 'updated'::text, v_shop.id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. D16a — classification à l'entrée. Lecture seule, aucun déchiffrement (le contrôle de
-- déchiffrement relève du serveur, D19). Ne renvoie qu'une valeur d'énumération : ni
-- locataire, ni credential.
--
-- Ordre d'évaluation (le premier qui s'applique l'emporte) :
--   1. entrée invalide                                  → invalid_input
--   2. aucune ligne                                     → absent
--   3. ligne d'une AUTRE app (règle de
--      decideShopAppSwitch : NULL = aucune app)          → other_app
--   4. status = 'uninstalled'                           → uninstalled
--   5. aucun access token (ligne active sans jeton)     → disconnected
--   6. app NULL alors que des jetons existent : ces
--      jetons ne sont attribuables à aucune app         → reauthorization_required
--   7. reauthorization_required_at non NULL (D17)       → reauthorization_required
--   8. refresh token échu                               → reauthorization_required
--   9. access token sans échéance (non expirant, KOBA)  → installed_valid
--  10. access token non échu                            → installed_valid
--  11. access échu SANS refresh token (même règle que
--      shopStatus, lib/shopify/shop-status.ts)          → reauthorization_required
--  12. sinon                                            → installed_refreshable
-- L'app passe avant le statut : une autre app ne doit jamais déclencher un grant de celle-ci.
-- Les états qui imposent un grant (8, 11) passent avant les états valides : un jeton encore
-- valide adossé à un refresh mort ne serait plus renouvelable dans l'heure.
-- ----------------------------------------------------------------------------
create function public.classify_shopify_entry(
  p_shop_domain text,
  p_client_id text
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_shop public.shop%rowtype;
begin
  if p_shop_domain is null
     or p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
     or p_client_id is null or btrim(p_client_id) = '' then
    return 'invalid_input';
  end if;

  select *
    into v_shop
  from public.shop s
  where s.shop_domain = p_shop_domain;

  if not found then
    return 'absent';
  end if;

  if v_shop.shopify_client_id is not null
     and v_shop.shopify_client_id is distinct from p_client_id then
    return 'other_app';
  end if;

  if v_shop.status is not distinct from 'uninstalled' then
    return 'uninstalled';
  end if;

  if v_shop.access_token_encrypted is null then
    return 'disconnected';
  end if;

  if v_shop.shopify_client_id is null then
    return 'reauthorization_required';
  end if;

  if v_shop.reauthorization_required_at is not null then
    return 'reauthorization_required';
  end if;

  if v_shop.refresh_token_expires_at is not null
     and v_shop.refresh_token_expires_at <= now() then
    return 'reauthorization_required';
  end if;

  if v_shop.access_token_expires_at is null
     or v_shop.access_token_expires_at > now() then
    return 'installed_valid';
  end if;

  if v_shop.refresh_token_encrypted is null then
    return 'reauthorization_required';
  end if;

  return 'installed_refreshable';
end;
$$;

revoke all on function public.classify_shopify_entry(text, text) from public;
revoke all on function public.classify_shopify_entry(text, text) from anon, authenticated;
grant execute on function public.classify_shopify_entry(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- 5. D16b — décision de branche ET écriture, dans UNE transaction (invariant 6 : aucune
-- classification suivie d'une écriture séparée).
--
--   1. bail : génération courante et bail non libéré, sous verrou       → sinon lease_lost
--   2. ligne `shop` du domaine verrouillée (si elle existe)
--   3. règle de decideShopAppSwitch, si la ligne existe                 → app_switch_refused
--   4. BRANCHE 1 — ligne existante, même app, `active`, avec access token (D14) :
--      persistance fencée chez le propriétaire RÉSOLU EN BASE, audit `shopify.connected`
--      dans la transaction (D11), suppression de l'attente active du couple.
--   5. BRANCHE 2 — tout le reste (aucune ligne, désinstallée, déconnectée, app NULL) :
--      AUCUNE écriture dans `shop` ; l'attente active du couple est remplacée.
--
-- Le locataire ne vient jamais de l'appelant : en branche 1, il est lu sur la ligne
-- verrouillée ; en branche 2, il n'existe pas encore.
-- Verdicts : (branch_1, updated | <refus de persist>) | (branch_2, pending_created) |
-- (NULL, lease_lost | app_switch_refused | invalid_input).
-- ----------------------------------------------------------------------------
create function public.decide_and_write_shopify_authorization(
  p_shop_domain text,
  p_client_id text,
  p_generation bigint,
  p_access_token_encrypted text,
  p_refresh_token_encrypted text,
  p_access_token_expires_at timestamptz,
  p_refresh_token_expires_at timestamptz,
  p_scopes text,
  p_ticket_hash text,
  p_pending_expires_at timestamptz
)
returns table (branch text, outcome text, shop_id uuid, merchant_account_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lease_generation bigint;
  v_lease_expires_at timestamptz;
  v_shop public.shop%rowtype;
  v_shop_exists boolean;
  v_persist_outcome text;
  v_persist_shop_id uuid;
begin
  if p_shop_domain is null
     or p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
     or p_client_id is null or btrim(p_client_id) = ''
     or p_generation is null
     or p_access_token_encrypted is null or btrim(p_access_token_encrypted) = ''
     or p_scopes is null
     or p_ticket_hash is null or p_ticket_hash !~ '^[0-9a-f]{64}$'
     or p_pending_expires_at is null
     or p_pending_expires_at <= now()
     or p_pending_expires_at > now() + interval '60 minutes' then
    return query select null::text, 'invalid_input'::text, null::uuid, null::uuid;
    return;
  end if;

  -- (1) Fencing, sous verrou de la ligne de bail.
  select l.generation, l.lease_expires_at
    into v_lease_generation, v_lease_expires_at
  from public.shopify_token_lease l
  where l.shop_domain = p_shop_domain
  for update;

  if not found
     or v_lease_generation is distinct from p_generation
     or v_lease_expires_at is null then
    return query select null::text, 'lease_lost'::text, null::uuid, null::uuid;
    return;
  end if;

  -- (2) Ligne `shop` verrouillée, si elle existe.
  select *
    into v_shop
  from public.shop s
  where s.shop_domain = p_shop_domain
  for update;

  v_shop_exists := found;

  -- (3) Bascule d'app (decideShopAppSwitch) : NULL = aucune app, jamais une autre app.
  if v_shop_exists
     and v_shop.shopify_client_id is not null
     and v_shop.shopify_client_id is distinct from p_client_id then
    return query select null::text, 'app_switch_refused'::text, null::uuid, null::uuid;
    return;
  end if;

  -- (4) Branche 1 : boutique installée pour cette app, chez son propriétaire établi.
  if v_shop_exists
     and v_shop.shopify_client_id is not distinct from p_client_id
     and v_shop.status is not distinct from 'active'
     and v_shop.access_token_encrypted is not null then
    select pc.outcome, pc.shop_id
      into v_persist_outcome, v_persist_shop_id
    from public.persist_shopify_credentials_fenced(
      'authorization_code',
      p_shop_domain,
      p_generation,
      v_shop.merchant_account_id,
      p_client_id,
      p_access_token_encrypted,
      p_refresh_token_encrypted,
      p_access_token_expires_at,
      p_refresh_token_expires_at,
      p_scopes
    ) pc;

    if v_persist_outcome is distinct from 'updated' then
      return query
        select 'branch_1'::text, coalesce(v_persist_outcome, 'write_failed'), null::uuid, null::uuid;
      return;
    end if;

    insert into public.audit_log (
      merchant_account_id,
      actor_user_id,
      action,
      resource_type,
      resource_id
    )
    values (
      v_shop.merchant_account_id,
      null,
      'shopify.connected',
      'shop',
      v_persist_shop_id
    );

    delete from public.shopify_pending_installation pi
    where pi.shop_domain = p_shop_domain
      and pi.shopify_client_id = p_client_id
      and pi.consumed_at is null;

    return query
      select 'branch_1'::text, 'updated'::text, v_persist_shop_id, v_shop.merchant_account_id;
    return;
  end if;

  -- (5) Branche 2 : aucune écriture dans `shop`. L'attente active du couple est remplacée,
  -- ce qui rend l'ancien ticket inutilisable (T16).
  delete from public.shopify_pending_installation pi
  where pi.shop_domain = p_shop_domain
    and pi.shopify_client_id = p_client_id
    and pi.consumed_at is null;

  insert into public.shopify_pending_installation (
    shop_domain,
    shopify_client_id,
    access_token_encrypted,
    refresh_token_encrypted,
    access_token_expires_at,
    refresh_token_expires_at,
    scopes,
    ticket_hash,
    expires_at
  )
  values (
    p_shop_domain,
    p_client_id,
    p_access_token_encrypted,
    p_refresh_token_encrypted,
    p_access_token_expires_at,
    p_refresh_token_expires_at,
    p_scopes,
    p_ticket_hash,
    p_pending_expires_at
  );

  return query select 'branch_2'::text, 'pending_created'::text, null::uuid, null::uuid;
end;
$$;

revoke all on function public.decide_and_write_shopify_authorization(
  text, text, bigint, text, text, timestamptz, timestamptz, text, text, timestamptz
) from public;
revoke all on function public.decide_and_write_shopify_authorization(
  text, text, bigint, text, text, timestamptz, timestamptz, text, text, timestamptz
) from anon, authenticated;
grant execute on function public.decide_and_write_shopify_authorization(
  text, text, bigint, text, text, timestamptz, timestamptz, text, text, timestamptz
) to service_role;

-- ----------------------------------------------------------------------------
-- 6. Rattachement — consommation du ticket (POST explicite, D2).
--
-- `p_user_id` et `p_merchant_account_id` sont dérivés de la session PAR LE SERVEUR. Le
-- navigateur ne présente que le ticket, dont seule l'empreinte arrive ici.
--
--   1. domaine de l'attente lu sans verrou                   → sinon ticket_invalid
--   2. bail du domaine, sous verrou                          → sinon lease_lost
--   3. attente relue SOUS verrou (active, non expirée,
--      même domaine)                                         → sinon ticket_invalid
--   4. appartenance owner/manager, NULL-safe (D4)            → sinon forbidden
--   5. ligne `shop` verrouillée ; SI elle existe : propriété, puis app — un seul verdict
--      `refused` pour les deux, l'attente est supprimée
--   6. persistance fencée (insertion, ou rotation et réactivation pour le même locataire)
--   7. audit `shopify.connected`, ticket consommé et credentials de l'attente effacés
-- Tout échec levé après l'écriture annule la transaction entière : le ticket n'est pas
-- consommé (T18). Absente, consommée ou expirée : un verdict unique, `ticket_invalid`.
-- Verdicts : inserted | updated | ticket_invalid | lease_lost | forbidden | refused |
-- invalid_input | <refus de persist>.
-- ----------------------------------------------------------------------------
create function public.consume_shopify_pending_installation(
  p_ticket_hash text,
  p_user_id uuid,
  p_merchant_account_id uuid,
  p_generation bigint
)
returns table (outcome text, shop_id uuid, shop_domain text, shopify_client_id text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_domain text;
  v_lease_generation bigint;
  v_lease_expires_at timestamptz;
  v_pending public.shopify_pending_installation%rowtype;
  v_member_role text;
  v_shop public.shop%rowtype;
  v_shop_exists boolean;
  v_persist_outcome text;
  v_persist_shop_id uuid;
begin
  if p_user_id is null
     or p_merchant_account_id is null
     or p_generation is null then
    return query select 'invalid_input'::text, null::uuid, null::text, null::text;
    return;
  end if;

  if p_ticket_hash is null or p_ticket_hash !~ '^[0-9a-f]{64}$' then
    return query select 'ticket_invalid'::text, null::uuid, null::text, null::text;
    return;
  end if;

  -- (1) Domaine lu sans verrou, pour prendre le bail AVANT l'attente.
  select pi.shop_domain
    into v_domain
  from public.shopify_pending_installation pi
  where pi.ticket_hash = p_ticket_hash
    and pi.consumed_at is null
    and pi.expires_at > now();

  if not found then
    return query select 'ticket_invalid'::text, null::uuid, null::text, null::text;
    return;
  end if;

  -- (2) Fencing, sous verrou de la ligne de bail.
  select l.generation, l.lease_expires_at
    into v_lease_generation, v_lease_expires_at
  from public.shopify_token_lease l
  where l.shop_domain = v_domain
  for update;

  if not found
     or v_lease_generation is distinct from p_generation
     or v_lease_expires_at is null then
    return query select 'lease_lost'::text, null::uuid, null::text, null::text;
    return;
  end if;

  -- (3) Attente relue sous verrou : elle a pu être consommée, supprimée ou remplacée.
  select *
    into v_pending
  from public.shopify_pending_installation pi
  where pi.ticket_hash = p_ticket_hash
  for update;

  if not found
     or v_pending.consumed_at is not null
     or v_pending.expires_at <= now()
     or v_pending.shop_domain is distinct from v_domain then
    return query select 'ticket_invalid'::text, null::uuid, null::text, null::text;
    return;
  end if;

  -- (4) Capacité (D4), NULL-safe : un non-membre a un rôle NULL.
  select mm.role
    into v_member_role
  from public.merchant_member mm
  where mm.user_id = p_user_id
    and mm.merchant_account_id = p_merchant_account_id;

  if v_member_role is null or v_member_role not in ('owner', 'manager') then
    return query select 'forbidden'::text, null::uuid, null::text, null::text;
    return;
  end if;

  -- (5) Ligne `shop` : propriété, puis app, UNIQUEMENT si la ligne existe.
  select *
    into v_shop
  from public.shop s
  where s.shop_domain = v_pending.shop_domain
  for update;

  v_shop_exists := found;

  if v_shop_exists
     and v_shop.merchant_account_id is distinct from p_merchant_account_id then
    delete from public.shopify_pending_installation pi where pi.id = v_pending.id;
    return query select 'refused'::text, null::uuid, null::text, null::text;
    return;
  end if;

  if v_shop_exists
     and v_shop.shopify_client_id is not null
     and v_shop.shopify_client_id is distinct from v_pending.shopify_client_id then
    delete from public.shopify_pending_installation pi where pi.id = v_pending.id;
    return query select 'refused'::text, null::uuid, null::text, null::text;
    return;
  end if;

  -- (6) Persistance fencée : insertion (boutique neuve) ou rotation (même locataire, D6 bis).
  select pc.outcome, pc.shop_id
    into v_persist_outcome, v_persist_shop_id
  from public.persist_shopify_credentials_fenced(
    'authorization_code',
    v_pending.shop_domain,
    p_generation,
    p_merchant_account_id,
    v_pending.shopify_client_id,
    v_pending.access_token_encrypted,
    v_pending.refresh_token_encrypted,
    v_pending.access_token_expires_at,
    v_pending.refresh_token_expires_at,
    v_pending.scopes
  ) pc;

  if v_persist_outcome is null or v_persist_outcome not in ('inserted', 'updated') then
    -- Aucune écriture n'a eu lieu : le ticket reste intact.
    return query
      select coalesce(v_persist_outcome, 'write_failed'), null::uuid, null::text, null::text;
    return;
  end if;

  -- (7) Audit et consommation, dans la même transaction.
  insert into public.audit_log (
    merchant_account_id,
    actor_user_id,
    action,
    resource_type,
    resource_id
  )
  values (
    p_merchant_account_id,
    p_user_id,
    'shopify.connected',
    'shop',
    v_persist_shop_id
  );

  update public.shopify_pending_installation pi
  set consumed_at = now(),
      access_token_encrypted = null,
      refresh_token_encrypted = null,
      access_token_expires_at = null,
      refresh_token_expires_at = null
  where pi.id = v_pending.id;

  return query
    select v_persist_outcome, v_persist_shop_id, v_pending.shop_domain, v_pending.shopify_client_id;
end;
$$;

revoke all on function public.consume_shopify_pending_installation(text, uuid, uuid, bigint)
  from public;
revoke all on function public.consume_shopify_pending_installation(text, uuid, uuid, bigint)
  from anon, authenticated;
grant execute on function public.consume_shopify_pending_installation(text, uuid, uuid, bigint)
  to service_role;

-- ----------------------------------------------------------------------------
-- 7. Lecture d'une attente (GET de confirmation, D2 ; acquisition du bail avant le POST).
-- Aucune écriture, y compris sur une attente expirée (T15). Ne renvoie que le domaine, l'app
-- et un état : jamais un credential ni un identifiant interne. Un ticket inconnu, consommé
-- ou expiré rend `invalid`, sans rien distinguer.
-- ----------------------------------------------------------------------------
create function public.read_shopify_pending_installation(
  p_ticket_hash text
)
returns table (state text, shop_domain text, shopify_client_id text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_domain text;
  v_client_id text;
begin
  if p_ticket_hash is null or p_ticket_hash !~ '^[0-9a-f]{64}$' then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  select pi.shop_domain, pi.shopify_client_id
    into v_domain, v_client_id
  from public.shopify_pending_installation pi
  where pi.ticket_hash = p_ticket_hash
    and pi.consumed_at is null
    and pi.expires_at > now();

  if not found then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;

  return query select 'valid'::text, v_domain, v_client_id;
end;
$$;

revoke all on function public.read_shopify_pending_installation(text) from public;
revoke all on function public.read_shopify_pending_installation(text) from anon, authenticated;
grant execute on function public.read_shopify_pending_installation(text) to service_role;

-- ----------------------------------------------------------------------------
-- 8. app/uninstalled pour un domaine sans boutique rattachée, ou dont la boutique vient de
-- l'être.
--
-- AVERTISSEMENT (D20b) : le domaine reçu ici N'EST PAS lié cryptographiquement à la signature
-- du webhook. Le HMAC Shopify ne couvre que le corps brut, et le chemin appelant peut retomber
-- sur un en-tête non signé quand le corps ne porte pas de domaine. Une livraison authentique
-- rejouée avec un autre domaine peut donc viser l'attente ou la boutique d'un tiers utilisant
-- la même app. Risque ACCEPTÉ jusqu'au lot 1b ; ne jamais présenter ce domaine comme authentifié.
--
-- Toute décision est prise SOUS VERROU, jamais sur une résolution antérieure à l'appel : si le
-- rattachement a été validé entre la résolution et cet appel, la boutique désormais présente
-- est désinstallée, et aucune désinstallation n'est perdue.
--
--   1. ligne de bail de génération 0 insérée si elle manque (motif 0159)
--   2. bail verrouillé puis PRÉEMPTÉ : toute acquisition en cours devient périmée
--   3. attente active du couple supprimée, si elle existe
--   4. boutique du domaine, si elle existe : uninstall_shopify_shop_fenced par COMPOSITION,
--      sans modification ; sa propre préemption incrémente la génération une seconde fois
-- La génération rendue est la dernière : l'appelant l'utilise pour l'écriture fencée de
-- `store_connection`, puis libère le bail (motif de processAppUninstalledCore).
-- Verdicts : pending_deleted | shop_uninstalled | both | nothing | invalid_input.
-- ----------------------------------------------------------------------------
create function public.uninstall_shopify_pending_or_shop(
  p_shop_domain text,
  p_client_id text,
  p_ttl_seconds integer
)
returns table (outcome text, shop_id uuid, merchant_account_id uuid, generation bigint)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_generation bigint;
  v_pending_deleted boolean;
  v_shop_uninstalled boolean := false;
  v_shop public.shop%rowtype;
  v_uninstall_outcome text;
  v_uninstall_generation bigint;
  v_deleted_count integer;
begin
  if p_shop_domain is null
     or p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
     or p_client_id is null or btrim(p_client_id) = ''
     or p_ttl_seconds is null or p_ttl_seconds <= 0 then
    return query select 'invalid_input'::text, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- (1) et (2) Bail : ligne garantie, verrouillée, puis préemptée.
  insert into public.shopify_token_lease (shop_domain, generation, lease_expires_at, acquired_at)
  values (p_shop_domain, 0, null, null)
  on conflict (shop_domain) do nothing;

  perform 1
  from public.shopify_token_lease l
  where l.shop_domain = p_shop_domain
  for update;

  update public.shopify_token_lease l
  set generation = l.generation + 1,
      lease_expires_at = now() + make_interval(secs => p_ttl_seconds),
      acquired_at = now()
  where l.shop_domain = p_shop_domain
  returning l.generation into v_generation;

  -- (3) Attente active du couple.
  delete from public.shopify_pending_installation pi
  where pi.shop_domain = p_shop_domain
    and pi.shopify_client_id = p_client_id
    and pi.consumed_at is null;

  get diagnostics v_deleted_count = row_count;
  v_pending_deleted := v_deleted_count > 0;

  -- (4) Boutique du domaine, relue sous verrou.
  select *
    into v_shop
  from public.shop s
  where s.shop_domain = p_shop_domain
  for update;

  if found then
    select u.outcome, u.generation
      into v_uninstall_outcome, v_uninstall_generation
    from public.uninstall_shopify_shop_fenced(
      p_shop_domain,
      v_shop.id,
      v_shop.merchant_account_id,
      p_client_id,
      p_ttl_seconds
    ) u;

    if v_uninstall_outcome is not distinct from 'uninstalled' then
      v_shop_uninstalled := true;
      v_generation := v_uninstall_generation;
    end if;
  end if;

  return query
    select
      case
        when v_pending_deleted and v_shop_uninstalled then 'both'
        when v_pending_deleted then 'pending_deleted'
        when v_shop_uninstalled then 'shop_uninstalled'
        else 'nothing'
      end,
      case when v_shop_uninstalled then v_shop.id else null::uuid end,
      case when v_shop_uninstalled then v_shop.merchant_account_id else null::uuid end,
      v_generation;
end;
$$;

revoke all on function public.uninstall_shopify_pending_or_shop(text, text, integer) from public;
revoke all on function public.uninstall_shopify_pending_or_shop(text, text, integer)
  from anon, authenticated;
grant execute on function public.uninstall_shopify_pending_or_shop(text, text, integer)
  to service_role;

-- ----------------------------------------------------------------------------
-- 9. D17 — marquage « réautorisation requise », sous le bail du rafraîchissement.
--
-- Appelée par le détenteur du bail de refresh, AVANT sa libération, quand Shopify a répondu la
-- signature définitive. Fencing par la génération courante ; même app ; boutique active.
-- Idempotente : une valeur déjà posée n'est pas réécrite.
-- Verdicts : marked | already_marked | lease_lost | not_applicable | invalid_input.
-- ----------------------------------------------------------------------------
create function public.mark_shopify_reauthorization_required(
  p_shop_domain text,
  p_client_id text,
  p_generation bigint
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lease_generation bigint;
  v_lease_expires_at timestamptz;
  v_shop public.shop%rowtype;
begin
  if p_shop_domain is null
     or p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
     or p_client_id is null or btrim(p_client_id) = ''
     or p_generation is null then
    return 'invalid_input';
  end if;

  select l.generation, l.lease_expires_at
    into v_lease_generation, v_lease_expires_at
  from public.shopify_token_lease l
  where l.shop_domain = p_shop_domain
  for update;

  if not found
     or v_lease_generation is distinct from p_generation
     or v_lease_expires_at is null then
    return 'lease_lost';
  end if;

  select *
    into v_shop
  from public.shop s
  where s.shop_domain = p_shop_domain
  for update;

  if not found
     or v_shop.shopify_client_id is distinct from p_client_id
     or v_shop.status is distinct from 'active' then
    return 'not_applicable';
  end if;

  if v_shop.reauthorization_required_at is not null then
    return 'already_marked';
  end if;

  update public.shop s
  set reauthorization_required_at = now()
  where s.id = v_shop.id;

  return 'marked';
end;
$$;

revoke all on function public.mark_shopify_reauthorization_required(text, text, bigint)
  from public;
revoke all on function public.mark_shopify_reauthorization_required(text, text, bigint)
  from anon, authenticated;
grant execute on function public.mark_shopify_reauthorization_required(text, text, bigint)
  to service_role;

-- ----------------------------------------------------------------------------
-- 10. Purge. Attentes actives expirées (elles portent encore des credentials), et attentes
-- consommées depuis plus de 7 jours (elles n'en portent plus : seules l'empreinte du ticket et
-- les dates y restent, utiles pour instruire un signalement de rattachement pendant une
-- semaine). Rien ne l'appelle encore : son branchement sur un cron existant relève de la
-- phase 2.
-- ----------------------------------------------------------------------------
create function public.purge_expired_shopify_pending_installations()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.shopify_pending_installation pi
  where (pi.consumed_at is null and pi.expires_at <= now())
     or (pi.consumed_at is not null and pi.consumed_at <= now() - interval '7 days');

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.purge_expired_shopify_pending_installations() from public;
revoke all on function public.purge_expired_shopify_pending_installations()
  from anon, authenticated;
grant execute on function public.purge_expired_shopify_pending_installations() to service_role;
