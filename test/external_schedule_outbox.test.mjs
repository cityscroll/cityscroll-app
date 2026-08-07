import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyIssueIntent,
  persistScheduleResult,
  replayOutbox,
} from "../tools/external_schedule_outbox.mjs";
import { auditSchedulerOwnership } from "../tools/audit_scheduler_ownership.mjs";

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
  const stateDir = await mkdtemp(join(tmpdir(), "crol-outbox-"));
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

test("replay creates once, comments once, and closes on recovery", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "crol-outbox-"));
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
