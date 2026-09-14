#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: tools/classify_a11y_browser_failure.sh LOG STATUS" >&2
  exit 2
fi

log_file="$1"
status="$2"
if [[ ! -f "$log_file" || ! "$status" =~ ^[1-9][0-9]*$ ]]; then
  echo "test-failed"
  exit 0
fi

# A retry is safe only when the browser process itself died and the run produced
# no axe result. Any observed axe result/violation remains a real gate failure.
if grep -Eq 'SIGSEGV|signal=SIGSEGV|Chromium process exited' "$log_file" \
  && ! grep -Eiq 'axe[[:space:]_-]*(result|results)|axe.*violation|violation.*axe|no critical/serious axe violations' "$log_file"; then
  echo "browser-crashed"
else
  echo "test-failed"
fi
