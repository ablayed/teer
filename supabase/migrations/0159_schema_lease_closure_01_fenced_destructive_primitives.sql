-- ============================================================================
-- 0159 — SCHEMA-LEASE-CLOSURE-01 : primitives préemptives et fencées pour les écrivains que
-- 0158 ne couvrait pas
--
-- 0158 a posé le bail par domaine et l'écriture fencée des credentials VALIDES (échange de
-- code, token exchange, rafraîchissement). Le réinventaire de SHOPIFY-EXPIRING-TOKENS-01 a
-- compté huit écrivains de `shop`, pas six, et établi que 0158 ne permet pas d'EFFACER sous
-- contrôle de génération : ses trois modes exigent un jeton d'accès non vide (0158:234), et une
-- mise à jour PostgREST de `shop` ne peut pas vérifier la ligne de bail dans la même
-- instruction. Ce lot ajoute les primitives manquantes ; aucune n'est encore appelée.
--
-- Régime par chemin (tranché par le porteur, non rouvrable) :
--   app/uninstalled (lib/shopify/webhook-core.ts:706)         préemption destructive
--   disconnectShopAction (lib/actions/shops.ts:161-175)       préemption destructive, AVEC
--                                                             effacement réel des credentials
--   libération d'identité (release_shopify_shop_app_identity) préemption destructive
--   rattachement embarqué (link_shopify_embedded_shop)        bail normal d'acquisition : il
--                                                             reçoit et vérifie la génération,
--                                                             il ne préempte pas
--
-- Le rattachement n'est traitable ici QUE parce que le bail est clé par le DOMAINE et non par
-- `shop_id` (décision de 0158, en-tête) : ce chemin CRÉE la ligne `shop`, aucune colonne portée
-- par `shop` n'aurait pu le couvrir. Ce n'est pas une chance, c'est la raison de cette clé.
--
-- Forme : UNE RPC PAR INTENTION, pas une RPC à mode. Mesuré avant de choisir : le `p_mode` de
-- persist_shopify_credentials_fenced tenait parce que ses trois modes reçoivent les MÊMES
-- paramètres et adressent la ligne de la même façon. Ici, rien de commun : la désinstallation
-- adresse la boutique par domaine, sans utilisateur, et écrit sept colonnes ; la déconnexion
-- l'adresse par id, exige un owner, et n'écrit pas `uninstalled_at` ; la libération l'adresse par
-- id, exige un owner ET un rôle de boutique, et n'écrit que `shopify_client_id`. Une RPC à mode
-- aurait l'union de ces paramètres, dont la moitié NULL selon le mode — une garde oubliée sur un
-- paramètre NULL serait silencieuse.
--
-- Atomicité par intention : dans UNE transaction, (1) verrou de la ligne de bail, (2) verrou et
-- gardes de la ligne `shop`, (3) incrément de la génération à l'horloge de la base, (4) écriture
-- destructive, (5) génération rendue pour l'écriture fencée best-effort de `store_connection`.
-- Une RPC de préemption suivie d'une RPC d'écriture laisserait, sur une panne entre les deux, un
-- bail préempté et une désinstallation non enregistrée. Toutes les gardes passent AVANT
-- l'incrément : un refus ne fait jamais bouger la génération.
--
-- Ordre des verrous : BAIL puis SHOP, comme persist_shopify_credentials_fenced (0158). L'ordre
-- inverse exposerait à un interblocage avec une écriture fencée concurrente. Pour les chemins
-- adressés par id, le domaine est lu sans verrou, puis relu sous verrou : un domaine changé entre
-- les deux rend `state_changed`, jamais une écriture sous le bail d'un autre domaine.
--
-- Bail et domaines non canoniques : le bail n'admet que `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`.
-- Un domaine hors de cette forme — boutique manuelle `manual-….internal`, boutique WooCommerce,
-- ou domaine Shopify historique non canonique — ne peut être écrit par AUCUNE écriture fencée de
-- 0158 (elles le refusent en invalid_input) : il n'y a donc aucune acquisition à sérialiser
-- contre lui. Les primitives destructives l'écrivent sans bail et rendent une génération NULL.
-- Refuser ici laisserait une boutique fantôme active sur une désinstallation réelle.
--
-- Ligne de bail de génération 0 : pour verrouiller un domaine jamais acquis, les primitives
-- insèrent `(domaine, 0, NULL)` si la ligne manque. Génération 0 et échéance NULL équivalent à
-- l'absence de ligne : acquire_shopify_token_lease la fait passer à 1, comme une insertion.
--
-- Additive et rétrocompatible : link_shopify_embedded_shop et release_shopify_shop_app_identity
-- (0155) restent en place, inchangées, parce que le code déployé les appelle encore. Aucune
-- surcharge : les nouvelles fonctions portent des NOMS DISTINCTS (une seconde signature sous le
-- même nom créerait une ambiguïté de résolution — motif payé avec transition_order).
--
-- Séquence de fermeture, nommée ici pour ne pas se perdre :
--   1. 0159 additive (ce fichier) ; 2. attestation de 0159 ; 3. lot applicatif : les huit
--   écrivains basculent sur les primitives fencées, avec la preuve 9B ; 4. 0160 : révocation
--   puis suppression des primitives non fencées, après une preuve de ZÉRO appelant mesurée sur
--   le dépôt ; 5. attestation de 0160. Sans 0160, le bail ne serait exhaustif que par convention.
--
-- ACL : chaque fonction est security invoker, search_path vide, EXECUTE au seul service_role.
-- Aucune ACL de `shop`, `store_connection` ni `shopify_token_lease` n'est modifiée.
--
-- RETOUR ARRIÈRE (aucun code applicatif n'y fait référence à la date de ce lot) :
--   begin;
--   drop function public.mark_shopify_store_connection_uninstalled_fenced(text, bigint, uuid);
--   drop function public.link_shopify_embedded_shop_fenced(uuid, uuid, text, text, bigint);
--   drop function public.release_shopify_shop_app_identity_fenced(uuid, uuid, text, integer);
--   drop function public.disconnect_shop_fenced(uuid, uuid, uuid, integer);
--   drop function public.uninstall_shopify_shop_fenced(text, uuid, uuid, text, integer);
--   commit;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Désinstallation Shopify (webhook app/uninstalled). Reprend l'écriture de
-- processAppUninstalledCore (webhook-core.ts:704-718) : statut, `uninstalled_at`, les quatre
-- colonnes de jeton à NULL, `updated_at`, sur la ligne désignée par domaine + id + locataire.
--
-- Garde d'app (SEC-APP-SWITCH-01) : `p_client_id` est l'app dont le HMAC a été validé. Une
-- boutique rattachée à une AUTRE app n'est pas désinstallée par elle. NULL côté boutique signifie
-- « aucune app », jamais « une autre app » (même règle que decideShopAppSwitch) : il ne refuse pas.
--
-- Idempotence : une boutique déjà désinstallée et sans aucun credential rend
-- `already_uninstalled`, sans écriture NI incrément. Deux désinstallations concurrentes : la
-- seconde attend le verrou de bail, voit l'état écrit par la première, et n'aboutit pas.
--
-- Verdicts : uninstalled | already_uninstalled | shop_not_found | ownership_refused |
-- app_identity_mismatch | invalid_input.
-- ----------------------------------------------------------------------------
create function public.uninstall_shopify_shop_fenced(
  p_shop_domain text,
  p_shop_id uuid,
  p_merchant_account_id uuid,
  p_client_id text,
  p_ttl_seconds integer
)
returns table (outcome text, shop_id uuid, generation bigint)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_leased boolean;
  v_generation bigint;
  v_shop public.shop%rowtype;
begin
  if p_shop_domain is null or btrim(p_shop_domain) = ''
     or p_shop_id is null
     or p_merchant_account_id is null
     or p_client_id is null or btrim(p_client_id) = ''
     or p_ttl_seconds is null or p_ttl_seconds <= 0 then
    return query select 'invalid_input'::text, null::uuid, null::bigint;
    return;
  end if;

  v_leased := p_shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$';

  -- (1) Verrou du bail, AVANT la ligne `shop`.
  if v_leased then
    insert into public.shopify_token_lease (shop_domain, generation, lease_expires_at, acquired_at)
    values (p_shop_domain, 0, null, null)
    on conflict (shop_domain) do nothing;

    perform 1
    from public.shopify_token_lease l
    where l.shop_domain = p_shop_domain
    for update;
  end if;

  -- (2) Ligne `shop` verrouillée et gardes.
  select *
    into v_shop
  from public.shop s
  where s.shop_domain = p_shop_domain
  for update;

  if not found then
    return query select 'shop_not_found'::text, null::uuid, null::bigint;
    return;
  end if;

  -- Propriété AVANT app, comme 0158 : un locataire étranger n'apprend pas qu'une app est
  -- rattachée. L'id et le locataire reçus doivent désigner CETTE ligne (défense en profondeur
  -- de webhook-core.ts:716-718 : id + locataire + domaine, jamais une seule colonne).
  if v_shop.id is distinct from p_shop_id
     or v_shop.merchant_account_id is distinct from p_merchant_account_id then
    return query select 'ownership_refused'::text, null::uuid, null::bigint;
    return;
  end if;

  if v_shop.shopify_client_id is not null
     and v_shop.shopify_client_id is distinct from p_client_id then
    return query select 'app_identity_mismatch'::text, null::uuid, null::bigint;
    return;
  end if;

  if v_shop.status is not distinct from 'uninstalled'
     and v_shop.access_token_encrypted is null
     and v_shop.refresh_token_encrypted is null
     and v_shop.access_token_expires_at is null
     and v_shop.refresh_token_expires_at is null then
    return query select 'already_uninstalled'::text, v_shop.id, null::bigint;
    return;
  end if;

  -- (3) Préemption : toute acquisition en cours devient périmée.
  if v_leased then
    update public.shopify_token_lease l
    set generation = l.generation + 1,
        lease_expires_at = now() + make_interval(secs => p_ttl_seconds),
        acquired_at = now()
    where l.shop_domain = p_shop_domain
    returning l.generation into v_generation;
  end if;

  -- (4) Écriture destructive, dans la même transaction.
  update public.shop s
  set status = 'uninstalled',
      uninstalled_at = now(),
      access_token_encrypted = null,
      refresh_token_encrypted = null,
      access_token_expires_at = null,
      refresh_token_expires_at = null,
      updated_at = now()
  where s.id = v_shop.id;

  return query select 'uninstalled'::text, v_shop.id, v_generation;
end;
$$;

revoke all on function public.uninstall_shopify_shop_fenced(text, uuid, uuid, text, integer)
  from public;
revoke all on function public.uninstall_shopify_shop_fenced(text, uuid, uuid, text, integer)
  from anon, authenticated, service_role;
grant execute on function public.uninstall_shopify_shop_fenced(text, uuid, uuid, text, integer)
  to service_role;

-- ----------------------------------------------------------------------------
-- Déconnexion par le propriétaire (disconnectShopAction). Écart corrigé par cette primitive :
-- l'action actuelle pose `uninstalled` SANS effacer les credentials (shops.ts:168-171). Ici, les
-- quatre colonnes de jeton passent à NULL avec le statut. `uninstalled_at` n'est PAS écrit : la
-- déconnexion ne l'a jamais écrit, et ce lot n'élargit pas son jeu de colonnes au-delà de
-- l'effacement décidé.
--
-- L'action vise toute boutique du compte, y compris manuelle et WooCommerce (listShopsAction ne
-- filtre pas `store_kind`, settings-shops.tsx:260-266) : le bail n'est pris que pour un domaine
-- Shopify canonique (voir l'en-tête).
--
-- Gardes : `requireRole('owner')` réévalué ici sur `merchant_member`, NULL-safe (non-membre →
-- not_a_member) ; la ligne doit appartenir au locataire reçu (filtre de shops.ts:173).
--
-- Verdicts : disconnected | already_disconnected | shop_not_found | ownership_refused |
-- not_a_member | insufficient_role | state_changed | invalid_input.
-- ----------------------------------------------------------------------------
create function public.disconnect_shop_fenced(
  p_user_id uuid,
  p_merchant_account_id uuid,
  p_shop_id uuid,
  p_ttl_seconds integer
)
returns table (outcome text, shop_id uuid, generation bigint)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_member_role text;
  v_domain text;
  v_leased boolean;
  v_generation bigint;
  v_shop public.shop%rowtype;
begin
  if p_user_id is null
     or p_merchant_account_id is null
     or p_shop_id is null
     or p_ttl_seconds is null or p_ttl_seconds <= 0 then
    return query select 'invalid_input'::text, null::uuid, null::bigint;
    return;
  end if;

  select mm.role
    into v_member_role
  from public.merchant_member mm
  where mm.user_id = p_user_id
    and mm.merchant_account_id = p_merchant_account_id;

  if v_member_role is null then
    return query select 'not_a_member'::text, null::uuid, null::bigint;
    return;
  end if;

  if v_member_role is distinct from 'owner' then
    return query select 'insufficient_role'::text, null::uuid, null::bigint;
    return;
  end if;

  -- Domaine lu sans verrou, pour prendre le verrou de bail AVANT celui de `shop`.
  select s.shop_domain
    into v_domain
  from public.shop s
  where s.id = p_shop_id;

  if not found then
    return query select 'shop_not_found'::text, null::uuid, null::bigint;
    return;
  end if;

  v_leased := v_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$';

  if v_leased then
    insert into public.shopify_token_lease (shop_domain, generation, lease_expires_at, acquired_at)
    values (v_domain, 0, null, null)
    on conflict (shop_domain) do nothing;

    perform 1
    from public.shopify_token_lease l
    where l.shop_domain = v_domain
    for update;
  end if;

  select *
    into v_shop
  from public.shop s
  where s.id = p_shop_id
  for update;

  if not found then
    return query select 'shop_not_found'::text, null::uuid, null::bigint;
    return;
  end if;

  if v_shop.shop_domain is distinct from v_domain then
    return query select 'state_changed'::text, null::uuid, null::bigint;
    return;
  end if;

  if v_shop.merchant_account_id is distinct from p_merchant_account_id then
    return query select 'ownership_refused'::text, null::uuid, null::bigint;
    return;
  end if;

  if v_shop.status is not distinct from 'uninstalled'
     and v_shop.access_token_encrypted is null
     and v_shop.refresh_token_encrypted is null
     and v_shop.access_token_expires_at is null
     and v_shop.refresh_token_expires_at is null then
    return query select 'already_disconnected'::text, v_shop.id, null::bigint;
    return;
  end if;

  if v_leased then
    update public.shopify_token_lease l
    set generation = l.generation + 1,
        lease_expires_at = now() + make_interval(secs => p_ttl_seconds),
        acquired_at = now()
    where l.shop_domain = v_domain
    returning l.generation into v_generation;
  end if;

  update public.shop s
  set status = 'uninstalled',
      access_token_encrypted = null,
      refresh_token_encrypted = null,
      access_token_expires_at = null,
      refresh_token_expires_at = null,
      updated_at = now()
  where s.id = v_shop.id;

  return query select 'disconnected'::text, v_shop.id, v_generation;
end;
$$;

revoke all on function public.disconnect_shop_fenced(uuid, uuid, uuid, integer) from public;
revoke all on function public.disconnect_shop_fenced(uuid, uuid, uuid, integer)
  from anon, authenticated, service_role;
grant execute on function public.disconnect_shop_fenced(uuid, uuid, uuid, integer)
  to service_role;

-- ----------------------------------------------------------------------------
-- Libération d'identité d'app, étape 3 (shop.shopify_client_id → NULL). Gardes reprises À
-- L'IDENTIQUE de release_shopify_shop_app_identity (0155:171-240) — owner sur le locataire de la
-- LIGNE, rôle de boutique owner/manager, compare-and-set (status uninstalled, ancienne app) —
-- puis préemption du bail avant l'écriture. Les étapes 1, 2 et 4 (audit, store_connection,
-- jeton opaque) restent applicatives (lib/shopify/app-release-write.ts).
--
-- Verdicts : released | shop_not_found | not_a_member | insufficient_role | state_changed |
-- write_failed (entrées invalides, comme 0155).
-- ----------------------------------------------------------------------------
create function public.release_shopify_shop_app_identity_fenced(
  p_user_id uuid,
  p_shop_id uuid,
  p_old_client_id text,
  p_ttl_seconds integer
)
returns table (outcome text, generation bigint)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_domain text;
  v_leased boolean;
  v_generation bigint;
  v_shop public.shop%rowtype;
  v_member_role text;
  v_shop_role text;
begin
  if p_user_id is null or p_shop_id is null or p_old_client_id is null
     or p_ttl_seconds is null or p_ttl_seconds <= 0 then
    return query select 'write_failed'::text, null::bigint;
    return;
  end if;

  select s.shop_domain
    into v_domain
  from public.shop s
  where s.id = p_shop_id;

  if not found then
    return query select 'shop_not_found'::text, null::bigint;
    return;
  end if;

  v_leased := v_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$';

  if v_leased then
    insert into public.shopify_token_lease (shop_domain, generation, lease_expires_at, acquired_at)
    values (v_domain, 0, null, null)
    on conflict (shop_domain) do nothing;

    perform 1
    from public.shopify_token_lease l
    where l.shop_domain = v_domain
    for update;
  end if;

  select *
    into v_shop
  from public.shop s
  where s.id = p_shop_id
  for update;

  if not found then
    return query select 'shop_not_found'::text, null::bigint;
    return;
  end if;

  if v_shop.shop_domain is distinct from v_domain then
    return query select 'state_changed'::text, null::bigint;
    return;
  end if;

  select mm.role
    into v_member_role
  from public.merchant_member mm
  where mm.user_id = p_user_id
    and mm.merchant_account_id = v_shop.merchant_account_id;

  if v_member_role is null then
    return query select 'not_a_member'::text, null::bigint;
    return;
  end if;

  if v_member_role is distinct from 'owner' then
    return query select 'insufficient_role'::text, null::bigint;
    return;
  end if;

  select sm.role
    into v_shop_role
  from public.shop_member sm
  where sm.shop_id = v_shop.id
    and sm.user_id = p_user_id;

  if v_shop_role is null or v_shop_role not in ('owner', 'manager') then
    return query select 'insufficient_role'::text, null::bigint;
    return;
  end if;

  if v_shop.status is distinct from 'uninstalled'
     or v_shop.shopify_client_id is distinct from p_old_client_id then
    return query select 'state_changed'::text, null::bigint;
    return;
  end if;

  if v_leased then
    update public.shopify_token_lease l
    set generation = l.generation + 1,
        lease_expires_at = now() + make_interval(secs => p_ttl_seconds),
        acquired_at = now()
    where l.shop_domain = v_domain
    returning l.generation into v_generation;
  end if;

  update public.shop s
  set shopify_client_id = null,
      updated_at = now()
  where s.id = v_shop.id
    and s.status = 'uninstalled'
    and s.shopify_client_id = p_old_client_id;

  return query select 'released'::text, v_generation;
end;
$$;

revoke all on function public.release_shopify_shop_app_identity_fenced(uuid, uuid, text, integer)
  from public;
revoke all on function public.release_shopify_shop_app_identity_fenced(uuid, uuid, text, integer)
  from anon, authenticated, service_role;
grant execute on function public.release_shopify_shop_app_identity_fenced(uuid, uuid, text, integer)
  to service_role;

-- ----------------------------------------------------------------------------
-- Rattachement embarqué, sous bail d'acquisition. Corps repris À L'IDENTIQUE de
-- link_shopify_embedded_shop (0155:52-160), précédé du contrôle de génération : la génération
-- reçue doit être la génération courante d'un bail non libéré, vérifiée sous verrou de la ligne
-- de bail, tenu jusqu'à la fin de la transaction. Pas de préemption : l'appelant a obtenu le bail
-- par acquire_shopify_token_lease, et une écriture tardive d'un détenteur périmé ne modifie plus
-- ni `status` ni `shopify_client_id`.
--
-- Le domaine doit être canonique : sans cela, aucun bail ne peut exister pour lui
-- (`intent_invalid`, comme une intention vide dans 0155).
--
-- Verdicts : ceux de 0155 (inserted | updated | intent_invalid | not_a_member |
-- insufficient_role | app_switch_refused | ownership_refused | write_failed) plus lease_lost.
-- ----------------------------------------------------------------------------
create function public.link_shopify_embedded_shop_fenced(
  p_user_id uuid,
  p_merchant_account_id uuid,
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
  v_member_role text;
  v_shop public.shop%rowtype;
  v_shop_role text;
  v_inserted_id uuid;
begin
  if p_user_id is null
     or p_merchant_account_id is null
     or p_shop_domain is null
     or p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
     or p_client_id is null or btrim(p_client_id) = ''
     or p_generation is null then
    return 'intent_invalid';
  end if;

  -- Fencing, sous verrou, AVANT toute lecture ou écriture de `shop`.
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
    return 'write_failed';
  end if;

  if v_shop.shopify_client_id is not null
     and v_shop.shopify_client_id is distinct from p_client_id then
    return 'app_switch_refused';
  end if;

  if v_shop.merchant_account_id is distinct from p_merchant_account_id then
    return 'ownership_refused';
  end if;

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

revoke all on function public.link_shopify_embedded_shop_fenced(uuid, uuid, text, text, bigint)
  from public;
revoke all on function public.link_shopify_embedded_shop_fenced(uuid, uuid, text, text, bigint)
  from anon, authenticated, service_role;
grant execute on function public.link_shopify_embedded_shop_fenced(uuid, uuid, text, text, bigint)
  to service_role;

-- ----------------------------------------------------------------------------
-- Écriture fencée de `store_connection` après une désinstallation, dans sa propre transaction :
-- son échec ne défait jamais la désinstallation de `shop` (best-effort voulu, comme
-- runDualWrite de webhook-core.ts:730-736). Elle exige la génération rendue par
-- uninstall_shopify_shop_fenced — ou par une acquisition normale, pour une reprise après un
-- `already_uninstalled` : une réinstallation ultérieure ne peut donc plus être remise à
-- `uninstalled` par une écriture tardive.
--
-- Même écriture que webhook-core.ts:733-735 (statut, `uninstalled_at`), plus le locataire en
-- défense en profondeur : une connexion d'un autre locataire n'est jamais touchée.
--
-- Verdicts : written | lease_lost | connection_not_found | ownership_refused | invalid_input.
-- ----------------------------------------------------------------------------
create function public.mark_shopify_store_connection_uninstalled_fenced(
  p_shop_domain text,
  p_generation bigint,
  p_merchant_account_id uuid
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
  v_connection public.store_connection%rowtype;
begin
  if p_shop_domain is null
     or p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
     or p_generation is null
     or p_merchant_account_id is null then
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
    into v_connection
  from public.store_connection c
  where c.platform = 'shopify'
    and c.external_identifier = p_shop_domain
  for update;

  if not found then
    return query select 'connection_not_found'::text, null::uuid;
    return;
  end if;

  if v_connection.merchant_account_id is distinct from p_merchant_account_id then
    return query select 'ownership_refused'::text, null::uuid;
    return;
  end if;

  update public.store_connection c
  set status = 'uninstalled',
      uninstalled_at = now()
  where c.id = v_connection.id;

  return query select 'written'::text, v_connection.id;
end;
$$;

revoke all on function public.mark_shopify_store_connection_uninstalled_fenced(text, bigint, uuid)
  from public;
revoke all on function public.mark_shopify_store_connection_uninstalled_fenced(text, bigint, uuid)
  from anon, authenticated, service_role;
grant execute on function public.mark_shopify_store_connection_uninstalled_fenced(text, bigint, uuid)
  to service_role;
