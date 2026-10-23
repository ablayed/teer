#!/usr/bin/env bash
# Installe les dépendances système et les moteurs Playwright demandés.
# Usage : scripts/ci-install-playwright.sh <chromium|webkit> [...]
#
# Mesuré sur la CI (run 39940752057) : au même instant, 117 Mo de paquets WebKit sont servis
# en 9 à 12 s sur la plupart des runners, et à ~40 Ko/s sur d'autres, qui restent lents d'une
# tentative à l'autre (117 → 103 → 82 Mo restants en 16 min). Le débit dépend du couple
# runner/miroir `azure.archive.ubuntu.com`. Refaire la même tentative sur le même miroir ne
# change donc rien : une tentative lente est coupée vite, et la suivante change de miroir.
# Les paquets déjà téléchargés restent dans le cache apt et ne sont pas retéléchargés.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage : $0 <chromium|webkit> [...]" >&2
  exit 2
fi
browsers=("$@")

# Réglages surchargeables, uniquement pour tester la logique hors CI.
attempt_timeout="${PW_INSTALL_ATTEMPT_TIMEOUT:-120}"
retry_pause="${PW_INSTALL_RETRY_PAUSE:-5}"
mirrors_file="${PW_APT_MIRRORS_FILE:-/etc/apt/apt-mirrors.txt}"
apt_conf_file="${PW_APT_CONF_FILE:-/etc/apt/apt.conf.d/80-ci-network}"
sudo_cmd="${PW_INSTALL_SUDO:-sudo}"
read -r -a install_cmd <<<"${PW_INSTALL_CMD:-pnpm exec playwright install --with-deps}"

# Miroirs de repli officiels, un par tentative après la première.
fallback_mirrors=(
  "https://archive.ubuntu.com/ubuntu/"
  "https://mirrors.edge.kernel.org/ubuntu/"
)

# `$sudo_cmd` est volontairement non guillemeté : vide en test, `sudo` en CI.
as_root() {
  # shellcheck disable=SC2086
  $sudo_cmd "$@"
}

# Une connexion muette est coupée au bout de 20 s et retentée par apt lui-même ;
# cela ne sert pas contre un débit faible mais continu, que traite le délai par tentative.
as_root tee "$apt_conf_file" >/dev/null <<'EOF'
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
EOF

echo "Miroir apt avant installation (${mirrors_file}) :"
cat "$mirrors_file" 2>/dev/null || echo "(fichier absent)"

# Arrête le watchdog ET son `sleep` en cours : sans cela le `sleep` survit et garde la sortie ouverte.
stop_watchdog() {
  pkill -P "$watchdog" 2>/dev/null || true
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
}

for attempt in 1 2 3; do
  if [ "$attempt" -gt 1 ]; then
    mirror="${fallback_mirrors[$((attempt - 2))]}"
    echo "Tentative $attempt : bascule sur le miroir officiel $mirror"
    printf '%s\n' "$mirror" | as_root tee "$mirrors_file" >/dev/null
  fi

  echo "::group::playwright install ${browsers[*]} (tentative $attempt/3, ${attempt_timeout}s max)"
  started=$SECONDS
  # `sudo apt-get` peut survivre au PID de tête après un stall de miroir.
  # Une session dédiée donne au watchdog un PGID unique à tuer en entier.
  setsid "${install_cmd[@]}" "${browsers[@]}" &
  pgid=$!
  (
    sleep "$attempt_timeout"
    if as_root kill -0 -- "-$pgid" 2>/dev/null; then
      echo "::warning::Tentative $attempt au-delà de ${attempt_timeout}s ; arrêt TERM du groupe $pgid."
      if ! as_root kill -TERM -- "-$pgid"; then
        echo "::error::Impossible d'envoyer TERM au groupe $pgid."
      fi
      sleep 5
      if as_root kill -0 -- "-$pgid" 2>/dev/null; then
        echo "::warning::Le groupe $pgid survit à TERM ; arrêt KILL."
        if ! as_root kill -KILL -- "-$pgid"; then
          echo "::error::Impossible d'envoyer KILL au groupe $pgid."
        fi
      fi
    fi
  ) &
  watchdog=$!

  if wait "$pgid"; then
    stop_watchdog
    echo "::endgroup::"
    echo "playwright install ${browsers[*]} réussi à la tentative $attempt en $((SECONDS - started))s."
    exit 0
  fi
  stop_watchdog
  echo "::endgroup::"
  echo "::warning::Tentative $attempt échouée ou coupée après $((SECONDS - started))s."
  sleep "$retry_pause"
done

echo "::error::playwright install a échoué 3 fois de suite. Lire les tentatives ci-dessus : un débit apt qui s'effondre (paquets restants qui baissent à peine) et un index incohérent (« Hash Sum mismatch ») sont deux causes différentes."
exit 1
