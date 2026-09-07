# Independent correctness monitors

The scheduled monitors for action links, civic-data source contracts, and digest-shadow readiness are owned by the external scheduler described in `tools/external_schedule_jobs.json`. GitHub Actions retains only the explicitly manual official roll-call tranche and migration-marker workflows; it is not the scheduler or issue-loop owner for these monitors.

Each run writes a result under `CROL_EXTERNAL_SCHEDULE_STATE_DIR` and an issue intent under its `outbox/` directory. The event id is derived from the monitor id and scheduled slot. Replay adds a marker to every issue mutation, checks existing comments before creating one, and closes the managed issue after recovery. A GitHub API outage therefore leaves the result and pending intent locally for a later replay without duplicating comments.

The scheduler can be run by launchd or cron. For launchd, set `CROL_EXTERNAL_SCHEDULE_STATE_DIR` and run `tools/install_external_schedule_launchd.sh` on the independent host. The runner also accepts `--job <id>` for a manual rehearsal and `--state-dir <path>` for a disposable test state directory. Its GitHub token is the issue loop's delivery identity: a dedicated account's fine-grained token scoped to Issues read/write on this repository only, and nothing else. It reaches the runner the same way the admin key does, as a path rather than a value: set `GH_TOKEN_FILE` (or `GITHUB_TOKEN_FILE`) to a file holding only the token, owned by the scheduler account and mode 0600 (`umask 177 && printf %s "$GH_TOKEN" > "$GH_TOKEN_FILE"`). `tools/install_external_schedule_launchd.sh` writes that path into the trigger alongside `CITYSCROLL_ADMIN_KEY_FILE`, so no secret is ever written into the plist. Configuring the variable makes the file authoritative for the whole cycle: a file that is absent, empty, unreadable, not a regular file, or readable by more than its owner resolves to no token and is never quietly replaced by an inline `GH_TOKEN`/`GITHUB_TOKEN` export or by an interactive GitHub CLI session on the host, so a misinstalled credential cannot file or close an issue under a person's account. An inline export is honoured only where no file variable is configured at all, which is how a workstation rehearsal still runs. Without a usable token the runner logs one line naming the variable and the failure class and nothing else, the cycle's replay summary carries `status: offline` with that reason, every pending intent keeps its attempt count and stays retryable, and the heartbeat reports `outbox_delivery: "offline"` with the same reason so a backlog is visibly undeliverable rather than merely unattempted. A cycle that did load a token reports `outbox_delivery: "credentialed"`, which states only that: naming a path, or holding a submitted credential, is never evidence that the identity is installed, correct, or accepted, and only a delivery attempt or the read-only checks below can establish that. The same cycle also reports `outbox_delivery_identity` (`app` or `file`) and `outbox_delivery_token_expires_at`, because two cycles can both read `credentialed` while writing under entirely different authorities; the identity kind is what tells them apart, and a moving expiry is what shows an App cycle still refreshing. `LEGISTAR_API_TOKEN` and `CITYSCROLL_ADMIN_KEY` are read from the scheduler environment when the corresponding live probes require them. Each invocation publishes a heartbeat to the private Worker reliability endpoint (override with `CITYSCROLL_SCHEDULER_HEARTBEAT_URL`); the independent hourly check alerts the ops mailbox when the heartbeat expires or the local outbox is non-empty.

Verification:

```bash
node --test test/external_schedule_trigger.test.mjs test/external_schedule_outbox.test.mjs \
  test/github_app_identity.test.mjs test/repair_dispatch.test.mjs
node --test worker/test/reliability_watchdogs.test.mjs
node tools/audit_scheduler_ownership.mjs --check
```

The heartbeat has exactly one producer, so a trigger that cannot start, cannot read its credential, or cannot run often enough presents only as a missing heartbeat with nothing else to act on. `test/external_schedule_trigger.test.mjs` holds the trigger to that contract: it must publish at least twice inside the watchdog's heartbeat window, name the state directory, credential file, and heartbeat route it cannot inherit from a login shell, and declare no placeholder the installer does not substitute.

## The GitHub App delivery identity

The site owner has chosen a GitHub App, not a machine user, as the identity the issue loop writes under. A machine user is an account: it has a password, a session, a recovery address, a seat, and a person who is ultimately responsible for it, and every one of those is a thing to secure and to hand over. An App installed on this repository alone is none of them. Its authority is an installation rather than an account, its permissions are declared once and repeated in the response to every mint, and the credential that actually authorizes a request is an installation token that expires in about an hour — so a leaked log line or a stale copy stops being useful without anyone having to revoke anything. The long-lived secret stays a private key on the scheduler host, is never transmitted, and only signs the short assertion the runner exchanges for a token.

The App is private, installed on `cityscroll/cityscroll-app` only, with repository permissions Issues: write and Metadata: read and nothing else. That is exactly the reach the issue loop needs: it opens, comments on, and closes the managed monitor issues, and it can do nothing else here.

The operator installs three files, and this repository holds none of them. Creating the App, generating its key, and installing the files is an estate process outside this repository; what matters here is what the runner reads:

| Variable | File contents | Requirement |
| --- | --- | --- |
| `GH_APP_ID_FILE` | the App's numeric id | regular file, mode 0600 or stricter, owned by the scheduler account |
| `GH_APP_INSTALLATION_ID_FILE` | the numeric id of this repository's installation | same |
| `GH_APP_PRIVATE_KEY_FILE` | the App's RSA private key in PEM form | same |

They are read with the same discipline as the token file, and they are configured as a set. Naming any one of the three selects the App identity for the whole cycle: `GH_TOKEN_FILE` is not consulted while it is configured, and a file that is absent, empty, unreadable, not a regular file, readable by more than its owner, or not in the form the credential requires — a non-numeric id, a PEM no parser accepts, a key that is not RSA — resolves to no App credential at all. So does one of the three variables being left unset while the others are named. Each of those reports offline naming the variable and the failure class and nothing else, exactly as the token path does, and never falls back to another identity. A half-installed App must not deliver monitor findings under whatever other credential the host happens to carry. With none of the three configured, the file-token path below behaves exactly as it did before, which is what keeps a workstation rehearsal running.

Minting happens inside the cycle. The runner signs a short-lived RS256 assertion from the PEM with Node's own crypto, backdated by a clock-skew margin so ordinary host drift does not get it rejected, and exchanges it for an installation access token scoped to this repository. The token is held in memory for the process only, and is re-minted when it comes within five minutes of expiry, so a cycle that spends ten minutes in a bounded repair task does not lose its identity halfway through a replay. On each mint the runner asserts against the response itself that the installation covers `cityscroll/cityscroll-app` and that the permissions include `issues: write`; if either fails, the cycle treats it as no credential and reports the reason rather than attempting a delivery under an identity nobody intended. The assertion, the token, and the key are never logged. What the cycle publishes about the identity is the App id, the installation id, the permission set GitHub reported, and the token expiry — enough to tell two identities apart and to see a refresh happen, and nothing that could be replayed by whoever reads it.

### Verifying the App before anything is delivered

Read-only, on the scheduler host, as the scheduler account. Mint one token by hand and interrogate it; nothing below mutates an issue.

```bash
# Who the App is, from its own credentials. Expect the App the owner created.
node -e '
  import("./tools/github_app_identity.mjs").then(async (m) => {
    const resolved = m.resolveGitHubAppCredential();
    if (resolved.failure) throw new Error(`${resolved.variable}: ${resolved.failure}`);
    const source = m.createInstallationTokenSource({
      credential: resolved.credential, owner: "cityscroll", repo: "cityscroll-app",
    });
    await source.token();
    console.log(JSON.stringify({ ...source.summary(), failure: source.failure }, null, 2));
  });
'
```

Expect `identity_kind: "app"`, the App and installation ids the owner installed, `repository_selection: "selected"`, `permissions` reading exactly `["issues:write", "metadata:read"]`, and a `token_expires_at` about an hour ahead. A `failure` of `repository-not-covered` means the App is installed somewhere other than this repository; `issues-write-missing` means its permissions were never granted or never accepted; `exchange-refused:401` means the key does not match the App id.

Then confirm the App as GitHub sees it, and that the Issues write it will actually use is available:

```bash
# What the App is, and where it is installed. Expect one installation.
gh api /app --jq '{slug, name, permissions}'            # signed as the App
gh api /app/installations --jq '.[] | {id, repository_selection, account: .account.login}'
# The Issues-write dry run: a create with no title is refused at validation,
# after authorization, so a 422 proves the write is authorized without filing
# anything. A 403 or 404 means it is not.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $INSTALLATION_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{}' https://api.github.com/repos/cityscroll/cityscroll-app/issues
```

Stop if the installation is on any account or repository other than `cityscroll/cityscroll-app`, if the permission set carries anything beyond issue write and metadata read, or if the dry run does not return 422. A wrong App is discovered without an issue having been filed under it.

Finally run one cycle in the foreground and read what it says about the identity it used:

```bash
node tools/external_schedule_runner.mjs --state-dir "$CROL_EXTERNAL_SCHEDULE_STATE_DIR" | jq '.delivery'
jq '{outbox_delivery, outbox_delivery_identity, outbox_delivery_token_expires_at, outbox_delivery_reason}' \
  "$CROL_EXTERNAL_SCHEDULE_STATE_DIR/heartbeat/latest.json"
```

The file-backed token path is not removed. It stays the rehearsal identity: a workstation running one cycle by hand does not need an App key on it, and a deployment already on a token keeps working until its three App files are installed.

## Activating issue delivery

Code and fixtures ship ahead of the account. Until the delivery credential is installed and verified, the runner stays deliberately offline: it keeps observing, keeps writing results and intents, and states on every cycle that it has no identity to deliver them with. That is the intended resting state, not a fault to chase.

Activate it only once the credential's own installation receipt reads installed. In order, on the scheduler host, as the scheduler account:

1. **Wire the verified path.** For the App identity, install the three files so only that account can read them, then point the trigger at them and reload. For the rehearsal identity, install the token the same way:

   ```bash
   # The App identity: three mode-0600 files, installed by the estate ceremony.
   GH_APP_ID_FILE="$GH_APP_ID_FILE" \
   GH_APP_INSTALLATION_ID_FILE="$GH_APP_INSTALLATION_ID_FILE" \
   GH_APP_PRIVATE_KEY_FILE="$GH_APP_PRIVATE_KEY_FILE" \
     tools/install_external_schedule_launchd.sh

   # The rehearsal identity, where no App is configured.
   umask 177 && printf %s "$GH_TOKEN" > "$GH_TOKEN_FILE"
   GH_TOKEN_FILE="$GH_TOKEN_FILE" tools/install_external_schedule_launchd.sh
   ```

   The installer writes the paths, never the values, and warns if a file is absent, if one of the three App variables is unset while the others are named, or if any of them is readable by more than its owner. Neither the path nor the warning is evidence of a working credential.

2. **Verify the identity before anything is delivered**, using read-only requests only. For the App identity, use the checks above. For the rehearsal token, the account must be the dedicated delivery account and not a person, and its permission on this repository must be exactly what the issue loop needs:

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

Until step 2 passes, record the deployment as credential-waiting. There is no substitute identity: an operator's own token would file monitor findings under a person, which is the outcome the file-backed credential discipline exists to prevent.

The remaining daily data-freshness jobs (`attachment-metadata`, `surface-load-live`, and `multi-flywheel`) remain listed as follow-ups in the job manifest.
