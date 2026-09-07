# Independent correctness monitors

The scheduled monitors for action links, civic-data source contracts, and digest-shadow readiness are owned by the external scheduler described in `tools/external_schedule_jobs.json`. GitHub Actions retains only the explicitly manual official roll-call tranche and migration-marker workflows; it is not the scheduler or issue-loop owner for these monitors.

Each run writes a result under `CROL_EXTERNAL_SCHEDULE_STATE_DIR` and an issue intent under its `outbox/` directory. The event id is derived from the monitor id and scheduled slot. Replay adds a marker to every issue mutation, checks existing comments before creating one, and closes the managed issue after recovery. A GitHub API outage therefore leaves the result and pending intent locally for a later replay without duplicating comments.

The scheduler can be run by launchd or cron. For launchd, set `CROL_EXTERNAL_SCHEDULE_STATE_DIR` and run `tools/install_external_schedule_launchd.sh` on the independent host. The runner also accepts `--job <id>` for a manual rehearsal and `--state-dir <path>` for a disposable test state directory. Its GitHub token is the issue loop's delivery identity: a dedicated account's fine-grained token scoped to Issues read/write on this repository only, and nothing else. It reaches the runner the same way the admin key does, as a path rather than a value: set `GH_TOKEN_FILE` (or `GITHUB_TOKEN_FILE`) to a file holding only the token, owned by the scheduler account and mode 0600 (`umask 177 && printf %s "$GH_TOKEN" > "$GH_TOKEN_FILE"`). `tools/install_external_schedule_launchd.sh` writes that path into the trigger alongside `CITYSCROLL_ADMIN_KEY_FILE`, so no secret is ever written into the plist. Configuring the variable makes the file authoritative for the whole cycle: a file that is absent, empty, unreadable, not a regular file, or readable by more than its owner resolves to no token and is never quietly replaced by an inline `GH_TOKEN`/`GITHUB_TOKEN` export or by an interactive GitHub CLI session on the host, so a misinstalled credential cannot file or close an issue under a person's account. An inline export is honoured only where no file variable is configured at all, which is how a workstation rehearsal still runs. Without a usable token the runner logs one line naming the variable and the failure class and nothing else, the cycle's replay summary carries `status: offline` with that reason, every pending intent keeps its attempt count and stays retryable, and the heartbeat reports `outbox_delivery: "offline"` with the same reason so a backlog is visibly undeliverable rather than merely unattempted. A cycle that did load a token reports `outbox_delivery: "credentialed"`, which states only that: naming a path, or holding a submitted credential, is never evidence that the identity is installed, correct, or accepted, and only a delivery attempt or the read-only checks below can establish that. `LEGISTAR_API_TOKEN` and `CITYSCROLL_ADMIN_KEY` are read from the scheduler environment when the corresponding live probes require them. Each invocation publishes a heartbeat to the private Worker reliability endpoint (override with `CITYSCROLL_SCHEDULER_HEARTBEAT_URL`); the independent hourly check alerts the ops mailbox when the heartbeat expires or the local outbox is non-empty.

Verification:

```bash
node --test test/external_schedule_trigger.test.mjs test/external_schedule_outbox.test.mjs test/repair_dispatch.test.mjs
node --test worker/test/reliability_watchdogs.test.mjs
node tools/audit_scheduler_ownership.mjs --check
```

The heartbeat has exactly one producer, so a trigger that cannot start, cannot read its credential, or cannot run often enough presents only as a missing heartbeat with nothing else to act on. `test/external_schedule_trigger.test.mjs` holds the trigger to that contract: it must publish at least twice inside the watchdog's heartbeat window, name the state directory, credential file, and heartbeat route it cannot inherit from a login shell, and declare no placeholder the installer does not substitute.

## Activating issue delivery

Code and fixtures ship ahead of the account. Until the delivery credential is installed and verified, the runner stays deliberately offline: it keeps observing, keeps writing results and intents, and states on every cycle that it has no identity to deliver them with. That is the intended resting state, not a fault to chase.

Activate it only once the credential's own installation receipt reads installed. In order, on the scheduler host, as the scheduler account:

1. **Wire the verified path.** Install the token into a file only that account can read, then point the trigger at it and reload:

   ```bash
   umask 177 && printf %s "$GH_TOKEN" > "$GH_TOKEN_FILE"
   GH_TOKEN_FILE="$GH_TOKEN_FILE" tools/install_external_schedule_launchd.sh
   ```

   The installer writes the path, never the value, and warns if the file is absent or readable by more than its owner. Neither the path nor the warning is evidence of a working credential.

2. **Verify the identity before anything is delivered**, using read-only requests only. The account must be the dedicated delivery account and not a person, and its permission on this repository must be exactly what the issue loop needs:

   ```bash
   token=$(cat "$GH_TOKEN_FILE")
   # Who the token actually is.
   curl -sS -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" \
     https://api.github.com/user | jq '{login, type}'
   # What it may do here. Expect issues true, push/admin false.
   curl -sS -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/cityscroll/cityscroll-app | jq '{full_name, has_issues, permissions}'
   # That it can read the issue list it will later write to.
   curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $token" \
     'https://api.github.com/repos/cityscroll/cityscroll-app/issues?state=open&per_page=1'
   ```

   Stop here if the login is not the delivery account, if the repository is not `cityscroll/cityscroll-app`, or if the token carries any permission beyond issue read/write. None of these requests mutates anything, so a wrong credential is discovered without an issue having been filed under it.

3. **Enable replay.** Replay is not a separate switch: the next cycle sees a readable token, reports `outbox_delivery: "credentialed"`, and drains the pending intents that accumulated while delivery was offline. Run one cycle in the foreground first and read its summary, then confirm the heartbeat agrees:

   ```bash
   node tools/external_schedule_runner.mjs --state-dir "$CROL_EXTERNAL_SCHEDULE_STATE_DIR"
   jq '{outbox_delivery, outbox_delivery_reason, pending_outbox}' \
     "$CROL_EXTERNAL_SCHEDULE_STATE_DIR/heartbeat/latest.json"
   ```

   Markers make that first drain safe: every intent is matched against existing issues and comments before it writes, so a backlog replays without duplicating anything.

Until step 2 passes, record the deployment as credential-waiting. There is no substitute account: an operator's own token would file monitor findings under a person, which is the outcome the file-backed identity exists to prevent.

The remaining daily data-freshness jobs (`attachment-metadata`, `surface-load-live`, and `multi-flywheel`) remain listed as follow-ups in the job manifest.
