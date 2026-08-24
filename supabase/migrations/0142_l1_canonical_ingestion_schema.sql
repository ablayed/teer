-- ============================================================================
-- 0142 — Lot L1 : schéma canonique additif (identité externe / ingestion)
-- ============================================================================
-- Purement additif. Rien de supprimé, rien rendu obligatoire, aucun chemin de
-- lecture ou d'écriture existant modifié. `orders.source` n'est PAS touchée.
--
-- VERROU DE DÉPLOIEMENT : cette migration ne part pas en production tant que
-- le Lot 4B n'a pas produit une baseline production réussie avec le rôle
-- `ci_schema_auditor`. Voir CLAUDE.md / le prompt de ce lot. Elle peut être
-- committée, appliquée en local, passer la CI — pas être déployée.
--
-- HARNAIS DE BACKFILL (scripts/l1-backfill-harness.sh, tests/rls dédié) : ce
-- backfill ne s'exécutera QU'UNE SEULE FOIS en production, sur l'historique
-- complet du moment — pas de seconde tentative. `supabase/seed.sql` ne
-- contient aucune boutique Shopify : un `db reset --local` ordinaire exécute
-- les DO blocks ci-dessous à 0=0, ce qui ne prouve rien. Le harnais monte des
-- bases fraîches et isolées (jamais le seed global), injecte une fixture
-- Shopify réaliste (2 tenants, 2 apps, GID multiples, variantes partageant un
-- `shopify_product_id`), applique CETTE migration en isolation (jamais depuis
-- 0001) et vérifie les comptes exacts par entité — ainsi que le cas négatif
-- « webhook dont la boutique n'est pas résoluble » (cas prod réel, 2026-05-30).
-- Preuve de non-partialité obtenue : les DO blocks ci-dessous s'exécutent tous
-- dans la transaction implicite du fichier de migration — un échec à
-- n'importe quel statement laisse la base EXACTEMENT à l'état d'avant (aucune
-- des 3 tables créées, `orders.store_connection_id` absente, `0142` absente
-- de `supabase_migrations.schema_migrations`), vérifié empiriquement, pas
-- supposé.
--
-- ÉCARTS entre le prompt d'origine de ce lot et le dépôt réel, vérifiés avant
-- d'écrire (voir rapport de session pour le détail complet) :
--   * order_line n'a NI `shopify_variant_id` NI `shopify_sku`. Les colonnes
--     réelles sont `raw_shopify_variant_id` / `raw_shopify_product_id`
--     (0028). Aucune des deux n'identifie la ligne de commande elle-même —
--     ce sont des références vers le produit/variant du catalogue, déjà
--     couvertes par `product.shopify_variant_id`. Aucun `shopify_line_item_id`
--     n'existe sur `order_line`. Backfiller `external_ref` pour
--     entity_type='order_line' à partir de ces colonnes serait un mauvais
--     modèle (identité empruntée à une autre entité) ET violerait
--     l'unicité (store_connection_id, entity_type, external_id) dès qu'un
--     même variant apparaît sur deux lignes de commande différentes — cas
--     courant. Décision : 'order_line' reste une valeur légale de
--     l'ensemble fermé `entity_type` (pour un futur identifiant réel, ex.
--     Shopify line_item id, si une colonne dédiée apparaît un jour), mais
--     ZÉRO ligne n'est backfillée pour ce type dans ce lot. Rien n'empêche
--     `external_ref` de rester vide pour un entity_type : les 4 colonnes
--     NOT NULL ne sont violées que par des lignes insérées, jamais par
--     l'absence de lignes.
--   * `product.shopify_product_id` n'est PAS unique par ligne de `product`
--     (plusieurs variantes partagent le même produit Shopify) ; seul
--     `shopify_variant_id` l'est (`product_merchant_variant_idx`, 0027).
--     external_ref pour entity_type='product' est donc backfillé depuis
--     `shopify_variant_id`, jamais `shopify_product_id`, pour respecter
--     l'unicité (store_connection_id, entity_type, external_id).
--   * `shop` porte déjà `unique (merchant_account_id, id)`
--     (`shop_merchant_account_id_id_key`, 0126) : aucune contrainte
--     supplémentaire n'est nécessaire sur `shop` pour la FK composite de
--     `store_connection`.
--   * `ingestion_event.payload` est délibérément OMISE (pas seulement
--     laissée nulle) : dupliquer les payloads déjà présents de
--     `webhook_event` dans une seconde table créerait une deuxième copie de
--     données potentiellement PCD que la purge de rétention (0122) ne
--     connaît pas — un trou de rétention hors du périmètre de ce lot.
--     `ingestion_event` porte les métadonnées de cycle de vie, jamais le
--     contenu brut.
-- ============================================================================

-- ── store_connection ─────────────────────────────────────────────────────
-- Ancrage d'identité de toute ingestion. Une ligne par boutique connectée à
-- une plateforme externe (aujourd'hui : Shopify uniquement). Les boutiques
-- manuelles (`shop.store_kind = 'manual'`) n'ont et n'auront jamais de ligne
-- ici.
create table public.store_connection (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  shop_id uuid not null,
  platform text not null check (platform in ('shopify')),
  external_identifier text not null,
  platform_app_id text,
  status text not null default 'active' check (status in ('active', 'uninstalled')),
  installed_at timestamptz not null default now(),
  uninstalled_at timestamptz,
  created_at timestamptz not null default now(),
  -- Intégrité composite obligatoire : empêche d'associer la boutique d'un
  -- tenant au compte d'un autre. `shop_merchant_account_id_id_key` (0126)
  -- fournit déjà la cible unique nécessaire, aucune modification de `shop`.
  constraint store_connection_shop_tenant_fk
    foreign key (merchant_account_id, shop_id)
    references public.shop (merchant_account_id, id)
    on delete cascade,
  -- Cible de FK composite pour les tables qui référencent une connexion
  -- (ingestion_event) : permet d'exiger que le compte/boutique déclarés
  -- correspondent réellement à ceux de la connexion référencée.
  constraint store_connection_id_tenant_shop_key
    unique (id, merchant_account_id, shop_id),
  constraint store_connection_platform_external_key
    unique (platform, external_identifier)
);

create index store_connection_tenant_shop_idx
  on public.store_connection (merchant_account_id, shop_id);

alter table public.store_connection enable row level security;
alter table public.store_connection force row level security;

-- Lecture : tout membre de la boutique (aucune donnée financière ou secrète
-- ici — pas de colonne de credentials, décision explicite du lot). Écriture :
-- aucune policy authenticated. Ce lot ne câble aucun chemin applicatif qui
-- écrit cette table ; seul le service-role (bypass RLS) le pourra, dans un
-- lot futur.
create policy store_connection_select on public.store_connection
  for select to authenticated
  using (
    public.current_member_role(merchant_account_id) is not null
    and public.is_shop_member_of(shop_id)
  );

revoke all on table public.store_connection from public, anon, authenticated;
grant select on table public.store_connection to authenticated;
grant all on table public.store_connection to service_role;

-- ── external_ref ─────────────────────────────────────────────────────────
-- Correspondance identifiant interne ↔ identifiant externe. Un client peut
-- porter plusieurs identifiants externes : plusieurs lignes, jamais un
-- tableau (contrairement à l'historique `customer.shopify_customer_gids`,
-- qui reste inchangé).
create table public.external_ref (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('order', 'customer', 'product', 'order_line')),
  entity_id uuid not null,
  store_connection_id uuid not null references public.store_connection(id) on delete cascade,
  external_id text not null,
  created_at timestamptz not null default now(),
  constraint external_ref_connection_type_external_key
    unique (store_connection_id, entity_type, external_id)
);

create index external_ref_entity_idx
  on public.external_ref (entity_type, entity_id);

alter table public.external_ref enable row level security;
alter table public.external_ref force row level security;

-- Pas de colonne merchant_account_id/shop_id directe sur cette table (hors
-- du jeu de colonnes mandaté par ce lot) : le prédicat de boutique/compte
-- passe par une jointure vers store_connection, qui les porte déjà.
create policy external_ref_select on public.external_ref
  for select to authenticated
  using (
    exists (
      select 1
      from public.store_connection sc
      where sc.id = external_ref.store_connection_id
        and public.current_member_role(sc.merchant_account_id) is not null
        and public.is_shop_member_of(sc.shop_id)
    )
  );

revoke all on table public.external_ref from public, anon, authenticated;
grant select on table public.external_ref to authenticated;
grant all on table public.external_ref to service_role;

-- ── ingestion_event ──────────────────────────────────────────────────────
-- Généralisation de `webhook_event`. `webhook_event` reste l'unique table
-- autoritaire dans ce lot : cette table est créée et backfillée, jamais lue
-- ni écrite par un chemin applicatif (la double écriture arrive en L2).
--
-- Le contexte autoritaire est le couple compte+boutique, jamais la
-- connexion : un import CSV ou une saisie manuelle appartient toujours à une
-- boutique, sans passer par un connecteur fournisseur.
create table public.ingestion_event (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  shop_id uuid not null,
  store_connection_id uuid,
  platform text not null,
  topic text not null,
  -- Identité de livraison fournisseur ; absente pour CSV et saisie manuelle.
  delivery_id text,
  resource_kind text,
  resource_external_id text,
  -- Valeur fournisseur opaque (aucune comparaison implémentée dans ce lot ;
  -- la sémantique par fournisseur/topic est définie en L2). Type text : rien
  -- dans les données source actuelles (webhook_event n'a jamais capturé de
  -- signal d'ordre côté ressource, seulement `received_at`/`triggered_at`,
  -- des horloges serveur) ne justifie un type plus spécifique aujourd'hui.
  ordering_signal text,
  status text not null default 'processing'
    check (status in ('processing', 'retryable', 'terminal', 'done')),
  received_at timestamptz not null default now(),
  triggered_at timestamptz,
  attempt_count integer not null default 0
    check (attempt_count between 0 and 1000),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  last_error_code text
    check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$'),
  completed_at timestamptz,
  processing_proof jsonb,
  created_at timestamptz not null default now(),
  -- Cohérence obligatoire : quand store_connection_id est renseigné, il doit
  -- désigner une connexion du MÊME compte et de la MÊME boutique que cet
  -- événement. FK composite contre store_connection_id_tenant_shop_key
  -- (MATCH SIMPLE : ignorée tant que store_connection_id est null, donc sans
  -- effet sur les sources natives).
  constraint ingestion_event_connection_tenant_shop_fk
    foreign key (store_connection_id, merchant_account_id, shop_id)
    references public.store_connection (id, merchant_account_id, shop_id)
);

-- Dédoublonnage : unicité PARTIELLE, uniquement quand delivery_id est non
-- nul (CSV/saisie manuelle n'ont pas d'identité de livraison à dédupliquer).
create unique index ingestion_event_connection_platform_delivery_idx
  on public.ingestion_event (store_connection_id, platform, delivery_id)
  where delivery_id is not null;

create index ingestion_event_tenant_shop_received_idx
  on public.ingestion_event (merchant_account_id, shop_id, received_at desc);

alter table public.ingestion_event enable row level security;
alter table public.ingestion_event force row level security;

create policy ingestion_event_select on public.ingestion_event
  for select to authenticated
  using (
    public.current_member_role(merchant_account_id) is not null
    and public.is_shop_member_of(shop_id)
  );

revoke all on table public.ingestion_event from public, anon, authenticated;
grant select on table public.ingestion_event to authenticated;
grant all on table public.ingestion_event to service_role;

-- ── orders.store_connection_id ──────────────────────────────────────────
-- Nullable, nulle pour la saisie manuelle. Composite FK défensive (même
-- motif que ci-dessus) : une commande ne peut jamais pointer vers une
-- connexion d'une autre boutique/tenant que la sienne, y compris via un
-- appel forgé hors interface.
alter table public.orders
  add column if not exists store_connection_id uuid;

alter table public.orders
  drop constraint if exists orders_store_connection_tenant_shop_fk;
alter table public.orders
  add constraint orders_store_connection_tenant_shop_fk
  foreign key (store_connection_id, merchant_account_id, shop_id)
  references public.store_connection (id, merchant_account_id, shop_id);

create index if not exists orders_store_connection_idx
  on public.orders (store_connection_id)
  where store_connection_id is not null;

-- ============================================================================
-- Préflight — la migration échoue bruyamment plutôt que d'absorber une
-- collision en silence. `ON CONFLICT DO NOTHING/DO UPDATE` est interdit dans
-- ce backfill : une collision signifie que le modèle ne décrit pas la
-- réalité des données, pas un doublon inoffensif à ignorer.
-- ============================================================================

-- (1) store_connection : deux boutiques Shopify du même domaine violeraient
-- (platform, external_identifier). `shop.shop_domain` est déjà UNIQUE
-- globalement (0004) : structurellement impossible, vérifié plutôt que
-- supposé.
do $$
declare
  v_dupes bigint;
  v_sample text;
begin
  select count(*), string_agg(shop_domain, ', ' order by shop_domain)
    into v_dupes, v_sample
  from (
    select shop_domain
    from public.shop
    where store_kind = 'shopify'
    group by shop_domain
    having count(*) > 1
  ) d;

  if v_dupes > 0 then
    raise exception 'l1_store_connection_domain_collision count=% domains=[%]', v_dupes, v_sample;
  end if;
end;
$$;

-- (2) external_ref pour 'customer' : deux clients de la MÊME boutique ne
-- doivent jamais partager un GID Shopify après le dédoublonnage de 0038
-- (qui fusionne uniquement par (merchant_account_id, phone_e164) — un
-- chevauchement de GID entre clients à téléphones distincts resterait non
-- fusionné et collision réelle ici).
do $$
declare
  v_collisions bigint;
  v_sample text;
begin
  select count(*), string_agg(format('shop=%s gid=%s customers=%s', shop_id, gid, ids), '; ' order by gid)
    into v_collisions, v_sample
  from (
    select c.shop_id, gid, string_agg(c.id::text, ',' order by c.id) as ids
    from public.customer c
    cross join lateral jsonb_array_elements_text(c.shopify_customer_gids) as gid
    group by c.shop_id, gid
    having count(distinct c.id) > 1
  ) d;

  if v_collisions > 0 then
    raise exception 'l1_external_ref_customer_gid_collision count=% [%]', v_collisions, v_sample;
  end if;
end;
$$;

-- (3) external_ref pour 'product' : deux produits de la MÊME boutique ne
-- doivent jamais partager un shopify_variant_id. `product_merchant_variant_idx`
-- (0027) l'assure déjà par merchant_account_id ; vérifié explicitement au
-- niveau boutique, le grain réel de external_ref.
do $$
declare
  v_collisions bigint;
  v_sample text;
begin
  select count(*), string_agg(format('shop=%s variant=%s products=%s', shop_id, shopify_variant_id, ids), '; ' order by shopify_variant_id)
    into v_collisions, v_sample
  from (
    select p.shop_id, p.shopify_variant_id, string_agg(p.id::text, ',' order by p.id) as ids
    from public.product p
    where p.shopify_variant_id is not null
    group by p.shop_id, p.shopify_variant_id
    having count(distinct p.id) > 1
  ) d;

  if v_collisions > 0 then
    raise exception 'l1_external_ref_product_variant_collision count=% [%]', v_collisions, v_sample;
  end if;
end;
$$;

-- (4) external_ref pour 'order' : deux commandes de la MÊME boutique ne
-- doivent jamais partager un shopify_order_id. L'index partiel unique
-- existant (0005) le garantit déjà par merchant_account_id ; vérifié
-- explicitement au grain boutique.
do $$
declare
  v_collisions bigint;
  v_sample text;
begin
  select count(*), string_agg(format('shop=%s shopify_order_id=%s orders=%s', shop_id, shopify_order_id, ids), '; ' order by shopify_order_id)
    into v_collisions, v_sample
  from (
    select o.shop_id, o.shopify_order_id, string_agg(o.id::text, ',' order by o.id) as ids
    from public.orders o
    where o.shopify_order_id is not null
    group by o.shop_id, o.shopify_order_id
    having count(distinct o.id) > 1
  ) d;

  if v_collisions > 0 then
    raise exception 'l1_external_ref_order_collision count=% [%]', v_collisions, v_sample;
  end if;
end;
$$;

-- (5) ingestion_event : tout événement historique dont la boutique ne peut
-- être établie fait échouer la migration. Aucun repli sur une boutique par
-- défaut — contrairement au motif utilisé ailleurs pour des lignes
-- métier, un événement d'ingestion mal attribué serait indiscernable d'un
-- événement d'une autre boutique.
do $$
declare
  v_missing bigint;
  v_sample text;
begin
  select count(*), string_agg(shopify_webhook_id, ', ' order by received_at)
    into v_missing, v_sample
  from public.webhook_event
  where merchant_account_id is null or shop_id is null;

  if v_missing > 0 then
    raise exception 'l1_ingestion_event_backfill_missing_shop_context count=% webhook_ids=[%]', v_missing, v_sample;
  end if;
end;
$$;

-- ============================================================================
-- Backfill
-- ============================================================================

insert into public.store_connection (
  merchant_account_id,
  shop_id,
  platform,
  external_identifier,
  platform_app_id,
  status,
  installed_at,
  uninstalled_at
)
select
  s.merchant_account_id,
  s.id,
  'shopify',
  s.shop_domain,
  s.shopify_client_id,
  s.status,
  s.installed_at,
  s.uninstalled_at
from public.shop s
where s.store_kind = 'shopify';

update public.orders o
set store_connection_id = sc.id
from public.store_connection sc
where sc.shop_id = o.shop_id
  and o.store_connection_id is null;

insert into public.external_ref (entity_type, entity_id, store_connection_id, external_id)
select 'order', o.id, sc.id, o.shopify_order_id
from public.orders o
join public.store_connection sc on sc.shop_id = o.shop_id
where o.shopify_order_id is not null;

insert into public.external_ref (entity_type, entity_id, store_connection_id, external_id)
select distinct 'customer', c.id, sc.id, gid.value
from public.customer c
join public.store_connection sc on sc.shop_id = c.shop_id
cross join lateral jsonb_array_elements_text(c.shopify_customer_gids) as gid(value)
where jsonb_array_length(c.shopify_customer_gids) > 0;

insert into public.external_ref (entity_type, entity_id, store_connection_id, external_id)
select 'product', p.id, sc.id, p.shopify_variant_id
from public.product p
join public.store_connection sc on sc.shop_id = p.shop_id
where p.shopify_variant_id is not null;

insert into public.ingestion_event (
  merchant_account_id,
  shop_id,
  store_connection_id,
  platform,
  topic,
  delivery_id,
  status,
  received_at,
  triggered_at,
  attempt_count,
  next_attempt_at,
  lease_until,
  last_error_code,
  completed_at,
  processing_proof
)
select
  we.merchant_account_id,
  we.shop_id,
  sc.id,
  'shopify',
  we.topic,
  we.shopify_webhook_id,
  we.status,
  we.received_at,
  we.triggered_at,
  we.attempt_count,
  we.next_attempt_at,
  we.lease_until,
  we.last_error_code,
  we.completed_at,
  we.processing_proof
from public.webhook_event we
left join public.store_connection sc on sc.shop_id = we.shop_id;

-- ============================================================================
-- Preuve d'exhaustivité — comptes avant/après doivent coïncider exactement.
-- Un écart, même d'une ligne, fait échouer la migration.
-- ============================================================================

do $$
declare
  v_source bigint;
  v_target bigint;
begin
  select count(*) into v_source from public.shop where store_kind = 'shopify';
  select count(*) into v_target from public.store_connection;
  if v_source <> v_target then
    raise exception 'l1_backfill_mismatch table=store_connection source=% target=%', v_source, v_target;
  end if;

  select count(*) into v_source from public.orders where shopify_order_id is not null;
  select count(*) into v_target from public.external_ref where entity_type = 'order';
  if v_source <> v_target then
    raise exception 'l1_backfill_mismatch table=external_ref/order source=% target=%', v_source, v_target;
  end if;

  select coalesce(sum(jsonb_array_length(shopify_customer_gids)), 0) into v_source
  from public.customer;
  select count(*) into v_target from public.external_ref where entity_type = 'customer';
  if v_source <> v_target then
    raise exception 'l1_backfill_mismatch table=external_ref/customer source=% target=%', v_source, v_target;
  end if;

  select count(*) into v_source from public.product where shopify_variant_id is not null;
  select count(*) into v_target from public.external_ref where entity_type = 'product';
  if v_source <> v_target then
    raise exception 'l1_backfill_mismatch table=external_ref/product source=% target=%', v_source, v_target;
  end if;

  select count(*) into v_source from public.webhook_event;
  select count(*) into v_target from public.ingestion_event;
  if v_source <> v_target then
    raise exception 'l1_backfill_mismatch table=ingestion_event source=% target=%', v_source, v_target;
  end if;
end;
$$;

analyze public.store_connection;
analyze public.external_ref;
analyze public.ingestion_event;
