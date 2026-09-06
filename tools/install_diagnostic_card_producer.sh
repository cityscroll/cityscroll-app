#!/usr/bin/env bash
# Install the hourly diagnostic-card producer LaunchAgent from a durable
# checkout. Disposable checkouts are refused; the job reads the Desk queue
# and writes only operator state under .diagnostic-card-producer/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.cityscroll.diagnostic-card-producer"
SOURCE="$REPO/ops/launchd/$LABEL.plist.template"
TARGET="${HOME:?}/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="${CITYSCROLL_DIAGNOSTIC_CARD_LOG_DIR:-$HOME/Library/Logs/cityscroll}"
DOMAIN="gui/$(id -u)"

[ -f "$SOURCE" ] || { echo "missing plist template: $SOURCE" >&2; exit 1; }
[ -f "$REPO/tools/run_diagnostic_card_producer.sh" ] || { echo "missing runner" >&2; exit 1; }

python_bin=${CITYSCROLL_PYTHON:-$(command -v python3 || true)}
if [ -z "$python_bin" ] || [ ! -x "$python_bin" ]; then
  echo "error: no executable python3 found; set CITYSCROLL_PYTHON" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
sed -e "s|__CITYSCROLL_ROOT__|$REPO|g" \
    -e "s|__CITYSCROLL_DIAGNOSTIC_CARD_LOG_DIR__|$LOG_DIR|g" \
    "$SOURCE" > "$TARGET"

if command -v plutil >/dev/null 2>&1; then
  /usr/bin/plutil -lint "$TARGET" >/dev/null
fi

/bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
if ! /bin/launchctl bootstrap "$DOMAIN" "$TARGET" >/dev/null 2>&1; then
  sleep 1
  /bin/launchctl bootstrap "$DOMAIN" "$TARGET"
fi
echo "installed $LABEL; interval 3600s; kill switch CITYSCROLL_DIAGNOSTIC_CARD_PRODUCER=off"
echo "rehearse: CITYSCROLL_DIAGNOSTIC_CARD_DRY_RUN=1 $REPO/tools/run_diagnostic_card_producer.sh"
