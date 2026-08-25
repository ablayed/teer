#!/usr/bin/env bash
# Lot L1 — harnais de non-régression du backfill de 0142_l1_canonical_ingestion_schema.sql.
#
# Ce backfill s'exécute UNE SEULE FOIS en production, sur l'historique complet
# du moment. Un `db reset --local` sur le seed global ne l'exerce jamais
# (aucune boutique Shopify dans supabase/seed.sql) : un contrôle vert sur
# surface vide ne prouve rien. Ce script monte des bases FRAÎCHES et ISOLÉES,
# injecte des fixtures Shopify réalistes, applique 0142 EN ISOLATION (jamais
# depuis 0001), et vérifie les comptes exacts entité par entité.
#
# NE TOUCHE JAMAIS supabase/seed.sql : le seed global reste indépendant de ce
# harnais, pour que `db reset --local` ordinaire reste utilisable par tout le
# monde.
#
# LOT L1-BIS (25 août 2026) : le préflight de 0142 est passé de deux issues
# (bloque / passe) à trois (bloque / exclut+notifie / passe), après que le
# préflight production réel a trouvé 8 lignes sans contexte — toutes
# `status in ('done','terminal')` — que l'ancien préflight aurait bloquées à
# tort. Ce harnais couvre désormais :
#   (1)/(5) contexte totalement absent ET ligne terminée → migration réussit,
#       exclusion comptée et rapportée par RAISE NOTICE, y compris quand le
#       domaine correspond à une boutique réellement enregistrée (preuve que
#       la décision ne dépend jamais de shop_domain).
#   (2) contexte PARTIEL (une seule colonne nulle, deux orientations) →
#       migration échoue, quel que soit le statut.
#   (3) contexte absent ET ligne NON terminée (encore en vol) → migration
#       échoue, identifiants nommés, aucun état partiel.
#
# NE couvre PAS (preuves faites manuellement une fois, voir le rapport de
# session, non automatisées ici — même discipline que la preuve de collision
# de domaine déjà documentée dans 0142) :
#   - la collision (platform, external_identifier) : structurellement
#     inatteignable en production (shop.shop_domain porte déjà une contrainte
#     UNIQUE globale, 0004).
#   - le statut nul/inconnu : structurellement inatteignable en production
#     (webhook_event.status est NOT NULL + CHECK sur exactement 4 valeurs) ;
#     prouvé en suspendant temporairement la contrainte en session locale
#     isolée, jamais committé.
#   - les deux mutations de preuve (prédicat de terminalité inversé, OR
#     transformé en AND) : preuves ponctuelles rejouables à la main si 0142
#     est un jour retouchée (ce qui ne devrait jamais arriver — les
#     migrations sont append-only), pas un job CI permanent.
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

apply_fixture_and_migrate() {
  local fixture_path="$1"
  mv "${MIGRATIONS_DIR}/${TARGET_MIGRATION}" "${STASH_DIR}/"
  pnpm exec supabase db reset --local >/dev/null
  docker exec -i supabase_db_teer-dev psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    < "${fixture_path}" >/dev/null
  mv "${STASH_DIR}/${TARGET_MIGRATION}" "${MIGRATIONS_DIR}/"
}

# ── Cas nominal ─────────────────────────────────────────────────────────────
step "cas nominal : contexte complet, backfill normal"
apply_fixture_and_migrate scripts/l1-harness-fixtures/nominal.sql

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

# ── Cas (1)/(5) : sans contexte, terminé (résoluble ou non) ────────────────
step "cas (1)/(5) : webhook_event sans contexte mais TERMINÉ — doit réussir et exclure"
apply_fixture_and_migrate scripts/l1-harness-fixtures/negative-orphan-webhook.sql

set +e
OUTPUT=$(pnpm exec supabase migration up --local 2>&1)
STATUS=$?
set -e

if [ "${STATUS}" -ne 0 ]; then
  echo "[l1-harness] ÉCHEC : 0142 aurait dû réussir (les 3 lignes sont terminées) mais a échoué :" >&2
  echo "${OUTPUT}" >&2
  FAILED=1
elif ! echo "${OUTPUT}" | grep -q "l1_ingestion_event_backfill_excluded_no_context count=3"; then
  echo "[l1-harness] ÉCHEC : NOTICE d'exclusion absente ou compte inattendu :" >&2
  echo "${OUTPUT}" >&2
  FAILED=1
else
  # Égalité indépendante (2/2) : le compte annoncé par le RAISE NOTICE
  # (calculé PENDANT le backfill, depuis webhook_event) doit coïncider avec
  # un recalcul APRÈS coup, depuis la même table, jamais depuis ingestion_event.
  RECOUNT=$(docker exec supabase_db_teer-dev psql -U postgres -d postgres -t -A -c "
    select count(*) from public.webhook_event
    where merchant_account_id is null and shop_id is null and status in ('done','terminal')
  ")
  INGESTION_COUNT=$(docker exec supabase_db_teer-dev psql -U postgres -d postgres -t -A -c "
    select count(*) from public.ingestion_event
  ")
  if [ "${RECOUNT}" != "3" ]; then
    echo "[l1-harness] ÉCHEC égalité (2/2) : recompte source=${RECOUNT}, attendu 3 (NOTICE annonçait 3)." >&2
    FAILED=1
  elif [ "${INGESTION_COUNT}" != "0" ]; then
    echo "[l1-harness] ÉCHEC : les lignes exclues ont été insérées dans ingestion_event (count=${INGESTION_COUNT})." >&2
    FAILED=1
  else
    step "cas (1)/(5) : OK — 3 exclues (dont 1 à domaine résolvable), 0 dans ingestion_event, égalités (1/2) et (2/2) vérifiées"
  fi
fi

# ── Cas (2) : contexte PARTIEL, deux orientations ───────────────────────────
step "cas (2) : contexte partiel (une seule colonne nulle) — doit échouer, quel que soit le statut"
apply_fixture_and_migrate scripts/l1-harness-fixtures/partial-context.sql

set +e
OUTPUT=$(pnpm exec supabase migration up --local 2>&1)
STATUS=$?
set -e

if [ "${STATUS}" -eq 0 ]; then
  echo "[l1-harness] ÉCHEC : 0142 aurait dû échouer sur un contexte partiel, mais a réussi." >&2
  FAILED=1
elif ! echo "${OUTPUT}" | grep -q "l1_ingestion_event_backfill_missing_shop_context count=2"; then
  echo "[l1-harness] ÉCHEC : 0142 a échoué mais pas avec l'erreur/le compte attendu (2 lignes) :" >&2
  echo "${OUTPUT}" >&2
  FAILED=1
elif ! echo "${OUTPUT}" | grep -q "fixture-partial-a" || ! echo "${OUTPUT}" | grep -q "fixture-partial-b"; then
  echo "[l1-harness] ÉCHEC : les deux orientations (merchant_account_id seul nul / shop_id seul nul) ne sont pas toutes deux nommées :" >&2
  echo "${OUTPUT}" >&2
  FAILED=1
else
  step "cas (2) : OK — les deux orientations bloquent, malgré un statut terminé"
fi

PARTIAL=$(docker exec supabase_db_teer-dev psql -U postgres -d postgres -t -A -c "select to_regclass('public.store_connection');")
if [ -n "${PARTIAL// }" ]; then
  echo "[l1-harness] ÉCHEC : état partiel détecté après l'échec attendu (store_connection existe)." >&2
  FAILED=1
else
  step "cas (2) : aucun état partiel après l'échec attendu : OK"
fi

# ── Cas (3) : contexte absent ET non terminé (en vol) ───────────────────────
step "cas (3) : webhook_event sans contexte ET non terminé (processing/retryable) — doit échouer"
apply_fixture_and_migrate scripts/l1-harness-fixtures/in-flight-no-context.sql

set +e
OUTPUT=$(pnpm exec supabase migration up --local 2>&1)
STATUS=$?
set -e

if [ "${STATUS}" -eq 0 ]; then
  echo "[l1-harness] ÉCHEC : 0142 aurait dû échouer sur un événement en vol sans contexte, mais a réussi." >&2
  FAILED=1
elif ! echo "${OUTPUT}" | grep -q "l1_ingestion_event_backfill_missing_shop_context count=2"; then
  echo "[l1-harness] ÉCHEC : 0142 a échoué mais pas avec l'erreur/le compte attendu (2 lignes) :" >&2
  echo "${OUTPUT}" >&2
  FAILED=1
elif ! echo "${OUTPUT}" | grep -q "fixture-inflight-1" || ! echo "${OUTPUT}" | grep -q "fixture-inflight-2"; then
  echo "[l1-harness] ÉCHEC : les deux statuts en vol (retryable/processing) ne sont pas tous deux nommés :" >&2
  echo "${OUTPUT}" >&2
  FAILED=1
else
  step "cas (3) : OK — échec attendu obtenu, identifiants nommés, aucune tolérance pour un événement en vol"
fi

PARTIAL=$(docker exec supabase_db_teer-dev psql -U postgres -d postgres -t -A -c "select to_regclass('public.store_connection');")
if [ -n "${PARTIAL// }" ]; then
  echo "[l1-harness] ÉCHEC : état partiel détecté après l'échec attendu (store_connection existe)." >&2
  FAILED=1
else
  step "cas (3) : aucun état partiel après l'échec attendu : OK"
fi

# ── Restauration finale : base au dernier état déclaré (0142 appliqué) ─────
step "restauration finale : db reset --local avec 0142 en place"
pnpm exec supabase db reset --local >/dev/null

if [ "${FAILED}" -ne 0 ]; then
  echo "[l1-harness] HARNAIS EN ÉCHEC." >&2
  exit 1
fi

step "harnais L1 : tous les scénarios automatisés sont verts."
