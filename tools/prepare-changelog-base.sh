#!/usr/bin/env bash
# tools/prepare-changelog-base.sh <bot-branch-name>
#
# Prepares changelog-data.json as the base for a changelog regeneration — either the real
# post-merge regeneration (update-changelog.yml) or the pre-merge reading-level simulation
# (ci.yml). Both call sites source this one script so the "which files come from where" logic
# can't diverge or regress independently between them.
#
# changelog-data.json DOES need the bot branch's pending entries when a bot PR is still open
# (a merged PR's harvested entry hasn't landed on main yet) — so this is the one file pulled
# from the bot branch, when present.
#
# changelog.html is deliberately NEVER touched here — it stays whatever this tree already has
# checked out (main's current committed copy, or the current PR's merged-with-main copy for
# the simulation). Regenerating the entries block on top of the bot branch's own carried-
# forward changelog.html reintroduces any page content main has since changed or removed —
# this is exactly what broke PR #84: the bot branch's changelog.html still had the
# `chg_auto_note` disclaimer paragraph PR #83 deleted from main, so the "fixed" i18n
# reference gate failed again once the entries block was rebuilt on top of that stale page.
set -euo pipefail
BOT_BRANCH="${1:?usage: prepare-changelog-base.sh <bot-branch-name>}"

if git ls-remote --exit-code --heads origin "$BOT_BRANCH" >/dev/null 2>&1; then
  echo "bot branch exists — using its pending changelog-data.json; changelog.html stays this tree's own current copy"
  git fetch origin "$BOT_BRANCH"
  git show "origin/$BOT_BRANCH:changelog-data.json" > changelog-data.json
else
  echo "no bot branch yet — using this tree's own changelog-data.json"
fi
