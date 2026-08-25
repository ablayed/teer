-- ============================================================================
-- 0144 — Idempotence métier de refunds/create (précondition de la bascule L3)
-- ============================================================================
-- Diagnostic (rapport de session dédié) : `refunds/create` est le SEUL topic
-- webhook Shopify sans filet d'idempotence métier. `orders/*` et `products/*`
-- sont protégés par la clé naturelle de leur table (`orders_shopify_order_
-- unique_idx`, `product_merchant_variant_idx`) + un select-avant-écriture.
-- `refunds/create` insère dans `audit_log` sans condition, sans clé unique
-- correspondante — deux livraisons du même remboursement (deux `delivery_id`
-- distincts, exactement le scénario d'une bascule d'abonnement mal
-- séquencée) produisent deux lignes pour un seul événement métier.
--
-- Étape 0 du rapport de session a établi :
--   (1) le payload refunds/create porte un `id` racine, stable, distinct de
--       `order_id` (objet Refund Shopify — shopify.dev/docs/api/admin-rest/
--       latest/resources/refund) ; jamais lu par deriveRefundWebhook à ce
--       jour (0144 ne change PAS ce fichier — Phase C séparée du rapport) ;
--   (2) `shopify.refund_received` n'a AUCUN lecteur dans le dépôt (grep
--       exhaustif) : piste d'audit pure, jamais agrégée — écarte le risque
--       de corruption de chiffres, pas le besoin de la garde elle-même ;
--   (3) préflight production (lecture seule, `supabase db query --linked`) :
--       0 ligne `shopify.refund_received` en base à ce jour → 0 doublon
--       possible, aucun obstacle à une contrainte unique.
--
-- ── Règle de frontière (à ne jamais désencadrer) ────────────────────────────
-- Quand la ressource possède une ENTITÉ INTERNE (une ligne dans une table
-- métier qui EST la ressource — `orders` pour une commande, `product` pour
-- un produit/variant), l'idempotence est portée par la clé naturelle de
-- cette table, jamais par une table d'idempotence dédiée : c'est déjà le
-- modèle de `persistShopifyOrder`/`persistShopifyProductWebhook`, non touché
-- ici. Quand la ressource N'A PAS d'entité interne — un remboursement
-- Shopify n'est PAS une ligne à lui seul dans ce schéma, seulement un effet
-- sur `orders.financial_status` et une ligne d'audit — elle est portée par
-- `store_connection_resource_receipt`, cette table.
--
-- `bulk_operations/finish` n'a AUCUN identifiant de ressource propre (une
-- opération asynchrone terminée, cf. `BulkOperationFinished`,
-- lib/ingestion/canonical.ts) : il ne participe PAS à ce mécanisme, et c'est
-- volontaire — pas un oubli. `resource_kind` reste donc un ensemble fermé à
-- 'refund' seul dans cette migration ; une future ressource sans entité
-- interne (si elle existe un jour) étendra ce `check` par une nouvelle
-- migration, jamais un fourre-tout ouvert.
--
-- Table SEULE, service_role uniquement — même motif que
-- store_connection_webhook_token (0143) : FORCE RLS, zéro policy
-- authenticated, grants explicitement retirés puis reposés (leçon 0140/0141
-- : un grant/revoke doit toujours nommer `public, anon, authenticated`
-- ensemble, jamais l'un sans l'autre).
-- ============================================================================

create table public.store_connection_resource_receipt (
  id uuid primary key default gen_random_uuid(),
  store_connection_id uuid not null
    references public.store_connection (id) on delete cascade,
  resource_kind text not null check (resource_kind in ('refund')),
  external_id text not null,
  created_at timestamptz not null default now(),
  constraint store_connection_resource_receipt_key
    unique (store_connection_id, resource_kind, external_id)
);

alter table public.store_connection_resource_receipt enable row level security;
alter table public.store_connection_resource_receipt force row level security;

revoke all on table public.store_connection_resource_receipt from public, anon, authenticated;
grant all on table public.store_connection_resource_receipt to service_role;

create index store_connection_resource_receipt_connection_idx
  on public.store_connection_resource_receipt (store_connection_id);

-- ============================================================================
-- record_shopify_refund_receipt — garde + écritures métier, UNE TRANSACTION.
-- ============================================================================
-- Appelée par le client service-role du Route Handler webhook (jamais une
-- session `authenticated` — cf. `revoke`/`grant` ci-dessous, et l'ajout
-- correspondant à AUTHENTICATED_FORBIDDEN dans
-- tests/rls/function-execute-acl-invariant.rls.test.ts, même commit).
--
-- L'insertion dans store_connection_resource_receipt et les écritures
-- métier (orders.financial_status, audit_log) vivent dans le MÊME appel de
-- fonction PL/pgSQL — donc la même transaction implicite. Un appel Supabase
-- JS fait un aller-retour PostgREST par `.from(...).insert(...)`/`.update(...)` :
-- deux appels séparés depuis le Route Handler laisseraient une fenêtre où la
-- garde existe sans l'audit (ou l'inverse) si le second échoue. Une seule
-- fonction ferme cette fenêtre.
--
-- `on conflict ... do nothing` + `get diagnostics row_count` : si la garde
-- ne s'insère pas (remboursement déjà connu pour cette store_connection),
-- retour `false` IMMÉDIAT, sans toucher `orders` ni `audit_log` — c'est le
-- rejeu attendu, jamais une erreur. `security invoker` : le service-role
-- contourne RLS de toute façon (même motif que get_finance_collected_joins,
-- 0087) ; AUCUNE garde de rôle applicative (piège DEFINER-guard-service-role
-- documenté CLAUDE.md — cet appelant n'a pas d'auth.uid()).
create function public.record_shopify_refund_receipt(
  p_store_connection_id uuid,
  p_external_id text,
  p_local_order_id uuid,
  p_should_update_financial_status boolean,
  p_merchant_account_id uuid,
  p_actor_user_id uuid,
  p_resource_type text,
  p_resource_id uuid,
  p_audit_payload jsonb
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_rows integer;
begin
  insert into public.store_connection_resource_receipt (store_connection_id, resource_kind, external_id)
  values (p_store_connection_id, 'refund', p_external_id)
  on conflict (store_connection_id, resource_kind, external_id) do nothing;

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    -- Rejeu (deux delivery_id distincts, même remboursement) : aucune écriture
    -- supplémentaire, ni orders ni audit_log. Comportement voulu, pas un échec.
    return false;
  end if;

  if p_local_order_id is not null and p_should_update_financial_status then
    update public.orders
    set financial_status = 'partially_refunded',
        shopify_financial_status = 'partially_refunded',
        updated_at = now()
    where id = p_local_order_id;
  end if;

  insert into public.audit_log (
    merchant_account_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    payload
  )
  values (
    p_merchant_account_id,
    p_actor_user_id,
    'shopify.refund_received',
    p_resource_type,
    p_resource_id,
    p_audit_payload
  );

  return true;
end;
$$;

revoke all on function public.record_shopify_refund_receipt(
  uuid, text, uuid, boolean, uuid, uuid, text, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.record_shopify_refund_receipt(
  uuid, text, uuid, boolean, uuid, uuid, text, uuid, jsonb
) to service_role;
