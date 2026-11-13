#!/usr/bin/env bash
# Enable automatic merge for a repository-owned automation pull request only
# after every required check on the exact generated head has passed.
#
# The producer workflows dispatch CI asynchronously. Reusing a fixed branch can
# therefore find a pull request whose earlier head is already red. Enabling
# auto-merge immediately would put that red pull request back into the merge
# queue. This gate polls the new head for a bounded period, refuses a failed or
# cancelled required check immediately, and re-verifies the head before arming
# auto-merge.
#
# Environment overrides used by the regression test:
#   AUTOMATION_CHECK_MAX_ATTEMPTS  default 60
#   AUTOMATION_CHECK_POLL_SECONDS  default 30
#   AUTOMATION_HEAD_SETTLE_ATTEMPTS  default 10
#   AUTOMATION_HEAD_SETTLE_POLL_SECONDS  default 3
# Head settle covers GitHub PR head lag right after a force-with-lease push to a
# fixed dated branch: the branch tip is already the generated commit while
# `gh pr view` can still report the previous head for a few seconds.
set -euo pipefail

pr_number="${1:-}"
expected_head="${2:-}"
max_attempts="${AUTOMATION_CHECK_MAX_ATTEMPTS:-60}"
poll_seconds="${AUTOMATION_CHECK_POLL_SECONDS:-30}"
head_settle_attempts="${AUTOMATION_HEAD_SETTLE_ATTEMPTS:-10}"
head_settle_poll_seconds="${AUTOMATION_HEAD_SETTLE_POLL_SECONDS:-3}"

if ! [[ "$pr_number" =~ ^[0-9]+$ ]]; then
  echo "A numeric pull request number is required." >&2
  exit 2
fi
if ! [[ "$expected_head" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "A full generated head SHA is required." >&2
  exit 2
fi
if ! [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "AUTOMATION_CHECK_MAX_ATTEMPTS must be a positive integer." >&2
  exit 2
fi
if ! [[ "$poll_seconds" =~ ^[0-9]+$ ]]; then
  echo "AUTOMATION_CHECK_POLL_SECONDS must be a non-negative integer." >&2
  exit 2
fi
if ! [[ "$head_settle_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "AUTOMATION_HEAD_SETTLE_ATTEMPTS must be a positive integer." >&2
  exit 2
fi
if ! [[ "$head_settle_poll_seconds" =~ ^[0-9]+$ ]]; then
  echo "AUTOMATION_HEAD_SETTLE_POLL_SECONDS must be a non-negative integer." >&2
  exit 2
fi

read_pr_head_state() {
  gh pr view "$pr_number" --json headRefOid,state --jq '[.headRefOid, .state] | @tsv'
}

verify_head() {
  local observed observed_head observed_state
  observed="$(read_pr_head_state)"
  observed_head="${observed%%$'\t'*}"
  observed_state="${observed#*$'\t'}"
  if [ "$observed_head" != "$expected_head" ]; then
    echo "Pull request #${pr_number} moved from ${expected_head} to ${observed_head}; automatic merge remains disabled." >&2
    return 1
  fi
  if [ "$observed_state" != "OPEN" ]; then
    echo "Pull request #${pr_number} is ${observed_state}; automatic merge remains disabled." >&2
    return 1
  fi
}

# Wait out PR-head propagation lag once before the check poll loop. A lasting
# mismatch still fails after the settle budget; only a later settle to the
# expected head continues.
settle_head() {
  local attempt observed observed_head observed_state
  for ((attempt = 1; attempt <= head_settle_attempts; attempt += 1)); do
    observed="$(read_pr_head_state)"
    observed_head="${observed%%$'\t'*}"
    observed_state="${observed#*$'\t'}"
    if [ "$observed_state" != "OPEN" ]; then
      echo "Pull request #${pr_number} is ${observed_state}; automatic merge remains disabled." >&2
      return 1
    fi
    if [ "$observed_head" = "$expected_head" ]; then
      if [ "$attempt" -gt 1 ]; then
        echo "Pull request #${pr_number} head settled to ${expected_head} after ${attempt} attempt(s)."
      fi
      return 0
    fi
    if [ "$attempt" -lt "$head_settle_attempts" ]; then
      echo "Pull request #${pr_number} still reports ${observed_head} (want ${expected_head}); waiting ${head_settle_poll_seconds}s for head settle (${attempt}/${head_settle_attempts})."
      sleep "$head_settle_poll_seconds"
    fi
  done
  echo "Pull request #${pr_number} moved from ${expected_head} to ${observed_head}; automatic merge remains disabled." >&2
  return 1
}

settle_head

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  verify_head

  set +e
  buckets="$(gh pr checks "$pr_number" --required --json bucket --jq 'map(.bucket) | unique | join(",")')"
  checks_status=$?
  set -e

  if [ "$checks_status" -eq 0 ]; then
    verify_head
    gh pr merge "$pr_number" --auto --match-head-commit "$expected_head"
    echo "Enabled automatic merge for pull request #${pr_number} at ${expected_head} after required checks passed."
    exit 0
  fi

  case ",${buckets}," in
    *,fail,*|*,cancel,*)
      echo "Required checks for pull request #${pr_number} at ${expected_head} did not pass (${buckets}); automatic merge remains disabled." >&2
      exit 1
      ;;
  esac

  if [ "$attempt" -lt "$max_attempts" ]; then
    echo "Required checks for pull request #${pr_number} are not complete (attempt ${attempt}/${max_attempts}); waiting ${poll_seconds}s."
    sleep "$poll_seconds"
  fi
done

echo "Required checks for pull request #${pr_number} did not become green after ${max_attempts} attempts; automatic merge remains disabled." >&2
exit 1
