#!/usr/bin/env bash
# Phase 2 / Lot 4B — génère une baseline ACL jetable, arrêtée à une migration
# précise, en réutilisant le mécanisme de scripts/l1-backfill-harness.sh (déplacer
# hors du dossier les migrations postérieures, `db reset --local`, restaurer).
#
# Pourquoi ce mécanisme et pas des instantanés committés par version : le dépôt
# grossirait sans fin et ces fichiers se périmeraient (cf. CLAUDE.md, Lot 4B).
# La sonde de production (scripts/acl-production-probe.mjs) a besoin de comparer
# l'ACL réelle de production à la baseline correspondant à SA propre version —
# jamais à la baseline courante du dépôt, qui peut être en avance (0142 mergée,
# jamais déployée au moment de l'écriture de ce lot).
#
# N'ALTÈRE JAMAIS supabase/security/acl-baseline.json (le fichier committé) :
# la sortie va systématiquement vers un chemin explicite passé en 2e argument,
# via ACL_BASELINE_OUTPUT (cf. scripts/generate-acl-baseline.mjs).
#
# Usage : ./scripts/acl-baseline-at-version.sh <version-migration> <chemin-sortie.json>
#   ex.  ./scripts/acl-baseline-at-version.sh 0141 /tmp/acl-baseline-0141.json
#
# Effet de bord assumé : le stack Supabase local est réinitialisé plusieurs fois
# (comme scripts/l1-backfill-harness.sh) et restauré au dernier état déclaré du
# dépôt (toutes les migrations appliquées) à la fin, succès ou échec.

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "[acl-baseline-at-version] usage : $0 <version-migration> <chemin-sortie.json>" >&2
  exit 1
fi

TARGET_VERSION="$1"
OUTPUT_PATH="$2"
MIGRATIONS_DIR="supabase/migrations"
STASH_DIR="$(mktemp -d)"

step() { echo "[acl-baseline-at-version] $*"; }

cleanup() {
  # Restaure TOUTES les migrations stashées, quel que soit le point de sortie.
  if compgen -G "${STASH_DIR}/*.sql" > /dev/null; then
    mv "${STASH_DIR}"/*.sql "${MIGRATIONS_DIR}/"
    step "migrations restaurées dans ${MIGRATIONS_DIR}."
  fi
  rm -rf "${STASH_DIR}"
  step "restauration finale : db reset --local avec l'historique complet du dépôt."
  pnpm exec supabase db reset --local >/dev/null
}
trap cleanup EXIT

# Sélectionne toute migration dont le préfixe numérique est STRICTEMENT postérieur
# à TARGET_VERSION — comparaison numérique, pas lexicographique (nécessaire dès
# que le compteur dépasse 4 chiffres, mais surtout robuste par construction).
shopt -s nullglob
for f in "${MIGRATIONS_DIR}"/*.sql; do
  base="$(basename "$f")"
  version="${base%%_*}"
  if [ "$((10#$version))" -gt "$((10#$TARGET_VERSION))" ]; then
    mv "$f" "${STASH_DIR}/"
  fi
done
shopt -u nullglob

step "arrêt à la migration ${TARGET_VERSION} ($(ls "${MIGRATIONS_DIR}" | wc -l | tr -d ' ') migrations restantes, $(ls "${STASH_DIR}" | wc -l | tr -d ' ') mises de côté)"

pnpm exec supabase db reset --local >/dev/null
step "stack local rejoué jusqu'à ${TARGET_VERSION}."

ACL_BASELINE_OUTPUT="${OUTPUT_PATH}" \
  SUPABASE_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  pnpm exec node scripts/generate-acl-baseline.mjs >/dev/null

step "baseline à la version ${TARGET_VERSION} écrite dans ${OUTPUT_PATH}."
