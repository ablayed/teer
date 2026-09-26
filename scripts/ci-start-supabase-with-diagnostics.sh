#!/usr/bin/env bash

# Capture the runner's port/container state around the single Supabase start.
# Deliberately do not use `set -e`: diagnostics must never hide the CLI's status.
set -u

timestamp_utc() {
  date -u '+%Y-%m-%dT%H:%M:%S.%NZ'
}

capture_listeners() {
  printf '%s\n' '  listeners:'

  if command -v ss >/dev/null 2>&1; then
    local ss_output
    if ss_output="$(ss -H -ltnup 'sport >= :54320 and sport <= :54330' 2>/dev/null)"; then
      if [[ -z "$ss_output" ]]; then
        printf '%s\n' '    none found (ss)'
      else
        printf '%s\n' "$ss_output" | awk '
          {
            process = "owner-unavailable"
            if (NF >= 7) {
              process = $7
              gsub(/,fd=[0-9]+/, "", process)
            }
            printf "    protocol=%s address=%s process=%s\n", $1, $5, process
          }
        '
      fi
      return 0
    fi
    printf '%s\n' '    diagnostic unavailable: ss failed'
  fi

  if command -v lsof >/dev/null 2>&1; then
    local lsof_output
    if lsof_output="$(lsof -nP -iTCP:54320-54330 -iUDP:54320-54330 -Fpcn 2>/dev/null)"; then
      if [[ -z "$lsof_output" ]]; then
        printf '%s\n' '    none found (lsof)'
      else
        printf '%s\n' "$lsof_output" | awk '
          /^p/ { pid = substr($0, 2) }
          /^c/ { process = substr($0, 2) }
          /^n/ { printf "    endpoint=%s process=%s pid=%s\n", substr($0, 2), process, pid }
        '
      fi
      return 0
    fi
    printf '%s\n' '    diagnostic unavailable: lsof failed'
  else
    printf '%s\n' '    diagnostic unavailable: neither ss nor lsof is installed'
  fi

  return 0
}

capture_docker() {
  local phase="$1"
  printf '  docker all containers (name, state, published ports) [%s]:\n' "$phase"
  if ! command -v docker >/dev/null 2>&1; then
    printf '%s\n' '    diagnostic unavailable: docker is not installed'
  elif ! docker ps -a --format '{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null; then
    printf '%s\n' '    diagnostic unavailable: docker ps failed'
  fi

  printf '  supabase containers (name, state) [%s]:\n' "$phase"
  if ! command -v docker >/dev/null 2>&1; then
    printf '%s\n' '    diagnostic unavailable: docker is not installed'
  elif ! docker ps -a --filter 'name=^supabase_' --format '{{.Names}}|{{.Status}}' 2>/dev/null; then
    printf '%s\n' '    diagnostic unavailable: docker ps failed'
  fi

  printf '  Inbucket published ports [%s]:\n' "$phase"
  if ! command -v docker >/dev/null 2>&1; then
    printf '%s\n' '    diagnostic unavailable: docker is not installed'
  elif ! docker ps -a --filter 'name=^supabase_inbucket_teer-dev$' --format '{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null; then
    printf '%s\n' '    diagnostic unavailable: docker ps failed'
  fi
}

capture_state() {
  local phase="$1"
  local begin_utc begin_epoch_ns end_epoch_ns elapsed_ms

  begin_utc="$(timestamp_utc)"
  begin_epoch_ns="$(date +%s%N)"
  printf 'SUPABASE_DIAGNOSTICS phase=%s capture_begin_utc=%s\n' "$phase" "$begin_utc"
  capture_listeners
  capture_docker "$phase"
  end_epoch_ns="$(date +%s%N)"
  LAST_CAPTURE_END_EPOCH_NS="$end_epoch_ns"
  elapsed_ms=$(((end_epoch_ns - begin_epoch_ns) / 1000000))
  printf 'SUPABASE_DIAGNOSTICS phase=%s capture_end_utc=%s capture_duration_ms=%s\n' \
    "$phase" "$(timestamp_utc)" "$elapsed_ms"
}

supabase_log="$(mktemp)"
capture_state before

cli_launch_epoch_ns="$(date +%s%N)"
cli_launch_utc="$(timestamp_utc)"
capture_to_cli_ms=$(((cli_launch_epoch_ns - LAST_CAPTURE_END_EPOCH_NS) / 1000000))
printf 'SUPABASE_DIAGNOSTICS cli_launch_utc=%s capture_end_to_cli_launch_ms=%s\n' \
  "$cli_launch_utc" "$capture_to_cli_ms"

if supabase start -x edge-runtime >"$supabase_log" 2>&1; then
  status=0
else
  status=$?
  printf '::error::supabase start failed (exit %s)\n' "$status"
  grep -Eiu 'error|failed|failure|timeout|timed out|unable|cannot|denied|refused|network|connection|pull|download|bind' "$supabase_log" \
    | sed -E '/key|token|secret|password|credential|jwt/Ic\[redacted sensitive diagnostic line\]' \
    || true
fi

capture_state after
rm -f "$supabase_log"
exit "$status"
