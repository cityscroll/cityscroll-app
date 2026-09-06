#!/usr/bin/env bash
# Refresh the first-class resident datasets that need the retained analytical
# warehouse, then open a pull request with whatever changed.
#
# This is the warehouse-holding half of the refresh that
# .github/workflows/first-class-refresh.yml performs for everything else. See
# README.md in this directory before installing it.
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

: "${CITYSCROLL_REPO:?set CITYSCROLL_REPO to the repository checkout}"
: "${CITYSCROLL_WAREHOUSE_ROOT:?set CITYSCROLL_WAREHOUSE_ROOT to the retained warehouse root}"

cd "$CITYSCROLL_REPO"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=preflight.sh
source "$SCRIPT_DIR/preflight.sh"

if [ ! -f "$CITYSCROLL_WAREHOUSE_ROOT/duckdb/cityscroll.duckdb" ]; then
  echo "no warehouse catalog at $CITYSCROLL_WAREHOUSE_ROOT/duckdb/cityscroll.duckdb" >&2
  exit 1
fi

# A rehearsal reports what a run would select and changes nothing: no branch is
# created, no acquisition contacts a publisher, and no artifact is rewritten.
if [ "$DRY_RUN" = "1" ]; then
  preflight_dry_run_report
  echo "Dry run; datasets a refresh would consider due:"
  node tools/first_class_refresh.mjs --list-due
  exit 0
fi

# preflight() is not wrapped in the exit trap below: a refusal on a dirty,
# non-data branch is an operator's checkout to fix by hand, and the job must
# not touch it further. The trap only guards the run once preflight has
# succeeded and put the checkout on the default branch.
preflight || exit 1
trap return_to_default_branch EXIT

DATA_BRANCH="${DATA_BRANCH_PREFIX}$(date -u +%Y%m%d)"
git checkout --quiet -B "$DATA_BRANCH" "$DEFAULT_BRANCH"

# Some dependent materializers (e.g. worker/scripts/build_remote_mcp_evidence.mjs) run
# out of worker/ and need its pinned dependencies. This checkout persists across runs
# (see the invariant above), so a dependency added since the last run would otherwise
# make that materializer fail silently mid-refresh, leaving its committed receipt stale
# against data this same run just refreshed.
tools/install_worker_dependencies.sh

# Bounded underlying acquisition for warehouse-dependent priority sources
# runs before rematerialization. This refuses undocumented bulk ingest; an
# unchanged old catalog is not freshness proof.
node tools/priority_source_warehouse_acquire.mjs --bounded

node tools/first_class_refresh.mjs --run-due
# --run-due stops after each owning builder. Every committed read model derived
# from those datasets is rebuilt here, before committing; otherwise the pull
# request carries a read model whose coherence receipt no longer matches the
# served keyword index. The registry beside this script is the single list both
# halves of the refresh share, and it is checked against the freshness gates.
node "$SCRIPT_DIR/rebuild-committed-read-models.mjs"
node tools/first_class_refresh.mjs --write-report

if [ -z "$(git status --porcelain -- site worker)" ]; then
  echo "No warehouse-backed dataset changes."
  exit 0
fi

git add -- site worker
git commit --quiet -m "Refresh warehouse-backed resident datasets"
echo "force-pushing $DATA_BRANCH (only ever the job's own dated data branch)"
git push --quiet --force-with-lease origin HEAD

PR_URL="$(gh pr create --fill --base "$DEFAULT_BRANCH" 2>/dev/null || true)"
if [ -n "$PR_URL" ]; then
  echo "pull request opened: $PR_URL"
else
  PR_URL="$(gh pr view "$DATA_BRANCH" --json url --jq .url 2>/dev/null || true)"
  echo "pull request already open: ${PR_URL:-unknown}"
fi
