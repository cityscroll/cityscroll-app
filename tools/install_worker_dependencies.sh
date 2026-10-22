#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORKER="$ROOT/worker"
EXPECTED="$(node -p "require('$WORKER/package.json').packageManager")"
EXPECTED_VERSION="${EXPECTED#pnpm@}"

# Prefer a trusted action-installed (or otherwise PATH) pnpm that already
# reports the packageManager pin. CI installs that binary via pnpm/action-setup
# before this script; forcing `corepack pnpm@$VERSION` re-fetches npm metadata
# on every run and fails closed when registry.npmjs.org returns 503.
resolve_pnpm() {
  local path version
  if path="$(command -v pnpm 2>/dev/null)"; then
    if version="$("$path" --version 2>/dev/null)"; then
      if [[ "$version" == "$EXPECTED_VERSION" ]]; then
        printf '%s\n' "$path"
        return 0
      fi
    fi
  fi
  return 1
}

PNPM=()
PNPM_SOURCE=""
if ACTION_PNPM="$(resolve_pnpm)"; then
  PNPM=("$ACTION_PNPM")
  PNPM_SOURCE="path"
else
  PNPM=(corepack "pnpm@$EXPECTED_VERSION")
  PNPM_SOURCE="corepack"
fi

if [[ "${CITYSCROLL_PNPM_PRINT_COMMAND:-}" == "1" ]]; then
  if [[ "$PNPM_SOURCE" == "path" ]]; then
    printf 'pnpm\n'
  else
    printf 'corepack pnpm@%s\n' "$EXPECTED_VERSION"
  fi
  exit 0
fi

ACTUAL_VERSION="$("${PNPM[@]}" --version)"

if [[ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "pinned package manager mismatch: expected pnpm $EXPECTED_VERSION, got $ACTUAL_VERSION" >&2
  exit 1
fi

STORE="${CITYSCROLL_PNPM_STORE_DIR:-$(cd "$WORKER" && "${PNPM[@]}" store path --silent)}"
mkdir -p "$STORE"
STORE="$(cd "$STORE" && pwd -P)"
case "$STORE/" in
  "$ROOT/"*) echo "dependency store must be outside the checkout: $STORE" >&2; exit 1 ;;
esac

exec "${PNPM[@]}" --dir "$WORKER" install --frozen-lockfile --store-dir "$STORE" "$@"
