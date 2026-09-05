#!/usr/bin/env bash
# Plain-bash test for preflight.sh, following the convention of
# test/functional/run.sh: build a scratch fixture, drive the real code
# against it, and report pass/fail with a non-zero exit on any failure.
#
#   ops/first-class-refresh/test-preflight.sh
set -u
cd "$(dirname "$0")" || exit 1   # ops/first-class-refresh

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=$((FAILED + 1)); }
pass() { echo "ok: $1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/crol-preflight-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# A bare "origin" plus a working clone, both seeded with one commit on main.
git init --quiet --bare "$WORK/origin.git"
git clone --quiet "$WORK/origin.git" "$WORK/clone"
(
  cd "$WORK/clone"
  git config user.email test@example.com
  git config user.name test
  echo one > file.txt
  git add file.txt
  git commit --quiet -m "initial"
  git push --quiet origin HEAD:main
  git branch --quiet -M main
)

run_preflight() {
  # Runs preflight() in a fresh subshell against $WORK/clone so each case
  # starts from that fixture's current state.
  (
    cd "$WORK/clone" || exit 1
    # shellcheck source=preflight.sh
    source "$OLDPWD/preflight.sh"
    preflight
  )
}

# (a) clean checkout on the default branch proceeds.
(
  cd "$WORK/clone"
  git checkout --quiet main
)
if out="$(run_preflight 2>&1)"; then
  branch="$(cd "$WORK/clone" && git branch --show-current)"
  [ "$branch" = "main" ] && pass "(a) clean default-branch checkout proceeds" \
    || fail "(a) expected to stay on main, got $branch"
else
  fail "(a) clean default-branch checkout should not refuse: $out"
fi

# (b) checkout on a stale data branch is switched to the fast-forwarded default.
(
  cd "$WORK/clone"
  git checkout --quiet main
  echo two >> file.txt
  git commit --quiet -am "advance main"
  git push --quiet origin HEAD:main
  git checkout --quiet -B data/warehouse-refresh-19990101 HEAD~1
)
if out="$(run_preflight 2>&1)"; then
  (
    cd "$WORK/clone"
    branch="$(git branch --show-current)"
    tip="$(git rev-parse HEAD)"
    origin_tip="$(git rev-parse origin/main)"
    if [ "$branch" = "main" ] && [ "$tip" = "$origin_tip" ]; then
      exit 0
    fi
    exit 1
  ) && pass "(b) stale data branch is reset to fast-forwarded main" \
    || fail "(b) expected main at origin/main tip, got: $out"
else
  fail "(b) stale data branch should not refuse: $out"
fi

# (c) dirty tree on the default branch refuses with the exact message.
(
  cd "$WORK/clone"
  git checkout --quiet main
  echo dirty >> file.txt
)
out="$(run_preflight 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -qF "preflight: refusing to run -- uncommitted changes on main"; then
  pass "(c) dirty default branch refuses with the exact message"
else
  fail "(c) expected a refusal naming main, got (rc=$rc): $out"
fi
(cd "$WORK/clone" && git checkout --quiet -- file.txt)

# (d) after a simulated run the checkout is back on the default branch.
(
  cd "$WORK/clone"
  git checkout --quiet main
  # shellcheck source=preflight.sh
  source "$OLDPWD/preflight.sh"
  preflight
  git checkout --quiet -B data/warehouse-refresh-simulated main
  echo simulated-change >> file.txt
  git commit --quiet -am "simulated run"
  git push --quiet --force-with-lease origin HEAD
  # Success or failure, the job returns the checkout to the default branch.
  trap return_to_default_branch EXIT
)
branch="$(cd "$WORK/clone" && git branch --show-current)"
[ "$branch" = "main" ] && pass "(d) checkout is back on the default branch after a run" \
  || fail "(d) expected main after the run, got $branch"

if [ "$FAILED" -gt 0 ]; then
  echo "❌ $FAILED case(s) failed"
  exit 1
fi
echo "✅ all preflight cases passed"
