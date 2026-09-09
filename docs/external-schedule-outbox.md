# Independent correctness monitors

The scheduled monitors for action links, civic-data source contracts, and digest-shadow readiness are owned by the external scheduler described in `tools/external_schedule_jobs.json`. GitHub Actions retains only the explicitly manual official roll-call tranche and migration-marker workflows; it is not the scheduler or issue-loop owner for these monitors.

Each run writes a result under `CROL_EXTERNAL_SCHEDULE_STATE_DIR` and an issue intent under its `outbox/` directory. The event id is derived from the monitor id and scheduled slot. Replay adds a marker to every issue mutation, checks existing comments before creating one, and closes the managed issue after recovery. A GitHub API outage therefore leaves the result and pending intent locally for a later replay without duplicating comments.

The scheduler can be run by launchd or cron. For launchd, set `CROL_EXTERNAL_SCHEDULE_STATE_DIR` and run `tools/install_external_schedule_launchd.sh` on the independent host. The runner also accepts `--job <id>` for a manual rehearsal and `--state-dir <path>` for a disposable test state directory. Its GitHub token is the issue loop's delivery identity: a dedicated account's fine-grained token scoped to Issues read/write on this repository only, and nothing else. It reaches the runner the same way the admin key does, as a path rather than a value: set `GH_TOKEN_FILE` (or `GITHUB_TOKEN_FILE`) to a file holding only the token, owned by the scheduler account and mode 0600 (`umask 177 && printf %s "$GH_TOKEN" > "$GH_TOKEN_FILE"`). `tools/install_external_schedule_launchd.sh` writes that path into the trigger alongside `CITYSCROLL_ADMIN_KEY_FILE`, so no secret is ever written into the plist. Configuring the variable makes the file authoritative for the whole cycle: a file that is absent, empty, unreadable, not a regular file, or readable by more than its owner resolves to no token and is never quietly replaced by an inline `GH_TOKEN`/`GITHUB_TOKEN` export or by an interactive GitHub CLI session on the host, so a misinstalled credential cannot file or close an issue under a person's account. An inline export is honoured only where no file variable is configured at all, which is how a workstation rehearsal still runs. Without a usable token the runner logs one line naming the variable and the failure class and nothing else, the cycle's replay summary carries `status: offline` with that reason, every pending intent keeps its attempt count and stays retryable, and the heartbeat reports `outbox_delivery: "offline"` with the same reason so a backlog is visibly undeliverable rather than merely unattempted. A cycle that did load a token reports `outbox_delivery: "credentialed"`, which states only that: naming a path, or holding a submitted credential, is never evidence that the identity is installed, correct, or accepted, and only a delivery attempt or the read-only checks below can establish that. The same cycle also reports `outbox_delivery_identity` (`app` or `file`) and `outbox_delivery_token_expires_at`, because two cycles can both read `credentialed` while writing under entirely different authorities; the identity kind is what tells them apart, and a moving expiry is what shows an App cycle still refreshing. `LEGISTAR_API_TOKEN` and `CITYSCROLL_ADMIN_KEY` are read from the scheduler environment when the corresponding live probes require them. Each invocation publishes a heartbeat to the private Worker reliability endpoint (override with `CITYSCROLL_SCHEDULER_HEARTBEAT_URL`); the independent hourly check alerts the ops mailbox when the heartbeat expires or the local outbox is non-empty.

The `stats-daily-snapshot-monitor` distinguishes two publication states. With no stored day
and no verified instant, `publisher-not-yet-delivered` means the daily search-use summary
has not been published yet: the producing work is the search-usage summary on the Stats page.
This state has no promised day, missing-days list, or retention-loss count, and creates no
repair item or judgment email. Its issue uses the same identity as a missed snapshot; replay
updates the existing title and body to correct an earlier loss diagnosis, without opening a
duplicate. The ordinary recovery path closes it once publication satisfies the daily promise.

Once a stored day or verified instant exists, an absent promised day remains
`missing-daily-aggregate` (or `frozen-publisher` when a recent verification claims success).
The existing grace period, dated gaps, and receipt-retention arithmetic apply in this state,
and actual failures continue through the repair classification. A verification alone cannot
prove that the promised dated aggregate exists.

Verification:

```bash
node --test test/external_schedule_trigger.test.mjs test/external_schedule_outbox.test.mjs \
  test/github_app_identity.test.mjs test/repair_dispatch.test.mjs \
  test/repair_findings.test.mjs test/repair_playbooks.test.mjs test/repair_dispatch_wiring.test.mjs
node --test worker/test/reliability_watchdogs.test.mjs worker/test/repair_queue.test.mjs \
  worker/test/repair_monitor_findings.test.mjs
node tools/audit_scheduler_ownership.mjs --check
```

The heartbeat has exactly one producer, so a trigger that cannot start, cannot read its credential, or cannot run often enough presents only as a missing heartbeat with nothing else to act on. `test/external_schedule_trigger.test.mjs` holds the trigger to that contract: it must publish at least twice inside the watchdog's heartbeat window, name the state directory, credential file, and heartbeat route it cannot inherit from a login shell, and declare no placeholder the installer does not substitute.

## Scheduled slots and the slot ledger

The trigger polls on an interval rather than firing at a wall-clock instant, so the clock a cycle samples is not the clock a slot is promised at. A cycle starts a fixed interval after the previous one exited, which means its sample slides forward by however long that cycle took; once the slide crosses a minute boundary an entire wall-clock minute passes with no cycle in it. Deciding due-ness by matching a cron expression against that single sample therefore lost whole slots: a daily job whose only slot fell in the skipped minute did not run, wrote no result, and left nothing behind saying it had been owed one.

Each job now keeps a ledger at `<state-dir>/jobs/<job-id>/schedule.json` naming the last slot it settled. A cycle asks which of the job's slots have passed since then and accounts for every one:

- The newest outstanding slot runs, keyed by the slot rather than by the minute the cycle woke up, so a late run settles the promise instead of opening a second event for it.
- Every older slot is written to `<state-dir>/missed/<job-id>/<slot>.json` with `reason: superseded-by-a-later-slot`. Only the newest runs, because these are monitors and a later observation subsumes an earlier one; replaying each skipped slot would report the same present state repeatedly and comment on the same issue twice.
- A ledger further behind than `SLOT_CATCH_UP_MINUTES` (26 hours) records `outside-the-catch-up-window` naming the stretch it declined to evaluate, then catches up to the newest slot in one run.
- A runner that throws records `runner-error` with the redacted reason and the cycle continues. Before the ledger, an exception in one job ended the whole cycle, so the remaining jobs, the outbox replay and the liveness heartbeat never happened and one broken job presented as a dead scheduler.

Whatever a cycle settled without running also travels on the heartbeat as `missed_slots` and is stored with it, so a reader of the reliability endpoint can tell "nothing was due" from "something was due and never happened".

A job with no ledger adopts the newest slot strictly before now and runs nothing. A fresh state directory therefore neither fires every job at once nor claims slots the trigger was not installed for. `--job <id>` still runs immediately and deliberately leaves the ledger alone: an operator rehearsal observes the world now, and neither claims nor consumes a scheduled slot.

## The Notice synthetic probe runtime

The Notice synthetic probe is the one scheduled job that drives a browser, so it is the one job whose runtime the trigger cannot assume. launchd starts the cycle with the system default `PATH` and no login shell, and the interpreter that resolves there is the operating system's own, which carries no Playwright. The probe therefore exited on its import line before it could measure anything, and the failure presented as an ordinary failed slot: the same shape a genuinely unreachable page produces.

The runtime is now the checkout's own, built once per host:

```bash
tools/setup_notice_probe_runtime.sh
```

That script creates a virtual environment at `ops/notice-probe/.venv` from `ops/notice-probe/requirements.txt`, installs it with `--no-deps` so the resolver picks nothing, and installs the browser build under `ops/notice-probe/browsers` rather than into the shared `~/.cache/ms-playwright`. Every distribution in that requirements file is pinned exactly, and the Playwright pin is deliberately the same one the repository's browser gate uses, so the scheduled measurement and the gate exercise the same Chromium build. The browser build is pinned transitively by that Playwright version rather than named separately: `playwright==1.58.0` resolves to Chromium build `chromium-1208`, browser version `145.0.7632.6`, which is recorded beside the pin and is what every slot measures with. It is idempotent: re-running it repairs a partial environment and is how the pin is moved. Nothing is installed globally or into a user site directory, so removing the two directories removes the whole install. Both, along with the receipt naming what was actually installed, are ignored by git — the pinned requirements file is the tracked part, and the receipt is host state.

The cycle names that interpreter absolutely, as `ops/notice-probe/.venv/bin/python3` relative to the checkout, rather than searching a `PATH`. `CROL_NOTICE_SYNTHETIC_PROBE_PYTHON` still overrides it verbatim for a rehearsal against another environment.

A missing runtime is a setup fault, not a measurement, and it now says so. Before spawning anything the cycle checks that the interpreter exists, and where it does not, the slot log's first line reads `probe runtime not set up: run tools/setup_notice_probe_runtime.sh` followed by the path it looked at. The probe reports the same named error for itself: an environment with no Playwright, or one with Playwright and no browser build, both exit with that line and the specific reason in parentheses. One named error covers every way the runtime can be absent, because one command repairs all of them. `tools/install_external_schedule_launchd.sh` reports the same thing at install time, alongside the credential warnings, so an operator is told before the first slot rather than by it.

After setup, two invocations check the runtime without contributing to the retained series:

```bash
ops/notice-probe/.venv/bin/python3 tools/run_notice_synthetic_probe.py --plan
ops/notice-probe/.venv/bin/python3 tools/run_notice_synthetic_probe.py --check-runtime
```

`--plan` resolves the visit plan with no browser and no network. `--check-runtime` starts and stops the browser, reports the build it launched, and visits no page, so it proves the environment the next slot will use while emitting no observation. Neither claims or consumes a scheduled slot; a full slot is left to the schedule.

Verification:

```bash
node --test test/notice_synthetic_probe.test.mjs
```

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

Minting happens inside the cycle. The runner signs a short-lived RS256 assertion from the PEM with Node's own crypto, backdated by a clock-skew margin so ordinary host drift does not get it rejected, and exchanges it for an installation access token. The token is held in memory for the process only, and is re-minted when it comes within five minutes of expiry, so a cycle that spends ten minutes in a bounded repair task does not lose its identity halfway through a replay.

The grant the runner accepts is exact, not sufficient: the installation must reach `cityscroll/cityscroll-app` and no other repository, and carry `issues: write` and `metadata: read` and no other permission. Anything broader — a second repository, an installation on all repositories, an extra permission — resolves to no credential for the whole cycle, reported by class, exactly as a missing one does. This is the same contract the credential's intake ceremony asserted when it was installed, checked again by the process that uses it, so a grant widened afterwards cannot go unnoticed.

Asserting that requires reading the installation rather than the request. The exchange therefore asks for nothing in particular: a mint that narrowed the token would be answered with the narrowing echoed back, and an installation granted far more than this identity should hold would still mint a response that looked exactly right. The unscoped response states the installation's own permissions and selection, and one further read of `/installation/repositories` — once per mint, so roughly once an hour — states the repository list, which no mint response carries. The token that results is exactly as broad as the installation, which the assertions have just established is the agreed scope.

A cycle proves its App identity before it delivers anything. A grant that is not the agreed one takes the whole cycle offline with the class as its reason, so no finding is ever filed under an authority nobody agreed to, and every pending intent keeps its attempt count exactly as it was. The assertion, the token, and the key are never logged, written to any file the cycle produces, or carried in any error message. What the cycle publishes about the identity is the App id, the installation id, the permission set and repository list GitHub reported, any failure class, and the token expiry — enough to tell two identities apart and to see a refresh happen, and nothing that could be replayed by whoever reads it.

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
    await source.ensure();
    console.log(JSON.stringify(source.summary(), null, 2));
  });
'
```

Expect `identity_kind: "app"`, the App and installation ids the owner installed, `repository_selection: "selected"`, `permissions` reading exactly `["issues:write", "metadata:read"]`, `repositories` reading exactly `["cityscroll/cityscroll-app"]`, `failure: null`, and a `token_expires_at` about an hour ahead. A `failure` of `repository-not-covered` means the App is installed somewhere other than this repository; `repository-scope-too-broad` means it reaches this repository and at least one more, or is installed on all of them; `permissions-not-exact` means the grant is not the two agreed permissions at the two agreed levels, which includes a missing `metadata: read`; `issues-write-missing` means the one permission the loop exists to use was never granted or never accepted; `repository-list-unreadable` means the repository list could not be read back, so the scope is unproven rather than proven wrong; `exchange-refused:401` means the key does not match the App id.

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

## Checkout refresh before scheduled runs

Every `--due` invocation discovers origin's current default branch and fetches it
before running monitors or repairs. Discovery and fetch share a five-second
deadline; a stalled Git transport is terminated and the cycle continues. Only a
clean checkout already on that default branch can advance, using fast-forward
only. Dirty files (including untracked files), detached HEAD, another branch,
local commits that cannot fast-forward, failed fetches, and unresolved Git state
are refused. The runner never resets, stashes, switches branches, or forces an
update. It checks the checkout again after fetching to detect intervening edits.

The refresh lives in the `--due` entry point so the existing launchd job needs no
wrapper change. After an update, the runner starts a fresh Node process before
running any job; this reloads imported monitors and source declarations as well
as the runner itself. Manual `--job` invocations do not refresh the checkout.

The cycle receipt and scheduler heartbeat include `checkout_refresh`: status,
`revision_before`, `revision_after`, refusal `reason`, and
`consecutive_refusals`. Local refresh state is retained under
`checkout-refresh/latest.json` in the scheduler state directory. After 24
consecutive refusals, the existing issue outbox opens one **Scheduler
configuration: checkout refresh refused** issue. Continued refusals reuse that
intent; a successful refresh resets the count and closes the issue. The cycle
continues on its current revision throughout. Refresh refusal does not create a
repair-queue finding or an owner-mail alert. Keep scheduler state and logs outside
tracked files (the default state directory is ignored) so they do not make the
checkout dirty.

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

## Automatic repair

Every monitor on this schedule could already say precisely what broke. What none of them could do was fix anything, so a stale source contract or a rehearsal that failed on a gateway error waited on somebody to read an issue — and the same condition re-filed itself the next morning, and the morning after that. The site owner's decision was to close that loop deterministically: a scripted playbook rather than a model, with everything a playbook cannot close escalated rather than dropped.

The loop runs entirely on the heartbeat this cycle already publishes.

1. **A monitor run becomes queue items.** A degraded run produces one item per failure signature, carrying the same sanitized evidence its issue carries. A run that recovers reports the scope it just evaluated and what is still failing inside it, and the queue closes the rest as `recovered` — a different word from `repaired`, because a condition that went away is not a repair that worked.
2. **The queue deduplicates by signature.** A signature is `monitor:<monitor id>:<failure class>[:<subject>]`. A condition on its fifth day advances a repeat counter on the item that already exists; it never opens a fifth item, and it never re-files a second issue.
3. **The cycle leases up to three items** on the same heartbeat, spending one attempt each, and runs the dispatcher once per item with a ten-minute bound.
4. **The dispatcher selects a committed playbook from the signature alone**, runs it, and verifies by re-running the monitor's own check for that one subject. Nothing a queue record carries is ever executed: the item reaches the dispatcher on stdin, and the registry — not the item — decides what runs.
5. **What no playbook can close is reported as judgment**, which is the one outcome that mails the owner. Queueing, pickup, retry and a successful repair are all silent.
6. **A record this rail cannot read is retired rather than parked.** A judgment is a question for a person, and it is asked again each day the condition lasts. A signature that is not in the form above is not a question: no playbook could match it, no retry would change that, and no day passing would make it readable. Those retire as `unkeyable` the first time the dispatcher sees them, silently, and the same signature is not queued a second time. The finding itself still reaches its reader through the alert and the issue it always did — what stops is a queue row that could only ever report the same thing.

The slot ledger already accounts for every scheduled slot that passed, so the repair rail does not go looking for missed ones. Of the three ways a slot goes unsettled, only one is repairable: a slot that was attempted and threw recorded nothing and the ledger has already advanced past it, so no later cycle will retry it. A slot recorded as superseded or outside the catch-up window was skipped on purpose — these are monitors, a later observation subsumes an earlier one, and the newest outstanding slot ran in the same cycle — so queueing those would re-report the same present state and re-open the same issue, which is what the ledger exists to prevent. A missed-slot item therefore also carries no recovery scope: the ledger stops reporting the slot immediately, so a scope would close the item before anything could re-run it. It is closed by its own dispatch instead, which reports the slot repaired as soon as it has a recorded result.

### The exit-code contract

`CITYSCROLL_REPAIR_DISPATCH_COMMAND` names the command the cycle runs for one leased item. It is spawned with the single argument `--repair-item` and no shell, with the item as JSON on stdin, and its exit code is the whole of what it reports:

| Exit | Queue outcome | Meaning |
| --- | --- | --- |
| `0` | `repaired` | A scripted remedy ran and the monitor's own check now passes. The item retires silently. |
| `2` | `judgment` | Nothing deterministic can close it. The item parks at the judgment boundary and mails the owner once, with the summary saying what change or grant would close it. It reopens for one further attempt tomorrow if the condition is still there. |
| `3` | `unkeyable` | The signature is not in the form above, so no playbook could ever match it. The item retires silently, and that signature is not queued again. |
| anything else | `failed` | A remedy ran and did not work. The queue retries, up to three attempts, then parks it as judgment. |

The last line the command writes to stdout is the sentence the cycle reports back, bounded to 400 characters and redacted on the way through.

The installer defaults the variable to a launcher it writes beside the state directory, which execs the resolved interpreter against `tools/repair_dispatch.mjs` in the checkout the trigger already runs. That indirection exists because launchd resolves nothing through a login shell and the cycle spawns the command with no shell at all, so "node plus a script path" cannot be a single string in the trigger. Set `CITYSCROLL_REPAIR_DISPATCH_COMMAND` to another executable to override it, or to `none` to run the cycle without one — in which case the heartbeat declares `repair_dispatch: false`, the queue declines to lease rather than promising a pickup it cannot make, and every finding waits on a person exactly as it did before.

### What the identity may and may not do

The App identity this scheduler runs under carries Issues: write and Metadata: read on this repository, and nothing else. So a playbook may read the repository and run local commands on the scheduler host, and it may not push a commit, open a pull request, or trigger a workflow. A remedy that needs any of those is not a remedy here: it is exactly the case for `judgment`, and the summary names the change that would close it. No playbook may widen that boundary from inside.

### The playbook registry

The registry is `tools/repair_playbooks.mjs`, keyed by monitor and failure class. Each entry declares a precondition, an idempotent remedy, a verification that re-runs the monitor's own check, and a bounded runtime.

A stale source contract is decided from the live verifier's own two-clock finding rather than from a second measurement: the verifier already names the publisher's stamp, the vintage our retained snapshot states, and which side is behind, and the playbook reads that. Where the publisher is the stale side, no acquisition can help and the item is judgment. Where our acquisition is the stale side, the retained evidence decides: a file this repository carries needs a repository change this identity cannot make, and host state can be re-acquired here.

| Playbook | Precondition | Remedy | Verification | Judgment instead when |
| --- | --- | --- | --- | --- |
| `source-contract-stale` | the contract is registered, and the live check names our acquisition as the stale side rather than the publisher | where the retained evidence is host state, re-run the contract's acquisition path once | re-run the live source-contract check for that one contract | the publisher is the stale side, no retained vintage is declared, the retained evidence is a repository file, or the contract declares no acquisition tool |
| `missed-slot` | the monitor is still a registered scheduled job and the slot has no recorded result | re-run the slot once under its original slot key | the slot has a recorded result afterwards | the finding names a monitor this cycle no longer carries |
| `digest-shadow-upstream` | the digest rehearsal is still a registered scheduled job | wait a bounded backoff, then re-run the rehearsal once | the re-run rehearsal reports READY | the upstream is still failing after the retry, reported as degraded-upstream rather than as a failed repair |
| `freshness-stale` | a scheduled publication path that publishes acquisition receipts is registered for the watchdog's reason, and its own receipt has not advanced | re-run that publication path's scheduled command once | re-run the freshness watchdog for that one source contract | the publication path ran recently and the evidence still did not advance, or no scheduled path is registered for the reason — for which the summary names why there is none rather than reporting a run that never happened |

#### What the freshness watchdog reports, and what it does not

| Reason | Raised when | Not raised when |
| --- | --- | --- |
| `monitor-missing` | the scheduler heartbeat is absent, or older than the expected number of slots | nothing a source contract declares changes this: daily scheduler liveness is independent of source cadence, so a weekly source still needs the daily heartbeat to prove its next acquisition is intentionally not due |
| `acquisition-missing` | the contract declares an explicit acquisition cadence this repository owns — `freshness_contract.acquisition_cadence_days`, or `acquisition_cadence_days` — and the clock it is measured against is older than that cadence | the contract declares no such cadence; a publisher's own cadence prose is never read as a promise about what this repository fetches, because publisher-side freshness is judged by the live source-contract check against `max_stale_days` |

The clock `acquisition-missing` measures is `acquired_at`, except where the contract declares `clock_basis: "checked_acquired"`, for which a successful check is itself the freshness evidence and the newer of `checked_at` and `acquired_at` is used. Only a receipt carrying `clock_kind: "acquisition"` advances the acquisition clock, so a reason that can only be cleared by an acquisition is mapped at a job that publishes one, or at nothing at all with the summary saying why.

`degraded-upstream` is deliberately neither repaired nor failed. A rehearsal that fails on a gateway error from a publisher is retried once after a bounded backoff, and if the publisher is still down, more retries would learn nothing new and calling it a failed repair would name the wrong fault. It parks as judgment saying what it is, so the decision in front of the operator is whether to wait or to raise it with the publisher.

### The classes deliberately left to judgment

A failure class with no deterministic local remedy is not given a playbook that pretends otherwise. These reach a person on their first sighting rather than after three silent attempts:

| Failure class | Why no playbook |
| --- | --- |
| `source-contract-outage` | the publisher is unreachable, and nothing on this host restores a third-party endpoint |
| `source-contract-schema-drift` | the publisher changed the shape of the data, so the fix is a change to this repository's reader or its declared required fields |
| `publication-cycle-stalled` | the desk publication cycle is a separate producer, and restarting it from inside a monitor's repair would hide which of the two is stalled |
| `digest-shadow-credential` | minting or rotating a credential is never inside a repair's scope |
| `digest-shadow-degraded` | the rehearsal built something the redlines refused, and what to do about the content is an editorial decision |
| `action-link-degraded` | an outbound action link changed on the publisher's side, and choosing a replacement destination is an editorial decision |
| `stats-snapshot-missing` | the daily snapshot did not publish, and the remedy is a change to the publication path in this repository |

### What judgment means for the operator

`unkeyable` is the one outcome that is about the record rather than the condition, and it is why the signature form is a contract rather than a convention. Findings reach this queue from more than one producer, and a producer that keys on something else — free prose, a digest, a count that changes each time it is observed — writes rows the dispatcher can lease and can never act on. Parking those as judgment mails an owner a question with no answer, once a day, for as long as the record exists; retiring them says the true thing once and stops.

A judgment is one mail per guard and failure class, naming what failed, since when, how many attempts were made, what the attempt reported, and the run and receipt to look at. Where one condition parked several subjects, that mail lists them — sorted, and counted rather than enumerated past the first few — because the decision in front of the owner is the same one for all of them. The grouping belongs to the mail alone: each subject keeps its own queue item, its own attempt counter, and its own receipts, and each closes on its own when the monitor stops reporting it. The queue then parks the item and stops retrying it for the rest of the day, so a condition firing every few minutes cannot spin the loop against work somebody has been asked to decide. If it is still happening tomorrow it gets one further bounded attempt, on the same rhythm the alert loop already uses to re-surface a finding that has not gone away.

Every attempt also leaves a local receipt at `$CROL_EXTERNAL_SCHEDULE_STATE_DIR/repair/receipts/<signature>.json` — the last ten attempts for that signature, newest first, each with its outcome and its verification result — so an operator can see what was tried without the mail. The cycle's own summary reports how many findings it observed, how many it queued, how many it closed, and what its repairs did:

```bash
jq '{repair_observed, repair_queued, repair_closed, repair_leased, repair_reported}' \
  "$CROL_EXTERNAL_SCHEDULE_STATE_DIR/heartbeat/latest.json"
jq '{latest_outcome, attempt_count, attempts: [.attempts[] | {observed_at, outcome, summary}]}' \
  "$CROL_EXTERNAL_SCHEDULE_STATE_DIR"/repair/receipts/*.json
```

Reinstall from the stable checkout to activate it:

```bash
tools/install_external_schedule_launchd.sh
```

The installer reports which launcher the trigger points at and warns if the rail is disabled. As with every other input it writes, naming a command is not evidence that a repair works: the first cycle's summary and the receipts are.

The remaining daily data-freshness jobs (`attachment-metadata`, `surface-load-live`, and `multi-flywheel`) remain listed as follow-ups in the job manifest.
