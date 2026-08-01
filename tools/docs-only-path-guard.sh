#!/usr/bin/env bash
# Exit 0 only when every changed path is documentation surface that cannot
# affect the site, worker, tests, or CI wiring. Used so required checks can
# fast-path docs-only PRs (same merge-queue contract as changelog_only).
#
# Allowed:
#   - docs/**
#   - top-level Markdown (README.md, CONTRIBUTING.md, Agents.md, …)
#   - LICENSE, NOTICE, CHANGELOG*, CODE_OF_CONDUCT*
#
# Anything under site/, worker/, test/, tools/, entity_resolution/, .github/,
# or other code/config paths fails closed.
set -euo pipefail

is_allowed() {
  local path="$1"
  case "$path" in
    docs|docs/*) return 0 ;;
    LICENSE|NOTICE|CODE_OF_CONDUCT|CODE_OF_CONDUCT.md) return 0 ;;
    CHANGELOG|CHANGELOG.md|CHANGELOG/*) return 0 ;;
  esac
  # Top-level markdown only (no nested paths outside docs/).
  case "$path" in
    */*) return 1 ;;
  esac
  case "$path" in
    *.md|*.MD|*.markdown) return 0 ;;
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
  echo "docs-only path guard failed — no changed paths given" >&2
  exit 1
fi

disallowed=()
for path in "${paths[@]}"; do
  is_allowed "$path" || disallowed+=("$path")
done

if [ "${#disallowed[@]}" -gt 0 ]; then
  echo "docs-only path guard failed — non-docs path(s): ${disallowed[*]}" >&2
  exit 1
fi

echo "docs-only path guard passed: ${paths[*]}" >&2
exit 0
