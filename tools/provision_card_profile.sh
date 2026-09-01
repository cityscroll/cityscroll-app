#!/usr/bin/env bash
# Provision a CityScroll working copy as either the reduced card-work profile or
# the full-checkout control, and hydrate a reduced profile on demand.
#
# The reduced profile acts on the two costs CI-08 measured as two thirds of a
# fresh working copy: Git repository metadata (481-560 MiB) and the tracked
# site/data payload (445 MiB).
#
#   Git metadata   A partial clone (--filter=blob:none) fetches commits and
#                  trees but only the blobs the profile materialises. Complete
#                  commit history is preserved, so a merge-base guard still
#                  works; missing blobs are served on demand by the promisor
#                  remote, which is the durable origin, never a scratch
#                  checkout. --depth is available as an opt-in extra reduction
#                  with an explicit unshallow fallback.
#
#   site/data      A sparse checkout materialises only the closure derived by
#                  tools/derive_card_profile.mjs. A read of a tracked path the
#                  profile does not hold fails closed through
#                  tools/card_profile_sentinel.cjs rather than passing by
#                  omission.
#
# Usage:
#   provision_card_profile.sh provision --dest <dir> [--profile card|full]
#       [--rev <sha>] [--source <url-or-path>] [--store <dir>] [--depth <n>]
#       [--no-install] [--timing-out <jsonl>] [--label <text>]
#   provision_card_profile.sh hydrate <path>...      # materialise tracked paths
#   provision_card_profile.sh hydrate --full         # become the full control
#   provision_card_profile.sh unshallow              # restore complete history
#   provision_card_profile.sh status                 # report the active profile
#
# Timing records carry the source class and phase durations only: never a local
# path, user name or host name.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PATTERN_FILE_PATH="tools/card-profile/card-work.sparse"

die() { echo "$*" >&2; exit 1; }
now_ms() { python3 -c 'import time; print(int(time.monotonic()*1000))'; }

usage() { sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# --- hydrate / unshallow / status: act on the checkout we are standing in -----

cmd_status() {
  node "$ROOT/tools/verify_card_profile.mjs" --status
}

cmd_unshallow() {
  if [[ "$(git -C "$ROOT" rev-parse --is-shallow-repository)" != "true" ]]; then
    echo "history is already complete; nothing to unshallow"
    return 0
  fi
  echo "restoring complete history from origin (this is the documented full-history fallback)"
  git -C "$ROOT" fetch --unshallow origin
  echo "complete history restored; merge-base guards can run here now"
}

cmd_hydrate() {
  [[ $# -gt 0 ]] || die "hydrate needs one or more tracked paths, or --full"
  if [[ "$(git -C "$ROOT" config --get core.sparseCheckout || true)" != "true" ]]; then
    echo "this checkout is already the full-checkout control; nothing to hydrate"
    return 0
  fi
  if [[ "$1" == "--full" ]]; then
    echo "materialising every tracked path (missing blobs are fetched from the promisor remote)"
    git -C "$ROOT" sparse-checkout disable
    echo "this checkout is now the full-checkout control"
    return 0
  fi
  local patterns=()
  for path in "$@"; do
    git -C "$ROOT" ls-files --error-unmatch -- "$path" >/dev/null 2>&1 \
      || die "not a tracked path: $path"
    patterns+=("/$path")
  done
  git -C "$ROOT" sparse-checkout add "${patterns[@]}"
  echo "hydrated ${#patterns[@]} path(s)"
  echo "record them in the profile with: node tools/derive_card_profile.mjs"
}

# --- provision: build a new checkout -----------------------------------------

cmd_provision() {
  local dest="" profile="card" rev="" source="" store="" depth="" install=1
  local timing_out="" label="" 
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dest) dest="$2"; shift 2 ;;
      --profile) profile="$2"; shift 2 ;;
      --rev) rev="$2"; shift 2 ;;
      --source) source="$2"; shift 2 ;;
      --store) store="$2"; shift 2 ;;
      --depth) depth="$2"; shift 2 ;;
      --no-install) install=0; shift ;;
      --timing-out) timing_out="$2"; shift 2 ;;
      --label) label="$2"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  [[ -n "$dest" ]] || die "--dest is required"
  [[ "$profile" == "card" || "$profile" == "full" ]] || die "--profile must be card or full"
  [[ -e "$dest" ]] && die "destination already exists: $dest"

  rev="${rev:-$(git -C "$ROOT" rev-parse HEAD)}"
  source="${source:-$(git -C "$ROOT" remote get-url origin)}"

  local source_class="remote"
  if [[ -e "$source" ]]; then source_class="local"; fi

  # A partial clone makes its source the promisor remote. A local scratch
  # checkout is not a durable object source, so blob filtering is only used
  # against a real remote. A local clone shares or copies objects anyway, so it
  # loses nothing by staying complete.
  local filter_args=()
  local partial="false"
  if [[ "$profile" == "card" && "$source_class" == "remote" ]]; then
    filter_args=(--filter=blob:none)
    partial="true"
  fi
  local depth_args=()
  if [[ -n "$depth" ]]; then
    [[ "$profile" == "card" ]] || die "--depth applies to the card profile only"
    depth_args=(--depth "$depth")
  fi

  local load_before
  load_before="$(uptime | sed -E 's/.*load averages?: //' | awk '{print $1}')"

  local start prepare_ms sparse_ms checkout_ms install_ms
  start="$(now_ms)"
  git clone --no-checkout "${filter_args[@]}" "${depth_args[@]}" "$source" "$dest" >/dev/null 2>&1
  prepare_ms=$(( $(now_ms) - start ))

  sparse_ms=0
  if [[ "$profile" == "card" ]]; then
    start="$(now_ms)"
    # The pattern list is read out of the object store, because the working tree
    # that would contain it does not exist yet.
    git -C "$dest" show "$rev:$PATTERN_FILE_PATH" > "$dest/.git/card-work.sparse"
    git -C "$dest" config core.sparseCheckout true
    grep -v '^#' "$dest/.git/card-work.sparse" | grep -v '^$' \
      | git -C "$dest" sparse-checkout set --no-cone --stdin
    sparse_ms=$(( $(now_ms) - start ))
  fi

  start="$(now_ms)"
  git -C "$dest" checkout --detach "$rev" >/dev/null 2>&1
  checkout_ms=$(( $(now_ms) - start ))

  install_ms=""
  if [[ "$install" == "1" ]]; then
    start="$(now_ms)"
    if [[ -n "$store" ]]; then
      CITYSCROLL_PNPM_STORE_DIR="$store" "$dest/tools/install_worker_dependencies.sh" >/dev/null 2>&1
    else
      "$dest/tools/install_worker_dependencies.sh" >/dev/null 2>&1
    fi
    install_ms=$(( $(now_ms) - start ))
  fi

  local load_after
  load_after="$(uptime | sed -E 's/.*load averages?: //' | awk '{print $1}')"

  echo "provisioned $profile profile at $rev"
  git -C "$dest" rev-parse --is-shallow-repository | sed 's/^/  shallow: /'
  echo "  partial clone: $partial"
  if [[ "$profile" == "card" ]]; then
    echo "  tracked paths not materialised: $(git -C "$dest" ls-files -t | grep -c '^S ' || true)"
  fi

  if [[ -n "$timing_out" ]]; then
    PROV_OUT="$timing_out" PROV_LABEL="$label" PROV_PROFILE="$profile" \
    PROV_SOURCE="$source_class" PROV_REV="$rev" PROV_PARTIAL="$partial" \
    PROV_DEPTH="${depth:-}" PROV_PREPARE="$prepare_ms" PROV_SPARSE="$sparse_ms" \
    PROV_CHECKOUT="$checkout_ms" PROV_INSTALL="$install_ms" \
    PROV_LOAD_BEFORE="$load_before" PROV_LOAD_AFTER="$load_after" \
    python3 - <<'PYEOF'
import json, os


def optional_ms(name):
    raw = os.environ.get(name, "")
    return int(raw) if raw else None


record = {
    "schema": "cityscroll.card-profile-provisioning.v1",
    "label": os.environ["PROV_LABEL"],
    "profile": os.environ["PROV_PROFILE"],
    "source_class": os.environ["PROV_SOURCE"],
    "revision": os.environ["PROV_REV"],
    "partial_clone": os.environ["PROV_PARTIAL"] == "true",
    "depth": int(os.environ["PROV_DEPTH"]) if os.environ.get("PROV_DEPTH") else None,
    "prepare_ms": optional_ms("PROV_PREPARE"),
    "sparse_ms": optional_ms("PROV_SPARSE"),
    "checkout_ms": optional_ms("PROV_CHECKOUT"),
    "install_ms": optional_ms("PROV_INSTALL"),
    "load_avg_1m_before": float(os.environ["PROV_LOAD_BEFORE"]),
    "load_avg_1m_after": float(os.environ["PROV_LOAD_AFTER"]),
}
record["measured_total_ms"] = sum(
    value for key, value in record.items() if key.endswith("_ms") and value is not None
)
with open(os.environ["PROV_OUT"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True) + "\n")
print(json.dumps(record, sort_keys=True))
PYEOF
  fi
}

case "${1:-}" in
  provision) shift; cmd_provision "$@" ;;
  hydrate) shift; cmd_hydrate "$@" ;;
  unshallow) shift; cmd_unshallow ;;
  status) shift; cmd_status ;;
  -h|--help|"") usage ;;
  *) die "unknown command: $1" ;;
esac
