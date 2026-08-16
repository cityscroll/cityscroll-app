#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: tools/run_a11y_ci_shard.sh <shard> <attempt>" >&2
  exit 2
fi

shard="$1"
attempt="$2"
case "$attempt" in
  primary|fresh-runner-retry) ;;
  *)
    echo "unknown accessibility shard attempt: $attempt" >&2
    exit 2
    ;;
esac

: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
NO_DISCLAIMER_SLOP_MODE="${NO_DISCLAIMER_SLOP_MODE:-warn}"
artifact_dir="$RUNNER_TEMP/a11y-pr-shard-${shard}-${attempt}-logs"
shard_log="$artifact_dir/a11y-pr-${shard}-${attempt}.log"
started_epoch="$(date +%s)"
started_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
server_pid=""
mkdir -p "$artifact_dir"
exec > >(tee "$shard_log") 2>&1

finish_shard() {
  local status=$?
  if [[ -n "${server_pid:-}" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  local finished_epoch
  local finished_iso
  finished_epoch="$(date +%s)"
  finished_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "$artifact_dir/a11y-pr-${shard}-${attempt}.timing.json" <<EOF
{
  "shard": "$shard",
  "attempt": "$attempt",
  "started_at": "$started_iso",
  "finished_at": "$finished_iso",
  "started_epoch": $started_epoch,
  "finished_epoch": $finished_epoch,
  "duration_seconds": $((finished_epoch - started_epoch)),
  "exit_status": $status
}
EOF
  return "$status"
}
trap finish_shard EXIT

ready_file="$RUNNER_TEMP/a11y-pr-${shard}-${attempt}-ready"
probe_error="$artifact_dir/local-site-probe-error.log"
server_log="$artifact_dir/local-site-server.log"
python3 tools/local_site_server.py \
  --directory _site \
  --port 0 \
  --ready-file "$ready_file" \
  >"$server_log" 2>&1 &
server_pid=$!
server_up=0
last_probe="ready file not published"
for _ in {1..120}; do
  if [[ -s "$ready_file" ]]; then
    IFS= read -r local_base < "$ready_file"
    readiness_url="${local_base}index.html"
    probe_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 5 "$readiness_url" 2>"$probe_error" || true)"
    if [[ "$probe_status" =~ ^2[0-9][0-9]$ ]]; then
      server_up=1
      break
    elif [[ "$probe_status" == "404" ]]; then
      echo "local site server returned HTTP 404 for readiness path (artifact is serving, but the probe path is missing): $readiness_url" >&2
      cat "$probe_error" >&2 2>/dev/null || true
      cat "$server_log" >&2 2>/dev/null || true
      exit 1
    elif [[ "$probe_status" == "000" || -z "$probe_status" ]]; then
      if grep -Eqi 'connection refused' "$probe_error" 2>/dev/null; then
        last_probe="connection refused for $readiness_url"
      elif grep -Eqi 'timed out|timeout' "$probe_error" 2>/dev/null; then
        last_probe="connection timed out for $readiness_url"
      else
        last_probe="connection failed for $readiness_url"
      fi
    else
      last_probe="HTTP $probe_status from $readiness_url"
    fi
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "local site server exited before becoming ready ($last_probe)" >&2
    cat "$probe_error" >&2 2>/dev/null || true
    cat "$server_log" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 0.25
done
if [[ "$server_up" != "1" ]]; then
  echo "timed out after 30s waiting for the local site server ($last_probe)" >&2
  cat "$probe_error" >&2 2>/dev/null || true
  cat "$server_log" >&2 2>/dev/null || true
  exit 1
fi
export CROL_BASE="$local_base"
export A11Y_LOG_DIR="$artifact_dir/functional-checks"
echo "local site ready at $CROL_BASE"

case "$shard" in
  browser-a11y)
    tools/run_a11y_functional_check.sh qr-share python3 test/functional/capture_qr_share.py --verify-only
    tools/run_a11y_functional_check.sh mobile-viewport python3 test/functional/23_mobile_viewport.py
    tools/run_a11y_functional_check.sh geolocation-gesture python3 test/functional/24_geolocation_gesture_gate.py
    # Keep axe and its final assertion outside the functional retry wrapper.
    python3 test/functional/11_accessibility.py
    ;;
  routes-focus)
    tools/run_a11y_functional_check.sh hash-route-focus python3 test/functional/19_hash_route_focus.py
    tools/run_a11y_functional_check.sh exams-route-alias python3 test/functional/29_exams_route_alias.py
    # Inline-to-module rendered DOM equivalence gate
    tools/run_a11y_functional_check.sh module-dom-equivalence python3 test/functional/21_module_dom_equivalence.py
    tools/run_a11y_functional_check.sh notice-document-features python3 test/functional/24_notice_document_features.py
    tools/run_a11y_functional_check.sh focus-visible python3 test/functional/14_focus_visible.py
    tools/run_a11y_functional_check.sh demo-links python3 test/functional/20_demo_links.py
    tools/run_a11y_functional_check.sh staffing-consolidation python3 test/functional/22_same_consolidation.py
    tools/run_a11y_functional_check.sh property-facet-parity python3 test/functional/25_property_facet_count_parity.py
    tools/run_a11y_functional_check.sh vendor-footprint-scope python3 test/functional/26_vendor_footprint_scope_count.py
    tools/run_a11y_functional_check.sh agency-scope-links python3 test/functional/28_agency_scope_links.py
    tools/run_a11y_functional_check.sh snapshot-only-resident-reads python3 test/functional/29_snapshot_only_resident_reads.py
    tools/run_a11y_functional_check.sh external-links python3 test/functional/16_external_links.py
    tools/run_a11y_functional_check.sh browse-interaction-grammar python3 test/functional/30_browse_interaction_grammar.py
    python3 tools/capture_browse_interaction_grammar.py --verify-only
    tools/run_a11y_functional_check.sh default-examples python3 test/functional/17_default_examples.py
    ;;
  language-layout)
    tools/run_a11y_functional_check.sh language python3 test/functional/12_language.py
    tools/run_a11y_functional_check.sh rtl python3 test/functional/15_rtl.py
    tools/run_a11y_functional_check.sh forecast-discoverability python3 test/functional/16_forecast_discoverability.py
    ;;
  rendered-census)
    python3 test/standards/no_disclaimer_slop.py \
      --root site --mode "$NO_DISCLAIMER_SLOP_MODE" --format github
    python3 test/standards/no_disclaimer_slop.py \
      --root _site --mode "$NO_DISCLAIMER_SLOP_MODE" --format github
    python3 test/standards/label_coverage.py
    python3 test/standards/rendered_schema_vocabulary.py
    python3 test/standards/heading_uniqueness.py
    ;;
  *)
    echo "unknown accessibility shard: $shard" >&2
    exit 1
    ;;
esac
