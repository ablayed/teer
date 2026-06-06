-- Phase 7a — Fondation sync Shopify : multi-boutiques, idempotence transactionnelle,
-- colonnes miroir de canal + garde hors-ordre. AUCUNE écriture des 4 dimensions ici.
--
-- Décisions (confirmées avec Ablaye) :
--   * On FAIT ÉVOLUER la table `shop` existante (pas de nouvelle table `shopify_shop`) :
--     elle porte déjà tokens chiffrés, expires_at, status active|uninstalled, installed_at,
--     et est référencée partout (orders.shop_id, webhooks, finance, dashboard, rapport).
--   * On ÉTEND `webhook_event` (déjà dédup par shopify_webhook_id unique) au lieu de créer
--     `processed_webhooks` : ajout shop_id / merchant_account_id / triggered_at / status / payload.

-- =============================================================================
-- 1. shop → multi-boutiques par marchand
-- =============================================================================
-- Retire la contrainte mono-boutique (un marchand pouvait connecter une seule boutique).
-- Auto-nommée par Postgres lors du `unique (merchant_account_id)` table-level en 0004.
alter table public.shop drop constraint if exists shop_merchant_account_id_key;

-- Métadonnées boutique manquantes. api_version a un défaut sûr (colonne de métadonnée,
-- pas une dimension d'état) ; les colonnes token/expiration/installed_at/status existent déjà.
alter table public.shop add column if not exists shop_gid text;
alter table public.shop add column if not exists api_version text not null default '2026-04';
alter table public.shop add column if not exists uninstalled_at timestamptz;
alter table public.shop add column if not exists last_reconciled_at timestamptz;

-- Plusieurs boutiques par marchand → index de requête.
create index if not exists shop_merchant_status_idx
  on public.shop (merchant_account_id, status);

-- =============================================================================
-- 2. orders : colonnes miroir de canal Shopify + garde hors-ordre
-- =============================================================================
-- DISTINCTES des 4 dimensions opérationnelles (order_state/call_state/delivery_state/cash_state),
-- que Shopify n'écrase JAMAIS. Les colonnes legacy financial_status/fulfillment_status restent
-- en place (lues par la finance/dashboard) ; les nouvelles `shopify_*` sont le miroir canonique.
alter table public.orders add column if not exists shopify_financial_status text;
alter table public.orders add column if not exists shopify_fulfillment_status text;
alter table public.orders add column if not exists shopify_cancelled_at timestamptz;
-- shopify_updated_at : timestamp Shopify du dernier événement appliqué → garde hors-ordre
-- (ignorer un webhook dont updated_at/X-Shopify-Triggered-At est plus ancien que le stocké).
alter table public.orders add column if not exists shopify_updated_at timestamptz;

-- Backfill miroir depuis les colonnes legacy pour les commandes Shopify existantes.
update public.orders
   set shopify_financial_status = financial_status,
       shopify_fulfillment_status = fulfillment_status
 where shopify_order_id is not null
   and (shopify_financial_status is null and shopify_fulfillment_status is null);

-- =============================================================================
-- 3. orders : dédup par BOUTIQUE (et non plus par marchand)
-- =============================================================================
-- Les ids de commande Shopify sont uniques par boutique, pas globalement : avec le multi-boutiques
-- la clé de dédup doit être (shop_id, shopify_order_id).
-- Backfill shop_id : chaque marchand n'a aujourd'hui qu'UNE boutique (la contrainte unique vient
-- d'être retirée mais la donnée reste 1:1), donc la jointure est sans ambiguïté ; seules les
-- commandes issues de Shopify (shopify_order_id non null) reçoivent un shop_id, les commandes
-- manuelles restent shop_id null.
update public.orders o
   set shop_id = s.id
  from public.shop s
 where o.shop_id is null
   and o.shopify_order_id is not null
   and s.merchant_account_id = o.merchant_account_id;

drop index if exists public.orders_shopify_order_unique_idx;
create unique index if not exists orders_shop_shopify_order_unique_idx
  on public.orders (shop_id, shopify_order_id)
  where shopify_order_id is not null;

create index if not exists orders_merchant_shop_idx
  on public.orders (merchant_account_id, shop_id);

-- =============================================================================
-- 4. webhook_event → idempotence transactionnelle + contexte
-- =============================================================================
-- La contrainte unique sur shopify_webhook_id existe déjà (0006). On ajoute le contexte
-- boutique/tenant, le timestamp de déclenchement (garde hors-ordre), un statut de traitement
-- et le payload brut, pour pouvoir insérer la dédup DANS la même transaction que l'effet métier.
alter table public.webhook_event
  add column if not exists shop_id uuid references public.shop(id) on delete cascade;
alter table public.webhook_event
  add column if not exists merchant_account_id uuid references public.merchant_account(id) on delete cascade;
alter table public.webhook_event add column if not exists triggered_at timestamptz;
alter table public.webhook_event
  add column if not exists status text not null default 'processing'
  check (status in ('processing', 'done', 'error'));
alter table public.webhook_event add column if not exists payload jsonb;

-- Les événements déjà traités passent à 'done' (cohérence avec le booléen legacy `processed`).
update public.webhook_event set status = 'done' where processed = true and status = 'processing';

create index if not exists webhook_event_merchant_idx
  on public.webhook_event (merchant_account_id);
create index if not exists webhook_event_shop_idx
  on public.webhook_event (shop_id);

-- RLS : webhook_event est déjà ENABLE + FORCE sans policy permissive (0006) → accès service-role
-- uniquement, deny-by-default. Les nouvelles colonnes héritent de cette protection. shop conserve
-- ses policies tenant is_member_of (multi-boutiques ne change pas la clé d'isolation).
