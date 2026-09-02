#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Readiness before work. The builder below reads tracked read models, and the
# copy step after it cannot fail on an absent one — it copies whatever the tree
# holds — so a checkout missing a read model would serve a smaller site and the
# browser checks would time out on rows that were never going to render. Assert
# the declared corpus first, so a provisioning gap is reported as one instead of
# arriving later disguised as an empty Browse result.
node tools/verify_functional_corpus.mjs --check \
  ${CROL_FUNCTIONAL_CORPUS_RECEIPT:+--receipt-out "${CROL_FUNCTIONAL_CORPUS_RECEIPT}"}

# Functional tests exercise the static-first document routes. Materialize them
# once at the suite boundary before any local server can expose a stale shell.
node tools/build_primary_documents.mjs
# Serve the public artifact shape used by Pages so client-imported capability modules
# are present during local browser checks.
node tools/build_public_site.mjs --source-dir . --site-dir _site
