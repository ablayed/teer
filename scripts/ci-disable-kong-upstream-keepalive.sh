#!/usr/bin/env bash

# Désactive la réutilisation des connexions entre Kong et PostgREST sur la pile Supabase LOCALE de test.
#
# Motif (mesuré, voir CLAUDE.md, dette (m)) : les « 502 — An invalid response was received from the
# upstream server » de `pnpm test:rls` sont des erreurs de Kong sur une connexion vers PostgREST
# déjà fermée (« upstream prematurely closed connection » / « Connection reset by peer »). Avec
# `upstream_keepalive_pool_size = 0`, chaque requête ouvre sa propre connexion et ces erreurs ne
# se produisent plus. C'est une mitigation de la pile de TEST, jamais un réglage de production.
#
# Le réglage vit dans le processus Kong : `docker restart` ou `supabase db reset` suivi d'un
# redémarrage de Kong le rétablit à 60. À rejouer après chaque redémarrage de Kong.
#
# Échoue explicitement (jamais un succès silencieux) si le rechargement n'est pas effectif.
set -euo pipefail

kong_container="${KONG_CONTAINER:-supabase_kong_teer-dev}"
expected='upstream_keepalive_pool_size=0'

docker exec -e KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=0 "$kong_container" kong reload

effective="$(docker exec "$kong_container" sh -c "grep '^upstream_keepalive_pool_size' /usr/local/kong/.kong_env" | tr -d ' ')"
if [[ "$effective" != "$expected" ]]; then
  echo "::error::Kong n'applique pas la mitigation : ${effective:-<absent>} (attendu ${expected})" >&2
  exit 1
fi

for _ in $(seq 1 30); do
  status="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/auth/v1/health -H 'apikey: x' || true)"
  if [[ "$status" == "200" ]]; then
    echo "Kong rechargé : ${effective} ; /auth/v1/health répond 200."
    exit 0
  fi
  sleep 1
done

echo "::error::Kong rechargé mais /auth/v1/health ne répond pas 200 (dernier statut : ${status:-aucun})" >&2
exit 1
