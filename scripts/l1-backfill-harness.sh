#!/usr/bin/env bash
# Lot L1 — harnais de non-régression du backfill de 0142_l1_canonical_ingestion_schema.sql.
#
# Ce backfill s'exécute UNE SEULE FOIS en production, sur l'historique complet
# du moment. Un `db reset --local` sur le seed global ne l'exerce jamais
# (aucune boutique Shopify dans supabase/seed.sql) : un contrôle vert sur
# surface vide ne prouve rien. Ce script monte des bases FRAÎCHES et ISOLÉES,
# injecte une fixture Shopify réaliste, applique 0142 EN ISOLATION (jamais
# depuis 0001), et vérifie les comptes exacts entité par entité.
#
# NE TOUCHE JAMAIS supabase/seed.sql : le seed global reste indépendant de ce
# harnais, pour que `db reset --local` ordinaire reste utilisable par tout le
# monde.
#
# Couvre : le cas nominal (2 boutiques/2 tenants/2 apps, GID multiples, deux
# variantes partageant un shopify_product_id, webhooks à payload nullé) et le
# cas négatif « webhook dont la boutique n'est pas résoluble » (cas prod réel
# documenté, 2026-05-30).
#
# NE couvre PAS (preuves faites manuellement une fois, voir le rapport de
# session, non automatisées ici) :
#   - la collision (platform, external_identifier) : structurellement
#     inatteignable en production (shop.shop_domain porte déjà une contrainte
#     UNIQUE globale, 0004) ; la reproduire exige de suspendre une contrainte
#     réelle, jugé trop fragile/destructif pour un job CI routinier.
#   - le test de mutation (clause de backfill volontairement cassée) : preuve
#     ponctuelle qu'un futur relecteur peut rejouer à la main si le backfill
#     de 0142 est un jour retouché (ce qui ne devrait jamais arriver — les
#     migrations sont append-only).
#
# Usage : ./scripts/l1-backfill-harness.sh
# Sortie : 0 si tout passe, non-zéro sinon (message explicite sur stderr).

set -euo pipefail

MIGRATIONS_DIR="supabase/migrations"
TARGET_MIGRATION="0142_l1_canonical_ingestion_schema.sql"
STASH_DIR="$(mktemp -d)"
FAILED=0

trap 'cleanup' EXIT

cleanup() {
  if [ -f "${STASH_DIR}/${TARGET_MIGRATION}" ] && [ ! -f "${MIGRATIONS_DIR}/${TARGET_MIGRATION}" ]; then
    mv "${STASH_DIR}/${TARGET_MIGRATION}" "${MIGRATIONS_DIR}/"
    echo "[l1-harness] ${TARGET_MIGRATION} restauré dans ${MIGRATIONS_DIR}."
  fi
  rm -rf "${STASH_DIR}"
}

step() { echo "[l1-harness] $*"; }

if [ ! -f "${MIGRATIONS_DIR}/${TARGET_MIGRATION}" ]; then
  echo "[l1-harness] ERREUR : ${TARGET_MIGRATION} introuvable dans ${MIGRATIONS_DIR}." >&2
  exit 1
fi

# ── Cas nominal ─────────────────────────────────────────────────────────────
step "cas nominal : arrêt à la migration précédant 0142"
mv "${MIGRATIONS_DIR}/${TARGET_MIGRATION}" "${STASH_DIR}/"
pnpm exec supabase db reset --local >/dev/null

step "injection de la fixture Shopify réaliste (2 tenants, 2 apps, GID multiples, variantes partagées)"
docker exec -i supabase_db_teer-dev psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < scripts/l1-harness-fixtures/nominal.sql >/dev/null

step "calcul des comptes attendus depuis la source (avant application de 0142)"
EXPECTED=$(docker exec supabase_db_teer-dev psql -U postgres -d postgres -t -A -F',' -c "
  select
    (select count(distinct shop_domain) from public.shop where store_kind='shopify'),
    (select count(distinct shopify_order_id) from public.orders where shopify_order_id is not null),
    (select count(*) from (select distinct c.shop_id, gid.value from public.customer c cross join lateral jsonb_array_elements_text(c.shopify_customer_gids) as gid(value)) x),
    (select count(distinct shopify_variant_id) from public.product where shopify_variant_id is not null),
    (select count(*) from public.webhook_event where merchant_account_id is not null and shop_id is not null)
")
step "comptes attendus (store_connection,ext_ref_order,ext_ref_customer,ext_ref_product,ingestion_event) = ${EXPECTED}"

step "application de 0142 EN ISOLATION"
mv "${STASH_DIR}/${TARGET_MIGRATION}" "${MIGRATIONS_DIR}/"
pnpm exec supabase migration up --local

ACTUAL=$(docker exec supabase_db_teer-dev psql -U postgres -d postgres -t -A -F',' -c "
  select
    (select count(*) from public.store_connection),
    (select count(*) from public.external_ref where entity_type='order'),
    (select count(*) from public.external_ref where entity_type='customer'),
    (select count(*) from public.external_ref where entity_type='product'),
    (select count(*) from public.ingestion_event)
")
step "comptes obtenus = ${ACTUAL}"

if [ "${EXPECTED}" != "${ACTUAL}" ]; then
  echo "[l1-harness] ÉCHEC cas nominal : attendu=${EXPECTED} obtenu=${ACTUAL}" >&2
  FAILED=1
else
  step "cas nominal : OK"
fi

# ── Cas négatif : webhook dont la boutique n'est pas résoluble ─────────────
step "cas négatif : webhook_event non résoluble (arrêt à la migration précédant 0142)"
mv "${MIGRATIONS_DIR}/${TARGET_MIGRATION}" "${STASH_DIR}/"
pnpm exec supabase db reset --local >/dev/null

docker exec -i supabase_db_teer-dev psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < scripts/l1-harness-fixtures/negative-orphan-webhook.sql >/dev/null

mv "${STASH_DIR}/${TARGET_MIGRATION}" "${MIGRATIONS_DIR}/"
set +e
OUTPUT=$(pnpm exec supabase migration up --local 2>&1)
STATUS=$?
set -e

if [ "${STATUS}" -eq 0 ]; then
  echo "[l1-harness] ÉCHEC : 0142 aurait dû échouer sur un webhook non résoluble, mais a réussi." >&2
  FAILED=1
elif ! echo "${OUTPUT}" | grep -q "l1_ingestion_event_backfill_missing_shop_context"; then
  echo "[l1-harness] ÉCHEC : 0142 a échoué mais pas avec l'erreur attendue :" >&2
  echo "${OUTPUT}" >&2
  FAILED=1
else
  step "cas négatif (webhook non résoluble) : OK — échec attendu obtenu, identifiants nommés"
fi

PARTIAL=$(docker exec supabase_db_teer-dev psql -U postgres -d postgres -t -A -c "select to_regclass('public.store_connection');")
if [ -n "${PARTIAL// }" ]; then
  echo "[l1-harness] ÉCHEC : état partiel détecté après l'échec attendu (store_connection existe)." >&2
  FAILED=1
else
  step "aucun état partiel après l'échec attendu : OK"
fi

# ── Restauration finale : base au dernier état déclaré (0142 appliqué) ─────
step "restauration finale : db reset --local avec 0142 en place"
pnpm exec supabase db reset --local >/dev/null

if [ "${FAILED}" -ne 0 ]; then
  echo "[l1-harness] HARNAIS EN ÉCHEC." >&2
  exit 1
fi

step "harnais L1 : tous les scénarios automatisés sont verts."
