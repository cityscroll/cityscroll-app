#!/usr/bin/env bash
# Lists a pull request's changed files, preferring the GitHub REST API and
# falling back to a local git diff when the API can't produce a diff — GitHub
# returns a "Sorry, this diff is taking too long to generate" / not_available
# error for very large PRs (see: hundreds of generated files under site/data
# in a single warehouse-refresh PR). The fallback needs the base commit
# reachable locally, i.e. a checkout with enough history (fetch-depth: 0 or a
# fetch of the base sha) — every caller of this script already does that.
#
# Usage: list_pr_changed_paths.sh <owner/repo> <pr-number> <base-sha> <status>
#   status: "added" lists only added files; "all" lists every changed file.
#
# Writes newline-separated repo-relative paths to stdout. Exits non-zero only
# when neither the API nor git can determine the changed paths — this guard
# must fail closed, never pass open on an empty list it can't trust.
set -euo pipefail

repo="$1"
pr="$2"
base_sha="$3"
status="$4"

case "$status" in
  added|all) ;;
  *) echo "list_pr_changed_paths.sh: status must be 'added' or 'all', got '$status'" >&2; exit 1 ;;
esac

api_query='.[].filename'
if [ "$status" = "added" ]; then
  api_query='.[] | select(.status == "added") | .filename'
fi

api_err="$(mktemp)"
api_out="$(mktemp)"
trap 'rm -f "$api_err" "$api_out"' EXIT

if gh api "repos/${repo}/pulls/${pr}/files" --paginate -q "$api_query" >"$api_out" 2>"$api_err"; then
  cat "$api_out"
  exit 0
fi

echo "list_pr_changed_paths.sh: GitHub API file list unavailable, falling back to git diff" >&2
sed 's/^/  api error: /' "$api_err" >&2 || true

if [ "$status" = "added" ]; then
  # -M so a rename (even with content drift) is classified as a rename, not a
  # delete+add pair — matches the merge_group git path used elsewhere in CI.
  git_diff_filter=(--diff-filter=A -M)
else
  git_diff_filter=(-M)
fi

if ! git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
  echo "list_pr_changed_paths.sh: base commit ${base_sha} not available locally — cannot determine changed paths" >&2
  exit 1
fi

if ! git diff "${git_diff_filter[@]}" --name-only "${base_sha}...HEAD"; then
  echo "list_pr_changed_paths.sh: git diff against ${base_sha} failed — cannot determine changed paths" >&2
  exit 1
fi
