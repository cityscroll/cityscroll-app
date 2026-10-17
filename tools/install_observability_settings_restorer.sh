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

# Install manifest: source commit + sha256 of each pinned runtime file.
source_commit=${CITYSCROLL_OBSERVABILITY_RESTORER_SOURCE_COMMIT:-$(git -C "$root" rev-parse HEAD 2>/dev/null || true)}
includes_commit=${CITYSCROLL_OBSERVABILITY_RESTORER_INCLUDES_COMMIT:-d03848063bf69116501e082580bc2994ba1b824e}
python3 - <<PY
import hashlib, json, os
from pathlib import Path
from datetime import datetime, timezone
state = Path("$state_root")
files = {
  "run.mjs": state / "run.mjs",
  "lib/worker_observability_restorer.mjs": state / "lib" / "worker_observability_restorer.mjs",
  "lib/worker_observability_settings.mjs": state / "lib" / "worker_observability_settings.mjs",
}
digests = {rel: hashlib.sha256(path.read_bytes()).hexdigest() for rel, path in files.items()}
manifest = {
  "schema": "cityscroll.observability_restorer_install_manifest.v1",
  "installed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "source_commit": "$source_commit" or None,
  "includes_commit": "$includes_commit",
  "state_root": str(state),
  "files": digests,
}
path = state / "install-manifest.json"
path.write_text(json.dumps(manifest, indent=2) + "\\n")
os.chmod(path, 0o600)
print(json.dumps(manifest, indent=2))
PY

# Transport mode: empty keeps window-bound selection (exact-layer windows
# select dual-view from script_layer; others use beta). Override with
# CITYSCROLL_OBSERVABILITY_RESTORER_TRANSPORT=dual-view-script-settings+beta.
transport_mode=${CITYSCROLL_OBSERVABILITY_RESTORER_TRANSPORT:-}

sed -e "s|__NODE__|$node_bin|g" \
  -e "s|__STATE_ROOT__|$state_root|g" \
  -e "s|__LOG_DIR__|$log_dir|g" \
  -e "s|__TOKEN_FILE__|$token_file|g" \
  -e "s|__ACCOUNT_ID__|$account_id|g" \
  -e "s|__TRANSPORT_MODE__|$transport_mode|g" \
  "$root/ops/launchd/$label.plist.template" > "$target"
chmod 644 "$target"

# Kill switch path stays adjacent; touching it stops new restore work.
kill_switch="$state_root/observability-restorer.off"

echo "installed durable restorer at $state_root"
echo "install manifest at $state_root/install-manifest.json"
echo "LaunchAgent plist at $target (not bootstrapped by this script)"
echo "kill switch: $kill_switch"
echo "bootstrap with: launchctl bootstrap gui/\$(id -u) $target"
echo "bootout with: launchctl bootout gui/\$(id -u) $target"
