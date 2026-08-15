#!/usr/bin/env bash
# Run one non-axe browser check with a bounded retry for runner scheduling flakes.
# The axe gate is intentionally invoked directly by CI so real accessibility findings
# cannot be hidden by this recovery path.
set -euo pipefail

if (( $# < 2 )); then
  echo "usage: $0 LABEL COMMAND [ARG ...]" >&2
  exit 2
fi

label="$1"
shift
attempts="${A11Y_FUNCTIONAL_ATTEMPTS:-2}"
log_dir="${A11Y_LOG_DIR:-${RUNNER_TEMP:-/tmp}/a11y-functional-checks}"

if [[ ! "$attempts" =~ ^[1-2]$ ]]; then
  echo "A11Y_FUNCTIONAL_ATTEMPTS must be 1 or 2" >&2
  exit 2
fi
mkdir -p "$log_dir"

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  log_file="$log_dir/${label}.attempt-${attempt}.log"
  set +e
  "$@" 2>&1 | tee "$log_file"
  status=${PIPESTATUS[0]}
  set -e

  if (( status == 0 )); then
    if (( attempt > 1 )); then
      echo "RECOVERED functional check: $label passed on bounded retry" >&2
    fi
    exit 0
  fi

  if (( attempt >= attempts )); then
    echo "FAILED functional check: $label after $attempt attempt(s); see $log_file" >&2
    exit "$status"
  fi

  echo "WAIT functional check: $label failed; retrying once" >&2
done
