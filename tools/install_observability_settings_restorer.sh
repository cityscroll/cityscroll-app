#!/usr/bin/env bash
# Install the supervised observability-settings restorer into a durable state
# root and a user LaunchAgent. The runner copies leave the disposable checkout.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
state_root=${CITYSCROLL_OBSERVABILITY_RESTORER_STATE:-"$HOME/.local/state/cityscroll-cost-control/observability-restorer"}
launch_agents_dir=${HOME:?}/Library/LaunchAgents
label=com.cityscroll.observability-settings-restorer
target="$launch_agents_dir/$label.plist"
node_bin=${CITYSCROLL_NODE:-$(command -v node || true)}
token_file=${CLOUDFLARE_API_TOKEN_FILE:-"$HOME/.config/estate/cloudflare-workers-deploy-cityscroll.key"}
account_id=${CLOUDFLARE_ACCOUNT_ID:-8162581cb1d97e20a172031adb8a13af}
log_dir=${CITYSCROLL_OBSERVABILITY_RESTORER_LOG_DIR:-"$state_root/logs"}

if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  echo "error: no executable node found; set CITYSCROLL_NODE" >&2
  exit 1
fi
case "$node_bin" in
  /*) ;;
  *) echo "error: CITYSCROLL_NODE must be absolute, got $node_bin" >&2; exit 1 ;;
esac

mkdir -p "$state_root/lib" "$state_root/receipts" "$log_dir" "$launch_agents_dir"
chmod 700 "$state_root" "$state_root/lib" "$state_root/receipts" "$log_dir"

# Durable copies: LaunchAgent must not depend on a disposable checkout path.
cp "$root/tools/worker_observability_restorer.mjs" "$state_root/run.mjs"
cp "$root/tools/lib/worker_observability_restorer.mjs" "$state_root/lib/worker_observability_restorer.mjs"
cp "$root/tools/lib/worker_observability_settings.mjs" "$state_root/lib/worker_observability_settings.mjs"
# Rewrite imports inside the durable entry to the durable lib directory.
python3 - <<PY
from pathlib import Path
path = Path("$state_root/run.mjs")
text = path.read_text()
text = text.replace(
    'from "./lib/worker_observability_settings.mjs"',
    'from "./lib/worker_observability_settings.mjs"',
)
text = text.replace(
    'from "./lib/worker_observability_restorer.mjs"',
    'from "./lib/worker_observability_restorer.mjs"',
)
# The lib copy of worker_observability_restorer imports ./worker_observability_settings.mjs
lib = Path("$state_root/lib/worker_observability_restorer.mjs")
lib_text = lib.read_text().replace(
    'from "./worker_observability_settings.mjs"',
    'from "./worker_observability_settings.mjs"',
)
lib.write_text(lib_text)
path.write_text(text)
PY
chmod 755 "$state_root/run.mjs"
chmod 644 "$state_root/lib/"*.mjs

sed -e "s|__NODE__|$node_bin|g" \
  -e "s|__STATE_ROOT__|$state_root|g" \
  -e "s|__LOG_DIR__|$log_dir|g" \
  -e "s|__TOKEN_FILE__|$token_file|g" \
  -e "s|__ACCOUNT_ID__|$account_id|g" \
  "$root/ops/launchd/$label.plist.template" > "$target"
chmod 644 "$target"

# Kill switch path stays adjacent; touching it stops new restore work.
kill_switch="$state_root/observability-restorer.off"

echo "installed durable restorer at $state_root"
echo "LaunchAgent plist at $target (not bootstrapped by this script)"
echo "kill switch: $kill_switch"
echo "bootstrap with: launchctl bootstrap gui/\$(id -u) $target"
echo "bootout with: launchctl bootout gui/\$(id -u) $target"
