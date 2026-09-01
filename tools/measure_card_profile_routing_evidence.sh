#!/usr/bin/env bash
# Produce the CI-10 raw receipt set: the routing decisions, the provisioning
# receipts, the reproduced byte accounting and the fail-closed probes.
#
# CI-09 measured what the reduced profile costs. This measures what the routing
# contract on top of it does: that focused card work is routed to the reduced
# profile without being asked, that every other work surface takes the control,
# that a request the router cannot classify fails closed, and that the receipt a
# caller gets back reproduces.
#
# It provisions throwaway checkouts under a caller-supplied scratch directory
# and never writes into the repository it runs from. Every record carries the
# profile class and durations only: never a scratch path, user name or host name.
#
# Usage:
#   tools/measure_card_profile_routing_evidence.sh --scratch <dir> --out <raw-dir>
#       [--rev <sha>] [--source <url>] [--trials 3] [--keep]
#
# The revision must be published to the source, because the reduced profile is
# provisioned by cloning it and the blob filter only applies to a real remote.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRATCH=""; OUT=""; REV=""; SOURCE=""; TRIALS=3; KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scratch) SCRATCH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --rev) REV="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --trials) TRIALS="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$SCRATCH" ]] || { echo "--scratch is required" >&2; exit 2; }
[[ -n "$OUT" ]] || { echo "--out is required" >&2; exit 2; }
REV="${REV:-$(git -C "$ROOT" rev-parse HEAD)}"
SOURCE="${SOURCE:-$(git -C "$ROOT" remote get-url origin)}"

mkdir -p "$SCRATCH" "$OUT"
# Both are absolutised before anything runs, because several steps execute from
# inside a provisioned checkout and a relative output path would resolve there.
SCRATCH="$(cd "$SCRATCH" && pwd -P)"
OUT="$(cd "$OUT" && pwd -P)"
free_kib() { df -k "$SCRATCH" | awk 'NR==2{print $4}'; }
heartbeat() { echo "[$(date -u +%H:%M:%S)] $*"; }

: > "$OUT/routing-decisions.jsonl"
: > "$OUT/provisioning-timings.jsonl"
: > "$OUT/charged-disk.jsonl"
: > "$OUT/fail-closed-probes.jsonl"

# --- 1. the decision table, taken from the router itself ---------------------

heartbeat "recording routing decisions"
REV="$REV" OUT="$OUT" ROOT="$ROOT" python3 - <<'PYEOF'
import json, os, subprocess

root, out = os.environ["ROOT"], os.environ["OUT"]
manifest = json.load(open(os.path.join(root, "tools/card-profile/profiles.v1.json"), encoding="utf-8"))
closure = json.load(open(os.path.join(root, "tools/card-profile/closure.v1.json"), encoding="utf-8"))


def decide(args, label):
    process = subprocess.run(
        ["node", "tools/card_profile_router.mjs", "--decide", *args, "--json"],
        cwd=root, capture_output=True, text=True,
    )
    record = {"probe": label, "argv": args, "exit_status": process.returncode}
    if process.stdout.strip():
        decision = json.loads(process.stdout)
        record.update(
            {
                "surface": decision["request"]["surface"],
                "gate_classes": decision["request"]["gate_classes"],
                "profile": decision["profile"],
                "rule": decision["rule"],
                "rule_order": decision["rule_order"],
                "reason": decision["reason"],
            }
        )
    return record


records = [decide(["--surface", surface["id"]], f"surface:{surface['id']}") for surface in manifest["surfaces"]]
records += [
    decide(["--surface", "focused-card-work", "--gate", gate], f"supported-gate:{gate}")
    for gate in closure["supported_gate_classes"]
]
records += [
    decide(["--surface", "focused-card-work", "--gate", entry["id"]], f"full-only-gate:{entry['id']}")
    for entry in closure["full_checkout_only"]
]
records += [
    decide(["--surface", "focused-card-work", "--require-complete-history"], "declared-complete-history"),
    decide(
        ["--surface", "focused-card-work", "--path", closure["deferred_hydration_set"]["paths"][0]],
        "deferred-path-requested",
    ),
    decide(
        ["--surface", "focused-card-work", "--path", closure["site_data"]["profile_paths"][0]],
        "in-closure-path-requested",
    ),
    decide(["--surface", "focused-card-work", "--recorded-digest", "0" * 64], "stale-recorded-digest"),
    decide(["--surface", "an-undeclared-work-surface"], "undeclared-surface"),
    decide(["--surface", "focused-card-work", "--gate", "an-undeclared-gate-class"], "undeclared-gate-class"),
]

with open(os.path.join(out, "routing-decisions.jsonl"), "w", encoding="utf-8") as handle:
    for record in records:
        handle.write(json.dumps(record, sort_keys=True) + "\n")
print(f"  {len(records)} routing decisions recorded")
PYEOF

# --- 2. provisioning trials, routed rather than flagged ----------------------

provision() {
  local variant="$1" trial="$2" dest="$3" args=()
  case "$variant" in
    routed-focused) args=(--surface focused-card-work) ;;
    routed-ci)      args=(--surface ci) ;;
  esac
  local before after
  before="$(free_kib)"
  "$ROOT/tools/provision_card_profile.sh" provision --dest "$dest" --rev "$REV" --source "$SOURCE" \
    "${args[@]}" --timing-out "$OUT/provisioning-timings.jsonl" --label "$variant" >/dev/null
  after="$(free_kib)"
  VARIANT="$variant" TRIAL="$trial" BEFORE="$before" AFTER="$after" OUT="$OUT" python3 - <<'PYEOF'
import json, os
record = {
    "schema": "cityscroll.card-profile-charged-disk.v1",
    "variant": os.environ["VARIANT"],
    "trial": int(os.environ["TRIAL"]),
    "charged_bytes": (int(os.environ["BEFORE"]) - int(os.environ["AFTER"])) * 1024,
    "method": "free-space delta across one provisioning run on the scratch volume",
}
with open(os.path.join(os.environ["OUT"], "charged-disk.jsonl"), "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True) + "\n")
PYEOF
}

for variant in routed-focused routed-ci; do
  for trial in $(seq 1 "$TRIALS"); do
    heartbeat "provisioning $variant trial $trial of $TRIALS"
    dest="$SCRATCH/$variant-$trial"
    provision "$variant" "$trial" "$dest"
    if [[ "$trial" == "1" ]]; then
      # The first trial of each variant is kept long enough to take its
      # footprint, its provisioning receipt and, for the reduced profile, the
      # fail-closed probes.
      python3 "$ROOT/tools/measure_working_copy_footprint.py" "$dest" --label "$variant" \
        > "$OUT/footprint-$variant.json"
      ( cd "$dest" && node tools/card_profile_receipt.mjs \
          --footprint "$OUT/footprint-$variant.json" --out "$OUT/receipt-$variant.json" ) >/dev/null
      # Reproduction is the point of a deterministic receipt, so it is checked
      # here rather than asserted in prose.
      ( cd "$dest" && node tools/card_profile_receipt.mjs --check "$OUT/receipt-$variant.json" ) \
        > "$OUT/receipt-$variant.reproduction.txt"
      cp "$(git -C "$dest" rev-parse --absolute-git-dir)/card-profile-identity.json" \
        "$OUT/recorded-identity-$variant.json"
      [[ "$variant" == "routed-focused" ]] && FOCUSED_DEST="$dest"
      [[ "$variant" == "routed-ci" ]] && CONTROL_DEST="$dest"
    else
      [[ "$KEEP" == "1" ]] || rm -rf "$dest"
    fi
  done
done

python3 "$ROOT/tools/measure_working_copy_footprint.py" \
  "$(cd "$ROOT/worker" && corepack pnpm store path --silent)" --store-only --label shared-dependency-store \
  > "$OUT/footprint-shared-store.json"

# --- 3. fail-closed probes in the provisioned reduced checkout ---------------

# Every probe declares what it expects. A probe that merely records an exit
# status is a log, not a check: the first version of the missing-blob probes
# recorded exit 0 under descriptions asserting failure, and nothing noticed.
PROBE_FAILURES=0
probe() {
  local id="$1" dir="$2" expect="$3" description="$4"; shift 4
  local status=0
  ( cd "$dir" && "$@" ) >/dev/null 2>&1 || status=$?
  local met="yes"
  case "$expect" in
    zero) [[ "$status" -eq 0 ]] || met="no" ;;
    non-zero) [[ "$status" -ne 0 ]] || met="no" ;;
    *) [[ "$status" -eq "$expect" ]] || met="no" ;;
  esac
  if [[ "$met" == "no" ]]; then
    echo "PROBE EXPECTATION NOT MET: $id expected $expect, got $status" >&2
    PROBE_FAILURES=$((PROBE_FAILURES + 1))
  fi
  PROBE_ID="$id" PROBE_STATUS="$status" PROBE_DESC="$description" OUT="$OUT" \
  PROBE_EXPECT="$expect" PROBE_MET="$met" PROBE_CMD="$*" python3 - <<'PYEOF'
import json, os
record = {
    "id": os.environ["PROBE_ID"],
    "exit_status": int(os.environ["PROBE_STATUS"]),
    "expected": os.environ["PROBE_EXPECT"],
    "expectation_met": os.environ["PROBE_MET"] == "yes",
    "command": os.environ["PROBE_CMD"],
    "description": os.environ["PROBE_DESC"],
}
with open(os.path.join(os.environ["OUT"], "fail-closed-probes.jsonl"), "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True) + "\n")
PYEOF
}

heartbeat "running fail-closed probes in the provisioned reduced checkout"
DEFERRED="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["deferred_hydration_set"]["paths"][0])' "$ROOT/tools/card-profile/closure.v1.json")"

probe routed-status "$FOCUSED_DEST" zero \
  "The provisioned checkout reports itself as the reduced profile and its recorded identity matches this revision's inputs." \
  tools/provision_card_profile.sh status
probe undeclared-surface-fails-closed "$FOCUSED_DEST" 2 \
  "A work surface the manifest does not declare is refused before anything is provisioned, rather than defaulting to the reduced profile." \
  node tools/card_profile_router.mjs --decide --surface an-undeclared-work-surface
probe undeclared-gate-fails-closed "$FOCUSED_DEST" 2 \
  "A gate class classified neither way is refused, because nothing is known about what it reads." \
  node tools/card_profile_router.mjs --decide --surface focused-card-work --gate an-undeclared-gate-class
probe full-only-surface-takes-control "$FOCUSED_DEST" 5 \
  "A full-checkout-only surface selects the control explicitly; exit 5 records that the reduced profile was required and refused." \
  node tools/card_profile_router.mjs --decide --surface deployment --require focused-reduced
probe stale-profile-takes-control "$FOCUSED_DEST" 5 \
  "A recorded manifest digest that does not match this revision's inputs routes to the control instead of trusting the closure." \
  node tools/card_profile_router.mjs --decide --surface focused-card-work --recorded-digest 0000000000000000000000000000000000000000000000000000000000000000 --require focused-reduced
probe deferred-path-takes-control "$FOCUSED_DEST" 5 \
  "Work naming a path the profile defers routes to the control rather than being handed a checkout that lacks it." \
  node tools/card_profile_router.mjs --decide --surface focused-card-work --path "$DEFERRED" --require focused-reduced
probe missing-path-named "$FOCUSED_DEST" non-zero \
  "A direct read of a deferred tracked path raises the named profile failure carrying the hydrate command, not a bare missing file." \
  node --require ./tools/card_profile_sentinel.cjs -e "require('node:fs').readFileSync('$DEFERRED','utf8')"
probe swallowed-miss-bare "$FOCUSED_DEST" zero \
  "A check that swallows the missing input and asserts nothing exits 0 on its own. This is the pass-by-omission the contract has to prevent." \
  node test/fixtures/card-profile/swallowed-missing-input.mjs
probe swallowed-miss-gated "$FOCUSED_DEST" 4 \
  "The same check through the gate front door fails, because the sentinel recorded a missing tracked path whatever the check returned." \
  node tools/verify_card_profile.mjs --gate worker-unit -- node test/fixtures/card-profile/swallowed-missing-input.mjs
probe gate-refused-evidence-placement "$FOCUSED_DEST" 3 \
  "A full-checkout-only gate class is refused by the front door before it runs, carrying the routing rule that refused it." \
  node tools/verify_card_profile.mjs --gate evidence-placement
probe gate-refused-cutover-receipt "$FOCUSED_DEST" 3 \
  "The control-plane cutover receipt is refused too. CI-09 declared it profile-supported on a recorded read set; it asserts that retained evidence projections resolve with an existence check, which that recording could not see, so this card reclassified it." \
  node tools/verify_card_profile.mjs --gate cutover-receipt
probe merge-base-resolves "$FOCUSED_DEST" zero \
  "The routed reduced profile keeps complete commit history, so a guard that resolves a merge base against the default branch still works in it." \
  git merge-base HEAD origin/main

# The distinct failure mode a partial clone introduces: the path is named in the
# tree, but its bytes live behind the promisor remote. GIT_NO_LAZY_FETCH is what
# makes the first probe meaningful — without it, asking whether the object is
# present is itself a request to go and fetch it.
heartbeat "forcing the missing-blob case"
MISSING_BLOB_DEST="$SCRATCH/missing-blob"
rm -rf "$MISSING_BLOB_DEST"
"$ROOT/tools/provision_card_profile.sh" provision --dest "$MISSING_BLOB_DEST" --rev "$REV" \
  --source "$SOURCE" --surface focused-card-work --no-install >/dev/null
DEFERRED_BLOB="$(git -C "$MISSING_BLOB_DEST" rev-parse "HEAD:$DEFERRED")"
probe missing-blob-absent-locally "$MISSING_BLOB_DEST" non-zero \
  "With lazy fetching disabled, the blob behind a deferred path is genuinely absent from the local object store, so the reduction is real rather than a working-tree trick." \
  env GIT_NO_LAZY_FETCH=1 git cat-file -e "$DEFERRED_BLOB"
git -C "$MISSING_BLOB_DEST" remote set-url origin "file:///nonexistent-promisor-remote-for-this-probe"
probe missing-blob-unreachable-promisor "$MISSING_BLOB_DEST" non-zero \
  "With the promisor remote unreachable, reading a deferred blob fails loudly instead of yielding an empty or truncated object." \
  git cat-file blob "$DEFERRED_BLOB"
probe missing-blob-hydration-refused "$MISSING_BLOB_DEST" non-zero \
  "The documented hydrate route fails the same way rather than reporting success over an object it could not fetch." \
  tools/provision_card_profile.sh hydrate "$DEFERRED"
probe missing-blob-path-still-absent "$MISSING_BLOB_DEST" non-zero \
  "After the refused hydration the path is still absent, so a failed fetch never leaves a partial input behind that a later check could read as present." \
  test -f "$DEFERRED"
git -C "$MISSING_BLOB_DEST" remote set-url origin "$SOURCE"
probe missing-blob-hydration-succeeds-when-reachable "$MISSING_BLOB_DEST" zero \
  "With the promisor remote restored the same hydration succeeds, so the failure above was the unreachable remote and not a broken profile." \
  tools/provision_card_profile.sh hydrate "$DEFERRED"
probe missing-blob-present-after-hydration "$MISSING_BLOB_DEST" zero \
  "And the path is present afterwards, which is what makes the deferred set one documented command away rather than lost." \
  test -f "$DEFERRED"

# --- 4. object integrity and history in both provisioned profiles ------------

heartbeat "recording object integrity"
FOCUSED="$FOCUSED_DEST" CONTROL="$CONTROL_DEST" OUT="$OUT" python3 - <<'PYEOF'
import json, os, subprocess


def probe(directory):
    def git(*args):
        return subprocess.run(["git", "-C", directory, *args], capture_output=True, text=True)

    counts = dict(
        line.split(": ", 1) for line in git("count-objects", "-v").stdout.strip().splitlines() if ": " in line
    )
    return {
        "commits_reachable_from_head": int(git("rev-list", "--count", "HEAD").stdout.strip()),
        "shallow_repository": git("rev-parse", "--is-shallow-repository").stdout.strip() == "true",
        "promisor_remote": git("config", "--get", "remote.origin.promisor").stdout.strip() == "true",
        "partial_clone_filter": git("config", "--get", "remote.origin.partialclonefilter").stdout.strip() or None,
        "packs": int(counts.get("packs", -1)),
        "pack_size_kib": int(counts.get("size-pack", -1)),
        "loose_objects": int(counts.get("count", -1)),
        "tracked_paths_not_materialised": sum(
            1 for line in git("ls-files", "-t").stdout.splitlines() if line.startswith("S ")
        ),
        "working_tree_clean": git("status", "--porcelain").stdout.strip() == "",
        "fsck_connectivity_only_exit": git("fsck", "--connectivity-only").returncode,
        "merge_base_against_default_branch_exit": git("merge-base", "HEAD", "origin/main").returncode,
    }


record = {
    "schema": "cityscroll.card-profile-routing-integrity.v1",
    "note": "--connectivity-only is the meaningful integrity check in a partial clone: it verifies the object graph without demanding blobs the profile deliberately did not fetch.",
    "routed-focused": probe(os.environ["FOCUSED"]),
    "routed-ci": probe(os.environ["CONTROL"]),
}
with open(os.path.join(os.environ["OUT"], "object-integrity.json"), "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2, sort_keys=True)
    handle.write("\n")
PYEOF

# --- 5. supported gate classes, run in both provisioned profiles -------------

# A gate class the manifest declares profile-supported has to actually pass in a
# provisioned reduced checkout. Recording the exit status without asserting it is
# how a misclassification survives: cutover-receipt was declared supported on a
# recorded read set that could not see its existence checks, and only running it
# in the real profile exposed that.
GATE_FAILURES=0
run_gate() {
  local gate="$1" dir="$2" variant="$3"; shift 3
  local status=0
  ( cd "$dir" && node tools/verify_card_profile.mjs --gate "$gate" -- "$@" ) >/dev/null 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "GATE CLASS FAILED: $gate in $variant (exit $status)" >&2
    GATE_FAILURES=$((GATE_FAILURES + 1))
  fi
  GATE="$gate" VARIANT="$variant" STATUS="$status" OUT="$OUT" python3 - <<'PYEOF'
import json, os
record = {"gate_class": os.environ["GATE"], "variant": os.environ["VARIANT"], "exit_status": int(os.environ["STATUS"])}
with open(os.path.join(os.environ["OUT"], "gate-probes.jsonl"), "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True) + "\n")
PYEOF
}

heartbeat "running every profile-supported gate class in both provisioned profiles"
: > "$OUT/gate-probes.jsonl"
for pair in "routed-focused:$FOCUSED_DEST" "routed-ci:$CONTROL_DEST"; do
  variant="${pair%%:*}"; dir="${pair#*:}"
  reconcile_out="$(mktemp -d "${TMPDIR:-/tmp}/cityscroll-architecture-evidence.XXXXXX")"
  run_gate card-profile-contract "$dir" "$variant" node tools/verify_card_profile.mjs --check
  run_gate architecture-evidence-shards "$dir" "$variant" node tools/architecture_evidence_shards.mjs --check
  run_gate architecture-reconcile "$dir" "$variant" node tools/reconcile_architecture.mjs --check --output-dir "$reconcile_out"
  run_gate architecture-canaries "$dir" "$variant" node tools/backtest_architecture_canaries.mjs --check
  run_gate card-reconciliation "$dir" "$variant" node tools/card_reconciliation_guard.mjs
  run_gate agents-router "$dir" "$variant" node tools/agents_router_guard.mjs --check
  run_gate worker-unit "$dir" "$variant" bash -c 'cd worker && node --test'
  rm -rf "$reconcile_out"
done

if [[ "$KEEP" != "1" ]]; then
  rm -rf "$FOCUSED_DEST" "$CONTROL_DEST" "$MISSING_BLOB_DEST"
fi

if [[ "$PROBE_FAILURES" -ne 0 || "$GATE_FAILURES" -ne 0 ]]; then
  echo "evidence run failed: $PROBE_FAILURES probe expectation(s) unmet, $GATE_FAILURES gate class failure(s)" >&2
  exit 1
fi
heartbeat "done; receipts are in $OUT"
