import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  applyIssueIntent,
  persistScheduleResult,
  replayOutbox,
} from "../tools/external_schedule_outbox.mjs";
import { auditSchedulerOwnership } from "../tools/audit_scheduler_ownership.mjs";
import { SCHEDULER_WORKFLOW, publishHeartbeat, schedulerRunId } from "../tools/external_schedule_runner.mjs";
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
