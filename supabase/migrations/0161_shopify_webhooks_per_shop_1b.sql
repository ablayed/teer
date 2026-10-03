-- ============================================================================
-- 0161 — SHOPIFY-WEBHOOKS-PER-SHOP-1B : état des abonnements par boutique et
-- désinstallation ORDONNÉE
--
-- Objet. Poser, SANS aucun code applicatif (règle 3 : le schéma en production avant le code),
-- les structures et les primitives du lot 1b :
--   - l'état des abonnements webhook Shopify par (connexion, topic), et le bail qui sérialise
--     leur réconciliation, indépendant du bail des jetons (G2) ;
--   - une borne basse locale de l'acquisition des credentials (G5), écrite par les trois
--     primitives d'acquisition ;
--   - une primitive de désinstallation qui compare l'horodatage de l'événement à cette borne
--     (G6), pour qu'une livraison `app/uninstalled` ancienne ou dupliquée ne désactive pas une
--     installation, ni ne supprime une attente, postérieure de plus de la marge à l'événement.
--
-- Surfaces :
--   1. table public.shopify_webhook_subscription_state       — état par (connexion, topic)
--   2. table public.shopify_webhook_reconcile_lease           — bail de réconciliation
--      acquire_shopify_webhook_reconcile_lease                — acquisition et reprise
--      release_shopify_webhook_reconcile_lease                — libération fencée
--   3. colonnes credentials_acquired_at                       — sur `shop` et sur
--      `shopify_pending_installation`
--   4. persist_shopify_credentials_fenced                     — CREATE OR REPLACE, signature
--      identique ; seul ajout : la borne, lue sur le bail, écrite hors mode `refresh`
--   5. decide_and_write_shopify_authorization                 — CREATE OR REPLACE, signature
--      identique ; seul ajout : la borne sur l'attente créée en branche 2
--   6. consume_shopify_pending_installation                   — CREATE OR REPLACE, signature
--      identique ; seul ajout : la borne de l'attente reportée sur `shop`
--   7. uninstall_shopify_pending_or_shop_ordered              — désinstallation ordonnée
--
-- Rien n'est retiré ni surchargé. `uninstall_shopify_pending_or_shop` (0160) reste en place,
-- inchangée : elle reste le chemin applicatif jusqu'au code de la phase 2.
--
-- Durées. Aucune durée n'est figée en SQL : TTL des baux et marge de comparaison sont toujours
-- des paramètres.
--
-- Ordre des verrous. Le bail du DOMAINE d'abord, dans toutes les fonctions qui touchent `shop`
-- ou une attente (règle de 0159, reprise par 0160). Le bail de réconciliation est une ligne
-- distincte, d'une table distincte, indexée par connexion : aucune fonction de ce fichier ne
-- prend les deux.
--
-- ACL. Toutes les fonctions sont security invoker, search_path vide, EXECUTE au seul
-- service_role. Les deux tables n'ont aucune policy (RLS forcée, deny-by-default) et n'accordent
-- de privilèges qu'au service_role, en colonnes nommées pour INSERT et UPDATE (motif 0158/0160).
-- Un CREATE OR REPLACE à signature identique conserve l'ACL ; security invoker et search_path
-- sont redéclarés, puisqu'il ne les conserve pas. La colonne ajoutée à `shop` hérite des grants
-- de TABLE existants de `shop` : aucun grant de colonne n'y est posé. Celle de la table
-- d'attente reçoit un grant INSERT de colonne, la table n'accordant INSERT que par colonnes.
--
-- Numérotation. L'en-tête immuable de 0159 annonçait « 0160 » pour la fermeture des primitives
-- non fencées ; 0160 puis 0161 étant pris, cette fermeture viendra au plus tôt en 0162.
--
-- RETOUR ARRIÈRE (aucun code applicatif n'y fait référence à la date de ce lot) :
--   begin;
--   drop function public.uninstall_shopify_pending_or_shop_ordered(
--     text, text, integer, timestamptz, integer);
--   -- rejouer les CREATE OR REPLACE de persist_shopify_credentials_fenced,
--   -- decide_and_write_shopify_authorization et consume_shopify_pending_installation tels que
--   -- dans 0160, AVANT de retirer les colonnes
--   alter table public.shopify_pending_installation drop column credentials_acquired_at;
--   alter table public.shop drop column credentials_acquired_at;
--   drop function public.release_shopify_webhook_reconcile_lease(uuid, bigint);
--   drop function public.acquire_shopify_webhook_reconcile_lease(uuid, integer);
--   drop table public.shopify_webhook_reconcile_lease;
--   drop table public.shopify_webhook_subscription_state;
--   commit;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. État des abonnements webhook Shopify, une ligne par (connexion, topic).
--
-- Ce que la réconciliation a OBSERVÉ ou TENTÉ chez Shopify pour ce topic. Aucune colonne ne
-- porte de secret ni d'`uri` : l'adresse de livraison contient le secret du jeton L3, stocké
-- nulle part ailleurs qu'en empreinte (0143). `token_public_id` est l'identifiant PUBLIC du
-- jeton visé (rôle de key id, non secret, 0143:42-43) ; il n'est pas une clé étrangère, pour
-- qu'un abonnement observé sur un identifiant qui n'est plus le courant reste consignable.
--
-- Statuts (liste fermée) :
--   pending  intention consignée, création non confirmée chez Shopify (avant l'appel, ou
--            interrompue entre l'appel et la sauvegarde) ;
--   active   abonnement observé chez Shopify pour ce topic — son identifiant est connu ;
--   failed   dernière tentative en échec — `last_error_code` dit pourquoi, l'état est
--            relançable ;
--   absent   constaté manquant chez Shopify et non réparé (désinstallation : Shopify supprime
--            les abonnements de la boutique).
--
-- `topic` est contraint par sa FORME, pas par une liste : la liste des topics appartient au
-- code (plan d'abonnements), et une liste fermée en base exigerait une migration à chaque
-- changement.
--
-- Suppression : `on delete cascade` vers `store_connection`, comme le jeton L3 (0143:27-28).
-- L'état n'a aucun sens sans sa connexion, et un `restrict` bloquerait la suppression d'un
-- locataire, qui cascade déjà jusqu'à `store_connection` (0142:105, :117-120).
-- ----------------------------------------------------------------------------
create table public.shopify_webhook_subscription_state (
  id uuid primary key default gen_random_uuid(),
  store_connection_id uuid not null
    references public.store_connection (id) on delete cascade,
  topic text not null
    check (topic ~ '^[a-z_]{1,64}/[a-z_]{1,64}$'),
  -- Identifiant Shopify de l'abonnement (GID). NULL tant qu'aucun n'a été observé.
  shopify_subscription_id text
    check (shopify_subscription_id is null or char_length(shopify_subscription_id) between 1 and 255),
  token_public_id text not null
    check (token_public_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  status text not null
    check (status in ('pending', 'active', 'failed', 'absent')),
  -- Version d'API relue sur l'abonnement après sa création (G12). NULL : non observée.
  api_version text
    check (api_version is null or api_version ~ '^[a-z0-9-]{1,32}$'),
  last_observed_at timestamptz,
  last_error_code text
    check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopify_webhook_subscription_state_connection_topic_key
    unique (store_connection_id, topic),
  constraint shopify_webhook_subscription_state_active_has_subscription
    check (status <> 'active' or shopify_subscription_id is not null),
  constraint shopify_webhook_subscription_state_failed_has_error
    check (status <> 'failed' or last_error_code is not null)
);

create trigger shopify_webhook_subscription_state_set_updated_at
  before update on public.shopify_webhook_subscription_state
  for each row
  execute function public.set_updated_at();

alter table public.shopify_webhook_subscription_state enable row level security;
alter table public.shopify_webhook_subscription_state force row level security;
-- Aucune policy : deny-by-default pour tout rôle soumis à la RLS. service_role la contourne.

revoke all on table public.shopify_webhook_subscription_state from public;
revoke all on table public.shopify_webhook_subscription_state
  from anon, authenticated, service_role;
grant select on table public.shopify_webhook_subscription_state to service_role;
grant insert (
  store_connection_id,
  topic,
  shopify_subscription_id,
  token_public_id,
  status,
  api_version,
  last_observed_at,
  last_error_code
) on table public.shopify_webhook_subscription_state to service_role;
-- `updated_at` est entretenue par le trigger : aucun grant de colonne n'est nécessaire.
grant update (
  shopify_subscription_id,
  token_public_id,
  status,
  api_version,
  last_observed_at,
  last_error_code
) on table public.shopify_webhook_subscription_state to service_role;
grant delete on table public.shopify_webhook_subscription_state to service_role;

-- ----------------------------------------------------------------------------
-- 2. Bail de réconciliation des abonnements, une ligne par connexion.
--
-- Même motif que le bail des jetons (0158) : génération monotone, échéance à l'horloge de la
-- base, acquisition et reprise en une instruction. Il en est INDÉPENDANT : autre table, autre
-- clé (`store_connection_id`, jamais le domaine), aucune référence à `shopify_token_lease`.
-- Une réconciliation tient ce bail pendant que `getValidShopAccessToken` prend et rend le
-- sien : rien n'est imbriqué.
-- ----------------------------------------------------------------------------
create table public.shopify_webhook_reconcile_lease (
  store_connection_id uuid primary key
    references public.store_connection (id) on delete cascade,
  generation bigint not null default 0 check (generation >= 0),
  -- NULL : bail libre (jamais pris, ou libéré par son détenteur). Non NULL : échéance, lue à
  -- l'horloge de la base ; un bail dont l'échéance est passée est repris par l'acquisition.
  lease_expires_at timestamptz,
  acquired_at timestamptz,
  created_at timestamptz not null default now(),
  constraint shopify_webhook_reconcile_lease_held_has_generation
    check (lease_expires_at is null or generation >= 1)
);

alter table public.shopify_webhook_reconcile_lease enable row level security;
alter table public.shopify_webhook_reconcile_lease force row level security;
-- Aucune policy : deny-by-default pour tout rôle soumis à la RLS. service_role la contourne.

revoke all on table public.shopify_webhook_reconcile_lease from public;
revoke all on table public.shopify_webhook_reconcile_lease
  from anon, authenticated, service_role;
grant select on table public.shopify_webhook_reconcile_lease to service_role;
grant insert (store_connection_id, generation, lease_expires_at, acquired_at)
  on table public.shopify_webhook_reconcile_lease to service_role;
grant update (generation, lease_expires_at, acquired_at)
  on table public.shopify_webhook_reconcile_lease to service_role;

-- ----------------------------------------------------------------------------
-- Acquisition et reprise, en UNE instruction (motif 0158:95-135). Bail libre ou expiré →
-- génération + 1, une ligne rendue. Bail tenu → zéro ligne, sans erreur.
--
-- La connexion doit exister ET être une connexion Shopify : refus nommé sinon, plutôt qu'une
-- violation de clé étrangère.
-- ----------------------------------------------------------------------------
create function public.acquire_shopify_webhook_reconcile_lease(
  p_store_connection_id uuid,
  p_ttl_seconds integer
)
returns table (acquired_generation bigint, expires_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'shopify_webhook_reconcile_lease_invalid_ttl' using errcode = '22023';
  end if;

  if p_store_connection_id is null
     or not exists (
       select 1
       from public.store_connection c
       where c.id = p_store_connection_id
         and c.platform = 'shopify'
     ) then
    raise exception 'shopify_webhook_reconcile_lease_unknown_connection' using errcode = '22023';
  end if;

  return query
  insert into public.shopify_webhook_reconcile_lease as l (
    store_connection_id,
    generation,
    lease_expires_at,
    acquired_at
  )
  values (
    p_store_connection_id,
    1,
    now() + make_interval(secs => p_ttl_seconds),
    now()
  )
  on conflict (store_connection_id) do update
    set generation = l.generation + 1,
        lease_expires_at = excluded.lease_expires_at,
        acquired_at = excluded.acquired_at
    where l.lease_expires_at is null
       or l.lease_expires_at <= now()
  returning l.generation, l.lease_expires_at;
end;
$$;

revoke all on function public.acquire_shopify_webhook_reconcile_lease(uuid, integer) from public;
revoke all on function public.acquire_shopify_webhook_reconcile_lease(uuid, integer)
  from anon, authenticated;
grant execute on function public.acquire_shopify_webhook_reconcile_lease(uuid, integer)
  to service_role;

-- ----------------------------------------------------------------------------
-- Libération FENCÉE : seul le détenteur de la génération courante libère. Une génération
-- périmée (bail repris entre-temps) ou un bail déjà libre ne modifient rien et rendent false.
-- 0158 n'a pas de fonction de libération — la sienne est une mise à jour conditionnelle faite
-- par le serveur (lib/shopify/token-lease.ts) ; celle-ci est une fonction, par décision.
-- ----------------------------------------------------------------------------
create function public.release_shopify_webhook_reconcile_lease(
  p_store_connection_id uuid,
  p_generation bigint
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.shopify_webhook_reconcile_lease l
  set lease_expires_at = null
  where l.store_connection_id = p_store_connection_id
    and l.generation = p_generation
    and l.lease_expires_at is not null;

  return found;
end;
$$;

revoke all on function public.release_shopify_webhook_reconcile_lease(uuid, bigint) from public;
revoke all on function public.release_shopify_webhook_reconcile_lease(uuid, bigint)
  from anon, authenticated;
grant execute on function public.release_shopify_webhook_reconcile_lease(uuid, bigint)
  to service_role;

-- ----------------------------------------------------------------------------
-- 3. G5 — borne basse locale de l'acquisition des credentials.
--
-- Nullable, sans défaut, sans rattrapage (règle 9). NULL sur toute connexion antérieure à ce
-- lot, jusqu'à son prochain grant : aucune garde d'ancienneté ne s'y applique. NULL sur une
-- attente créée avant ce lot : la primitive ordonnée retombe sur `created_at`.
-- ----------------------------------------------------------------------------
alter table public.shop add column credentials_acquired_at timestamptz;

comment on column public.shop.credentials_acquired_at is
  'borne basse locale : `acquired_at` du bail de jetons, pris avant la demande d''échange OAuth ; ce n''est pas l''heure exacte du grant chez Shopify';

alter table public.shopify_pending_installation add column credentials_acquired_at timestamptz;

comment on column public.shopify_pending_installation.credentials_acquired_at is
  'borne basse locale : `acquired_at` du bail de jetons, pris avant la demande d''échange OAuth ; ce n''est pas l''heure exacte du grant chez Shopify';

-- La table d'attente n'accorde INSERT que par colonnes nommées (0160:115-125) : sans ce grant,
-- l'insertion de la branche 2 serait refusée. Aucun grant UPDATE : la borne ne change jamais.
grant insert (credentials_acquired_at)
  on table public.shopify_pending_installation to service_role;

-- ----------------------------------------------------------------------------
-- 4. persist_shopify_credentials_fenced — CREATE OR REPLACE à signature IDENTIQUE.
--
-- Corps repris à l'identique de 0160:154-340. Seuls ajouts :
--   - `l.acquired_at` lu dans le MÊME `select … for update` que la génération : c'est l'heure,
--     à l'horloge de la base, à laquelle le bail de CETTE génération a été acquis, donc avant
--     la demande d'échange OAuth ;
--   - `credentials_acquired_at = v_lease_acquired_at` à l'insertion et dans les mises à jour
--     des modes `authorization_code` et `token_exchange`. Jamais `now()` : l'heure de la
--     persistance est postérieure au grant, et jugerait ancien un événement qui désinstalle
--     précisément ces credentials.
-- Le mode `refresh` ne touche pas la borne : un rafraîchissement n'est pas un nouveau grant.
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
  v_lease_acquired_at timestamptz;
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
  select l.generation, l.lease_expires_at, l.acquired_at
    into v_lease_generation, v_lease_expires_at, v_lease_acquired_at
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
      credentials_acquired_at,
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
      v_lease_acquired_at,
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
        credentials_acquired_at = v_lease_acquired_at,
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
        credentials_acquired_at = v_lease_acquired_at,
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
-- 5. decide_and_write_shopify_authorization — CREATE OR REPLACE à signature IDENTIQUE.
--
-- Corps repris à l'identique de 0160:456-610. Seul ajout : en branche 2, l'attente créée porte
-- `credentials_acquired_at`, l'`acquired_at` du bail lu dans le verrou qui existait déjà. La
-- branche 1 passe par persist_shopify_credentials_fenced, qui écrit la même borne sur `shop`.
-- ----------------------------------------------------------------------------
create or replace function public.decide_and_write_shopify_authorization(
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
  v_lease_acquired_at timestamptz;
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
  select l.generation, l.lease_expires_at, l.acquired_at
    into v_lease_generation, v_lease_expires_at, v_lease_acquired_at
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
    expires_at,
    credentials_acquired_at
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
    p_pending_expires_at,
    v_lease_acquired_at
  );

  return query select 'branch_2'::text, 'pending_created'::text, null::uuid, null::uuid;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. consume_shopify_pending_installation — CREATE OR REPLACE à signature IDENTIQUE.
--
-- Corps repris à l'identique de 0160:644-821. Seul ajout, étape (6 bis) : après une
-- persistance réussie et dans la même transaction, la borne écrite sur `shop` est celle de
-- L'ATTENTE (`credentials_acquired_at`, ou `created_at` pour une attente antérieure à ce lot),
-- et non celle du bail du POST que persist vient d'écrire. Le grant date du callback ; le POST
-- de rattachement peut le suivre de plusieurs minutes.
-- ----------------------------------------------------------------------------
create or replace function public.consume_shopify_pending_installation(
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

  -- Attente périmée : la boutique a été reconnectée pour cette app par un autre chemin depuis
  -- le callback. Le grant de l'attente est antérieur ; Shopify a donc déjà retiré son refresh
  -- token. Le persister écraserait une connexion valide. Placée après la propriété : seul le
  -- même locataire atteint ce verdict, un tiers reçoit toujours `refused`.
  if v_shop_exists
     and v_shop.shopify_client_id is not distinct from v_pending.shopify_client_id
     and v_shop.status is not distinct from 'active'
     and v_shop.access_token_encrypted is not null then
    delete from public.shopify_pending_installation pi where pi.id = v_pending.id;
    return query select 'already_connected'::text, v_shop.id, v_shop.shop_domain,
                        v_shop.shopify_client_id;
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

  -- (6 bis) G5 : la borne est celle du grant de l'attente, jamais celle du bail de ce POST.
  update public.shop s
  set credentials_acquired_at = coalesce(v_pending.credentials_acquired_at, v_pending.created_at)
  where s.id = v_persist_shop_id;

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

-- ----------------------------------------------------------------------------
-- 7. Désinstallation ORDONNÉE (G6).
--
-- Même rôle que uninstall_shopify_pending_or_shop (0160), avec deux entrées de plus :
-- l'horodatage de l'événement (`X-Shopify-Triggered-At`) et une marge. Une seule transaction.
--
-- HYPOTHÈSES ET LIMITES, à ne jamais présenter autrement :
--   H1. `p_event_triggered_at` vient d'un en-tête NON SIGNÉ : le HMAC Shopify ne couvre que le
--       corps brut. Il est accepté comme INDICATION D'ORDRE, jamais comme une preuve.
--   Domaine. `p_shop_domain` n'est lié cryptographiquement à la livraison QUE sur le chemin
--       opaque (jeton d'URL → connexion). Sur l'endpoint historique, il peut venir de l'en-tête
--       non signé (D20b, 0160:875-883) : ne jamais le présenter comme authentifié.
--   Doute. En cas d'ambiguïté, le choix se porte sur l'issue RÉCUPÉRABLE : désinstaller ou
--       supprimer à tort se répare en rouvrant Tëër depuis l'admin Shopify ; conserver à tort
--       laisse des jetons révoqués en place, sans récupération automatique. D'où : horodatage
--       NULL → désinstallation et suppression ; borne NULL sur la boutique → aucune garde
--       d'ancienneté ; événement dans la marge → traité.
--
--   1. bail : ligne de génération 0 insérée si elle manque (motif 0159), puis VERROUILLÉE sans
--      incrément. Toutes les décisions sont prises sous ce verrou.
--   2. boutique du domaine, sous verrou :
--        absente                                                    → not_found
--        rattachée à une AUTRE app (NULL = aucune app, pas une autre) → other_app
--        active, même app, borne non NULL, horodatage non NULL, et
--        horodatage < borne − marge                                 → stale_ignored
--        sinon : uninstall_shopify_shop_fenced par COMPOSITION, sans modification
--                                                     → uninstalled | already_uninstalled
--   3. préemption du bail (génération + 1) SAUF pour stale_ignored et other_app. Dans ces deux
--      cas la boutique reste en l'état, et elle peut être saine : préempter ferait perdre un
--      rafraîchissement en cours (son `persist` rendrait lease_lost après que Shopify a délivré
--      la nouvelle paire). Pour other_app, la préemption ne protégerait rien : une autorisation
--      de l'app de l'événement sur cette boutique est déjà refusée avant toute écriture
--      (app_switch_refused). Pour not_found, uninstalled et already_uninstalled, la préemption
--      arrête une acquisition en vol dont les jetons seraient révoqués. La composition préempte
--      une seconde fois quand elle désinstalle.
--   4. attente active du couple, sous verrou :
--        supprimée si l'horodatage est NULL, ou si
--        coalesce(credentials_acquired_at, created_at) < horodatage + marge
--        conservée sinon.
--
-- Un horodatage dans le futur se comporte comme un horodatage absent, sans traitement à part :
-- il n'est antérieur à aucune borne (pas de stale_ignored) et toute attente lui est antérieure.
--
-- Sorties, une ligne toujours :
--   shop_effect         not_found | other_app | stale_ignored | uninstalled |
--                       already_uninstalled | invalid_input
--   pending_effect      deleted | kept | none
--   shop_transitioned   vrai SEULEMENT si la boutique est passée de `active` à `uninstalled`
--                       dans cet appel
--   pending_deleted     vrai SEULEMENT si une attente a été supprimée dans cet appel
--   shop_id, merchant_account_id   de la boutique du domaine, sauf not_found et other_app
--   generation          dernière génération d'un bail PRIS par cet appel ; NULL pour
--                       stale_ignored et other_app (et invalid_input), où aucun bail n'a été
--                       pris.
-- Aucun booléen unique d'effet : chaque effet aval dépend de SON booléen. L'appelant libère le
-- bail de la génération rendue, et seulement celle-là : libérer sur un stale_ignored ou un
-- other_app libérerait le bail d'un autre détenteur — c'est pourquoi la génération y est NULL.
-- ----------------------------------------------------------------------------
create function public.uninstall_shopify_pending_or_shop_ordered(
  p_shop_domain text,
  p_client_id text,
  p_ttl_seconds integer,
  p_event_triggered_at timestamptz,
  p_margin_seconds integer
)
returns table (
  shop_effect text,
  pending_effect text,
  shop_transitioned boolean,
  pending_deleted boolean,
  shop_id uuid,
  merchant_account_id uuid,
  generation bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_margin interval;
  v_generation bigint;
  v_shop public.shop%rowtype;
  v_shop_exists boolean;
  v_shop_effect text;
  v_shop_transitioned boolean := false;
  v_uninstall_outcome text;
  v_uninstall_generation bigint;
  v_pending public.shopify_pending_installation%rowtype;
  v_pending_effect text := 'none';
  v_pending_deleted boolean := false;
begin
  if p_shop_domain is null
     or p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
     or p_client_id is null or btrim(p_client_id) = ''
     or p_ttl_seconds is null or p_ttl_seconds <= 0
     or p_margin_seconds is null or p_margin_seconds < 0 then
    return query
      select 'invalid_input'::text, 'none'::text, false, false,
             null::uuid, null::uuid, null::bigint;
    return;
  end if;

  v_margin := make_interval(secs => p_margin_seconds);

  -- (1) Bail : ligne garantie, puis verrouillée SANS incrément.
  insert into public.shopify_token_lease (shop_domain, generation, lease_expires_at, acquired_at)
  values (p_shop_domain, 0, null, null)
  on conflict (shop_domain) do nothing;

  perform 1
  from public.shopify_token_lease l
  where l.shop_domain = p_shop_domain
  for update;

  -- (2) Boutique du domaine, sous verrou.
  select *
    into v_shop
  from public.shop s
  where s.shop_domain = p_shop_domain
  for update;

  v_shop_exists := found;

  if not v_shop_exists then
    v_shop_effect := 'not_found';
  elsif v_shop.shopify_client_id is not null
        and v_shop.shopify_client_id is distinct from p_client_id then
    v_shop_effect := 'other_app';
  elsif v_shop.status is not distinct from 'active'
        and v_shop.shopify_client_id is not distinct from p_client_id
        and v_shop.credentials_acquired_at is not null
        and p_event_triggered_at is not null
        and p_event_triggered_at < v_shop.credentials_acquired_at - v_margin then
    v_shop_effect := 'stale_ignored';
  end if;

  -- (3) Préemption, sauf quand la boutique reste en l'état : événement ancien, ou autre app.
  if v_shop_effect is distinct from 'stale_ignored'
     and v_shop_effect is distinct from 'other_app' then
    update public.shopify_token_lease l
    set generation = l.generation + 1,
        lease_expires_at = now() + make_interval(secs => p_ttl_seconds),
        acquired_at = now()
    where l.shop_domain = p_shop_domain
    returning l.generation into v_generation;
  end if;

  -- Désinstallation par composition : la boutique existe, n'est pas à une autre app, et
  -- l'événement n'est pas ancien.
  if v_shop_effect is null then
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
      v_shop_effect := 'uninstalled';
      v_generation := v_uninstall_generation;
      v_shop_transitioned := v_shop.status is not distinct from 'active';
    elsif v_uninstall_outcome is not distinct from 'already_uninstalled' then
      v_shop_effect := 'already_uninstalled';
    else
      -- Inatteignable par construction : la ligne est verrouillée, désignée par son propre id
      -- et son propre locataire, et la garde d'app vient d'être passée. Lever annule la
      -- transaction entière plutôt que de rendre un effet que l'appelant ne saurait pas lire.
      raise exception 'shopify_ordered_uninstall_unexpected_outcome';
    end if;
  end if;

  -- (4) Attente active du couple, sous verrou. L'index unique partiel en garantit une au plus.
  select *
    into v_pending
  from public.shopify_pending_installation pi
  where pi.shop_domain = p_shop_domain
    and pi.shopify_client_id = p_client_id
    and pi.consumed_at is null
  for update;

  if found then
    if p_event_triggered_at is null
       or coalesce(v_pending.credentials_acquired_at, v_pending.created_at)
          < p_event_triggered_at + v_margin then
      delete from public.shopify_pending_installation pi
      where pi.id = v_pending.id;

      v_pending_effect := 'deleted';
      v_pending_deleted := true;
    else
      v_pending_effect := 'kept';
    end if;
  end if;

  return query
    select
      v_shop_effect,
      v_pending_effect,
      v_shop_transitioned,
      v_pending_deleted,
      case when v_shop_effect in ('uninstalled', 'already_uninstalled', 'stale_ignored')
           then v_shop.id else null::uuid end,
      case when v_shop_effect in ('uninstalled', 'already_uninstalled', 'stale_ignored')
           then v_shop.merchant_account_id else null::uuid end,
      v_generation;
end;
$$;

comment on function public.uninstall_shopify_pending_or_shop_ordered(
  text, text, integer, timestamptz, integer
) is
  'Désinstallation ordonnée (lot 1b, G6). H1 : p_event_triggered_at vient d''un en-tête non signé, accepté comme indication d''ordre, jamais comme une preuve. p_shop_domain n''est lié cryptographiquement à la livraison que sur le chemin opaque. En cas d''ambiguïté, le choix se porte sur l''issue récupérable (désinstaller, supprimer).';

revoke all on function public.uninstall_shopify_pending_or_shop_ordered(
  text, text, integer, timestamptz, integer
) from public;
revoke all on function public.uninstall_shopify_pending_or_shop_ordered(
  text, text, integer, timestamptz, integer
) from anon, authenticated;
grant execute on function public.uninstall_shopify_pending_or_shop_ordered(
  text, text, integer, timestamptz, integer
) to service_role;
