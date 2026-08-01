#!/usr/bin/env bash
# Parallel Stray-English locale shards for CI wall-clock (single required job).
# Each shard is a separate process with its own Playwright browser so N locales
# no longer run strictly serially. Failures from any shard fail the job.
#
# Env (same as 13_stray_english.py):
#   CROL_GUARD_LANGS  — if set, run that set only (no sharding; for local debug)
#   CROL_GUARD_PAGES  — default index,about,data,stats,api,changelog
#   CROL_STRAY_SHARDS — optional override: space-separated lang-lists
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PAGES="${CROL_GUARD_PAGES:-index,about,data,stats,api,changelog}"
export CROL_GUARD_PAGES="$PAGES"

if [ -n "${CROL_GUARD_LANGS:-}" ]; then
  echo "Stray-English: single-process langs=${CROL_GUARD_LANGS} pages=${PAGES}"
  exec python3 test/functional/13_stray_english.py
fi

# Three shards keep full coverage while overlapping browser time.
# Override with CROL_STRAY_SHARDS for experiments.
if [ -n "${CROL_STRAY_SHARDS:-}" ]; then
  # shellcheck disable=SC2206
  SHARDS=(${CROL_STRAY_SHARDS})
else
  SHARDS=(
    "es,zh-Hans,ru,bn"
    "ht,ko,fr,pl"
    "ar,ur"
  )
fi

echo "Stray-English: ${#SHARDS[@]} parallel shards; pages=${PAGES}"
pids=()
logs=()
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

i=0
for shard in "${SHARDS[@]}"; do
  i=$((i + 1))
  log="$tmpdir/shard-${i}.log"
  logs+=("$log")
  echo "  shard $i: langs=${shard}"
  (
    export CROL_GUARD_LANGS="$shard"
    python3 test/functional/13_stray_english.py
  ) >"$log" 2>&1 &
  pids+=("$!")
done

ec=0
for idx in "${!pids[@]}"; do
  pid="${pids[$idx]}"
  log="${logs[$idx]}"
  if ! wait "$pid"; then
    ec=1
    echo "---- shard $((idx + 1)) FAILED (log tail) ----" >&2
    tail -n 80 "$log" >&2 || true
  else
    echo "---- shard $((idx + 1)) ok ----"
    # Keep CI readable: last few success lines only
    tail -n 5 "$log" || true
  fi
done

if [ "$ec" -ne 0 ]; then
  echo "Stray-English: one or more shards failed" >&2
  exit 1
fi
echo "Stray-English: all shards passed"
