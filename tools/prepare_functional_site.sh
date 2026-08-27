#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Functional tests exercise the static-first document routes. Materialize them
# once at the suite boundary before any local server can expose a stale shell.
node tools/build_primary_documents.mjs
# Serve the public artifact shape used by Pages so client-imported capability modules
# are present during local browser checks.
node tools/build_public_site.mjs --source-dir . --site-dir _site
