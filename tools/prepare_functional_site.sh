#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Functional tests exercise the static-first document routes. Materialize them
# once at the suite boundary before any local server can expose a stale shell.
node tools/build_primary_documents.mjs
