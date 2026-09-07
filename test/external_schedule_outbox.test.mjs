import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  applyIssueIntent,
  createGitHubClient,
  persistScheduleResult,
  replayOutbox,
} from "../tools/external_schedule_outbox.mjs";
import { auditSchedulerOwnership } from "../tools/audit_scheduler_ownership.mjs";
import {
  SCHEDULER_WORKFLOW,
  githubToken,
  githubTokenResolution,
  outboxDeliveryReason,
  publishHeartbeat,
  resolveCredential,
  resolveCredentialSource,
  runScheduledJob,
  schedulerRunId,
} from "../tools/external_schedule_runner.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

function fakeGithub() {
  const issues = [];
  const comments = new Map();
  return {
    issues,
    async listIssues() { return issues.filter((issue) => issue.state === "open"); },
    async listComments(number) { return comments.get(number) || []; },
    async createIssue(issue) { const created = { number: issues.length + 1, state: "open", ...issue }; issues.push(created); return created; },
    async createComment(number, body) { const list = comments.get(number) || []; list.push({ body }); comments.set(number, list); },
    async updateIssue(number, patch) { Object.assign(issues.find((issue) => issue.number === number), patch); },
  };
}

test("outbox persists one idempotent event per scheduled slot", async () => {
  await withTempDir("crol-outbox", async (stateDir) => {
    const result = { observed_at: "2026-08-07T11:41:00.000Z", status: "degraded", body: "failure" };
    const issue = { mode: "open", title: "Monitor drift", body: "failure" };
    const first = await persistScheduleResult({ stateDir, jobId: "action-links-live", runKey: "2026-08-07T11-41", result, issue });
    const second = await persistScheduleResult({ stateDir, jobId: "action-links-live", runKey: "2026-08-07T11-41", result, issue });
    assert.equal(first.event.event_id, second.event.event_id);
    const stored = JSON.parse(await readFile(second.eventPath, "utf8"));
    assert.equal(stored.event_id, first.event.event_id);
    assert.equal(stored.status, "pending");
    const extra = await persistScheduleResult({ stateDir, jobId: "source-contracts-live", runKey: "2026-08-07T10-23", eventRunKey: "2026-08-07T10-23-source-0", result, issue });
    const extraTwo = await persistScheduleResult({ stateDir, jobId: "source-contracts-live", runKey: "2026-08-07T10-23", eventRunKey: "2026-08-07T10-23-source-1", result, issue });
    assert.equal(extra.resultPath, extraTwo.resultPath);
    assert.notEqual(extra.eventPath, extraTwo.eventPath);
  });
});

test("replay creates once, comments once, and closes on recovery", async () => {
  await withTempDir("crol-outbox", async (stateDir) => {
    const github = fakeGithub();
    const result = { observed_at: "2026-08-07T11:41:00.000Z", status: "degraded", body: "failure" };
    await persistScheduleResult({ stateDir, jobId: "digest-shadow-monitor", runKey: "failure", result, issue: { mode: "open", title: "Digest shadow run needs attention", body: "failure" } });
    assert.equal((await replayOutbox({ stateDir, github })).delivered, 1);
    await persistScheduleResult({ stateDir, jobId: "digest-shadow-monitor", runKey: "failure", result, issue: { mode: "open", title: "Digest shadow run needs attention", body: "failure" } });
    assert.equal((await replayOutbox({ stateDir, github })).delivered, 0);
    const recovery = await applyIssueIntent(github, { mode: "close", title: "Digest shadow run needs attention", body: "recovered", marker: "recovery-marker" });
    assert.equal(recovery.action, "closed");
    assert.equal(github.issues[0].state, "closed");
  });
});

test("replay after an accepted create does not add a duplicate comment", async () => {
  const github = fakeGithub();
  const intent = { mode: "open", title: "Accepted create", body: "failure", marker: "create-marker" };
  let first = true;
  const originalCreate = github.createIssue;
  github.createIssue = async (issue) => {
    const created = await originalCreate(issue);
    if (first) { first = false; throw new Error("response lost after create"); }
    return created;
  };
  await assert.rejects(() => applyIssueIntent(github, intent), /response lost/);
  const replay = await applyIssueIntent(github, intent);
  assert.equal(replay.action, "already-recorded");
  assert.equal((await github.listComments(1)).length, 0);
});

test("source recovery closes only managed issues whose source ids are healthy", async () => {
  const github = fakeGithub();
  await github.createIssue({ title: "Live civic-data source contract drift: city-record", body: "error city-record: stale" });
  await github.createIssue({ title: "Live civic-data source contract drift: other", body: "error other: stale" });
  const result = await applyIssueIntent(github, {
    mode: "close-recovered",
    title_prefix: "Live civic-data source contract drift",
    title_aliases: ["Live civic-data source contract drift"],
    healthy_ids: ["city-record"],
    body: "resolved",
    marker: "recovery-marker",
  });
  assert.equal(result.closed_count, 1);
  assert.equal(github.issues[0].state, "closed");
  assert.equal(github.issues[1].state, "open");
});

test("targeted scheduled ownership is independent of GitHub Actions", async () => {
  const audit = await auditSchedulerOwnership();
  assert.equal(audit.ok, true, audit.errors.join("; "));
  assert.deepEqual(audit.targets, ["action-links-live", "source-contracts-live", "digest-shadow-monitor"]);
});

/** Install a credential file the way the operator ceremony does: owner-only. */
async function writeCredentialFile(path, contents, mode = 0o600) {
  await writeFile(path, contents, { encoding: "utf8", mode });
  await chmod(path, mode);
  return path;
}

const RUN_ID = "2026-08-31T12-00:runner-7:4821";
const REVISION = "dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace";

test("scheduler run identity names the cycle, host, and process", () => {
  assert.equal(
    schedulerRunId(new Date("2026-08-31T12:00:00.000Z"), { host: "runner-7", pid: 4821 }),
    RUN_ID,
  );
});

test("scheduler heartbeat distinguishes missing credential, rejection, and verified liveness", async () => {
  await withTempDir("crol-heartbeat", async (stateDir) => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    const priorKey = process.env.CITYSCROLL_ADMIN_KEY;
    const priorUrl = process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL;
    process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL = "https://api.example.test/admin/reliability/scheduler";
    try {
      delete process.env.CITYSCROLL_ADMIN_KEY;
      // A credential the launchd job never received is a failed cycle, not a
      // quiet one, and the reason is left on disk for the next operator.
      const unconfigured = await publishHeartbeat(stateDir, now, [], { runId: RUN_ID, sourceRevision: REVISION });
      assert.equal(unconfigured.status, "failed");
      assert.equal(unconfigured.reason, "admin-credential-missing");
      assert.equal(
        JSON.parse(await readFile(join(stateDir, "heartbeat", "latest.json"), "utf8")).reason,
        "admin-credential-missing",
      );

      process.env.CITYSCROLL_ADMIN_KEY = "secret";
      const refused = await publishHeartbeat(stateDir, now, [], {
        runId: RUN_ID, sourceRevision: REVISION,
        fetchImpl: async () => ({ ok: false, status: 403 }),
      });
      assert.equal(refused.status, "failed");
      assert.equal(refused.reason, "heartbeat-write-refused");

      // An explicitly rejected heartbeat is distinct from a refused one.
      const rejected = await publishHeartbeat(stateDir, now, [], {
        runId: RUN_ID, sourceRevision: REVISION,
        fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ rejected: ["heartbeat evidence field run_id is missing"] }) }),
      });
      assert.equal(rejected.reason, "heartbeat-rejected");
      assert.deepEqual(rejected.rejected, ["heartbeat evidence field run_id is missing"]);

      let requests = 0;
      let posted = null;
      const success = await publishHeartbeat(stateDir, now, ["controlled-job"], {
        runId: RUN_ID, sourceRevision: REVISION,
        fetchImpl: async (_url, options = {}) => {
          requests += 1;
          if (options.method === "POST") { posted = JSON.parse(options.body); return { ok: true, status: 200 }; }
          return { ok: true, status: 200, json: async () => ({ ok: true, heartbeat: { ...posted, schema: "cityscroll.external-scheduler-heartbeat.v1" } }) };
        },
      });
      assert.equal(success.status, "succeeded");
      assert.equal(success.verified, true);
      assert.equal(requests, 2);
      assert.equal(posted.workflow, SCHEDULER_WORKFLOW);
      assert.equal(posted.run_id, RUN_ID);
      assert.equal(posted.source_revision, REVISION);
      assert.equal(posted.result, "succeeded");

      // A mail-leg finding makes the endpoint report ok:false. Liveness is proven
      // by the round-tripped run identity, so the write still verifies.
      const mailDegraded = await publishHeartbeat(stateDir, now, [], {
        runId: RUN_ID, sourceRevision: REVISION,
        fetchImpl: async (_url, options = {}) => {
          if (options.method === "POST") { posted = JSON.parse(options.body); return { ok: true, status: 200 }; }
          return { ok: false, status: 503, json: async () => ({ ok: false, heartbeat: { ...posted } }) };
        },
      });
      assert.equal(mailDegraded.status, "succeeded");

      // Someone else's heartbeat is not proof that this cycle wrote one.
      const foreign = await publishHeartbeat(stateDir, now, [], {
        runId: RUN_ID, sourceRevision: REVISION,
        fetchImpl: async (_url, options = {}) => {
          if (options.method === "POST") return { ok: true, status: 200 };
          return { ok: true, status: 200, json: async () => ({ ok: true, heartbeat: { workflow: SCHEDULER_WORKFLOW, run_id: "someone-else" } }) };
        },
      });
      assert.equal(foreign.status, "failed");
      assert.equal(foreign.reason, "heartbeat-not-verified");
    } finally {
      if (priorKey == null) delete process.env.CITYSCROLL_ADMIN_KEY; else process.env.CITYSCROLL_ADMIN_KEY = priorKey;
      if (priorUrl == null) delete process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL; else process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL = priorUrl;
    }
  });
});

const DIGEST_SHADOW_JOB = {
  id: "digest-shadow-monitor",
  runner: "digest-shadow",
  issue_title: "Digest shadow run needs attention",
};

async function withDigestShadowEnv(env, run) {
  const keys = ["CITYSCROLL_ADMIN_KEY", "ADMIN_KEY", "CITYSCROLL_ADMIN_KEY_FILE", "CITYSCROLL_DIGEST_SHADOW_URL"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  try { return await run(); } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("the digest shadow probe authenticates from the credential file the schedule installs", async () => {
  await withTempDir("crol-digest-shadow", async (stateDir) => {
    const keyPath = join(stateDir, "admin.key");
    await writeFile(keyPath, "file-resident-secret\n", "utf8");
    const calls = [];
    const result = await withDigestShadowEnv({
      CITYSCROLL_ADMIN_KEY_FILE: keyPath,
      CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
    }, () => runScheduledJob(DIGEST_SHADOW_JOB, {
      stateDir,
      now: new Date("2026-08-07T10:10:00.000Z"),
      async fetchImpl(url, options) {
        calls.push({ url, options });
        return { ok: true, status: 200, async json() { return { summary: { status: "READY", run_day: "2026-08-07" } }; } };
      },
    }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example.invalid/admin/digest-shadow");
    assert.equal(calls[0].options.headers.Authorization, "Bearer file-resident-secret");
    assert.equal(result.result.status, "healthy");
  });
});

test("the digest shadow probe reports a missing credential instead of an anonymous request", async () => {
  await withTempDir("crol-digest-shadow-anon", async (stateDir) => {
    let called = false;
    const result = await withDigestShadowEnv({
      CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
    }, () => runScheduledJob(DIGEST_SHADOW_JOB, {
      stateDir,
      now: new Date("2026-08-07T10:10:00.000Z"),
      async fetchImpl() { called = true; throw new Error("the probe must not call the admin route without a credential"); },
    }));
    assert.equal(called, false);
    assert.equal(result.result.status, "degraded");
    assert.equal(result.result.degraded_reason, "admin-credential-missing");
    assert.equal(result.result.http_status, null);
    assert.match(result.result.body, /no admin credential/);
    assert.equal(result.issue.title, "Digest shadow probe has no admin credential");
  });
});

// A rehearsal the probe cannot read and a rehearsal that read a source which did not answer are
// two different things, and neither of them is "the digest is wrong". These pin the words the
// monitor uses for each, because the word it reaches for is the whole value of the report.
test("a rehearsal the probe cannot read names why, and claims nothing about the digest", async () => {
  await withTempDir("crol-digest-shadow-notrun", async (stateDir) => {
    const output = await withDigestShadowEnv({
      CITYSCROLL_ADMIN_KEY: "probe-secret",
      CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
    }, () => runScheduledJob(DIGEST_SHADOW_JOB, {
      stateDir,
      now: new Date("2026-09-06T10:10:00.000Z"),
      async fetchImpl() {
        return { ok: false, status: 404, async json() { return { error: "not-run", degraded_receipt: null }; } };
      },
    }));
    assert.equal(output.result.status, "degraded");
    assert.equal(output.result.degraded_reason, "rehearsal-not-run");
    assert.equal(output.result.fault_domain, "rehearsal_reachability");
    assert.match(output.result.body, /no rehearsal is stored for 2026-09-06/);
    assert.doesNotMatch(output.result.body, /UNAVAILABLE/);
    // Nothing is known about the sources either, so nothing is said about them.
    assert.equal(output.intents.length, 1);
    assert.equal(output.intents[0].issue.mode, "open");
    assert.equal(output.intents[0].issue.title, "Digest shadow run needs attention");
  });
});

test("a stale rehearsal is named as stale rather than as an unnamed failure", async () => {
  await withTempDir("crol-digest-shadow-stale", async (stateDir) => {
    const output = await withDigestShadowEnv({
      CITYSCROLL_ADMIN_KEY: "probe-secret",
      CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
    }, () => runScheduledJob(DIGEST_SHADOW_JOB, {
      stateDir,
      now: new Date("2026-09-07T10:10:00.000Z"),
      async fetchImpl() {
        return { ok: true, status: 200, async json() { return { summary: { status: "READY", run_day: "2026-09-05" } }; } };
      },
    }));
    assert.equal(output.result.degraded_reason, "rehearsal-stale");
    assert.match(output.result.body, /newest stored rehearsal is for 2026-09-05, not 2026-09-07/);
  });
});

test("an unavailable source closes the digest finding and opens its own", async () => {
  await withTempDir("crol-digest-shadow-upstream", async (stateDir) => {
    const output = await withDigestShadowEnv({
      CITYSCROLL_ADMIN_KEY: "probe-secret",
      CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
    }, () => runScheduledJob(DIGEST_SHADOW_JOB, {
      stateDir,
      now: new Date("2026-09-07T10:10:00.000Z"),
      async fetchImpl() {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              summary: {
                status: "DEGRADED_UPSTREAM",
                run_day: "2026-09-07",
                redlines: [],
                upstream_incidents: [{
                  code: "upstream_source_unavailable",
                  digest_id: "watch:rivington",
                  evidence: { source: "soda", http_status: 524, attempts: 3 },
                }],
              },
            };
          },
        };
      },
    }));
    assert.equal(output.result.status, "degraded");
    assert.equal(output.result.degraded_reason, "upstream-source-unavailable");
    assert.equal(output.result.fault_domain, "upstream_source");
    assert.match(output.result.body, /found no fault in the digest/);
    assert.deepEqual(output.intents.map((intent) => [intent.issue.mode, intent.issue.title]), [
      ["close", "Digest shadow run needs attention"],
      ["open", "Digest shadow source is unavailable"],
    ]);
  });
});

test("a healthy rehearsal closes both the digest finding and the source finding", async () => {
  await withTempDir("crol-digest-shadow-recovered", async (stateDir) => {
    const output = await withDigestShadowEnv({
      CITYSCROLL_ADMIN_KEY: "probe-secret",
      CITYSCROLL_DIGEST_SHADOW_URL: "https://example.invalid/admin/digest-shadow",
    }, () => runScheduledJob(DIGEST_SHADOW_JOB, {
      stateDir,
      now: new Date("2026-09-07T10:10:00.000Z"),
      async fetchImpl() {
        return { ok: true, status: 200, async json() { return { summary: { status: "READY", run_day: "2026-09-07" } }; } };
      },
    }));
    assert.equal(output.result.status, "healthy");
    assert.deepEqual(output.intents.map((intent) => [intent.issue.mode, intent.issue.title]), [
      ["close", "Digest shadow run needs attention"],
      ["close", "Digest shadow source is unavailable"],
    ]);
  });
});

// The issue loop's delivery identity is a dedicated machine account, installed
// as a mode-0600 file the trigger only names. The failure that matters is not a
// missing file: it is a broken file being papered over by whatever other
// identity the host happens to carry, which would file or close monitor issues
// under a person. Explicit file configuration therefore fails closed, and these
// cases pin every way it can fail.
async function withTokenEnv(env, run) {
  const keys = ["GH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN_FILE", "GITHUB_TOKEN_FILE"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  try { return await run(); } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("the delivery token resolves from the file the trigger names, and an intent is delivered", async () => {
  await withTempDir("crol-outbox-token", async (stateDir) => {
    const tokenPath = await writeCredentialFile(join(stateDir, "github-token"), "file-resident-token\n");
    const token = await withTokenEnv({ GH_TOKEN_FILE: tokenPath }, () => githubToken());
    assert.equal(token, "file-resident-token");
    // The alias the operator process may use instead resolves identically.
    assert.equal(await withTokenEnv({ GITHUB_TOKEN_FILE: tokenPath }, () => githubToken()), "file-resident-token");
    // An inline export is honoured only where no file is configured, so a
    // workstation rehearsal still runs.
    assert.equal(await withTokenEnv({ GH_TOKEN: "inline-token" }, () => githubToken()), "inline-token");

    const requests = [];
    const github = createGitHubClient({
      token,
      owner: "cityscroll",
      repo: "cityscroll-app",
      apiBase: "https://api.example.test",
      async fetchImpl(url, options = {}) {
        requests.push({ url, method: options.method || "GET", headers: options.headers });
        if (url.endsWith("/issues?state=open&per_page=100")) return { ok: true, status: 200, async json() { return []; } };
        return { ok: true, status: 201, async json() { return { number: 42 }; } };
      },
    });
    assert.ok(github, "a resolved token must produce a client");

    await persistScheduleResult({
      stateDir,
      jobId: "action-link-monitor",
      runKey: "2026-09-06T11:00",
      result: { observed_at: "2026-09-06T11:00:00.000Z", status: "degraded", body: "drift" },
      issue: { mode: "open", title: "Monitor drift", body: "drift" },
    });

    const summary = await replayOutbox({ stateDir, github });
    assert.equal(summary.status, "ok");
    assert.equal(summary.delivered, 1);
    assert.equal(summary.pending, 0);
    assert.equal(requests.at(-1).method, "POST");
    assert.equal(requests[0].headers.Authorization, "Bearer file-resident-token");
  });
});

test("an explicitly configured credential file that cannot be used resolves to nothing, whatever the failure", async () => {
  await withTempDir("crol-outbox-token-bad", async (stateDir) => {
    const cases = [
      ["absent", join(stateDir, "absent-token")],
      ["empty", await writeCredentialFile(join(stateDir, "empty-token"), "   \n")],
      // A token any local account can read is not a machine identity.
      ["insecure-permissions", await writeCredentialFile(join(stateDir, "loose-token"), "loose\n", 0o644)],
      ["insecure-permissions", await writeCredentialFile(join(stateDir, "group-token"), "group\n", 0o640)],
      ["not-a-file", stateDir],
    ];
    for (const [failure, path] of cases) {
      const resolution = resolveCredentialSource({
        inlineVars: ["GH_TOKEN", "GITHUB_TOKEN"],
        fileVars: ["GH_TOKEN_FILE"],
        env: { GH_TOKEN_FILE: path },
        requireOwnerOnly: true,
      });
      assert.equal(resolution.value, null, `${failure} must resolve to no credential`);
      assert.equal(resolution.failure, failure);
      assert.equal(resolution.variable, "GH_TOKEN_FILE");
    }

    // A file the process genuinely cannot read is reported as unreadable rather
    // than mistaken for an absent one, because the two need different repairs.
    const unreadable = resolveCredentialSource({
      fileVars: ["GH_TOKEN_FILE"],
      env: { GH_TOKEN_FILE: join(stateDir, "denied-token") },
      statFile: () => ({ isFile: () => true, mode: 0o600 }),
      readTextFile: () => { const error = new Error("permission denied"); error.code = "EACCES"; throw error; },
    });
    assert.equal(unreadable.value, null);
    assert.equal(unreadable.failure, "unreadable");
  });
});

test("a broken credential file never falls back to another identity", async () => {
  await withTempDir("crol-outbox-token-closed", async (stateDir) => {
    const empty = await writeCredentialFile(join(stateDir, "empty-token"), "\n");
    const loose = await writeCredentialFile(join(stateDir, "loose-token"), "loose-token\n", 0o644);
    // Every one of these environments carries a usable inline export. None of
    // them may be used: the file was named, so the file decides.
    for (const env of [
      { GH_TOKEN: "personal-token", GH_TOKEN_FILE: join(stateDir, "absent-token") },
      { GITHUB_TOKEN: "personal-token", GH_TOKEN_FILE: empty },
      { GH_TOKEN: "personal-token", GITHUB_TOKEN: "other-token", GH_TOKEN_FILE: loose },
      { GH_TOKEN: "personal-token", GITHUB_TOKEN_FILE: join(stateDir, "absent-token") },
    ]) {
      assert.equal(await withTokenEnv(env, () => githubToken()), null, `${Object.keys(env).join("+")} fell back to an inline identity`);
    }

    // Nothing in the delivery path can reach a GitHub CLI session either: the
    // client is built from the resolved token alone and is null without one.
    assert.equal(createGitHubClient({ token: null, owner: "cityscroll", repo: "cityscroll-app" }), null);
    const runnerSource = await readFile(new URL("../tools/external_schedule_runner.mjs", import.meta.url), "utf8");
    const outboxSource = await readFile(new URL("../tools/external_schedule_outbox.mjs", import.meta.url), "utf8");
    for (const source of [runnerSource, outboxSource]) {
      assert.equal(/\bgh\s+(auth|api|issue)\b/.test(source), false, "the delivery path shells out to the GitHub CLI");
    }
  });
});

test("a failed credential resolution reports the variable and failure class and nothing else", async () => {
  await withTempDir("crol-outbox-token-receipt", async (stateDir) => {
    const secret = "s3cr3t-delivery-token";
    const loose = await writeCredentialFile(join(stateDir, "loose-token"), `${secret}\n`, 0o644);
    const logged = [];
    const value = resolveCredential({
      fileVars: ["GH_TOKEN_FILE"],
      env: { GH_TOKEN_FILE: loose },
      requireOwnerOnly: true,
      log: (line) => logged.push(line),
    });
    assert.equal(value, null);
    // Exactly one line, naming what to fix and nothing that must not travel.
    assert.equal(logged.length, 1);
    assert.match(logged[0], /GH_TOKEN_FILE/);
    assert.match(logged[0], /readable by more than its owner/);
    assert.equal(logged[0].includes(secret), false, "the receipt carries the credential");
    assert.equal(logged[0].includes(loose), false, "the receipt carries the credential's path");

    // The heartbeat reason is the same redacted pair.
    assert.equal(
      outboxDeliveryReason(resolveCredentialSource({ fileVars: ["GH_TOKEN_FILE"], env: { GH_TOKEN_FILE: loose }, requireOwnerOnly: true })),
      "GH_TOKEN_FILE:insecure-permissions",
    );
    assert.equal(outboxDeliveryReason(resolveCredentialSource({ inlineVars: ["GH_TOKEN"], env: {} })), "github-token-unconfigured");
    assert.equal(outboxDeliveryReason({ value: "token", failure: null }), null);
  });
});

test("a cycle with no usable credential keeps every pending intent retryable and says why", async () => {
  await withTempDir("crol-outbox-offline", async (stateDir) => {
    const loose = await writeCredentialFile(join(stateDir, "loose-token"), "loose-token\n", 0o644);
    const resolution = await withTokenEnv({ GH_TOKEN: "personal-token", GH_TOKEN_FILE: loose }, () => githubTokenResolution());
    assert.equal(resolution.value, null);
    const reason = outboxDeliveryReason(resolution);

    const { eventPath } = await persistScheduleResult({
      stateDir,
      jobId: "action-link-monitor",
      runKey: "2026-09-06T11:00",
      result: { observed_at: "2026-09-06T11:00:00.000Z", status: "degraded", body: "drift" },
      issue: { mode: "open", title: "Monitor drift", body: "drift" },
    });

    // Previously this reported pending 0 with no reason, so an undeliverable
    // backlog was indistinguishable from an empty one.
    const summary = await replayOutbox({ stateDir, github: null, offlineReason: reason });
    assert.equal(summary.status, "offline");
    assert.equal(summary.reason, "GH_TOKEN_FILE:insecure-permissions");
    assert.equal(summary.delivered, 0);
    assert.equal(summary.pending, 1);

    // The intent is untouched: still pending, still at attempt zero, so the
    // cycle that follows a repaired credential delivers it unchanged.
    const event = JSON.parse(await readFile(eventPath, "utf8"));
    assert.equal(event.status, "pending");
    assert.equal(event.attempts, 0);
    assert.equal(event.last_error, undefined);

    const priorKey = process.env.CITYSCROLL_ADMIN_KEY;
    process.env.CITYSCROLL_ADMIN_KEY = "secret";
    try {
      const heartbeat = await publishHeartbeat(stateDir, new Date("2026-09-06T11:00:00.000Z"), [], {
        runId: RUN_ID,
        sourceRevision: REVISION,
        outboxDelivery: "offline",
        outboxDeliveryReason: reason,
        fetchImpl: async () => ({ ok: false, status: 503 }),
      });
      assert.equal(heartbeat.outbox_delivery, "offline");
      assert.equal(heartbeat.outbox_delivery_reason, reason);
      const persisted = JSON.parse(await readFile(join(stateDir, "heartbeat", "latest.json"), "utf8"));
      assert.equal(persisted.outbox_delivery, "offline");
      assert.equal(persisted.outbox_delivery_reason, reason);
      // The receipt is publishable: it names a variable and a class, never a path.
      assert.equal(JSON.stringify(persisted).includes(loose), false);
    } finally {
      if (priorKey == null) delete process.env.CITYSCROLL_ADMIN_KEY; else process.env.CITYSCROLL_ADMIN_KEY = priorKey;
    }
  });
});

test("a loaded credential is reported as credentialed, never as installed or operational", async () => {
  await withTempDir("crol-outbox-credentialed", async (stateDir) => {
    // The heartbeat vocabulary states only that a credential was loaded. A
    // deployment must not read live delivery out of a configured path.
    const priorKey = process.env.CITYSCROLL_ADMIN_KEY;
    process.env.CITYSCROLL_ADMIN_KEY = "secret";
    try {
      const heartbeat = await publishHeartbeat(stateDir, new Date("2026-09-06T11:00:00.000Z"), [], {
        runId: RUN_ID,
        sourceRevision: REVISION,
        outboxDelivery: "credentialed",
        fetchImpl: async () => ({ ok: false, status: 503 }),
      });
      assert.equal(heartbeat.outbox_delivery, "credentialed");
      assert.equal(heartbeat.outbox_delivery_reason, null);
    } finally {
      if (priorKey == null) delete process.env.CITYSCROLL_ADMIN_KEY; else process.env.CITYSCROLL_ADMIN_KEY = priorKey;
    }

    const docs = await readFile(new URL("../docs/external-schedule-outbox.md", import.meta.url), "utf8");
    const installer = await readFile(new URL("../tools/install_external_schedule_launchd.sh", import.meta.url), "utf8");
    // The operator procedure exists and is gated on a verified identity rather
    // than on a path or a submitted credential.
    assert.match(docs, /## Activating issue delivery/);
    assert.match(docs, /read-only/);
    assert.match(docs, /credential-waiting/);
    assert.match(installer, /configured paths, not verified credentials/);
    // Neither surface may treat a configured path or a submitted credential as
    // readiness: each says outright that it is not one.
    assert.match(docs, /naming a path, or holding a submitted credential, is never evidence that the identity is installed, correct, or accepted/);
    assert.match(docs, /Neither the path nor the warning is evidence of a working credential/);
    assert.match(installer, /Configuring a path is not installing a credential/);
    const template = await readFile(new URL("../ops/launchd/com.cityscroll.external-schedules.plist.template", import.meta.url), "utf8");
    assert.match(template, /naming a path neither installs nor verifies the credential/);
  });
});
