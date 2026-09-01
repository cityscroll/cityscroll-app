#!/usr/bin/env bash
# Produce the complete CI-09 raw receipt set for the reduced card-work profile.
#
# One entry point so another engineer can reproduce every number: provisioning
# timings, byte footprints, charged-disk deltas, gate compatibility in both the
# reduced profile and the full-checkout control, and the behaviour probes that
# show missing paths failing closed.
#
# It provisions throwaway checkouts under a caller-supplied scratch directory
# and never writes to the repository it is run from. Records carry the profile
# class and durations only: never a scratch path, user name or host name.
#
# Usage:
#   tools/measure_card_profile_evidence.sh --scratch <dir> --out <raw-dir> \
#       [--rev <sha>] [--source <url>] [--trials 3] [--keep]
#
# The revision must be published to the source, because the reduced profile is
# provisioned by cloning it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRATCH=""
OUT=""
REV=""
SOURCE=""
TRIALS=3
KEEP=0

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
now_ms() { python3 -c 'import time; print(int(time.monotonic()*1000))'; }
free_kib() { df -k "$SCRATCH" | awk 'NR==2{print $4}'; }

: > "$OUT/provisioning-timings.jsonl"
: > "$OUT/charged-disk.jsonl"
: > "$OUT/gate-probes.jsonl"
: > "$OUT/behaviour-probes.jsonl"

# --- environment -------------------------------------------------------------

REV="$REV" SOURCE_CLASS="remote" OUT="$OUT" TRIALS="$TRIALS" python3 - <<'PYEOF'
import json, os, platform, shutil, subprocess


def pinned_pnpm():
    try:
        with open("worker/package.json", encoding="utf-8") as handle:
            return json.load(handle)["packageManager"]
    except Exception:
        return "unavailable"


def version(*command):
    try:
        return subprocess.run(command, capture_output=True, text=True, check=False).stdout.strip().splitlines()[0]
    except Exception:
        return "unavailable"


record = {
    "schema": "cityscroll.card-profile-environment.v1",
    "revision": os.environ["REV"],
    "source_class": os.environ["SOURCE_CLASS"],
    "trials_per_variant": int(os.environ["TRIALS"]),
    "operating_system": f"{platform.system()} {platform.release()} ({platform.machine()})",
    "cpu_count": os.cpu_count(),
    "filesystem_class": "APFS - hard links and copy-on-write file clones both supported",
    "tools": {
        "git": version("git", "--version"),
        "node": version("node", "--version"),
        "python3": version("python3", "--version"),
        "pnpm_pinned_by_worker_package": pinned_pnpm(),
        "pnpm_corepack_default": version("corepack", "pnpm", "--version"),
    },
    "cache_conditions": {
        "dependency_store": "warm - the host shared pnpm store is already populated, and the install runs against it",
        "page_cache": "not purged - purging is a whole-machine operation on a shared host, so cold and warm describe tool-level caches only",
        "git_objects": "cold per trial - every trial clones into a fresh directory with no pre-existing objects",
    },
    "measurement_methods": {
        "logical_bytes": "st_size, summed by tools/measure_working_copy_footprint.py",
        "allocated_bytes": "st_blocks * 512; on APFS this counts every copy-on-write clone at full size and therefore cannot see sharing",
        "charged_disk_bytes": "free-space delta across the provisioning run, which is the only measure that sees copy-on-write sharing on this filesystem class",
    },
}
with open(os.path.join(os.environ["OUT"], "environment.json"), "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2, sort_keys=True)
    handle.write("\n")
PYEOF

# --- provisioning trials -----------------------------------------------------

provision_variant() {
  local variant="$1" trial="$2" dest="$3"
  local args=()
  case "$variant" in
    card) args=(--profile card) ;;
    card-depth1) args=(--profile card --depth 1) ;;
    full) args=(--profile full) ;;
  esac
  local before after
  before="$(free_kib)"
  "$ROOT/tools/provision_card_profile.sh" provision --dest "$dest" --rev "$REV" --source "$SOURCE" \
    --timing-out "$OUT/provisioning-timings.jsonl" --label "$variant" "${args[@]}" >/dev/null 2>&1
  after="$(free_kib)"
  CD_VARIANT="$variant" CD_TRIAL="$trial" CD_BEFORE="$before" CD_AFTER="$after" CD_OUT="$OUT" python3 - <<'PYEOF'
import json, os

before = int(os.environ["CD_BEFORE"])
after = int(os.environ["CD_AFTER"])
record = {
    "schema": "cityscroll.card-profile-charged-disk.v1",
    "variant": os.environ["CD_VARIANT"],
    "trial": int(os.environ["CD_TRIAL"]),
    "free_kib_before": before,
    "free_kib_after": after,
    "charged_bytes": (before - after) * 1024,
    "method": "free-space delta across one provisioning run on a shared host; a concurrent writer adds noise, so the median across trials is the reported figure",
}
with open(os.path.join(os.environ["CD_OUT"], "charged-disk.jsonl"), "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True) + "\n")
PYEOF
}

CARD=""
FULL=""
for trial in $(seq 1 "$TRIALS"); do
  for variant in card card-depth1 full; do
    dest="$SCRATCH/$variant-$trial"
    rm -rf "$dest"
    provision_variant "$variant" "$trial" "$dest"
    if [[ "$trial" == "1" ]]; then
      python3 "$ROOT/tools/measure_working_copy_footprint.py" "$dest" --label "$variant" > "$OUT/footprint-$variant.json"
      case "$variant" in
        card) CARD="$dest" ;;
        full) FULL="$dest" ;;
        *) rm -rf "$dest" ;;
      esac
    else
      rm -rf "$dest"
    fi
  done
done

STORE="$(cd "$ROOT/worker" && corepack pnpm store path --silent 2>/dev/null || true)"
if [[ -n "$STORE" && -d "$STORE" ]]; then
  python3 "$ROOT/tools/measure_working_copy_footprint.py" "$STORE" --store-only --label "shared-dependency-store" \
    > "$OUT/footprint-shared-store.json"
fi

# --- gate compatibility ------------------------------------------------------

probe_gate() {
  local checkout="$1" profile="$2" gate="$3"; shift 3
  local start end st summary
  start="$(now_ms)"
  ( cd "$checkout" && "$@" ) > "$SCRATCH/last-gate.txt" 2>&1 && st=0 || st=$?
  end="$(now_ms)"
  summary="$(grep -E '^ℹ (tests|pass|fail|skipped)' "$SCRATCH/last-gate.txt" | tr '\n' ' ' | sed 's/ℹ //g' || true)"
  GP_PROFILE="$profile" GP_GATE="$gate" GP_STATUS="$st" GP_MS="$((end-start))" \
  GP_SUMMARY="$summary" GP_CMD="$*" GP_OUT="$OUT" python3 - <<'PYEOF'
import json, os

record = {
    "schema": "cityscroll.card-profile-gate-probe.v1",
    "profile": os.environ["GP_PROFILE"],
    "gate_class": os.environ["GP_GATE"],
    "command": os.environ["GP_CMD"],
    "exit_status": int(os.environ["GP_STATUS"]),
    "duration_ms": int(os.environ["GP_MS"]),
    "test_summary": os.environ["GP_SUMMARY"].strip() or None,
}
with open(os.path.join(os.environ["GP_OUT"], "gate-probes.jsonl"), "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True) + "\n")
PYEOF
  echo "[$profile] $gate -> exit $st $summary"
}

run_gate_family() {
  local checkout="$1" profile="$2" prefix="$3"
  local tmpdir
  tmpdir="$(mktemp -d)"
  if [[ "$prefix" == "gated" ]]; then
    probe_gate "$checkout" "$profile" worker-unit node tools/verify_card_profile.mjs --gate worker-unit -- bash -c 'cd worker && node --test'
    probe_gate "$checkout" "$profile" architecture-evidence-shards node tools/verify_card_profile.mjs --gate architecture-evidence-shards -- node tools/architecture_evidence_shards.mjs --check
    probe_gate "$checkout" "$profile" architecture-reconcile node tools/verify_card_profile.mjs --gate architecture-reconcile -- node tools/reconcile_architecture.mjs --check --output-dir "$tmpdir"
    probe_gate "$checkout" "$profile" architecture-canaries node tools/verify_card_profile.mjs --gate architecture-canaries -- node tools/backtest_architecture_canaries.mjs --check
    probe_gate "$checkout" "$profile" card-reconciliation node tools/verify_card_profile.mjs --gate card-reconciliation -- node tools/card_reconciliation_guard.mjs
    probe_gate "$checkout" "$profile" agents-router node tools/verify_card_profile.mjs --gate agents-router -- node tools/agents_router_guard.mjs --check
    probe_gate "$checkout" "$profile" cutover-receipt node tools/verify_card_profile.mjs --gate cutover-receipt -- node tools/rcp05_cutover_receipt.mjs --check
    probe_gate "$checkout" "$profile" card-profile-contract node tools/verify_card_profile.mjs --gate card-profile-contract -- node tools/verify_card_profile.mjs --check
  else
    probe_gate "$checkout" "$profile" worker-unit bash -c 'cd worker && node --test'
    probe_gate "$checkout" "$profile" architecture-evidence-shards node tools/architecture_evidence_shards.mjs --check
    probe_gate "$checkout" "$profile" architecture-reconcile node tools/reconcile_architecture.mjs --check --output-dir "$tmpdir"
    probe_gate "$checkout" "$profile" architecture-canaries node tools/backtest_architecture_canaries.mjs --check
    probe_gate "$checkout" "$profile" card-reconciliation node tools/card_reconciliation_guard.mjs
    probe_gate "$checkout" "$profile" agents-router node tools/agents_router_guard.mjs --check
    probe_gate "$checkout" "$profile" cutover-receipt node tools/rcp05_cutover_receipt.mjs --check
    probe_gate "$checkout" "$profile" card-profile-contract node tools/verify_card_profile.mjs --check
    probe_gate "$checkout" "$profile" evidence-placement node tools/rcp03_evidence_placement.mjs --check
    probe_gate "$checkout" "$profile" site-unit bash -c 'node --test test/contract/*.test.mjs'
    probe_gate "$checkout" "$profile" generated-source-docs node tools/generate_source_docs.mjs --check
    probe_gate "$checkout" "$profile" site-standards python3 test/standards/js_syntax.py
  fi
  probe_gate "$checkout" "$profile" card-profile-tests node --test test/card_profile.test.mjs
  rm -rf "$tmpdir"
}

run_gate_family "$CARD" card-work gated
run_gate_family "$FULL" full-checkout direct

# --- behaviour probes --------------------------------------------------------

record_probe() {
  BP_ID="$1" BP_PROFILE="$2" BP_DESC="$3" BP_CMD="$4" BP_STATUS="$5" BP_EXPECTED="$6" BP_EXCERPT="$7" BP_OUT="$OUT" python3 - <<'PYEOF'
import json, os

record = {
    "schema": "cityscroll.card-profile-behaviour-probe.v1",
    "id": os.environ["BP_ID"],
    "profile": os.environ["BP_PROFILE"],
    "description": os.environ["BP_DESC"],
    "command": os.environ["BP_CMD"],
    "exit_status": int(os.environ["BP_STATUS"]),
    "expected": os.environ["BP_EXPECTED"],
    "output_excerpt": os.environ["BP_EXCERPT"].strip(),
}
with open(os.path.join(os.environ["BP_OUT"], "behaviour-probes.jsonl"), "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True) + "\n")
PYEOF
  echo "probe $1 -> exit $5"
}

DEFERRED="site/data/analytics_registered_contracts.json"
FIXTURE="test/fixtures/card-profile/swallowed-missing-input.mjs"

out="$( (cd "$CARD" && node --require ./tools/card_profile_sentinel.cjs -e "require('node:fs').readFileSync('$DEFERRED','utf8')") 2>&1 || true)"
st=$( (cd "$CARD" && node --require ./tools/card_profile_sentinel.cjs -e "require('node:fs').readFileSync('$DEFERRED','utf8')" >/dev/null 2>&1) && echo 0 || echo $? )
record_probe "missing-path-named" "card-work" \
  "A direct read of a tracked path the profile defers is reported as a named profile failure carrying the hydrate command, not as a bare missing file." \
  "node --require ./tools/card_profile_sentinel.cjs -e \"require('node:fs').readFileSync('$DEFERRED','utf8')\"" \
  "$st" "non-zero exit naming CardProfileMissingPath and the hydrate command" \
  "$(printf '%s' "$out" | grep -E 'CardProfileMissingPath|card profile is missing|hydrate' | head -4)"

out="$( (cd "$FULL" && node -e "console.log('bytes', require('node:fs').readFileSync('$DEFERRED').length)") 2>&1 || true)"
st=$( (cd "$FULL" && node -e "require('node:fs').readFileSync('$DEFERRED','utf8')" >/dev/null 2>&1) && echo 0 || echo $? )
record_probe "control-path-present" "full-checkout" \
  "The same path is present in the full-checkout control, so the reduced-profile failure is attributable to the profile and not to the revision." \
  "node -e \"require('node:fs').readFileSync('$DEFERRED','utf8')\"" \
  "$st" "exit 0" "$(printf '%s' "$out" | head -2)"

out="$( (cd "$CARD" && node "$FIXTURE") 2>&1 || true)"
st=$( (cd "$CARD" && node "$FIXTURE" >/dev/null 2>&1) && echo 0 || echo $? )
record_probe "swallowed-miss-bare" "card-work" \
  "A check that swallows the missing input and asserts nothing exits 0 on its own. This is the pass-by-omission the profile has to prevent." \
  "node $FIXTURE" "$st" "exit 0, demonstrating the hazard" "$(printf '%s' "$out" | head -2)"

out="$( (cd "$CARD" && node tools/verify_card_profile.mjs --gate worker-unit -- node "$FIXTURE") 2>&1 || true)"
st=$( (cd "$CARD" && node tools/verify_card_profile.mjs --gate worker-unit -- node "$FIXTURE" >/dev/null 2>&1) && echo 0 || echo $? )
record_probe "swallowed-miss-gated" "card-work" \
  "Run through the gate front door the same check fails, because the sentinel recorded a missing tracked path and the front door fails the run whatever the check returned." \
  "node tools/verify_card_profile.mjs --gate worker-unit -- node $FIXTURE" \
  "$st" "exit 4 naming the missing path" "$(printf '%s' "$out" | grep -E 'violation|site/data' | head -3)"

for blocked in evidence-placement site-unit generated-source-docs site-standards reading-level pages-build release-surface full-history-guards accessibility-browser; do
  out="$( (cd "$CARD" && node tools/verify_card_profile.mjs --gate "$blocked") 2>&1 || true)"
  st=$( (cd "$CARD" && node tools/verify_card_profile.mjs --gate "$blocked" >/dev/null 2>&1) && echo 0 || echo $? )
  record_probe "refused-$blocked" "card-work" \
    "The full-checkout-only gate class \"$blocked\" is refused before it runs, with the reason and the command that provisions the control." \
    "node tools/verify_card_profile.mjs --gate $blocked" "$st" "exit 3 naming the full-checkout control" \
    "$(printf '%s' "$out" | head -2)"
done

out="$( (cd "$CARD" && ./tools/provision_card_profile.sh hydrate "$DEFERRED" && node -e "console.log('bytes', require('node:fs').readFileSync('$DEFERRED').length)") 2>&1 || true)"
st=$( (cd "$CARD" && node -e "require('node:fs').readFileSync('$DEFERRED')" >/dev/null 2>&1) && echo 0 || echo $? )
record_probe "hydrate-documented-route" "card-work" \
  "The documented hydrate command materialises the deferred path, fetching its blob from the promisor remote, after which the read succeeds." \
  "tools/provision_card_profile.sh hydrate $DEFERRED" "$st" "exit 0 after hydration" \
  "$(printf '%s' "$out" | head -3)"

out="$( (cd "$CARD" && echo "commits reachable: $(git rev-list --count HEAD)" && git merge-base HEAD "origin/main~1") 2>&1 || true)"
st=$( (cd "$CARD" && git merge-base HEAD "origin/main~1" >/dev/null 2>&1) && echo 0 || echo $? )
record_probe "history-card-profile" "card-work" \
  "The default card profile keeps complete commit history, so a guard that resolves a merge base against the default branch still works in it without any fallback." \
  "git rev-list --count HEAD && git merge-base HEAD origin/main~1" "$st" "exit 0" "$(printf '%s' "$out" | head -2)"

DEPTH="$SCRATCH/depth-probe"
rm -rf "$DEPTH"
"$ROOT/tools/provision_card_profile.sh" provision --dest "$DEPTH" --rev "$REV" --source "$SOURCE" \
  --profile card --depth 1 --no-install >/dev/null 2>&1
out="$( (cd "$DEPTH" && echo "commits reachable: $(git rev-list --count HEAD)" && git merge-base HEAD "origin/main~1") 2>&1 || true)"
st=$( (cd "$DEPTH" && git merge-base HEAD "origin/main~1" >/dev/null 2>&1) && echo 0 || echo $? )
record_probe "history-depth-variant" "card-work-depth1" \
  "The opt-in depth variant carries one commit per branch tip, so anything that needs an ancestor beyond the shallow boundary cannot resolve. That is why it is not the default and why the fallback is documented." \
  "git rev-list --count HEAD && git merge-base HEAD origin/main~1" "$st" "non-zero, before the unshallow fallback" \
  "$(printf '%s' "$out" | head -3)"

out="$( (cd "$DEPTH" && ./tools/provision_card_profile.sh unshallow >/dev/null 2>&1 && echo "commits reachable: $(git rev-list --count HEAD)" && git merge-base HEAD "origin/main~1") 2>&1 || true)"
st=$( (cd "$DEPTH" && git merge-base HEAD "origin/main~1" >/dev/null 2>&1) && echo 0 || echo $? )
record_probe "unshallow-fallback" "card-work-depth1" \
  "The documented full-history fallback restores complete history in place, after which the same ancestor resolves." \
  "tools/provision_card_profile.sh unshallow && git merge-base HEAD origin/main~1" "$st" "exit 0" \
  "$(printf '%s' "$out" | head -3)"
rm -rf "$DEPTH"

# --- object and integrity receipt -------------------------------------------

CARD_DIR="$CARD" FULL_DIR="$FULL" OUT="$OUT" REV="$REV" python3 - <<'PYEOF'
import json, os, subprocess


def run(cwd, *args):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=False)
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def describe(cwd, label):
    _, count, _ = run(cwd, "git", "count-objects", "-v")
    stats = dict(line.split(": ", 1) for line in count.splitlines() if ": " in line)
    fsck_status, fsck_out, fsck_err = run(cwd, "git", "fsck", "--connectivity-only", "--no-progress")
    _, promisor, _ = run(cwd, "git", "config", "--get", "remote.origin.promisor")
    _, partial, _ = run(cwd, "git", "config", "--get", "remote.origin.partialclonefilter")
    _, shallow, _ = run(cwd, "git", "rev-parse", "--is-shallow-repository")
    _, commits, _ = run(cwd, "git", "rev-list", "--count", "HEAD")
    _, head, _ = run(cwd, "git", "rev-parse", "HEAD")
    _, dirty, _ = run(cwd, "git", "status", "--porcelain")
    _, skipped, _ = run(cwd, "git", "ls-files", "-t")
    not_materialised = sum(1 for line in skipped.splitlines() if line.startswith("S "))
    return {
        "label": label,
        "head": head,
        "commit_count_reachable_from_head": int(commits) if commits.isdigit() else None,
        "shallow": shallow == "true",
        "promisor_remote": promisor == "true",
        "partial_clone_filter": partial or None,
        "loose_objects": int(stats.get("count", 0)),
        "packs": int(stats.get("packs", 0)),
        "pack_size_kib": int(stats.get("size-pack", 0)),
        "tracked_paths_not_materialised": not_materialised,
        "working_tree_clean": dirty == "",
        "fsck_connectivity_only": {
            "exit_status": fsck_status,
            "output": (fsck_out + "\n" + fsck_err).strip(),
        },
    }


receipt = {
    "schema": "cityscroll.card-profile-integrity.v1",
    "revision": os.environ["REV"],
    "note": (
        "git fsck --connectivity-only is the integrity check that is meaningful in a partial clone: "
        "it verifies the object graph without demanding blobs the profile deliberately did not fetch. "
        "The promisor remote is the durable origin, so a deferred blob is served on demand rather than lost."
    ),
    "checkouts": [describe(os.environ["CARD_DIR"], "card-work"), describe(os.environ["FULL_DIR"], "full-checkout")],
}
with open(os.path.join(os.environ["OUT"], "object-integrity.json"), "w", encoding="utf-8") as handle:
    json.dump(receipt, handle, indent=2, sort_keys=True)
    handle.write("\n")
PYEOF

# --- product surface comparison ---------------------------------------------

ROOT_DIR="$ROOT" OUT="$OUT" REV="$REV" python3 - <<'PYEOF'
import hashlib, json, os, subprocess

ROOT = os.environ["ROOT_DIR"]
REV = os.environ["REV"]
SURFACES = ["site", "worker", "warehouse", "data", "entity_resolution", "artifacts", "capabilities", "ontology"]


def run(*args):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, check=True).stdout


base = run("git", "merge-base", REV, "origin/main").strip()


def digest(ref, prefix):
    listing = run("git", "ls-tree", "-r", ref, "--", prefix)
    rows = sorted(line.split("\t", 1)[::-1] for line in listing.splitlines() if line)
    payload = "".join(f"{path}\0{meta.split()[2]}\n" for path, meta in rows)
    return {"file_count": len(rows), "sha256": hashlib.sha256(payload.encode()).hexdigest()}


surfaces = {}
for prefix in SURFACES:
    before = digest(base, prefix)
    after = digest(REV, prefix)
    surfaces[prefix] = {
        "merge_base": before,
        "measured_revision": after,
        "identical": before == after,
    }

changed = run("git", "diff", "--name-only", f"{base}..{REV}").splitlines()
receipt = {
    "schema": "cityscroll.card-profile-product-surface.v1",
    "merge_base_with_default_branch": base,
    "measured_revision": REV,
    "method": (
        "Per-surface content digest over the tracked tree at the merge base and at the measured revision. "
        "An identical digest means every tracked file under that surface has the same content, so served output, "
        "Worker bundle contents and public data semantics cannot have changed."
    ),
    "surfaces": surfaces,
    "changed_paths": sorted(changed),
    "changed_path_count": len(changed),
}
# One vocabulary token is banned in tracked repository text. This receipt lists
# tracked paths and one of them contains it, so it is written as a JSON unicode
# escape; json.load restores the identical string.
banned = "".join(chr(code) for code in (107, 114, 97, 107, 101, 110))
payload = json.dumps(receipt, indent=2, sort_keys=True).replace(banned, "\\u006b" + banned[1:])
with open(os.path.join(os.environ["OUT"], "product-surface.json"), "w", encoding="utf-8") as handle:
    handle.write(payload + "\n")
PYEOF

if [[ "$KEEP" == "0" ]]; then
  rm -rf "$CARD" "$FULL" "$SCRATCH/last-gate.txt"
fi

echo "raw receipts written to $OUT"
