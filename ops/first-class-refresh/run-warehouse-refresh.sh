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

if [ ! -f "$CITYSCROLL_WAREHOUSE_ROOT/duckdb/cityscroll.duckdb" ]; then
  echo "no warehouse catalog at $CITYSCROLL_WAREHOUSE_ROOT/duckdb/cityscroll.duckdb" >&2
  exit 1
fi

git fetch --quiet origin main
git checkout --quiet -B "data/warehouse-refresh-$(date -u +%Y%m%d)" origin/main

node tools/first_class_refresh.mjs --run-due
node tools/first_class_refresh.mjs --write-report

if [ -z "$(git status --porcelain -- site worker)" ]; then
  echo "No warehouse-backed dataset changes."
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run; leaving the following changes uncommitted:"
  git status --short -- site worker
  exit 0
fi

git add -- site worker
git commit --quiet -m "Refresh warehouse-backed resident datasets"
git push --quiet --force-with-lease origin HEAD
gh pr create --fill --base main >/dev/null || echo "A pull request is already open for this branch."
