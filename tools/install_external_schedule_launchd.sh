#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
state_dir=${CROL_EXTERNAL_SCHEDULE_STATE_DIR:-"$root/.external-schedule-state"}
log_dir=${CROL_EXTERNAL_SCHEDULE_LOG_DIR:-"$state_dir/logs"}
launch_agents_dir=${HOME:?}/Library/LaunchAgents
label=com.cityscroll.external-schedules
target="$launch_agents_dir/$label.plist"

key_file=${CITYSCROLL_ADMIN_KEY_FILE:-"$state_dir/admin-key"}
# launchd resolves nothing from a login shell, so the interpreter is resolved
# here and written into the trigger absolutely. A trigger that cannot start
# exits before it can report why, and the only symptom is a missing heartbeat.
node_bin=${CITYSCROLL_NODE:-$(command -v node || true)}
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  echo "error: no executable node found; set CITYSCROLL_NODE to its absolute path" >&2
  exit 1
fi
case "$node_bin" in
  /*) ;;
  *) echo "error: CITYSCROLL_NODE must be an absolute path, got $node_bin" >&2; exit 1 ;;
esac
# Optional. Without it the cycle still proves liveness and still reconciles the
# repair queue; it simply declines the leases it could not service.
repair_command=${CITYSCROLL_REPAIR_DISPATCH_COMMAND:-}

mkdir -p "$log_dir" "$launch_agents_dir"
sed -e "s|__CITYSCROLL_ROOT__|$root|g" -e "s|__CROL_EXTERNAL_SCHEDULE_LOG_DIR__|$log_dir|g" \
  -e "s|__CITYSCROLL_NODE__|$node_bin|g" \
  -e "s|__CROL_EXTERNAL_SCHEDULE_STATE_DIR__|$state_dir|g" \
  -e "s|__CITYSCROLL_ADMIN_KEY_FILE__|$key_file|g" \
  -e "s|__CITYSCROLL_REPAIR_DISPATCH_COMMAND__|$repair_command|g" \
  "$root/ops/launchd/$label.plist.template" > "$target"

# The agent cannot publish a heartbeat without this credential, and a scheduler
# that cannot publish one is reported as a failed cycle rather than a quiet one.
if [ ! -f "$key_file" ]; then
  echo "warning: $key_file is absent; the cycle will report admin-credential-missing" >&2
  echo "  install it with: umask 177 && printf %s \"\$ADMIN_KEY\" > $key_file" >&2
fi

if [ -z "$repair_command" ]; then
  echo "note: CITYSCROLL_REPAIR_DISPATCH_COMMAND is unset; the cycle will not lease repair work" >&2
fi

launchctl unload "$target" 2>/dev/null || true
launchctl load "$target"
echo "loaded $label; state is $state_dir; credential file is $key_file; interpreter is $node_bin"
