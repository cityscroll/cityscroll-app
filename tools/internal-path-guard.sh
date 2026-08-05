#!/usr/bin/env bash
# Fails when changed paths introduce internal-only locations.
# This list is deny-only for existing-path introductions in a PR.
set -euo pipefail

is_internal_path() {
  local path="$1"
  case "$path" in
    backlog/*|internal/*|tasks/*|*.local.md)
      return 0
      ;;
  esac
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
  echo "internal-path guard passed (no changed paths)." >&2
  exit 0
fi

disallowed=()
for path in "${paths[@]}"; do
  is_internal_path "$path" && disallowed+=("$path")
done

if [ "${#disallowed[@]}" -gt 0 ]; then
  echo "internal-path guard failed — new or touched path(s): ${disallowed[*]}" >&2
  exit 1
fi

echo "internal-path guard passed — no newly introduced internal paths in change set: ${paths[*]}" >&2
exit 0
