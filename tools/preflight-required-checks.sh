#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

RUN_READING_LEVEL=0
RUN_FULL=0
RECEIPT_PATH="${PREFLIGHT_RECEIPT:-$PROJECT_ROOT/.artifacts/preflight-required-checks.json}"

usage() {
  cat <<'EOF'
Usage: ./tools/preflight-required-checks.sh [--with-reading-level] [--full] [--receipt PATH] [--help]

Runs the local, offline-first gates matching CI's Unit job and required check mapping:
  - Unit tests (site + worker)
    - syntax + i18n gates
    - stray-English static lint
    - generated-source docs + source contract docs/sanity checks
    - site and worker unit test suites

Options:
  --with-reading-level  Run readable-or-else locally (same pages/arguments as CI reading-level job).
  --full                Run CI-equivalent heavy gates locally (requires browser tooling).
  NO_DISCLAIMER_SLOP_MODE=block  Promote the plain-language warning to a blocking check.
  --receipt PATH        Write the full-run JSON receipt to PATH (default: .artifacts/preflight-required-checks.json).
  --help                Show this help text.

Notes:
  - --full enables Playwright-based local validation for axe + runtime stray-English.
  - A full run emits a JSON receipt with commands, versions, statuses, timestamps, and git head.
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
  local command="$*"
  local started_at finished_at status
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  status=0
  if "$@"; then
    status=0
  else
    status=$?
  fi
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  record_command "$command" "$started_at" "$finished_at" "$status"
  if [[ "$status" != "0" ]]; then
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
    --receipt)
      shift
      if [[ $# -eq 0 || -z "$1" ]]; then
        echo "--receipt requires a path" >&2
        usage
        exit 1
      fi
      RECEIPT_PATH="$1"
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

# Keep the receipt writer in the contract runner so a failing command still leaves a
# durable, machine-readable explanation of what ran. Commands are JSONL during the run
# to avoid shell escaping problems, then wrapped in the final receipt below.
COMMAND_LOG="$(mktemp "${TMPDIR:-/tmp}/crol-preflight-commands.XXXXXX")"
LOCAL_EVENT_PATH=""
SERVER_PID=""
SERVER_READY_FILE=""
RECEIPT_WRITTEN=0
PREFLIGHT_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

version_or_unavailable() {
  local value
  value="$("$@" 2>/dev/null | head -1 || true)"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
  else
    printf 'unavailable'
  fi
}

record_command() {
  local command="$1"
  local started_at="$2"
  local finished_at="$3"
  local status="$4"
  python3 - "$COMMAND_LOG" "$command" "$started_at" "$finished_at" "$status" "$PWD" <<'PY'
import json
import sys

path, command, started_at, finished_at, status, cwd = sys.argv[1:]
with open(path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps({
        "command": command,
        "cwd": cwd,
        "started_at": started_at,
        "finished_at": finished_at,
        "exit_status": int(status),
    }, sort_keys=True) + "\n")
PY
}

cleanup_local_resources() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "${SERVER_READY_FILE:-}" ]]; then
    rm -f "$SERVER_READY_FILE"
  fi
  if [[ -n "${LOCAL_EVENT_PATH:-}" ]]; then
    rm -f "$LOCAL_EVENT_PATH"
  fi
}

write_receipt() {
  local exit_status="$1"
  [[ "$RUN_FULL" == "1" ]] || return 0
  [[ "$RECEIPT_WRITTEN" == "1" ]] && return 0
  RECEIPT_WRITTEN=1
  local finished_at
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$(dirname "$RECEIPT_PATH")"
  python3 - "$COMMAND_LOG" "$RECEIPT_PATH" "$PREFLIGHT_STARTED_AT" "$finished_at" "$exit_status" \
    "$RUN_FULL" "$RUN_READING_LEVEL" \
    "$(git rev-parse HEAD 2>/dev/null || printf 'unknown')" \
    "$(version_or_unavailable node --version)" \
    "$(version_or_unavailable python3 --version)" \
    "$(version_or_unavailable bash --version | head -1)" \
    "$(version_or_unavailable git --version)" <<'PY'
import json
import sys

(
    log_path, receipt_path, started_at, finished_at, exit_status,
    full, reading_level, git_head, node_version, python_version,
    bash_version, git_version,
) = sys.argv[1:]
with open(log_path, encoding="utf-8") as handle:
    commands = [json.loads(line) for line in handle if line.strip()]  # source: command JSONL emitted during this preflight run
receipt = {
    "schema": "crol.preflight.required-checks-receipt.v1",
    "started_at": started_at,
    "finished_at": finished_at,
    "exit_status": int(exit_status),
    "mode": {"full": full == "1", "reading_level": reading_level == "1"},
    "git_head": git_head,
    "versions": {
        "node": node_version,
        "python3": python_version,
        "bash": bash_version,
        "git": git_version,
    },
    "commands": commands,
}
with open(receipt_path, "w", encoding="utf-8") as handle:
    json.dump(receipt, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
  rm -f "$COMMAND_LOG"
  echo "preflight receipt: $RECEIPT_PATH"
}

finish_preflight() {
  local status="$?"
  cleanup_local_resources
  write_receipt "$status"
  exit "$status"
}
trap finish_preflight EXIT

# The beta contract normally receives GitHub's event payload. A deterministic draft
# payload keeps the same validator executable locally without depending on GitHub.
if [[ -z "${GITHUB_EVENT_PATH:-}" ]]; then
  LOCAL_EVENT_PATH="$(mktemp "${TMPDIR:-/tmp}/crol-beta-review-event.XXXXXX")"
  printf '%s\n' '{"pull_request":{"number":0,"draft":true,"labels":[],"body":""}}' > "$LOCAL_EVENT_PATH"
  export GITHUB_EVENT_PATH="$LOCAL_EVENT_PATH"
fi

run_banner "Unit tests (site + worker)" "Syntax + i18n + static lint" \
  "python3 test/standards/{js_syntax,i18n_keys,i18n_refs,i18n_fallback_sync,es_diacritics,i18n_glossary,attribution,link_text,control_labels,outline_guard,form_border_contrast,nyc_copy_lint,reader_register,public_surface_vocab,claim_first_prediction,page_metadata,brand_identity,no_official_marks,canonical_domain,link_targets,heading_punctuation,genai_disclosure,nl_input_clarity,demo_links}.py"
run_and_fail python3 test/standards/js_syntax.py
run_and_fail python3 test/standards/i18n_keys.py
run_and_fail python3 test/standards/i18n_refs.py
run_and_fail python3 test/standards/i18n_fallback_sync.py
run_and_fail python3 test/standards/stray_english.py
run_and_fail python3 test/standards/es_diacritics.py
run_and_fail python3 test/standards/i18n_glossary.py
run_and_fail python3 test/standards/attribution.py
run_and_fail python3 test/standards/link_text.py
run_and_fail python3 test/standards/control_labels.py
run_and_fail python3 test/standards/outline_guard.py
run_and_fail python3 test/standards/form_border_contrast.py
run_and_fail python3 test/standards/civic_token_contract.py
run_and_fail python3 test/standards/nyc_copy_lint.py --gate
run_banner "Accessibility + language gate (plain-language copy)" "No-disclaimer-slop check" \
  "python3 test/standards/no_disclaimer_slop.py --mode ${NO_DISCLAIMER_SLOP_MODE:-warn}"
run_and_fail python3 test/standards/no_disclaimer_slop.py \
  --mode "${NO_DISCLAIMER_SLOP_MODE:-warn}"
run_and_fail python3 test/standards/public_surface_vocab.py --gate
run_and_fail python3 test/standards/claim_first_prediction.py
run_and_fail node tools/check_public_payload_integrity.mjs
run_and_fail node tools/check-collapsed-group-labels.mjs
run_and_fail python3 test/standards/page_metadata.py
run_and_fail python3 test/standards/brand_identity.py
run_and_fail python3 test/standards/no_official_marks.py
run_and_fail python3 test/standards/canonical_domain.py
run_and_fail python3 test/standards/link_targets.py
run_and_fail python3 test/standards/heading_punctuation.py
run_and_fail python3 test/standards/genai_disclosure.py
run_and_fail python3 test/standards/nl_input_clarity.py
run_and_fail python3 test/standards/demo_links.py
run_and_fail python3 test/functional/a11y_gate_test.py
run_and_fail python3 test/functional/ci_waits_test.py

run_banner "Unit tests (site + worker)" "Beta preview alias contract" \
  "node tools/check_beta_review_contract.mjs"
run_and_fail node tools/check_beta_review_contract.mjs

run_banner "Unit tests (site + worker)" "Site + worker metadata/unit suites + joins" \
  "node tools/generate_source_docs.mjs --check"
run_and_fail node tools/no_live_external_reads.mjs --check
run_and_fail node tools/generate_source_docs.mjs --check
run_and_fail node tools/data_source_graph.mjs
run_and_fail node tools/data_source_graph.mjs --check
run_and_fail node tools/build_url_migration_map.mjs --check
run_and_fail node tools/build_money_resident_snapshot.mjs --check
run_and_fail node tools/build_property_resident_snapshot.mjs --check
run_and_fail node tools/build_primary_documents.mjs --check
run_and_fail node tools/build_exam_documents.mjs --check
run_and_fail node tools/build_near_you_pages.mjs --check
run_and_fail node tools/build_following_page.mjs --check
run_and_fail node tools/depot_rederive.mjs --check
run_and_fail node tools/validate_beta_flags.mjs
run_and_fail node tools/audit-test-clocks.mjs
run_and_fail node --test test/*.test.mjs
run_banner "Unit tests (site + worker)" "Preset snapshot receipt is internally consistent" \
  "node tools/validate_presets.mjs --check"
run_and_fail node tools/validate_presets.mjs --check
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
  run_and_fail python3 test/standards/reading_level.py \
    --root site \
    --max-grade 7 \
    --format gh-annotations \
    following/index.html
  run_and_fail node tools/property_a11y_census.mjs \
    --limit 50000 \
    --ratchet-baseline site/property-a11y-ratchet.json \
    --format markdown
  run_and_fail node tools/now_reading_level.mjs \
    --baseline site/now-reading-level-ratchet.json \
    --format markdown
  run_and_fail node tools/near_you_reading_level.mjs \
    --baseline site/near-you-reading-level-ratchet.json \
    --format markdown
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
  if node tools/home_cold_load.mjs; then
    run_banner "Performance budgets (local smoke)" "home.cold fixture" \
      "python3 test/performance/verify.py --budgets performance-budgets.json --fixtures test/performance/fixtures --fixture home.cold --site-root site --samples 1"
    run_and_fail python3 test/performance/verify.py \
      --budgets performance-budgets.json \
      --fixtures test/performance/fixtures \
      --fixture home.cold \
      --site-root site \
      --samples 1
  fi
  run_banner "Unit tests (site + worker)" "Optional source-contract/network gates" \
    "node tools/verify_source_contracts.mjs"
  run_and_fail node tools/verify_source_contracts.mjs
  run_and_fail python3 test/functional/capture_qr_share.py --verify-only
  run_and_fail python3 test/functional/19_hash_route_focus.py
  run_and_fail python3 test/functional/21_module_dom_equivalence.py
  # Agency constellation HTML is gitignored; generate it before the local site
  # server so axe + demo-links hit the same static documents as production.
  run_banner "Accessibility + language gate (axe on every PR)" "Build agency constellation HTML artifacts" \
    "node tools/build_agency_constellation_documents.mjs"
  run_and_fail node tools/build_agency_constellation_documents.mjs
  run_and_fail node tools/build_agency_documents.mjs
  if [[ ! -f site/agencies/parks-and-recreation/index.html ]]; then
    echo "preflight: expected site/agencies/parks-and-recreation/index.html after constellation build" >&2
    exit 1
  fi
  run_banner "Accessibility + language gate (axe on every PR)" "Build community board constellation HTML artifacts" \
    "node tools/build_community_board_constellation_documents.mjs"
  run_and_fail node tools/build_community_board_constellation_documents.mjs
  if [[ ! -f site/community-boards/bronx-cb-01/index.html ]]; then
    echo "preflight: expected site/community-boards/bronx-cb-01/index.html after constellation build" >&2
    exit 1
  fi
  # Bind atomically to an available port so concurrent local checks cannot replace
  # one another's server. CROL_TEST_PORT remains an explicit debugging override.
  SERVER_READY_FILE="$(mktemp "${TMPDIR:-/tmp}/crol-preflight-site.XXXXXX")"
  python3 tools/local_site_server.py \
    --directory site \
    --port "${CROL_TEST_PORT:-0}" \
    --ready-file "${SERVER_READY_FILE}" &
  SERVER_PID=$!
  server_up=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if [[ -s "${SERVER_READY_FILE}" ]]; then
      IFS= read -r CROL_BASE < "${SERVER_READY_FILE}"
      if curl -sf -o /dev/null "${CROL_BASE}"; then
        export CROL_BASE
        server_up=1
        break
      fi
    fi
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
      echo "preflight: local site server exited before becoming ready" >&2
      exit 1
    fi
    sleep 0.25
  done
  if [[ "${server_up}" != "1" ]]; then
    echo "preflight: timed out waiting for the local site server" >&2
    exit 1
  fi
  echo "preflight: local site ready at ${CROL_BASE}"
  run_and_fail python3 test/functional/23_mobile_viewport.py
  run_and_fail python3 test/functional/24_geolocation_gesture_gate.py
  run_and_fail python3 test/functional/11_accessibility.py
  run_and_fail python3 test/standards/rendered_schema_vocabulary.py
  run_and_fail python3 test/functional/12_language.py
  run_and_fail python3 test/functional/24_notice_document_features.py
  run_and_fail python3 test/functional/14_focus_visible.py
  run_and_fail python3 test/functional/16_external_links.py
  run_and_fail python3 test/functional/30_browse_interaction_grammar.py
  run_and_fail python3 tools/capture_browse_interaction_grammar.py --verify-only
  run_banner "Accessibility + language gate (axe on every PR)" "Label-coverage census" \
    "python3 test/standards/label_coverage.py"
  run_and_fail python3 test/standards/label_coverage.py
  run_banner "Accessibility + language gate (axe on every PR)" "Heading-uniqueness + landmark check" \
    "python3 test/standards/heading_uniqueness.py"
  run_and_fail python3 test/standards/heading_uniqueness.py
  # Runtime multi-locale stray-English is not a CI required gate (static lint is).
  # Optional full walk: bash test/functional/run_stray_english_shards.sh
  run_and_fail python3 test/functional/15_rtl.py
  run_and_fail python3 test/functional/16_forecast_discoverability.py
  run_and_fail python3 test/functional/17_default_examples.py
  run_and_fail python3 test/functional/20_demo_links.py
  run_and_fail python3 test/functional/22_same_consolidation.py
  run_and_fail python3 test/functional/25_property_facet_count_parity.py
  run_and_fail python3 test/functional/26_vendor_footprint_scope_count.py
  run_and_fail python3 test/functional/28_agency_scope_links.py
  run_and_fail python3 test/functional/29_snapshot_only_resident_reads.py
else
  echo
  echo "Skipping full browser gates by default."
  echo "CI runs accessibility + reading-level; Stray-English is the Unit static lint only."
fi
