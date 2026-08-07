#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
state_dir=${CROL_EXTERNAL_SCHEDULE_STATE_DIR:-"$root/.external-schedule-state"}
log_dir=${CROL_EXTERNAL_SCHEDULE_LOG_DIR:-"$state_dir/logs"}
launch_agents_dir=${HOME:?}/Library/LaunchAgents
label=com.cityscroll.crol-list.external-schedules
target="$launch_agents_dir/$label.plist"

mkdir -p "$log_dir" "$launch_agents_dir"
sed -e "s|__CROL_LIST_ROOT__|$root|g" -e "s|__CROL_EXTERNAL_SCHEDULE_LOG_DIR__|$log_dir|g" \
  "$root/ops/launchd/$label.plist.template" > "$target"

launchctl unload "$target" 2>/dev/null || true
launchctl load "$target"
echo "loaded $label; state is $state_dir"
