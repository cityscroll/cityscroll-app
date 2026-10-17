#!/usr/bin/env bash

a11y_readiness_outer_timeout() {
  local inner_timeout="$1"
  local outer_grace="$2"
  if [[ ! "$inner_timeout" =~ ^[1-9][0-9]*$ ]]; then
    echo "server readiness timeout must be a positive whole number: $inner_timeout" >&2
    return 2
  fi
  if [[ ! "$outer_grace" =~ ^[1-9][0-9]*$ ]]; then
    echo "server readiness grace must be a positive whole number: $outer_grace" >&2
    return 2
  fi
  local outer_timeout=$((inner_timeout + outer_grace))
  if (( outer_timeout <= inner_timeout )); then
    echo "outer server wait must exceed the internal readiness timeout" >&2
    return 2
  fi
  printf '%s\n' "$outer_timeout"
}

# Sub-second monotonic clock for wait deadlines. Bash SECONDS is whole-second
# quantized, so an integer SECONDS-based outer wait can expire after ~1s of
# wall time for outer=2 when the wait starts near a second boundary
# (measured early give-up ~1.5s under load).
a11y_monotonic_now() {
  python3 -c 'import time; print(time.monotonic())'
}

# True (exit 0) while elapsed monotonic time since started is still < timeout.
a11y_before_deadline() {
  local started="$1"
  local timeout_seconds="$2"
  python3 -c 'import sys, time; started=float(sys.argv[1]); timeout=float(sys.argv[2]); sys.exit(0 if (time.monotonic() - started) < timeout else 1)' \
    "$started" "$timeout_seconds"
}

a11y_wait_for_local_site() {
  local ready_file="$1"
  local probe_error="$2"
  local server_log="$3"
  local server_pid="$4"
  local outer_timeout="$5"
  local started
  local last_probe="ready file not published"
  local probe_status=""
  local readiness_url=""

  started="$(a11y_monotonic_now)" || return 1

  A11Y_READY_BASE=""
  while a11y_before_deadline "$started" "$outer_timeout"; do
    if [[ -s "$ready_file" ]]; then
      IFS= read -r A11Y_READY_BASE < "$ready_file"
      readiness_url="${A11Y_READY_BASE}index.html"
      probe_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 1 "$readiness_url" 2>"$probe_error" || true)"
      if [[ "$probe_status" =~ ^2[0-9][0-9]$ ]]; then
        return 0
      elif [[ "$probe_status" == "404" ]]; then
        echo "local site server returned HTTP 404 for readiness path (artifact is serving, but the probe path is missing): $readiness_url" >&2
        cat "$probe_error" >&2 2>/dev/null || true
        cat "$server_log" >&2 2>/dev/null || true
        return 1
      elif [[ "$probe_status" == "000" || -z "$probe_status" ]]; then
        if grep -Eqi 'connection refused' "$probe_error" 2>/dev/null; then
          last_probe="connection refused for $readiness_url"
        elif grep -Eqi 'timed out|timeout' "$probe_error" 2>/dev/null; then
          last_probe="connection timed out for $readiness_url"
        else
          last_probe="connection failed for $readiness_url"
        fi
      else
        last_probe="HTTP $probe_status from $readiness_url"
      fi
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "local site server exited before becoming ready ($last_probe)" >&2
      cat "$probe_error" >&2 2>/dev/null || true
      cat "$server_log" >&2 2>/dev/null || true
      return 1
    fi
    sleep 0.25
  done

  echo "timed out after ${outer_timeout}s waiting for the local site server ($last_probe)" >&2
  cat "$probe_error" >&2 2>/dev/null || true
  cat "$server_log" >&2 2>/dev/null || true
  return 1
}
