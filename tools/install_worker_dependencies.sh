#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORKER="$ROOT/worker"
EXPECTED="$(node -p "require('$WORKER/package.json').packageManager")"
EXPECTED_VERSION="${EXPECTED#pnpm@}"
PNPM=(corepack "pnpm@$EXPECTED_VERSION")
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
