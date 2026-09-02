#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
state_dir=${CROL_EXTERNAL_SCHEDULE_STATE_DIR:-"$root/.external-schedule-state"}
log_dir=${CROL_EXTERNAL_SCHEDULE_LOG_DIR:-"$state_dir/logs"}
launch_agents_dir=${HOME:?}/Library/LaunchAgents
label=com.cityscroll.external-schedules
target="$launch_agents_dir/$label.plist"

key_file=${CITYSCROLL_ADMIN_KEY_FILE:-"$state_dir/admin-key"}

mkdir -p "$log_dir" "$launch_agents_dir"
sed -e "s|__CITYSCROLL_ROOT__|$root|g" -e "s|__CROL_EXTERNAL_SCHEDULE_LOG_DIR__|$log_dir|g" \
  -e "s|__CROL_EXTERNAL_SCHEDULE_STATE_DIR__|$state_dir|g" \
  -e "s|__CITYSCROLL_ADMIN_KEY_FILE__|$key_file|g" \
  "$root/ops/launchd/$label.plist.template" > "$target"

# The agent cannot publish a heartbeat without this credential, and a scheduler
# that cannot publish one is reported as a failed cycle rather than a quiet one.
if [ ! -f "$key_file" ]; then
  echo "warning: $key_file is absent; the cycle will report admin-credential-missing" >&2
  echo "  install it with: umask 177 && printf %s \"\$ADMIN_KEY\" > $key_file" >&2
fi

launchctl unload "$target" 2>/dev/null || true
launchctl load "$target"
echo "loaded $label; state is $state_dir; credential file is $key_file"
