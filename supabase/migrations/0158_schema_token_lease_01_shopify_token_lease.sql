-- ============================================================================
-- 0158 — SCHEMA-TOKEN-LEASE-01 : bail de jeton Shopify par domaine, avec fencing
--
-- Shopify exige de SÉRIALISER, par boutique, trois opérations qui s'annulent mutuellement :
-- l'échange de code d'autorisation, le token exchange par ID token et le rafraîchissement
-- (« Acquiring a token and refreshing one each retire the other's result »). Aucun verrou
-- transactionnel ne peut entourer l'appel HTTP sortant : il faut un bail, et un fencing à
-- l'écriture pour qu'un détenteur dont le bail a expiré pendant l'appel n'écrase pas son
-- successeur.
--
-- Pourquoi une table indépendante de `shop` (mesuré au préflight, non rouvrable) : sur le
-- chemin d'échange de code, la ligne `shop` n'existe pas encore au moment de l'appel Shopify
-- (app/api/shopify/callback/route.ts:100-104 lecture, :157 appel, :182-187 insertion). Le bail
-- est donc adressé par le DOMAINE, qui existe avant la boutique.
--
-- Normalisation du domaine : par REFUS, jamais par transformation. Seule la forme canonique
-- `^[a-z0-9][a-z0-9-]*\.myshopify\.com$` est admise (la version minuscule de
-- validateShopDomain, lib/shopify/oauth.ts:27). Transformer silencieusement (lower/btrim)
-- ferait diverger la clé de bail de `shop.shop_domain`, comparé ici à l'identique ; refuser
-- garantit une seule clé de bail par boutique et une comparaison exacte avec `shop`.
--
-- Motif de fencing : celui de D2 (store_connection_sync_state.attempt, 0152 ; écrivain
-- lib/woocommerce/sync.ts:319-341). `generation` est une génération monotone par domaine,
-- incrémentée à chaque acquisition ; toute écriture fencée exige la génération courante et un
-- bail non libéré. Comme D2, l'expiration seule ne fence pas : elle autorise la REPRISE, et
-- c'est la reprise (génération changée) qui périme l'ancien détenteur.
--
-- Surfaces :
--   1. table public.shopify_token_lease                      — aucune ligne jamais supprimée
--   2. acquire_shopify_token_lease(domaine, ttl)           — RPC : PostgREST ne sait pas émettre
--      `on conflict … do update … where`, et l'expiration doit se lire à l'horloge de la base
--   3. renew_shopify_token_lease(domaine, génération, ttl) — RPC : échéance à l'horloge de la base
--   4. persist_shopify_credentials_fenced(…)                — RPC : prédicat inter-tables
--   5. write_shopify_store_connection_fenced(…)             — RPC : prédicat inter-tables,
--      transaction distincte de 4, échec non bloquant côté appelant
--   La LIBÉRATION n'est pas une RPC : elle s'exprime par un UPDATE PostgREST conditionnel sur
--   (shop_domain, generation, lease_expires_at non nul), sans horloge ni autre table.
--
-- Aucune durée de bail n'est figée ici : le TTL est fourni par l'appelant à chaque acquisition
-- et à chaque renouvellement. Seul invariant : TTL strictement positif.
--
-- Périmètre du fencing (union des colonnes écrites par les trois chemins sur `shop`) :
--   access_token_encrypted, refresh_token_encrypted, access_token_expires_at,
--   refresh_token_expires_at, scopes, status, updated_at, shopify_client_id, uninstalled_at
--   (+ shop_domain, merchant_account_id à l'insertion) ; sur `store_connection` :
--   shop_id, platform_app_id, status, uninstalled_at.
--
-- ACL : aucun privilège pour public, anon, authenticated (table et fonctions) ; service_role
-- reçoit sur la table SELECT, INSERT et UPDATE de colonnes nommées — jamais DELETE, dont
-- l'absence interdit de remettre une génération à zéro (ABA). Aucune ACL de `shop` ni de
-- `store_connection` n'est modifiée.
--
-- RETOUR ARRIÈRE (aucun code applicatif n'y fait référence à la date de ce lot) :
--   begin;
--   drop function public.write_shopify_store_connection_fenced(text, bigint, uuid, text);
--   drop function public.persist_shopify_credentials_fenced(
--     text, text, bigint, uuid, text, text, text, timestamptz, timestamptz, text);
--   drop function public.renew_shopify_token_lease(text, bigint, integer);
--   drop function public.acquire_shopify_token_lease(text, integer);
--   drop table public.shopify_token_lease;
--   commit;
-- ============================================================================

create table public.shopify_token_lease (
  shop_domain text primary key
    check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  generation bigint not null default 0 check (generation >= 0),
  -- NULL : bail libre (jamais pris, ou libéré par son détenteur). Non NULL : échéance, lue
  -- à l'horloge de la base ; un bail dont l'échéance est passée est repris par l'acquisition.
  lease_expires_at timestamptz,
  acquired_at timestamptz,
  created_at timestamptz not null default now(),
  constraint shopify_token_lease_held_has_generation
    check (lease_expires_at is null or generation >= 1)
);

alter table public.shopify_token_lease enable row level security;
alter table public.shopify_token_lease force row level security;
-- Aucune policy : deny-by-default pour tout rôle soumis à la RLS. service_role la contourne.
revoke all on table public.shopify_token_lease from public;
revoke all on table public.shopify_token_lease from anon, authenticated, service_role;
grant select on table public.shopify_token_lease to service_role;
grant insert (shop_domain, generation, lease_expires_at, acquired_at)
  on table public.shopify_token_lease to service_role;
grant update (generation, lease_expires_at, acquired_at)
  on table public.shopify_token_lease to service_role;

-- ----------------------------------------------------------------------------
-- Acquisition et reprise, en UNE instruction. Bail libre ou expiré → génération + 1, une
-- ligne rendue. Bail tenu → zéro ligne, sans erreur : le conflit d'unicité est absorbé par
-- `on conflict`, jamais rendu comme 23505. Deux acquisitions concurrentes sur un domaine
-- absent : la seconde attend l'insertion de la première, puis réévalue le `where` sur la ligne
-- validée et n'obtient rien.
-- ----------------------------------------------------------------------------
create function public.acquire_shopify_token_lease(
  p_shop_domain text,
  p_ttl_seconds integer
)
returns table (acquired_generation bigint, expires_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_shop_domain is null
     or p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' then
    raise exception 'shopify_token_lease_invalid_domain' using errcode = '22023';
  end if;

  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'shopify_token_lease_invalid_ttl' using errcode = '22023';
  end if;

  return query
  insert into public.shopify_token_lease as l (
    shop_domain,
    generation,
    lease_expires_at,
    acquired_at
  )
  values (
    p_shop_domain,
    1,
    now() + make_interval(secs => p_ttl_seconds),
    now()
  )
  on conflict (shop_domain) do update
    set generation = l.generation + 1,
        lease_expires_at = excluded.lease_expires_at,
        acquired_at = excluded.acquired_at
    where l.lease_expires_at is null
       or l.lease_expires_at <= now()
  returning l.generation, l.lease_expires_at;
end;
$$;

revoke all on function public.acquire_shopify_token_lease(text, integer) from public;
revoke all on function public.acquire_shopify_token_lease(text, integer)
  from anon, authenticated, service_role;
grant execute on function public.acquire_shopify_token_lease(text, integer) to service_role;

-- ----------------------------------------------------------------------------
-- Renouvellement par le seul détenteur : génération courante et bail non libéré. Zéro ligne
-- sinon. Comme D2, l'échéance dépassée n'empêche pas le renouvellement tant que personne n'a
-- repris le bail : la génération inchangée prouve qu'aucune autre opération n'a commencé.
-- ----------------------------------------------------------------------------
create function public.renew_shopify_token_lease(
  p_shop_domain text,
  p_generation bigint,
  p_ttl_seconds integer
)
returns table (expires_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'shopify_token_lease_invalid_ttl' using errcode = '22023';
  end if;

  return query
  update public.shopify_token_lease l
  set lease_expires_at = now() + make_interval(secs => p_ttl_seconds)
  where l.shop_domain = p_shop_domain
    and l.generation = p_generation
    and l.lease_expires_at is not null
  returning l.lease_expires_at;
end;
$$;

revoke all on function public.renew_shopify_token_lease(text, bigint, integer) from public;
revoke all on function public.renew_shopify_token_lease(text, bigint, integer)
  from anon, authenticated, service_role;
grant execute on function public.renew_shopify_token_lease(text, bigint, integer)
  to service_role;

-- ----------------------------------------------------------------------------
-- Écriture fencée des credentials sur `shop`, branche insertion ET branche mise à jour.
--
-- Persiste seulement si, AU MOMENT DE L'ÉCRITURE : (a) la génération est courante et le bail
-- non libéré — la ligne de bail est verrouillée, donc une reprise concurrente attend la fin de
-- cette transaction ; (b) les gardes de propriété et d'identité d'app, reprises à l'identique
-- des chemins existants, restent satisfaites sur la ligne `shop` verrouillée.
--
-- p_mode reprend le jeu de colonnes et la garde d'app de chaque chemin, sans l'élargir :
--   authorization_code  callback/route.ts:165-178 — seule voie qui INSÈRE ; écrit
--                       shopify_client_id et uninstalled_at ; garde de bascule
--                       decideShopAppSwitch (NULL = aucune app, jamais une autre app).
--   token_exchange      embedded/session/route.ts:257-270 — mise à jour seule ; app STRICTE
--                       (le filtre .eq('shopify_client_id', app) n'admet pas NULL).
--   refresh             lib/shopify/token.ts:111-126 — mise à jour seule ; app stricte ; ne
--                       touche ni scopes, ni statut, ni identité ; refuse une boutique non
--                       active (une désinstallation concurrente n'est jamais ranimée) ; un
--                       refresh token ou son échéance NULL conservent la valeur en place,
--                       comme token.ts:115-120.
--
-- Verdicts (une ligne, toujours) : inserted | updated | lease_lost | ownership_refused |
-- app_switch_refused | app_identity_mismatch | shop_not_found | shop_inactive |
-- invalid_input | write_failed. Ordre des gardes : propriété AVANT app, comme le callback
-- (route.ts:133-138) — un locataire étranger ne doit pas apprendre qu'une app est rattachée.
-- ----------------------------------------------------------------------------
create function public.persist_shopify_credentials_fenced(
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
      updated_at = now()
  where s.id = v_shop.id;

  return query select 'updated'::text, v_shop.id;
end;
$$;

revoke all on function public.persist_shopify_credentials_fenced(
  text, text, bigint, uuid, text, text, text, timestamptz, timestamptz, text
) from public;
revoke all on function public.persist_shopify_credentials_fenced(
  text, text, bigint, uuid, text, text, text, timestamptz, timestamptz, text
) from anon, authenticated, service_role;
grant execute on function public.persist_shopify_credentials_fenced(
  text, text, bigint, uuid, text, text, text, timestamptz, timestamptz, text
) to service_role;

-- ----------------------------------------------------------------------------
-- Écriture fencée de `store_connection`, appelée APRÈS la précédente, dans sa propre
-- transaction : son échec ne défait jamais des credentials déjà persistés (best-effort voulu,
-- callback/route.ts:263-267). Elle porte l'identité d'app (`platform_app_id`) : une réponse
-- tardive d'un détenteur périmé ne doit pas la réécrire après son successeur.
--
-- `shop_id` et le locataire sont DÉRIVÉS de la ligne `shop` du domaine, jamais reçus : la
-- connexion ne peut désigner qu'une boutique du locataire attendu, portant l'app attendue.
-- Une connexion existante d'un autre locataire n'est jamais réassignée (zéro ligne →
-- ownership_refused), comme la mise à jour filtrée de callback/route.ts:291-296.
--
-- Verdicts : written | lease_lost | shop_not_found | ownership_refused |
-- app_identity_mismatch | invalid_input.
-- ----------------------------------------------------------------------------
create function public.write_shopify_store_connection_fenced(
  p_shop_domain text,
  p_generation bigint,
  p_merchant_account_id uuid,
  p_client_id text
)
returns table (outcome text, connection_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lease_generation bigint;
  v_lease_expires_at timestamptz;
  v_shop public.shop%rowtype;
  v_connection_id uuid;
begin
  if p_shop_domain is null
     or p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
     or p_generation is null
     or p_merchant_account_id is null
     or p_client_id is null or btrim(p_client_id) = '' then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

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

  select *
    into v_shop
  from public.shop s
  where s.shop_domain = p_shop_domain
  for share;

  if not found then
    return query select 'shop_not_found'::text, null::uuid;
    return;
  end if;

  if v_shop.merchant_account_id is distinct from p_merchant_account_id then
    return query select 'ownership_refused'::text, null::uuid;
    return;
  end if;

  if v_shop.shopify_client_id is distinct from p_client_id then
    return query select 'app_identity_mismatch'::text, null::uuid;
    return;
  end if;

  insert into public.store_connection as c (
    merchant_account_id,
    shop_id,
    platform,
    external_identifier,
    platform_app_id,
    status,
    uninstalled_at
  )
  values (
    v_shop.merchant_account_id,
    v_shop.id,
    'shopify',
    p_shop_domain,
    p_client_id,
    'active',
    null
  )
  on conflict on constraint store_connection_platform_external_key do update
    set shop_id = excluded.shop_id,
        platform_app_id = excluded.platform_app_id,
        status = 'active',
        uninstalled_at = null
    where c.merchant_account_id = excluded.merchant_account_id
  returning c.id into v_connection_id;

  if v_connection_id is null then
    return query select 'ownership_refused'::text, null::uuid;
    return;
  end if;

  return query select 'written'::text, v_connection_id;
end;
$$;

revoke all on function public.write_shopify_store_connection_fenced(text, bigint, uuid, text)
  from public;
revoke all on function public.write_shopify_store_connection_fenced(text, bigint, uuid, text)
  from anon, authenticated, service_role;
grant execute on function public.write_shopify_store_connection_fenced(text, bigint, uuid, text)
  to service_role;
