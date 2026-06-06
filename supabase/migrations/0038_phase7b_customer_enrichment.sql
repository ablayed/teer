-- Phase 7b — Enrichissement client depuis Shopify.
--
-- Périmètre STRICT : on N'AJOUTE QUE de la PII enrichie + la clé de dédup téléphone.
-- On N'AJOUTE PAS order_count / is_recurring / refusal_count : ces métriques sont DÉJÀ
-- dérivées à la volée et de façon fiable par get_customer_reliability/list_customer_reliability
-- (0014) à partir de orders.cod_status :
--   * récurrence  = count(o.id)            (order_count, ligne 0014:61)
--   * refus       = filter cod_status='REFUSEE' (refused_count, 0014:63)
--     et cod_status='REFUSEE' dérive de delivery_state ∈ {failed,returned} (cf. CLAUDE.md).
-- Créer un compteur stocké concurrent serait une DOUBLE SOURCE (interdit). is_recurring sera
-- exposé en Phase 7b/Stage 3 comme champ CALCULÉ (order_count > 1) dans la RPC — zéro schéma ici.
--
-- Le client reste une entité CROSS-BOUTIQUES : pas de shop_id sur customer (cohérent 7a).
-- Dédup primaire = phone_e164 (E.164 +221XXXXXXXXX), secondaire = email (appliqué en code Stage 2).

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. Helper SQL : normalisation téléphone sénégalais → E.164 (port exact de
--    lib/address/phone-sn.ts:normalizeSenegalPhone). NE valide PAS la forme 7x
--    (décision : on garde les fixes 33…). La validation 7x mobile est séparée, côté app.
-- ──────────────────────────────────────────────────────────────────────────────
create or replace function public.sn_phone_e164(p_value text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  d text;
begin
  if p_value is null then
    return null;
  end if;

  d := regexp_replace(btrim(p_value), '\D', '', 'g');

  if left(d, 2) = '00' then
    d := substr(d, 3);
  end if;

  if left(d, 3) = '221' then
    d := substr(d, 4);
  end if;

  if left(d, 1) = '0' then
    d := substr(d, 2);
  end if;

  if d !~ '^\d{9}$' then
    return null;
  end if;

  return '+221' || d;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. Colonnes d'enrichissement (toutes nullables ; defaults seulement pour les
--    structures cumulatives shopify_customer_gids / source).
-- ──────────────────────────────────────────────────────────────────────────────
alter table public.customer
  add column if not exists phone_e164 text,
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists accepts_marketing boolean,
  add column if not exists tags text[],
  add column if not exists address jsonb,
  add column if not exists shopify_customer_gids jsonb not null default '[]'::jsonb,
  add column if not exists source text not null default 'manual',
  add column if not exists shopify_orders_count integer,
  add column if not exists shopify_amount_spent_minor bigint,
  add column if not exists first_seen_at timestamptz;

-- source ∈ {manual, shopify, whatsapp, social}
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customer_source_check'
  ) then
    alter table public.customer
      add constraint customer_source_check
      check (source in ('manual', 'shopify', 'whatsapp', 'social'));
  end if;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. Backfill (avant la contrainte unique).
-- ──────────────────────────────────────────────────────────────────────────────
update public.customer
set phone_e164 = public.sn_phone_e164(phone)
where phone_e164 is null
  and phone is not null;

update public.customer
set source = 'shopify'
where shopify_customer_id is not null
  and source = 'manual';

-- Le tableau de GID part du shopify_customer_id legacy (même valeur extraite déjà stockée).
update public.customer
set shopify_customer_gids = jsonb_build_array(shopify_customer_id)
where shopify_customer_id is not null
  and shopify_customer_gids = '[]'::jsonb;

update public.customer
set first_seen_at = created_at
where first_seen_at is null;

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. Dédoublonnage des collisions (merchant_account_id, phone_e164) AVANT l'unique.
--    Stratégie de fusion :
--      survivant  = ligne la plus ancienne (created_at asc, id asc) du groupe.
--      GID        = union dédupliquée des shopify_customer_gids du groupe.
--      PII        = coalesce(survivant, première valeur non nulle des perdants par created_at).
--      compteurs  = max (greatest) — hint Shopify, pas une source de vérité.
--      first_seen = least.
--      FK         = orders.customer_id repointé vers le survivant, puis perdants supprimés.
--    Aucune autre table ne référence customer.id (call_log → order_id ; reliability → via orders).
-- ──────────────────────────────────────────────────────────────────────────────
create temporary table _survivor on commit drop as
select distinct on (merchant_account_id, phone_e164)
  id as survivor_id, merchant_account_id, phone_e164
from public.customer
where phone_e164 is not null
order by merchant_account_id, phone_e164, created_at asc, id asc;

create temporary table _dup_map on commit drop as
select c.id as loser_id, s.survivor_id
from public.customer c
join _survivor s
  on s.merchant_account_id = c.merchant_account_id
 and s.phone_e164 = c.phone_e164
where c.id <> s.survivor_id;

-- 4a. Fusion des GID dans le survivant (union + dédup).
update public.customer surv
set shopify_customer_gids = (
  select coalesce(jsonb_agg(distinct elem), '[]'::jsonb)
  from (
    select jsonb_array_elements_text(surv.shopify_customer_gids) as elem
    union
    select jsonb_array_elements_text(c.shopify_customer_gids)
    from public.customer c
    join _dup_map m on m.loser_id = c.id
    where m.survivor_id = surv.id
  ) u(elem)
)
where surv.id in (select distinct survivor_id from _dup_map);

-- 4b. Fusion de la PII + compteurs (coalesce survivant → perdants).
update public.customer surv
set
  full_name = coalesce(surv.full_name, agg.full_name),
  email = coalesce(surv.email, agg.email),
  first_name = coalesce(surv.first_name, agg.first_name),
  last_name = coalesce(surv.last_name, agg.last_name),
  address = coalesce(surv.address, agg.address),
  shipping_address = coalesce(surv.shipping_address, agg.shipping_address),
  tags = coalesce(surv.tags, agg.tags),
  accepts_marketing = coalesce(surv.accepts_marketing, agg.accepts_marketing),
  shopify_customer_id = coalesce(surv.shopify_customer_id, agg.shopify_customer_id),
  shopify_orders_count = nullif(
    greatest(coalesce(surv.shopify_orders_count, 0), coalesce(agg.shopify_orders_count, 0)), 0),
  shopify_amount_spent_minor = nullif(
    greatest(coalesce(surv.shopify_amount_spent_minor, 0), coalesce(agg.shopify_amount_spent_minor, 0)), 0),
  first_seen_at = least(surv.first_seen_at, agg.first_seen_at),
  source = case
    when surv.source = 'manual' and agg.has_shopify then 'shopify'
    else surv.source
  end
from (
  select
    m.survivor_id,
    (array_agg(c.full_name order by c.created_at, c.id) filter (where c.full_name is not null))[1] as full_name,
    (array_agg(c.email order by c.created_at, c.id) filter (where c.email is not null))[1] as email,
    (array_agg(c.first_name order by c.created_at, c.id) filter (where c.first_name is not null))[1] as first_name,
    (array_agg(c.last_name order by c.created_at, c.id) filter (where c.last_name is not null))[1] as last_name,
    (array_agg(c.address order by c.created_at, c.id) filter (where c.address is not null))[1] as address,
    (array_agg(c.shipping_address order by c.created_at, c.id) filter (where c.shipping_address is not null))[1] as shipping_address,
    (
      select c2.tags
      from public.customer c2
      join _dup_map m2 on m2.loser_id = c2.id
      where m2.survivor_id = m.survivor_id
        and c2.tags is not null
      order by c2.created_at, c2.id
      limit 1
    ) as tags,
    (array_agg(c.accepts_marketing order by c.created_at, c.id) filter (where c.accepts_marketing is not null))[1] as accepts_marketing,
    (array_agg(c.shopify_customer_id order by c.created_at, c.id) filter (where c.shopify_customer_id is not null))[1] as shopify_customer_id,
    max(c.shopify_orders_count) as shopify_orders_count,
    max(c.shopify_amount_spent_minor) as shopify_amount_spent_minor,
    min(c.first_seen_at) as first_seen_at,
    bool_or(c.source = 'shopify' or c.shopify_customer_id is not null) as has_shopify
  from _dup_map m
  join public.customer c on c.id = m.loser_id
  group by m.survivor_id
) agg
where surv.id = agg.survivor_id;

-- 4c. Repointer les commandes des perdants vers le survivant.
update public.orders o
set customer_id = m.survivor_id
from _dup_map m
where o.customer_id = m.loser_id;

-- 4d. Supprimer les perdants.
delete from public.customer
where id in (select loser_id from _dup_map);

-- ──────────────────────────────────────────────────────────────────────────────
-- 5. Contrainte unique de dédup + index de recherche.
-- ──────────────────────────────────────────────────────────────────────────────
create unique index if not exists customer_merchant_phone_e164_unique_idx
  on public.customer (merchant_account_id, phone_e164)
  where phone_e164 is not null;

-- Recherche/jointure par GID Shopify (dédup multi-boutiques en Stage 2).
create index if not exists customer_shopify_gids_idx
  on public.customer using gin (shopify_customer_gids);

-- RLS : customer porte déjà ENABLE + FORCE + policies tenant (is_member_of) depuis 0005.
-- Les nouvelles colonnes héritent de ces policies — aucune policy à ajouter.
