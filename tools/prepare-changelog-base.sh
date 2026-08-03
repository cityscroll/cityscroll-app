#!/usr/bin/env bash
# tools/prepare-changelog-base.sh <bot-branch-name>
#
# Prepares changelog-data.json as the base for the post-merge machine-data update.
#
# The bot branch is the publication surface for this data contract, so each run starts from
# its latest copy when present. The retired public page is never read or written here.
set -euo pipefail
BOT_BRANCH="${1:?usage: prepare-changelog-base.sh <bot-branch-name>}"

if git ls-remote --exit-code --heads origin "$BOT_BRANCH" >/dev/null 2>&1; then
  echo "bot branch exists — using its latest changelog-data.json"
  git fetch origin "$BOT_BRANCH"
  bot_data_path="site/changelog-data.json"
  if ! git cat-file -e "origin/$BOT_BRANCH:$bot_data_path" 2>/dev/null; then
    # A bot branch created before the site/ move remains a valid reconciliation source.
    bot_data_path="changelog-data.json"
  fi
  git show "origin/$BOT_BRANCH:$bot_data_path" > site/changelog-data.json
else
  echo "no bot branch yet — using this tree's own changelog-data.json"
fi
