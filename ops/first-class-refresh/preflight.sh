#!/usr/bin/env bash
# Shared preflight for the warehouse refresh job.
#
# Fetches origin and makes sure the checkout starts from the current tip of
# the default branch, so every run -- scheduled or by hand -- picks up
# whatever has landed on it since the previous run, rather than resuming from
# wherever the last run happened to leave the checkout.
#
# A dirty tree on a data/warehouse-refresh-* branch is this job's own
# leftovers from an interrupted run: that branch is disposable and, once
# committed, already lives on origin, so it is safe to discard and reset. A
# dirty tree on any other branch -- including the default branch itself -- is
# an operator's in-progress work; the job stops rather than guess what to do
# with it.
#
# Sourced by run-warehouse-refresh.sh and exercised directly by
# test-preflight.sh; assumes the caller has already `cd`ed into the checkout.

DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
DATA_BRANCH_PREFIX="${DATA_BRANCH_PREFIX:-data/warehouse-refresh-}"
DIRTY_TREE_MESSAGE_PREFIX="preflight: refusing to run -- uncommitted changes on"

current_branch() {
  local branch
  branch="$(git branch --show-current)"
  [ -n "$branch" ] && echo "$branch" || echo "(detached HEAD)"
}

is_data_branch() {
  case "$1" in
    "$DATA_BRANCH_PREFIX"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Always leave the checkout back on the default branch, whether the run
# succeeds or fails, so the next scheduled run -- and any operator looking at
# the checkout in between -- starts from a clean, recognizable state instead
# of a parked data branch.
return_to_default_branch() {
  git checkout --quiet "$DEFAULT_BRANCH" 2>/dev/null || true
}

preflight() {
  git fetch --quiet origin

  local branch
  branch="$(current_branch)"

  if [ -n "$(git status --porcelain)" ]; then
    if is_data_branch "$branch"; then
      echo "preflight: discarding leftover changes on $branch from an interrupted run"
      git checkout --quiet -- .
      git clean --quiet -fd -- site worker
    else
      echo "$DIRTY_TREE_MESSAGE_PREFIX $branch" >&2
      return 1
    fi
  fi

  echo "preflight: switching to $DEFAULT_BRANCH and fast-forwarding to origin/$DEFAULT_BRANCH"
  git checkout --quiet "$DEFAULT_BRANCH"
  git pull --quiet --ff-only origin "$DEFAULT_BRANCH"
}

# Reports what preflight() would do without mutating the checkout or
# contacting anything beyond a read-only fetch.
preflight_dry_run_report() {
  git fetch --quiet origin

  local branch
  branch="$(current_branch)"

  if [ -n "$(git status --porcelain)" ]; then
    if is_data_branch "$branch"; then
      echo "dry run; preflight would discard leftover changes on $branch and reset to origin/$DEFAULT_BRANCH"
    else
      echo "dry run; $DIRTY_TREE_MESSAGE_PREFIX $branch"
    fi
  else
    echo "dry run; preflight would switch from $branch to $DEFAULT_BRANCH at origin/$DEFAULT_BRANCH"
  fi
}
