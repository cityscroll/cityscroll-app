#!/usr/bin/env bash
# Publish whatever the scheduled first-class dataset refresh regenerated onto a
# dated branch, then open or update its pull request.
#
# The branch name is dated, so a second run on the same day reuses a branch that
# already exists on the remote. A fresh clone has no remote-tracking ref for that
# branch, which made a bare `--force-with-lease` fail with "stale info" and
# stranded the run before it could reach its pull-request handling. This script
# reads the remote branch first, so the lease is stated against a known commit
# instead of against nothing, and it treats a closed pull request on the branch
# as absent rather than as an existing one to update.
#
# The branch push and the pull request both use the same token, and it must not
# be the workflow's own GITHUB_TOKEN: GitHub does not start workflows for events
# created by that token, so the pull request would open with no checks and the
# merge queue could never admit it. The caller passes the repository's automation
# token instead; this script refuses to run without one rather than pushing
# unauthenticated and failing further along.
#
# Environment:
#   GH_TOKEN     token used for the push URL and for the gh calls
#   REPOSITORY   owner/name, used to build the default push URL
#   PUSH_REMOTE  overrides the push/read remote (used by the test)
#   BRANCH_DATE  overrides the dated branch suffix (used by the test)
set -euo pipefail

if [ -z "${GH_TOKEN:-}" ] && [ -z "${PUSH_REMOTE:-}" ]; then
  echo "GH_TOKEN is empty: the refresh needs an automation token that can push a branch and open a pull request." >&2
  exit 1
fi

paths=(site worker)
if [ -z "$(git status --porcelain -- "${paths[@]}")" ]; then
  echo "No dataset changes to publish."
  exit 0
fi

branch="data/first-class-refresh-${BRANCH_DATE:-$(date -u +%Y%m%d)}"
remote="${PUSH_REMOTE:-https://x-access-token:${GH_TOKEN}@github.com/${REPOSITORY}.git}"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git checkout -b "$branch"
git add -- "${paths[@]}"
git commit -m "Refresh first-class resident datasets from their publishers"

# Read the branch as the remote currently holds it. An absent branch is normal
# on the first run of the day and must not fail the step.
remote_sha="$(git ls-remote "$remote" "refs/heads/${branch}" 2>/dev/null | awk 'NR==1 {print $1}')"
if [ -n "$remote_sha" ]; then
  git fetch "$remote" "+refs/heads/${branch}:refs/remotes/origin/${branch}"
  echo "Branch ${branch} already exists on the remote at ${remote_sha}; replacing it under that lease."
  lease="${branch}:${remote_sha}"
else
  echo "Branch ${branch} does not exist on the remote yet."
  # An empty expected value leases the branch as "must not exist", so a branch
  # created between this read and the push still stops the write.
  lease="${branch}:"
fi

git push "--force-with-lease=${lease}" "$remote" "HEAD:${branch}"

existing="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // ""')"
if [ -n "$existing" ]; then
  echo "Updated existing pull request #${existing}."
  exit 0
fi

# Any earlier pull request on this branch is closed, which does not prevent a new
# one from being opened for the same head branch.
gh pr create --head "$branch" --base main \
  --title "Refresh first-class resident datasets" \
  --body "Scheduled refresh of every first-class resident dataset that was past its declared cadence. The run summary lists each dataset's freshness state and any acquisition that could not complete."
