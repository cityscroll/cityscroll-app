#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
state_dir=${CROL_EXTERNAL_SCHEDULE_STATE_DIR:-"$root/.external-schedule-state"}
log_dir=${CROL_EXTERNAL_SCHEDULE_LOG_DIR:-"$state_dir/logs"}
launch_agents_dir=${HOME:?}/Library/LaunchAgents
label=com.cityscroll.external-schedules
target="$launch_agents_dir/$label.plist"

key_file=${CITYSCROLL_ADMIN_KEY_FILE:-"$state_dir/admin-key"}
# The issue loop's delivery identity. Only the path is written into the trigger;
# the token itself stays in a mode-0600 file installed by a separate operator
# step. Without it the cycle still runs and still records intents locally, and
# it now says so instead of leaving them silently undelivered.
gh_token_file=${GH_TOKEN_FILE:-"$state_dir/github-token"}
# The same delivery identity in its GitHub App form. These are passed through
# exactly as configured and are never defaulted to a path: naming any one of
# them selects the App identity for the whole cycle, so inventing the other two
# here would turn a partly configured App into a path the operator never chose.
# Left unset, all three are written empty and the cycle keeps using the token
# file exactly as before.
gh_app_id_file=${GH_APP_ID_FILE:-}
gh_app_installation_id_file=${GH_APP_INSTALLATION_ID_FILE:-}
gh_app_private_key_file=${GH_APP_PRIVATE_KEY_FILE:-}
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
  -e "s|__GH_TOKEN_FILE__|$gh_token_file|g" \
  -e "s|__GH_APP_ID_FILE__|$gh_app_id_file|g" \
  -e "s|__GH_APP_INSTALLATION_ID_FILE__|$gh_app_installation_id_file|g" \
  -e "s|__GH_APP_PRIVATE_KEY_FILE__|$gh_app_private_key_file|g" \
  -e "s|__CITYSCROLL_REPAIR_DISPATCH_COMMAND__|$repair_command|g" \
  "$root/ops/launchd/$label.plist.template" > "$target"

# The agent cannot publish a heartbeat without this credential, and a scheduler
# that cannot publish one is reported as a failed cycle rather than a quiet one.
if [ ! -f "$key_file" ]; then
  echo "warning: $key_file is absent; the cycle will report admin-credential-missing" >&2
  echo "  install it with: umask 177 && printf %s \"\$ADMIN_KEY\" > $key_file" >&2
fi

# Configuring a path is not installing a credential, and this script never
# checks one. It reports what it can see about the file so the operator is not
# left inferring readiness from the fact that the trigger names a path.
app_configured=0
for app_file in "$gh_app_id_file" "$gh_app_installation_id_file" "$gh_app_private_key_file"; do
  if [ -n "$app_file" ]; then app_configured=1; fi
done

if [ "$app_configured" = 1 ]; then
  # The App identity is configured as a set of three. A partly named set is a
  # half-installed identity, and the cycle reports it offline rather than
  # delivering under the token file, so say so here rather than at the next run.
  for pair in "GH_APP_ID_FILE=$gh_app_id_file" "GH_APP_INSTALLATION_ID_FILE=$gh_app_installation_id_file" "GH_APP_PRIVATE_KEY_FILE=$gh_app_private_key_file"; do
    name=${pair%%=*}
    path=${pair#*=}
    if [ -z "$path" ]; then
      echo "warning: $name is unset while the other GitHub App variables are configured; the cycle will report outbox delivery offline" >&2
      continue
    fi
    if [ ! -f "$path" ]; then
      echo "warning: $name names a file that is absent; the cycle will report outbox delivery offline" >&2
    elif [ -n "$(find "$path" -perm +077 2>/dev/null)" ]; then
      echo "warning: $name names a file readable by more than its owner; the cycle will refuse it and report outbox delivery offline" >&2
      echo "  tighten it with: chmod 600 $path" >&2
    fi
  done
  echo "note: the GitHub App identity is authoritative for the whole cycle; GH_TOKEN_FILE is not consulted while it is configured" >&2
fi

if [ "$app_configured" = 0 ] && [ ! -f "$gh_token_file" ]; then
  echo "warning: no delivery credential file is present at the configured path; the cycle will report outbox delivery offline and record intents without delivering them" >&2
  echo "  install it with: umask 177 && printf %s \"\$GH_TOKEN\" > $gh_token_file" >&2
elif [ "$app_configured" = 0 ] && [ -n "$(find "$gh_token_file" -perm +077 2>/dev/null)" ]; then
  # A token any local account can read is not a machine identity, so the cycle
  # refuses it outright rather than using it.
  echo "warning: the delivery credential file is readable by more than its owner; the cycle will refuse it and report outbox delivery offline" >&2
  echo "  tighten it with: chmod 600 $gh_token_file" >&2
fi

if [ -z "$repair_command" ]; then
  echo "note: CITYSCROLL_REPAIR_DISPATCH_COMMAND is unset; the cycle will not lease repair work" >&2
fi

launchctl unload "$target" 2>/dev/null || true
launchctl load "$target"
if [ "$app_configured" = 1 ]; then
  echo "loaded $label; state is $state_dir; credential file is $key_file; delivery identity is the GitHub App named by GH_APP_ID_FILE, GH_APP_INSTALLATION_ID_FILE and GH_APP_PRIVATE_KEY_FILE; interpreter is $node_bin"
else
  echo "loaded $label; state is $state_dir; credential file is $key_file; delivery token file is $gh_token_file; interpreter is $node_bin"
fi
echo "these are configured paths, not verified credentials: the cycle reports outbox delivery offline until it can read the delivery credential, and the delivery identity is confirmed by the read-only checks in docs/external-schedule-outbox.md" >&2
