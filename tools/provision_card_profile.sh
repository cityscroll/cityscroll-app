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
# Which profile a request gets is not a flag the caller has to know: it is a
# routing decision. tools/card_profile_router.mjs turns a declared work surface
# into exactly one profile, and the reduced one is the supported default for
# focused card work only. Every other surface, and every request the router
# cannot classify, takes the full-checkout control.
#
# Usage:
#   provision_card_profile.sh provision --dest <dir>
#       [--surface <work-surface>]          # routed; defaults to focused-card-work
#       [--profile focused-reduced|full]    # overrides routing, still recorded
#       [--rev <sha>] [--source <url-or-path>] [--store <dir>] [--depth <n>]
#       [--no-install] [--timing-out <jsonl>] [--label <text>]
#       [--receipt-out <json>] [--gate <class>]... [--require-complete-history]
#   provision_card_profile.sh decide [--surface <id>] [--gate <class>]...
#   provision_card_profile.sh hydrate <path>...      # materialise tracked paths
#   provision_card_profile.sh hydrate --full         # become the full control
#   provision_card_profile.sh unshallow              # restore complete history
#   provision_card_profile.sh status                 # report the active profile
#
# Timing records and receipts carry the source class and phase durations only:
# never a local path, user name or host name.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PATTERN_FILE_PATH="tools/card-profile/card-work.sparse"

die() { echo "$*" >&2; exit 1; }
now_ms() { python3 -c 'import time; print(int(time.monotonic()*1000))'; }

usage() { sed -n '2,48p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# --- hydrate / unshallow / status: act on the checkout we are standing in -----

cmd_status() {
  node "$ROOT/tools/verify_card_profile.mjs" --status
  echo
  node "$ROOT/tools/card_profile_router.mjs" --identity --json
  local recorded computed
  recorded="$(recorded_manifest_digest)"
  if [[ -n "$recorded" ]]; then
    computed="$(node "$ROOT/tools/card_profile_router.mjs" --identity)"
    if [[ "$recorded" == "$computed" ]]; then
      echo "recorded profile identity matches this revision's inputs"
    else
      echo "STALE: this checkout was provisioned from manifest digest $recorded but this revision computes $computed" >&2
      echo "  routing will select the full-checkout control until it is reprovisioned" >&2
    fi
  fi
}

# The digest a checkout was provisioned under, recorded outside the working tree
# so it survives a sparse-checkout change and is never mistaken for tracked
# content. Absent in a checkout this tool did not provision.
recorded_manifest_digest() {
  local file
  file="$(git -C "$ROOT" rev-parse --absolute-git-dir)/card-profile-identity.json"
  [[ -f "$file" ]] || return 0
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifest_digest"])' "$file"
}

cmd_decide() {
  local args=(--decide)
  local surface="focused-card-work"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --surface) surface="$2"; shift 2 ;;
      *) args+=("$1"); shift ;;
    esac
  done
  local recorded
  recorded="$(recorded_manifest_digest)"
  if [[ -n "$recorded" ]]; then args+=(--recorded-digest "$recorded"); fi
  node "$ROOT/tools/card_profile_router.mjs" "${args[@]}" --surface "$surface"
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
  local dest="" profile="" rev="" source="" store="" depth="" install=1
  local timing_out="" label="" receipt_out="" surface="focused-card-work"
  local history_flag="" gates=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dest) dest="$2"; shift 2 ;;
      --profile) profile="$2"; shift 2 ;;
      --surface) surface="$2"; shift 2 ;;
      --gate) gates+=(--gate "$2"); shift 2 ;;
      --require-complete-history) history_flag="--require-complete-history"; shift ;;
      --rev) rev="$2"; shift 2 ;;
      --source) source="$2"; shift 2 ;;
      --store) store="$2"; shift 2 ;;
      --depth) depth="$2"; shift 2 ;;
      --no-install) install=0; shift ;;
      --timing-out) timing_out="$2"; shift 2 ;;
      --label) label="$2"; shift 2 ;;
      --receipt-out) receipt_out="$2"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  [[ -n "$dest" ]] || die "--dest is required"
  [[ -e "$dest" ]] && die "destination already exists: $dest"

  # Route first. The decision is taken in the source checkout, because the
  # destination does not exist yet, and it is written into the receipt whether
  # it was followed or overridden.
  local decision_file
  decision_file="$(mktemp -t card-profile-decision)"
  node "$ROOT/tools/card_profile_router.mjs" --decide --surface "$surface" \
    ${gates[@]+"${gates[@]}"} ${history_flag:+$history_flag} --json > "$decision_file" \
    || { rm -f "$decision_file"; die "provisioning request failed closed; nothing was created"; }
  local routed
  routed="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["profile"])' "$decision_file")"

  # --profile is an override, not the normal path. "card" is accepted as the
  # name CI-09 provisioned under so its measurement harness keeps working.
  local requested="$profile"
  case "$profile" in
    "") profile="$routed" ;;
    card|card-work) profile="focused-reduced" ;;
    focused-reduced|full) ;;
    *) rm -f "$decision_file"; die "--profile must be focused-reduced or full" ;;
  esac
  [[ -z "$requested" ]] && echo "routed $surface to the $profile profile (${routed})"
  local override_note=""
  if [[ -n "$requested" && "$profile" != "$routed" ]]; then
    override_note="explicitly requested $profile; the router would have selected $routed for surface $surface"
    echo "note: $override_note" >&2
  fi

  # The rest of this function speaks CI-09's internal vocabulary.
  local mode="full"
  [[ "$profile" == "focused-reduced" ]] && mode="card"

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
  if [[ "$mode" == "card" && "$source_class" == "remote" ]]; then
    filter_args=(--filter=blob:none)
    partial="true"
  fi
  local depth_args=()
  if [[ -n "$depth" ]]; then
    [[ "$mode" == "card" ]] || die "--depth applies to the focused-reduced profile only"
    depth_args=(--depth "$depth")
  fi

  local load_before
  load_before="$(uptime | sed -E 's/.*load averages?: //' | awk '{print $1}')"

  local start prepare_ms sparse_ms checkout_ms install_ms
  start="$(now_ms)"
  git clone --no-checkout ${filter_args[@]+"${filter_args[@]}"} ${depth_args[@]+"${depth_args[@]}"} "$source" "$dest" >/dev/null 2>&1
  prepare_ms=$(( $(now_ms) - start ))

  sparse_ms=0
  if [[ "$mode" == "card" ]]; then
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
  if [[ "$mode" == "card" ]]; then
    echo "  tracked paths not materialised: $(git -C "$dest" ls-files -t | grep -c '^S ' || true)"
  fi

  if [[ -n "$timing_out" ]]; then
    PROV_OUT="$timing_out" PROV_LABEL="$label" PROV_PROFILE="$mode" \
    PROV_SOURCE="$source_class" PROV_REV="$rev" PROV_PARTIAL="$partial" \
    PROV_DEPTH="${depth:-}" PROV_PREPARE="$prepare_ms" PROV_SPARSE="$sparse_ms" \
    PROV_CHECKOUT="$checkout_ms" PROV_INSTALL="$install_ms" \
    PROV_LOAD_BEFORE="$load_before" PROV_LOAD_AFTER="$load_after" \
    PROV_ROUTED="$profile" PROV_SURFACE="$surface" \
    PROV_RULE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rule"])' "$decision_file")" \
    python3 - <<'PYEOF'
import json, os


def optional_ms(name):
    raw = os.environ.get(name, "")
    return int(raw) if raw else None


record = {
    "schema": "cityscroll.card-profile-provisioning.v1",
    "label": os.environ["PROV_LABEL"],
    # The CI-09 vocabulary this file has always used, so its summarizer keeps
    # reading the same records. The routed names are additive.
    "profile": os.environ["PROV_PROFILE"],
    "routed_profile": os.environ.get("PROV_ROUTED"),
    "work_surface": os.environ.get("PROV_SURFACE"),
    "routing_rule": os.environ.get("PROV_RULE"),
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

  # Bind the checkout to the profile it was provisioned under. This lives in the
  # Git directory rather than the working tree, so it survives a sparse-checkout
  # change and can never be mistaken for tracked content. A later routing
  # request compares it against the computed digest, which is how a profile that
  # has drifted from its revision is caught instead of trusted.
  local dest_identity
  dest_identity="$(git -C "$dest" rev-parse --absolute-git-dir)/card-profile-identity.json"
  ( cd "$dest" && node tools/card_profile_router.mjs --identity --json ) > "$dest_identity"
  PROV_DECISION="$decision_file" PROV_IDENT="$dest_identity" PROV_ROUTED="$profile" \
  PROV_OVERRIDE="$override_note" PROV_SURFACE="$surface" python3 - <<'PYEOF'
import json, os

path = os.environ["PROV_IDENT"]
with open(path, encoding="utf-8") as handle:
    identity = json.load(handle)
with open(os.environ["PROV_DECISION"], encoding="utf-8") as handle:
    decision = json.load(handle)
identity["provisioned_profile"] = os.environ["PROV_ROUTED"]
identity["work_surface"] = os.environ["PROV_SURFACE"]
identity["routing_rule"] = decision["rule"]
identity["routing_reason"] = decision["reason"]
identity["profile_override"] = os.environ["PROV_OVERRIDE"] or None
with open(path, "w", encoding="utf-8") as handle:
    json.dump(identity, handle, indent=2, sort_keys=True)
    handle.write("\n")
PYEOF

  if [[ -n "$receipt_out" ]]; then
    local receipt_abs
    receipt_abs="$(cd "$(dirname "$receipt_out")" && pwd -P)/$(basename "$receipt_out")"
    ( cd "$dest" && node tools/card_profile_receipt.mjs --decision "$decision_file" \
        ${override_note:+--fallback-reason "$override_note"} --out "$receipt_abs" )
  fi
  rm -f "$decision_file"
}

case "${1:-}" in
  provision) shift; cmd_provision "$@" ;;
  decide) shift; cmd_decide "$@" ;;
  hydrate) shift; cmd_hydrate "$@" ;;
  unshallow) shift; cmd_unshallow ;;
  status) shift; cmd_status ;;
  -h|--help|"") usage ;;
  *) die "unknown command: $1" ;;
esac
