#!/usr/bin/env bash
# Hard guard for the changelog bot's self-merge arming (see update-changelog.yml). Exits 0
# only when every changed path supplied — one per line on stdin, or as arguments — is one the
# bot regeneration script actually owns. Anything else fails the guard, so the calling workflow
# leaves the PR for a human instead of arming auto-merge. Keep this list in sync with the files
# tools/gen_changelog.mjs writes (DATA_PATH, HTML_PATH).
set -euo pipefail

ALLOWED_PATHS=(
  "changelog-data.json"
  "changelog.html"
)

is_allowed() {
  local path="$1"
  local allowed
  for allowed in "${ALLOWED_PATHS[@]}"; do
    [ "$path" = "$allowed" ] && return 0
  done
  return 1
}

paths=()
if [ "$#" -gt 0 ]; then
  paths=("$@")
else
  while IFS= read -r line; do
    [ -n "$line" ] && paths+=("$line")
  done
fi

if [ "${#paths[@]}" -eq 0 ]; then
  echo "path guard failed — no changed paths given" >&2
  exit 1
fi

disallowed=()
for path in "${paths[@]}"; do
  is_allowed "$path" || disallowed+=("$path")
done

if [ "${#disallowed[@]}" -gt 0 ]; then
  echo "path guard failed — outside the changelog-owned surface: ${disallowed[*]}" >&2
  exit 1
fi

echo "path guard passed — all changed paths are changelog-owned: ${paths[*]}" >&2
exit 0
