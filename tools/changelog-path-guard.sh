#!/usr/bin/env bash
# Hard guard for the machine changelog publisher. Exits 0 only when every changed path
# supplied is the data contract owned by tools/gen_changelog.mjs.
set -euo pipefail

ALLOWED_PATHS=(
  "site/changelog-data.json"
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
