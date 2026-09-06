// Scheduler liveness is only as good as the receipt the scheduled cycle wrote.
// These cases pin the specimens that were alarming with nothing to act on: a
// heartbeat that never existed, one that cannot be attributed to a run, and an
// alert paragraph whose workflow and receipt links read "null".
import assert from "node:assert/strict";
import test from "node:test";

import {
  recordDigestShadowReceipt,
  recordDigestDeliveryReceipt,
  recordSchedulerHeartbeat,
  digestWatchdogSnapshot,
  schedulerWatchdogSnapshot,
  SCHEDULER_HEARTBEAT_KEY,
} from "../src/reliability_watchdogs.mjs";
import { handleAdminSchedulerHeartbeat } from "../src/admin.mjs";

const SCHEDULER = "https://api.cityscroll.org/admin/reliability/scheduler";
const OBSERVER = "observer_workflow=Reliability+watchdogs"
  + "&observer_run_url=https%3A%2F%2Fgithub.com%2Fcityscroll%2Fcityscroll-app%2Factions%2Fruns%2F33575789190"
  + "&observer_revision=dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace";

const CYCLE = Object.freeze({
  workflow: "com.cityscroll.external-schedules",
  run_id: "2026-09-02T00-45:runner-7:4821",
  source_revision: "dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace",
  result: "succeeded",
  pending_outbox: 0,
  due_jobs: ["digest-shadow-monitor"],
});

const PUBLICATION = Object.freeze({
  cycle: "desk-publication",
  workflow: "Deploy Cloudflare Pages",
  run_id: "33968898164",
  source_revision: "dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace",
  result: "succeeded",
  destination: "https://desk.cityscroll.org/data-sources",
});

function store(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    // A restart drops every in-process value and keeps only what the store holds.
    binding: () => ({
      async get(key) { return map.get(key) || null; },
      async put(key, value) { map.set(key, String(value)); },
    }),
  };
}

function harness(seed = {}) {
  const backing = store(seed);
  const sent = [];
  const env = { ADMIN_KEY: "secret", RESEND_API_KEY: "rk", ALERT_STATE: backing.binding() };
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: `mail-${sent.length}` }) };
  };
  return {
    env, sent, backing,
    restore: () => { globalThis.fetch = original; },
    get: (now, query = OBSERVER) => handleAdminSchedulerHeartbeat(
      new Request(`${SCHEDULER}${query ? `?${query}` : ""}`, { headers: { authorization: "Bearer secret" } }),
      env,
      { now },
    ),
    post: (body, now) => handleAdminSchedulerHeartbeat(
      new Request(SCHEDULER, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      { now },
    ),
  };
}

test("a completed scheduled cycle reads ok from the heartbeat it wrote and verified", async () => {
  const kit = harness();
  try {
    const write = await kit.post(CYCLE, new Date("2026-09-02T00:45:00Z"));
    assert.equal(write.status, 200);
    assert.equal((await kit.post(PUBLICATION, new Date("2026-09-02T00:45:00Z"))).status, 200);
    const written = (await write.json()).heartbeat;
    assert.equal(written.run_id, CYCLE.run_id);

    const read = await kit.get(new Date("2026-09-02T00:50:00Z"));
    assert.equal(read.status, 200);
    const snapshot = await read.json();
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.scheduler_ok, true);
    // The same run that executed due work is the run the endpoint reports back.
    assert.equal(snapshot.heartbeat.run_id, CYCLE.run_id);
    assert.equal(snapshot.heartbeat.workflow, CYCLE.workflow);
    assert.equal(snapshot.heartbeat.source_revision, CYCLE.source_revision);
    assert.equal(kit.sent.length, 0);
  } finally { kit.restore(); }
});

test("the 13-alert null specimen alarms with concrete workflow, run, revision and receipt evidence", async () => {
  const kit = harness();
  try {
    const response = await kit.get(new Date("2026-09-01T10:28:00Z"));
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).scheduler_findings, ["scheduler heartbeat missing"]);
    assert.equal(kit.sent.length, 2);
    const paragraph = kit.sent.find((item) => /scheduler-heartbeat broke/.test(item.html)).html;
    assert.match(paragraph, /scheduler-heartbeat broke: scheduler heartbeat missing/);
    assert.match(paragraph, /Workflow: Reliability watchdogs\./);
    assert.match(paragraph, /Source revision: dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace\./);
    assert.match(paragraph, /Workflow run: https:\/\/github\.com\/cityscroll\/cityscroll-app\/actions\/runs\/33575789190\./);
    assert.match(paragraph, /Raw receipt: https:\/\/api\.cityscroll\.org\/admin\/reliability\/scheduler\./);
    assert.doesNotMatch(paragraph, /null/);
    // rel-09's human-grade shape is preserved: one paragraph, no dumped JSON.
    assert.equal((paragraph.match(/<p>/g) || []).length, 1);
  } finally { kit.restore(); }
});

test("a caller that omits run evidence cannot emit an alert, and the endpoint stays red", async () => {
  const kit = harness();
  try {
    const response = await kit.get(new Date("2026-09-01T10:28:00Z"), "");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).alert.reason, "evidence-required");
    assert.equal(kit.sent.length, 0);
  } finally { kit.restore(); }
});

test("an unattributable heartbeat is rejected explicitly and never stored", async () => {
  const kit = harness();
  try {
    const now = new Date("2026-09-02T00:45:00Z");
    // The pre-repair payload: a run key and an outbox count, naming no cycle.
    const rejected = await kit.post({ run_key: "2026-09-02T00-45", pending_outbox: 0, due_jobs: [] }, now);
    assert.equal(rejected.status, 400);
    const body = await rejected.json();
    assert.equal(body.accepted, false);
    assert.deepEqual(body.rejected.sort(), [
      "heartbeat evidence field result is missing",
      "heartbeat evidence field run_id is missing",
      "heartbeat evidence field source_revision is missing",
      "heartbeat evidence field workflow is missing",
    ]);
    assert.equal(kit.backing.map.get(SCHEDULER_HEARTBEAT_KEY), undefined);

    const read = await kit.get(now);
    assert.equal(read.status, 503);
    assert.equal((await read.json()).scheduler_ok, false);
  } finally { kit.restore(); }
});

test("a heartbeat naming a fabricated revision or unknown result is refused", async () => {
  const kit = harness();
  const now = new Date("2026-09-02T00:45:00Z");
  try {
    assert.equal((await kit.post({ ...CYCLE, source_revision: "unknown" }, now)).status, 400);
    assert.equal((await kit.post({ ...CYCLE, result: "probably-fine" }, now)).status, 400);
    assert.equal((await kit.post({ ...CYCLE, workflow: "scheduler" }, now)).status, 400);
    assert.equal(kit.backing.map.get(SCHEDULER_HEARTBEAT_KEY), undefined);
  } finally { kit.restore(); }
});

test("a malformed or foreign-schema receipt fails closed instead of reading as liveness", async () => {
  const now = new Date("2026-09-02T00:50:00Z");
  const unparseable = harness({ [SCHEDULER_HEARTBEAT_KEY]: "{not json" });
  try {
    const snapshot = await schedulerWatchdogSnapshot(unparseable.env, { now });
    assert.equal(snapshot.scheduler_ok, false);
    assert.match(snapshot.findings.join("; "), /scheduler heartbeat missing/);
  } finally { unparseable.restore(); }

  const foreign = harness({
    [SCHEDULER_HEARTBEAT_KEY]: JSON.stringify({
      schema: "cityscroll.digest-shadow-ready-receipt.v1",
      observed_at: now.toISOString(),
    }),
  });
  try {
    const snapshot = await schedulerWatchdogSnapshot(foreign.env, { now });
    assert.equal(snapshot.scheduler_ok, false);
    assert.match(snapshot.findings.join("; "), /unrecognized schema/);
  } finally { foreign.restore(); }

  const clockless = harness({
    [SCHEDULER_HEARTBEAT_KEY]: JSON.stringify({
      schema: "cityscroll.external-scheduler-heartbeat.v1",
      ...CYCLE,
      observed_at: "whenever",
    }),
  });
  try {
    const snapshot = await schedulerWatchdogSnapshot(clockless.env, { now });
    assert.equal(snapshot.scheduler_ok, false);
    assert.match(snapshot.findings.join("; "), /observed_at is missing or unparseable/);
  } finally { clockless.restore(); }
});

test("a healthy digest and shadow receipt never stand in for scheduler liveness", async () => {
  const kit = harness();
  try {
    const now = new Date("2026-09-02T14:10:00Z");
    await recordDigestShadowReceipt(kit.env, { ok: true }, now);
    await recordDigestDeliveryReceipt(kit.env, { sent: 2, enqueued: 0 }, now);
    const digest = await digestWatchdogSnapshot(kit.env, { now });
    assert.equal(digest.ok, true);

    const scheduler = await schedulerWatchdogSnapshot(kit.env, { now });
    assert.equal(scheduler.scheduler_ok, false);
    assert.deepEqual(scheduler.scheduler_findings, ["scheduler heartbeat missing"]);
  } finally { kit.restore(); }
});

test("a degraded cycle result cannot report itself as healthy liveness", async () => {
  const kit = harness();
  try {
    const now = new Date("2026-09-02T00:45:00Z");
    assert.equal((await kit.post({ ...CYCLE, result: "degraded" }, now)).status, 200);
    const snapshot = await schedulerWatchdogSnapshot(kit.env, { now });
    assert.equal(snapshot.scheduler_ok, false);
    assert.match(snapshot.findings.join("; "), /reported result degraded/);
  } finally { kit.restore(); }
});

test("the heartbeat survives a restart and a deliberate pause re-alerts within one cycle", async () => {
  const kit = harness();
  try {
    await kit.post(CYCLE, new Date("2026-09-02T00:45:00Z"));
    await kit.post(PUBLICATION, new Date("2026-09-02T00:45:00Z"));
    assert.equal((await kit.get(new Date("2026-09-02T00:50:00Z"))).status, 200);

    // Restart: a new binding over the same store still reads the receipt.
    const restarted = { ...kit.env, ALERT_STATE: kit.backing.binding() };
    const afterRestart = await schedulerWatchdogSnapshot(restarted, { now: new Date("2026-09-02T00:55:00Z") });
    assert.equal(afterRestart.scheduler_ok, true);
    assert.equal(afterRestart.heartbeat.run_id, CYCLE.run_id);
    assert.equal(kit.sent.length, 0);

    // Deliberate pause: the scheduler stops writing and the next cycle past the
    // window alarms again, still carrying evidence rather than a bare finding.
    const paused = await kit.get(new Date("2026-09-02T02:30:00Z"));
    assert.equal(paused.status, 503);
    assert.match((await paused.json()).scheduler_findings.join("; "), /heartbeat expired/);
    assert.equal(kit.sent.length, 1);
    assert.match(kit.sent[0].html, /actions\/runs\/33575789190/);
    assert.doesNotMatch(kit.sent[0].html, /null/);

    // Recovery: the next real cycle writes, and the endpoint clears on its own.
    const recovery = { ...CYCLE, run_id: "2026-09-02T02-31:runner-7:5190" };
    assert.equal((await kit.post(recovery, new Date("2026-09-02T02:31:00Z"))).status, 200);
    const cleared = await kit.get(new Date("2026-09-02T02:35:00Z"));
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).heartbeat.run_id, recovery.run_id);
    assert.equal(kit.sent.length, 1);
  } finally { kit.restore(); }
});

test("a rejected write leaves the prior heartbeat untouched rather than half-updated", async () => {
  const kit = harness();
  try {
    await kit.post(CYCLE, new Date("2026-09-02T00:45:00Z"));
    const rejected = await recordSchedulerHeartbeat(kit.env, { run_key: "2026-09-02T00-46" }, new Date("2026-09-02T00:46:00Z"));
    assert.equal(rejected.accepted, false);
    const stored = JSON.parse(kit.backing.map.get(SCHEDULER_HEARTBEAT_KEY));
    assert.equal(stored.run_id, CYCLE.run_id);
    assert.equal(stored.observed_at, "2026-09-02T00:45:00.000Z");
  } finally { kit.restore(); }
});
