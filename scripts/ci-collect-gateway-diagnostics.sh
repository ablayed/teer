#!/usr/bin/env bash

# Collecte des diagnostics de la passerelle (kong) et de PostgREST après un échec de test-rls.
# N'écrit que dans $RUNNER_TEMP/ci-diagnostics (téléversé ensuite en artefact, 7 jours). Les artefacts
# d'un dépôt public sont lisibles par tout compte GitHub : tout est expurgé avant écriture (jetons,
# courriels, en-têtes d'autorisation, cookies). Les tests ne manipulent que des données synthétiques
# d'une pile locale éphémère.
# Pas de `set -e` : un diagnostic ne masque jamais l'échec qu'il décrit.
set -u

out="${RUNNER_TEMP:-/tmp}/ci-diagnostics"
mkdir -p "$out"

redact() {
  sed -E \
    -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/[jeton]/g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[courriel]/g' \
    -e 's/(apikey|authorization|cookie)([=: "]+)[^ "&]+/\1\2[retiré]/Ig'
}

for name in $(docker ps -a --format '{{.Names}}' | grep -E '^supabase_(kong|rest)_' || true); do
  docker logs --timestamps --tail 30000 "$name" 2>&1 | redact >"$out/$name.log" || true
done

{
  echo '--- conteneurs'
  docker ps -a --format '{{.Names}} | {{.Status}} | {{.CreatedAt}}'
  echo '--- état et redémarrages'
  for name in $(docker ps -a --format '{{.Names}}' | grep -E '^supabase_' || true); do
    docker inspect -f '{{.Name}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} started={{.State.StartedAt}}' "$name" || true
  done
  echo "--- mémoire de l'hôte"
  free -m || true
  echo '--- consommation instantanée des conteneurs'
  docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' || true
} >"$out/conteneurs.txt" 2>&1

ls -la "$out"
