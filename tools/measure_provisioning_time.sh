#!/usr/bin/env bash
# Measure the wall-clock cost of provisioning a fresh CityScroll working copy.
#
# Measurement-only instrument for the CI-08 provisioning evidence. It creates
# throwaway checkouts under a caller-supplied scratch directory, times each
# provisioning phase separately, and appends one JSON record per trial. It
# never writes to the repository under measurement and never changes
# application behaviour, package versions or dependency semantics.
#
# Phases are timed independently so a slow total can be attributed:
#   prepare  - object transfer and repository preparation (clone --no-checkout)
#   checkout - materialising the tracked working tree at the pinned revision
#   install  - the pinned shared-store dependency install
#   pages    - the generated site build
#
# Usage:
#   measure_provisioning_time.sh --source <local-copy|local-link|linked-working-tree|remote> \
#       --rev <sha> --origin <path-or-url> --scratch <dir> --out <jsonl> \
#       [--store <dir>] [--label <text>] [--phases prepare,checkout,install,pages]
#
# Sanitisation: the record stores the source *class* and phase durations, never
# the scratch path, origin path, user name or host name.

set -euo pipefail

SOURCE_CLASS=""
REV=""
ORIGIN=""
SCRATCH=""
OUT=""
STORE=""
LABEL=""
PHASES="prepare,checkout"
NETWORK="unspecified"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE_CLASS="$2"; shift 2 ;;
    --rev) REV="$2"; shift 2 ;;
    --origin) ORIGIN="$2"; shift 2 ;;
    --scratch) SCRATCH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --store) STORE="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --phases) PHASES="$2"; shift 2 ;;
    --network) NETWORK="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for required in SOURCE_CLASS REV ORIGIN SCRATCH OUT; do
  if [[ -z "${!required}" ]]; then
    echo "missing required argument for $required" >&2
    exit 2
  fi
done

has_phase() { [[ ",$PHASES," == *",$1,"* ]]; }

now_ms() { python3 -c 'import time; print(int(time.monotonic()*1000))'; }

mkdir -p "$SCRATCH"
TARGET="$SCRATCH/checkout"
rm -rf "$TARGET"

LOAD_BEFORE="$(uptime | sed -E 's/.*load averages?: //' | awk '{print $1}')"

PREPARE_MS=""
CHECKOUT_MS=""
INSTALL_MS=""
PAGES_MS=""

if has_phase prepare; then
  start="$(now_ms)"
  case "$SOURCE_CLASS" in
    linked-working-tree)
      git -C "$ORIGIN" worktree add --detach --no-checkout "$TARGET" "$REV" >/dev/null 2>&1
      ;;
    local-link)
      git clone --no-checkout "$ORIGIN" "$TARGET" >/dev/null 2>&1
      ;;
    local-copy)
      git clone --no-hardlinks --no-checkout "$ORIGIN" "$TARGET" >/dev/null 2>&1
      ;;
    remote)
      git clone --no-checkout "$ORIGIN" "$TARGET" >/dev/null 2>&1
      ;;
    *) echo "unknown source class: $SOURCE_CLASS" >&2; exit 2 ;;
  esac
  PREPARE_MS=$(( $(now_ms) - start ))
fi

if has_phase checkout; then
  start="$(now_ms)"
  git -C "$TARGET" checkout --detach "$REV" >/dev/null 2>&1
  CHECKOUT_MS=$(( $(now_ms) - start ))
fi

if has_phase install; then
  start="$(now_ms)"
  if [[ -n "$STORE" ]]; then
    CITYSCROLL_PNPM_STORE_DIR="$STORE" "$TARGET/tools/install_worker_dependencies.sh" >/dev/null 2>&1
  else
    "$TARGET/tools/install_worker_dependencies.sh" >/dev/null 2>&1
  fi
  INSTALL_MS=$(( $(now_ms) - start ))
fi

if has_phase pages; then
  start="$(now_ms)"
  ( cd "$TARGET" && node tools/build_cloudflare_pages.mjs --site-dir _site >/dev/null 2>&1 ) || true
  PAGES_MS=$(( $(now_ms) - start ))
fi

LOAD_AFTER="$(uptime | sed -E 's/.*load averages?: //' | awk '{print $1}')"

MEASURE_OUT="$OUT" \
MEASURE_LABEL="$LABEL" \
MEASURE_SOURCE="$SOURCE_CLASS" \
MEASURE_NETWORK="$NETWORK" \
MEASURE_REV="$REV" \
MEASURE_PHASES="$PHASES" \
MEASURE_PREPARE="$PREPARE_MS" \
MEASURE_CHECKOUT="$CHECKOUT_MS" \
MEASURE_INSTALL="$INSTALL_MS" \
MEASURE_PAGES="$PAGES_MS" \
MEASURE_LOAD_BEFORE="$LOAD_BEFORE" \
MEASURE_LOAD_AFTER="$LOAD_AFTER" \
python3 - <<'PYEOF'
import json, os


def optional_ms(name):
    raw = os.environ.get(name, "")
    return int(raw) if raw else None


record = {
    "schema": "cityscroll.provisioning-timing.v1",
    "label": os.environ["MEASURE_LABEL"],
    "source_class": os.environ["MEASURE_SOURCE"],
    "network": os.environ["MEASURE_NETWORK"],
    "revision": os.environ["MEASURE_REV"],
    "phases_requested": os.environ["MEASURE_PHASES"].split(","),
    "prepare_ms": optional_ms("MEASURE_PREPARE"),
    "checkout_ms": optional_ms("MEASURE_CHECKOUT"),
    "install_ms": optional_ms("MEASURE_INSTALL"),
    "pages_ms": optional_ms("MEASURE_PAGES"),
    "load_avg_1m_before": float(os.environ["MEASURE_LOAD_BEFORE"]),
    "load_avg_1m_after": float(os.environ["MEASURE_LOAD_AFTER"]),
}
record["measured_total_ms"] = sum(
    value for key, value in record.items() if key.endswith("_ms") and value is not None
)
with open(os.environ["MEASURE_OUT"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True) + "\n")
print(json.dumps(record, sort_keys=True))
PYEOF
