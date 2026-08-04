#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

RUN_READING_LEVEL=0
RUN_FULL=0

usage() {
  cat <<'EOF'
Usage: ./tools/preflight-required-checks.sh [--with-reading-level] [--full] [--help]

Runs the local, offline-first gates matching CI's Unit job and required check mapping:
  - Unit tests (site + worker)
    - syntax + i18n gates
    - stray-English static lint
    - generated-source docs + source contract docs/sanity checks
    - site and worker unit test suites

Options:
  --with-reading-level  Run readable-or-else locally (same pages/arguments as CI reading-level job).
  --full                Run CI-equivalent heavy gates locally (requires browser tooling).
  --help                Show this help text.

Notes:
  - --full enables Playwright-based local validation for axe + runtime stray-English.
  - CI still runs axe/runtime/i18n guard and reading-level jobs after Unit in CI.
EOF
}

run_banner() {
  local check_name="$1"
  local step_name="$2"
  local command="$3"
  echo
  echo "------------------------------------------------------------"
  echo "Required check: $check_name"
  echo "Step: $step_name"
  echo "Command: $command"
  echo "------------------------------------------------------------"
}

run_and_fail() {
  if ! "$@"; then
    echo "do not open PR yet: failed preflight command: $*"
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-reading-level)
      RUN_READING_LEVEL=1
      ;;
    --full)
      RUN_FULL=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

run_banner "Unit tests (site + worker)" "Syntax + i18n + static lint" \
  "python3 test/standards/{js_syntax,i18n_keys,i18n_refs,i18n_fallback_sync,es_diacritics,i18n_glossary,attribution,link_text,outline_guard,form_border_contrast,nyc_copy_lint,public_surface_vocab,page_metadata,brand_identity,no_official_marks,canonical_domain,link_targets,heading_punctuation,genai_disclosure,nl_input_clarity,demo_links}.py"
run_and_fail python3 test/standards/js_syntax.py
run_and_fail python3 test/standards/i18n_keys.py
run_and_fail python3 test/standards/i18n_refs.py
run_and_fail python3 test/standards/i18n_fallback_sync.py
run_and_fail python3 test/standards/stray_english.py
run_and_fail python3 test/standards/es_diacritics.py
run_and_fail python3 test/standards/i18n_glossary.py
run_and_fail python3 test/standards/attribution.py
run_and_fail python3 test/standards/link_text.py
run_and_fail python3 test/standards/outline_guard.py
run_and_fail python3 test/standards/form_border_contrast.py
run_and_fail python3 test/standards/nyc_copy_lint.py --gate
run_and_fail python3 test/standards/public_surface_vocab.py --gate
run_and_fail python3 test/standards/page_metadata.py
run_and_fail python3 test/standards/brand_identity.py
run_and_fail python3 test/standards/no_official_marks.py
run_and_fail python3 test/standards/canonical_domain.py
run_and_fail python3 test/standards/link_targets.py
run_and_fail python3 test/standards/heading_punctuation.py
run_and_fail python3 test/standards/genai_disclosure.py
run_and_fail python3 test/standards/nl_input_clarity.py
run_and_fail python3 test/standards/demo_links.py

run_banner "Unit tests (site + worker)" "Site + worker metadata/unit suites + joins" \
  "node tools/generate_source_docs.mjs --check"
run_and_fail node tools/generate_source_docs.mjs --check
run_and_fail node tools/depot_rederive.mjs --check
run_and_fail node tools/validate_beta_flags.mjs
run_and_fail node tools/audit-test-clocks.mjs
run_and_fail node --test test/*.test.mjs
run_and_fail node --test test/contract/*.test.mjs

run_banner "Unit tests (site + worker)" "Worker dependencies + worker unit tests" \
  "node --test (inside worker/)"
(cd worker && run_and_fail npm ci)
(cd worker && run_and_fail node --test)

if [[ "$RUN_READING_LEVEL" == "1" ]]; then
  run_banner "Reading-level ratchet gate (readable-or-else)" "reading-level gate" \
    "python3 test/standards/reading_level.py --root site --mode ratchet --baseline site/reading-level-baseline.json --format gh-annotations"
  if ! command -v readable-or-else >/dev/null 2>&1; then
    run_and_fail python3 -m pip install git+https://github.com/jimdc/readable-or-else.git
  fi
  run_and_fail python3 test/standards/reading_level.py \
    --root site \
    --mode ratchet \
    --baseline site/reading-level-baseline.json \
    --format gh-annotations \
    about.html api.html changelog.html data.html index.html stats.html standards.html
else
  echo
  echo "Reading-level ratchet check is CI-required but not run by default."
  echo "Use --with-reading-level to run it locally."
fi

if [[ "$RUN_FULL" == "1" ]]; then
  run_banner "Accessibility + language gate (axe on every PR)" "CI-equivalent full accessibility + stray-English runtime" \
    "Python playwright + test/functional/*"
  if ! python3 -c 'import playwright' >/dev/null 2>&1; then
    run_and_fail python3 -m pip install playwright
  fi
  run_and_fail python3 -m playwright install --with-deps chromium
  run_banner "Unit tests (site + worker)" "Optional source-contract/network gates" \
    "node tools/verify_source_contracts.mjs"
  run_and_fail node tools/verify_source_contracts.mjs
  run_and_fail python3 test/functional/capture_qr_share.py --verify-only
  run_and_fail python3 test/functional/19_hash_route_focus.py
  run_and_fail python3 test/functional/21_module_dom_equivalence.py
  # Functional gates hardcode http://localhost:8000 — free a stale listener first,
  # then wait until the server actually accepts connections (sleep 1 alone races).
  if command -v lsof >/dev/null 2>&1; then
    stale_pids="$(lsof -tiTCP:8000 -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "${stale_pids}" ]]; then
      echo "preflight: freeing port 8000 (stale pids: ${stale_pids})"
      # shellcheck disable=SC2086
      kill ${stale_pids} 2>/dev/null || true
      sleep 0.5
    fi
  fi
  python3 -m http.server 8000 --directory site --bind 127.0.0.1 &
  SERVER_PID=$!
  trap 'kill "${SERVER_PID}" 2>/dev/null || true' EXIT
  server_up=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if curl -sf -o /dev/null "http://127.0.0.1:8000/"; then
      server_up=1
      break
    fi
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
      echo "preflight: http.server on :8000 exited before becoming ready" >&2
      exit 1
    fi
    sleep 0.25
  done
  if [[ "${server_up}" != "1" ]]; then
    echo "preflight: timed out waiting for http://127.0.0.1:8000/" >&2
    exit 1
  fi
  run_and_fail python3 test/functional/11_accessibility.py
  run_and_fail python3 test/functional/12_language.py
  run_and_fail python3 test/functional/14_focus_visible.py
  run_and_fail python3 test/functional/16_external_links.py
  # Runtime multi-locale stray-English is not a CI required gate (static lint is).
  # Optional full walk: bash test/functional/run_stray_english_shards.sh
  run_and_fail python3 test/functional/15_rtl.py
  run_and_fail python3 test/functional/16_forecast_discoverability.py
  run_and_fail python3 test/functional/17_default_examples.py
  run_and_fail python3 test/functional/20_demo_links.py
else
  echo
  echo "Skipping full browser gates by default."
  echo "CI runs accessibility + reading-level; Stray-English is the Unit static lint only."
fi
