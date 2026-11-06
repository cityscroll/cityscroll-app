#!/usr/bin/env bash
# Open or update the pull request for an already-pushed warehouse refresh
# branch, arm it for the merge queue once its checks pass, and close older
# open warehouse refresh pull requests as superseded.
#
# run-warehouse-refresh.sh commits and force-pushes its dated branch itself
# (preflight.sh's invariant guarantees every run starts from a fast-forwarded
# default branch, so a superseded branch's commit carries nothing the newer
# one lacks). This script owns only what happens to the pull request on top
# of that branch, which lets it be exercised the way
# test/first_class_refresh_pr_step.test.mjs exercises
# tools/open_first_class_refresh_pr.sh, without a warehouse catalog or the
# rest of the rebuild.
#
# Usage: open_warehouse_refresh_pr.sh <branch> <base-branch> <branch-prefix>
set -euo pipefail

branch="${1:?a pushed branch name is required}"
base_branch="${2:?a base branch is required}"
branch_prefix="${3:?a branch prefix is required to find predecessors}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

existing="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // ""')"
if [ -n "$existing" ]; then
  echo "Updated existing pull request #${existing}."
  current_pr="$existing"
else
  gh pr create --fill --head "$branch" --base "$base_branch"
  current_pr="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // ""')"
fi

if ! [[ "$current_pr" =~ ^[0-9]+$ ]]; then
  echo "The warehouse refresh branch was pushed, but its open pull request could not be identified." >&2
  exit 1
fi

# Wait for every required check on the exact generated head before queueing it
# and closing anything it supersedes. If the checks or queue request fail, the
# script stops and leaves every predecessor open so the next scheduled run can
# retry without hiding the last known publication path.
head_sha="$(git rev-parse HEAD)"
bash "$SCRIPT_DIR/queue_automation_pr_after_checks.sh" "$current_pr" "$head_sha"
echo "Queued pull request #${current_pr} at ${head_sha}."

# A dated branch is useful evidence for a particular run, but its pull request
# is not an independent release after a newer run has rebuilt from current
# main. Keep exactly one open warehouse refresh: the queued head above. Never
# close a predecessor that has a comment, a review, or a commit this job did
# not make itself -- that is no longer purely this job's own output, and a
# human may be in the middle of using it.
while IFS= read -r older_pr; do
  [ -n "$older_pr" ] || continue
  [ "$older_pr" != "$current_pr" ] || continue
  touches="$(gh pr view "$older_pr" --json comments,reviews,commits \
    --jq '(.comments | length) + (.reviews | length) + ((.commits | length) - 1)')"
  if [ "${touches:-1}" != "0" ]; then
    echo "Leaving pull request #${older_pr} open: it has a comment, review, or extra commit from outside this job."
    continue
  fi
  gh pr close "$older_pr" \
    --comment "Superseded by #${current_pr}, which was regenerated from the current main branch and queued for merge."
  echo "Closed superseded warehouse refresh pull request #${older_pr}."
done < <(
  gh pr list --state open --base "$base_branch" --limit 100 \
    --json number,headRefName \
    --jq --arg prefix "$branch_prefix" '.[] | select(.headRefName | startswith($prefix)) | .number'
)
