import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalOpsFailureSignature,
  dispatchRepairQueue,
  emitOpsAlertOnce,
  recordSchedulerHeartbeat,
  reportRepairResults,
  REPAIR_JUDGMENT_GUARD,
  OPS_ALERT_HISTORY_KEY,
} from "../src/reliability_watchdogs.mjs";
import {
  REPAIR_MAX_ATTEMPTS,
  REPAIR_QUEUE_LIMIT,
  REPAIR_PICKUP_INTERVAL_MS,
  REPAIR_QUEUE_ITEM_SCHEMA,
  REPAIR_SCOPE,
  normalizeRepairItem,
  readRepairItem,
  readRepairQueue,
  repairItemKey,
  repairPickupState,
  upsertRepairItem,
} from "../src/lib/repair_queue.mjs";
import { handleAdminOpsHealth, handleAdminSchedulerHeartbeat } from "../src/admin.mjs";
import { OPS_ALERT_TO } from "../src/alerts.mjs";

function kv(seed = {}) {
  const store = new Map(Object.entries(seed));
  const failures = new Set();
  return {
    store,
    failWrites(prefix) { failures.add(prefix); },
    allowWrites() { failures.clear(); },
    async get(key) { return store.get(key) || null; },
    async put(key, value) {
      for (const prefix of failures) {
        if (key.startsWith(prefix)) throw new Error("kv-unavailable");
      }
      store.set(key, String(value));
    },
  };
}

const CYCLE = Object.freeze({
  workflow: "com.cityscroll.external-schedules",
  run_id: "2026-09-01T12-00:runner-3:991",
  source_revision: "42ab127935d09b99afa1fc88d6065212efd4b04a",
  result: "succeeded",
});

const FINDING = Object.freeze({
  guard: "served-artifact-freshness",
  stage: "served_artifact_freshness",
  findings: ["artifact hash mismatch", "source commit mismatch"],
  workflow: "Served artifact freshness",
  source_revision: "42ab127935d09b99afa1fc88d6065212efd4b04a",
  workflow_run_url: "https://github.com/cityscroll/cityscroll-app/actions/runs/900",
  receipt_url: "https://github.com/cityscroll/cityscroll-app/actions/runs/900#artifacts",
});

function at(stamp) {
  return new Date(stamp);
}

/** A live cycle that can run a bounded repair task, so a pickup time exists. */
async function liveCycle(ALERT_STATE, observedAt = "2026-09-01T12:00:00Z") {
  const write = await recordSchedulerHeartbeat({ ALERT_STATE }, { ...CYCLE, repair_dispatch: true }, at(observedAt));
  assert.equal(write.accepted, true);
  return write.heartbeat;
}

function captureSends() {
  const sent = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: `mail-${sent.length}` }) };
  };
  return { sent, restore() { globalThis.fetch = previous; } };
}

function alertBodies(sent) {
  return sent.map((row) => row.html || "").join(" ");
}

test("A1 an owner alert queues one structured repair item and names the actual pickup time", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING,
      first_seen: "2026-09-01T12:00:20Z",
      last_seen: "2026-09-01T12:00:30Z",
      now: at("2026-09-01T12:00:30Z"),
    });
    assert.equal(alert.sent, true);
    const item = alert.queue.item;
    assert.equal(item.schema, REPAIR_QUEUE_ITEM_SCHEMA);
    assert.equal(item.signature, alert.signature);
    assert.equal(item.guard, "served-artifact-freshness");
    assert.equal(item.stage, "served_artifact_freshness");
    assert.equal(item.first_seen, "2026-09-01T12:00:20.000Z");
    assert.equal(item.last_seen, "2026-09-01T12:00:30.000Z");
    assert.equal(item.repeat_count, 1);
    assert.equal(item.workflow, "Served artifact freshness");
    assert.equal(item.source_revision, FINDING.source_revision);
    assert.equal(item.latest_run_url, FINDING.workflow_run_url);
    assert.equal(item.latest_receipt_url, FINDING.receipt_url);
    assert.deepEqual(item.context.findings, ["artifact hash mismatch", "source commit mismatch"]);
    assert.equal(item.state, "queued");
    assert.equal(item.repair_scope, REPAIR_SCOPE);

    // The heartbeat landed at 12:00:00Z and the cycle runs on its own interval,
    // so the next pickup is one interval later, not a number the alert invented.
    const expected = new Date(Date.parse("2026-09-01T12:00:00Z") + REPAIR_PICKUP_INTERVAL_MS).toISOString();
    assert.equal(item.next_pickup_at, expected);
    assert.equal(sent(mail).includes(expected), true);
    assert.match(alertBodies(mail.sent), /Queued for automatic repair, next pickup at/);
    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0].to, OPS_ALERT_TO);
  } finally { mail.restore(); }
});

function sent(mail) {
  return alertBodies(mail.sent);
}

test("A2 a repeated signature upserts one item and a different signature gets its own", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    const first = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING,
      first_seen: "2026-09-01T12:00:20Z",
      last_seen: "2026-09-01T12:00:20Z",
      now: at("2026-09-01T12:00:20Z"),
    });
    const repeat = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING,
      workflow_run_url: "https://github.com/cityscroll/cityscroll-app/actions/runs/901",
      receipt_url: "https://github.com/cityscroll/cityscroll-app/actions/runs/901#artifacts",
      first_seen: "2026-09-01T12:00:20Z",
      last_seen: "2026-09-01T12:03:00Z",
      now: at("2026-09-01T12:03:00Z"),
    });
    const again = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING,
      first_seen: "2026-09-01T12:00:20Z",
      last_seen: "2026-09-01T12:04:00Z",
      now: at("2026-09-01T12:04:00Z"),
    });
    assert.equal(repeat.signature, first.signature);
    assert.equal(again.signature, first.signature);
    // The repeat is suppressed from mail (rel-09) but still advances the queue.
    assert.equal(repeat.sent, false);
    assert.equal(again.sent, false);
    assert.equal(mail.sent.length, 1);

    const stored = (await readRepairItem({ ALERT_STATE }, first.signature)).item;
    assert.equal(stored.repeat_count, 3);
    assert.equal(stored.first_seen, "2026-09-01T12:00:20.000Z");
    assert.equal(stored.last_seen, "2026-09-01T12:04:00.000Z");
    assert.equal(stored.latest_run_url, FINDING.workflow_run_url);

    const other = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING,
      stage: "generation_output",
      findings: ["generated artifact is older than its source"],
      first_seen: "2026-09-01T12:05:00Z",
      last_seen: "2026-09-01T12:05:00Z",
      now: at("2026-09-01T12:05:00Z"),
    });
    assert.notEqual(other.signature, first.signature);
    assert.equal(other.queue.item.repeat_count, 1);

    const queue = await readRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:05:01Z") });
    assert.equal(queue.items.length, 2);
    assert.equal(queue.open, 2);

    // One item per signature, and one lease per item: a repeated finding never
    // dispatches the same repair twice.
    const dispatch = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:05:02Z"), runId: CYCLE.run_id });
    assert.equal(dispatch.items.length, 2);
    assert.equal(new Set(dispatch.items.map((row) => row.signature)).size, 2);
    const second = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:05:03Z"), runId: CYCLE.run_id });
    assert.deepEqual(second.items, []);
  } finally { mail.restore(); }
});

test("A2 dedupe and repeat counts survive a restart of the reading process", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    const first = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-01T12:00:20Z", now: at("2026-09-01T12:00:20Z"),
    });
    // A different env object over the same durable store is what a restart looks
    // like from here: nothing in memory carries the dedupe.
    const restarted = { ALERT_STATE, RESEND_API_KEY: "rk" };
    const after = await emitOpsAlertOnce(restarted, {
      ...FINDING, first_seen: "2026-09-01T12:10:00Z", last_seen: "2026-09-01T12:10:00Z", now: at("2026-09-01T12:10:00Z"),
    });
    assert.equal(after.signature, first.signature);
    assert.equal(after.queue.item.repeat_count, 2);
    assert.equal(after.queue.item.first_seen, "2026-09-01T12:00:20.000Z");
    const queue = await readRepairQueue(restarted, { now: at("2026-09-01T12:10:01Z") });
    assert.equal(queue.items.length, 1);
  } finally { mail.restore(); }
});

test("A1 a queue write failure stays a durable finding and recovers idempotently", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  ALERT_STATE.failWrites("ops:repair:");
  const mail = captureSends();
  let signature;
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-01T12:00:20Z", now: at("2026-09-01T12:00:20Z"),
    });
    signature = alert.signature;
    // The alert still reaches the owner, and says plainly that it was not queued.
    assert.equal(alert.sent, true);
    assert.equal(alert.queue.ok, false);
    assert.equal(alert.queue.reason, "queue-write-failed");
    assert.equal(alert.record.queue.queued, false);
    assert.equal(alert.record.queue.finding.reason, "queue-write-failed");
    assert.match(sent(mail), /was not queued for automatic repair/);
    assert.doesNotMatch(sent(mail), /Queued for automatic repair, next pickup/);
    // Exactly one mail: a dead queue never alarms recursively through the same rail.
    assert.equal(mail.sent.length, 1);
    assert.equal((await readRepairItem({ ALERT_STATE }, signature)).item, null);
  } finally { mail.restore(); }

  ALERT_STATE.allowWrites();
  const recovery = captureSends();
  try {
    const first = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:01:00Z"), runId: CYCLE.run_id });
    assert.deepEqual(first.recovered, [signature]);
    const restored = (await readRepairItem({ ALERT_STATE }, signature)).item;
    assert.equal(restored.repeat_count, 1);
    assert.equal(restored.first_seen, "2026-09-01T12:00:20.000Z");
    // Recovery is idempotent: a second pass restores nothing and duplicates nothing.
    const again = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:02:00Z"), runId: CYCLE.run_id });
    assert.deepEqual(again.recovered, []);
    const queue = await readRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:02:01Z") });
    assert.equal(queue.items.length, 1);
    assert.equal(recovery.sent.length, 0);
  } finally { recovery.restore(); }
});

test("A3 pickup, lease expiry, and a successful repair never mail the owner", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-01T12:00:20Z", now: at("2026-09-01T12:00:20Z"),
    });
    const mailAfterAlert = mail.sent.length;
    assert.equal(mailAfterAlert, 1);

    const pickup = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:01:00Z"), runId: CYCLE.run_id });
    assert.equal(pickup.items.length, 1);
    const leased = pickup.items[0];
    assert.equal(leased.state, "leased");
    assert.equal(leased.attempts, 1);
    assert.ok(leased.lease.lease_id);
    assert.equal(leased.lease.holder_run_id, CYCLE.run_id);
    assert.ok(Date.parse(leased.lease.expires_at) > Date.parse(leased.lease.acquired_at));
    // A live lease is not handed to a second cycle.
    const contended = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:02:00Z"), runId: "other-cycle" });
    assert.deepEqual(contended.items, []);

    // The holder dies. The lease expires and the same item is picked up again,
    // keeping its first-seen, its repeat count, and its attempt history.
    const expired = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:20:00Z"), runId: "restarted-cycle" });
    assert.equal(expired.items.length, 1);
    assert.equal(expired.items[0].signature, leased.signature);
    assert.equal(expired.items[0].attempts, 2);
    assert.equal(expired.items[0].repeat_count, 1);
    assert.equal(expired.items[0].first_seen, "2026-09-01T12:00:20.000Z");

    const done = await reportRepairResults({ ALERT_STATE, RESEND_API_KEY: "rk" }, [{
      signature: leased.signature,
      lease_id: expired.items[0].lease.lease_id,
      outcome: "repaired",
      summary: "Rebuilt the served artifact from the current source revision.",
    }], { now: at("2026-09-01T12:25:00Z") });
    assert.equal(done.applied[0].accepted, true);
    assert.equal(done.applied[0].state, "repaired");
    assert.deepEqual(done.judgment_alerts, []);

    // Pickup, lease expiry, retry, and the successful repair added no mail.
    assert.equal(mail.sent.length, mailAfterAlert);
    const queue = await readRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:25:01Z") });
    assert.equal(queue.open, 0);
    assert.equal(queue.needs_judgment, 0);
    // A repaired item is not resurrected by the recovery pass.
    const after = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:26:00Z"), runId: CYCLE.run_id });
    assert.deepEqual(after.recovered, []);
    assert.deepEqual(after.items, []);
    assert.equal(alert.queue.item.state, "queued");
  } finally { mail.restore(); }
});

test("A3 a retryable failure stays silent and only the judgment boundary mails once", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-01T12:00:20Z", now: at("2026-09-01T12:00:20Z"),
    });
    assert.equal(mail.sent.length, 1);

    let minute = 1;
    let lastLease = null;
    for (let attempt = 1; attempt <= REPAIR_MAX_ATTEMPTS; attempt += 1) {
      const pickup = await dispatchRepairQueue({ ALERT_STATE }, { now: at(`2026-09-01T12:0${minute}:00Z`), runId: CYCLE.run_id });
      assert.equal(pickup.items.length, 1, `attempt ${attempt} should lease`);
      lastLease = pickup.items[0].lease.lease_id;
      minute += 1;
      await reportRepairResults({ ALERT_STATE, RESEND_API_KEY: "rk" }, [{
        signature: alert.signature,
        lease_id: lastLease,
        outcome: "failed",
        summary: `attempt ${attempt} could not rebuild the artifact`,
      }], { now: at(`2026-09-01T12:0${minute}:00Z`) });
      minute += 1;
    }
    // Two retries stayed silent; only the exhausted attempt mailed.
    assert.equal(mail.sent.length, 2);
    const judgment = mail.sent[1];
    assert.equal(judgment.to, OPS_ALERT_TO);
    assert.match(judgment.subject, /needs a decision/);
    assert.match(judgment.html, /Automatic repair needs your decision/);
    assert.match(judgment.html, /artifact hash mismatch/);
    assert.match(judgment.html, /Failing since 2026-09-01T12:00:20/);
    assert.match(judgment.html, /actions\/runs\/900/);
    assert.match(judgment.html, /Decide whether to repair it by hand/);

    const stored = (await readRepairItem({ ALERT_STATE }, alert.signature)).item;
    assert.equal(stored.state, "needs_judgment");
    assert.equal(stored.attempts, REPAIR_MAX_ATTEMPTS);
    assert.equal(stored.repeat_count, 1);
    assert.match(stored.judgment_reason, /stopped after 3 attempt/);

    // An item at the judgment boundary is not leased again, and does not mail again.
    const parked = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:30:00Z"), runId: CYCLE.run_id });
    assert.deepEqual(parked.items, []);
    assert.equal(mail.sent.length, 2);
  } finally { mail.restore(); }
});

test("A3 a repair that asks for a decision mails once without spending its retries", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-01T12:00:20Z", now: at("2026-09-01T12:00:20Z"),
    });
    const pickup = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:01:00Z"), runId: CYCLE.run_id });
    const outcome = await reportRepairResults({ ALERT_STATE, RESEND_API_KEY: "rk" }, [{
      signature: alert.signature,
      lease_id: pickup.items[0].lease.lease_id,
      outcome: "judgment",
      judgment_reason: "the only fix rotates a deployment credential",
      summary: "Root cause is a stale deploy credential.",
      run_url: "https://github.com/cityscroll/cityscroll-app/actions/runs/902",
    }], { now: at("2026-09-01T12:02:00Z") });
    assert.equal(outcome.applied[0].state, "needs_judgment");
    assert.equal(outcome.judgment_alerts.length, 1);
    assert.equal(mail.sent.length, 2);
    assert.match(mail.sent[1].html, /the only fix rotates a deployment credential/);
    assert.match(mail.sent[1].html, /actions\/runs\/902/);
    const stored = (await readRepairItem({ ALERT_STATE }, alert.signature)).item;
    assert.equal(stored.attempts, 1);
  } finally { mail.restore(); }
});

test("A3 a report from a lease the queue no longer holds is refused", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-01T12:00:20Z", now: at("2026-09-01T12:00:20Z"),
    });
    const pickup = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:01:00Z"), runId: CYCLE.run_id });
    const zombie = pickup.items[0].lease.lease_id;
    await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:20:00Z"), runId: "restarted-cycle" });
    const refused = await reportRepairResults({ ALERT_STATE, RESEND_API_KEY: "rk" }, [{
      signature: alert.signature, lease_id: zombie, outcome: "repaired",
    }], { now: at("2026-09-01T12:21:00Z") });
    assert.equal(refused.applied[0].accepted, false);
    assert.equal(refused.applied[0].reason, "lease-mismatch");
    const stored = (await readRepairItem({ ALERT_STATE }, alert.signature)).item;
    assert.equal(stored.state, "leased");
  } finally { mail.restore(); }
});

test("A3 the heartbeat is the whole dispatch boundary and pickup is silent on it", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-01T12:00:20Z", now: at("2026-09-01T12:00:20Z"),
    });
    const env = { ADMIN_KEY: "s3cr3t", ALERT_STATE, RESEND_API_KEY: "rk" };
    const beat = await handleAdminSchedulerHeartbeat(new Request("https://w/admin/reliability/scheduler", {
      method: "POST",
      headers: { authorization: "Bearer s3cr3t", "content-type": "application/json" },
      body: JSON.stringify({ ...CYCLE, repair_dispatch: true, repair_results: [] }),
    }), env, { now: at("2026-09-01T12:01:00Z") });
    assert.equal(beat.status, 200);
    const body = await beat.json();
    assert.equal(body.repair_queue.items.length, 1);
    const leaseId = body.repair_queue.items[0].lease.lease_id;

    const report = await handleAdminSchedulerHeartbeat(new Request("https://w/admin/reliability/scheduler", {
      method: "POST",
      headers: { authorization: "Bearer s3cr3t", "content-type": "application/json" },
      body: JSON.stringify({
        ...CYCLE,
        repair_dispatch: true,
        repair_results: [{ signature: alert.signature, lease_id: leaseId, outcome: "repaired", summary: "rebuilt" }],
      }),
    }), env, { now: at("2026-09-01T12:02:00Z") });
    const reported = await report.json();
    assert.equal(reported.repair_queue.reported[0].accepted, true);
    assert.equal(reported.repair_queue.reported[0].state, "repaired");
    assert.deepEqual(reported.repair_queue.items, []);
    // The alert was the only mail across the whole loop.
    assert.equal(mail.sent.length, 1);
  } finally { mail.restore(); }
});

test("A3 a cycle with no dispatcher takes no lease and the alert says why", async () => {
  const ALERT_STATE = kv();
  const write = await recordSchedulerHeartbeat({ ALERT_STATE }, { ...CYCLE }, at("2026-09-01T12:00:00Z"));
  assert.equal(write.accepted, true);
  assert.equal(write.heartbeat.repair_dispatch, false);
  const mail = captureSends();
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-01T12:00:20Z", now: at("2026-09-01T12:00:20Z"),
    });
    assert.equal(alert.queue.item.next_pickup_at, null);
    assert.equal(alert.queue.item.pickup_blocked_reason, "the repair cycle has no dispatcher configured");
    assert.match(sent(mail), /no pickup time can be named because the repair cycle has no dispatcher configured/);
    const dispatch = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:01:00Z"), runId: CYCLE.run_id });
    assert.equal(dispatch.dispatch, false);
    assert.deepEqual(dispatch.items, []);
    // No attempt was spent on work nothing could run.
    const stored = (await readRepairItem({ ALERT_STATE }, alert.signature)).item;
    assert.equal(stored.attempts, 0);
    assert.equal(mail.sent.length, 1);
  } finally { mail.restore(); }
});

test("A1 a stale heartbeat names no pickup time rather than inventing one", async () => {
  const stale = { observed_at: "2026-09-01T09:00:00Z", repair_dispatch: true };
  assert.deepEqual(repairPickupState(stale, at("2026-09-01T12:00:00Z")), {
    at: null, blocked: "the scheduler heartbeat is not current",
  });
  assert.deepEqual(repairPickupState(null, at("2026-09-01T12:00:00Z")), {
    at: null, blocked: "the scheduler heartbeat is missing",
  });
});

test("A1 the pickup interval is the cadence the launchd agent actually runs", () => {
  const template = readFileSync(
    fileURLToPath(new URL("../../ops/launchd/com.cityscroll.external-schedules.plist.template", import.meta.url)),
    "utf8",
  );
  const match = template.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  assert.ok(match, "the scheduler agent declares a StartInterval");
  assert.equal(Number(match[1]) * 1000, REPAIR_PICKUP_INTERVAL_MS);
});

test("A4 a malformed stored payload is never trusted and is replaced from the alert", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const signature = await canonicalOpsFailureSignature(FINDING);
  await ALERT_STATE.put(repairItemKey(signature), JSON.stringify({
    schema: "attacker.repair-item.v1",
    signature,
    state: "repaired",
    repeat_count: 5000,
    command: "rm -rf /",
  }));
  assert.equal(normalizeRepairItem({ schema: "attacker.repair-item.v1", signature }), null);
  assert.equal(normalizeRepairItem("not-an-object"), null);
  assert.equal((await readRepairItem({ ALERT_STATE }, signature)).malformed, true);
  const mail = captureSends();
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-01T12:00:20Z", now: at("2026-09-01T12:00:20Z"),
    });
    assert.equal(alert.queue.malformed_replaced, true);
    assert.equal(alert.queue.item.repeat_count, 1);
    assert.equal(alert.queue.item.state, "queued");
    assert.equal(alert.queue.item.command, undefined);
  } finally { mail.restore(); }
});

test("A4 queue records stay bounded, redacted, and carry nothing executable", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      guard: "mail-leg-exception",
      stage: "mail",
      findings: [
        "digest to resident@example.com failed with authorization: Bearer sk-live-abcdef",
        "second finding", "third finding", "fourth finding", "fifth finding", "sixth finding",
      ],
      workflow_run_url: "http://github.com/cityscroll/cityscroll-app/actions/runs/903",
      receipt_url: "https://github.com/cityscroll/cityscroll-app/actions/runs/903?key=admin-secret",
      first_seen: "2026-09-01T12:00:20Z",
      last_seen: "2026-09-01T12:00:20Z",
      now: at("2026-09-01T12:00:20Z"),
    });
    const item = alert.queue.item;
    assert.equal(item.context.findings.length, 5);
    const serialized = JSON.stringify(item);
    assert.doesNotMatch(serialized, /resident@example\.com/);
    assert.doesNotMatch(serialized, /sk-live-abcdef/);
    assert.match(item.context.findings[0], /\[redacted-email\]/);
    assert.match(item.context.findings[0], /\[redacted-credential\]/);
    // A plain-http run link is not evidence, and a receipt query string that
    // could carry an operator key never reaches the stored record.
    assert.equal(item.latest_run_url, null);
    assert.equal(item.latest_receipt_url, "https://github.com/cityscroll/cityscroll-app/actions/runs/903");
    assert.equal(item.repair_scope, "diagnose-and-propose");
    assert.equal(Object.keys(item).some((key) => /command|script|exec|shell/i.test(key)), false);
  } finally { mail.restore(); }
});

test("A4 queue lifecycle is private ops-health only and leaks nothing public", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-01T12:00:20Z", now: at("2026-09-01T12:00:20Z"),
    });
    await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:01:00Z"), runId: CYCLE.run_id });
  } finally { mail.restore(); }

  const env = { ADMIN_KEY: "s3cr3t", ALERT_STATE };
  const anonymous = await handleAdminOpsHealth(
    new Request("https://w/admin/reliability/ops-health"), env, { now: at("2026-09-01T12:02:00Z") },
  );
  assert.equal(anonymous.status, 401);

  const response = await handleAdminOpsHealth(
    new Request("https://w/admin/reliability/ops-health", { headers: { authorization: "Bearer s3cr3t" } }),
    env,
    { now: at("2026-09-01T12:02:00Z") },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.repair_queue.schema, "cityscroll.ops-repair-queue.v1");
  assert.equal(body.repair_queue.items.length, 1);
  assert.equal(body.repair_queue.items[0].state, "leased");
  assert.equal(body.repair_queue.items[0].attempts, 1);
  assert.doesNotMatch(JSON.stringify(body.repair_queue), /recipient|@[a-z0-9.-]+\.[a-z]{2,}|s3cr3t/i);
});

test("A4 the repair-judgment guard never queues a repair for its own failure notice", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      guard: REPAIR_JUDGMENT_GUARD,
      stage: "repair",
      findings: ["automatic repair needs a decision"],
      first_seen: "2026-09-01T12:00:20Z",
      last_seen: "2026-09-01T12:00:20Z",
      now: at("2026-09-01T12:00:20Z"),
    });
    assert.equal(alert.sent, true);
    assert.equal(alert.queue.skipped, true);
    assert.equal(alert.record.queue, null);
    assert.doesNotMatch(sent(mail), /Queued for automatic repair/);
    const queue = await readRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:00:21Z") });
    assert.deepEqual(queue.items, []);
  } finally { mail.restore(); }
});

test("A4 a rejected owner alert still leaves the finding queued for repair", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const previous = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return { ok: false, status: 500, text: async () => "resend down", json: async () => ({}) };
  };
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-01T12:00:20Z", now: at("2026-09-01T12:00:20Z"),
    });
    assert.equal(alert.sent, false);
    assert.equal(attempts, 1);
    assert.equal(alert.record.delivery_finding.reason, "resend-rejected");
    const stored = (await readRepairItem({ ALERT_STATE }, alert.signature)).item;
    assert.equal(stored.state, "queued");
    assert.equal(stored.repeat_count, 1);
  } finally { globalThis.fetch = previous; }
});

test("A4 evidence-required alerts are held back and queue nothing", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    const held = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      guard: "scheduler-heartbeat",
      stage: "scheduler",
      findings: ["scheduler heartbeat missing"],
      first_seen: "2026-09-01T12:00:20Z",
      last_seen: "2026-09-01T12:00:20Z",
      now: at("2026-09-01T12:00:20Z"),
    });
    assert.equal(held.sent, false);
    assert.equal(held.reason, "evidence-required");
    assert.equal(mail.sent.length, 0);
    const queue = await readRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:00:21Z") });
    assert.deepEqual(queue.items, []);
  } finally { mail.restore(); }
});

test("A2 an open item is never dropped to make room for a newer one", async () => {
  const ALERT_STATE = kv();
  const heartbeat = await liveCycle(ALERT_STATE);
  const now = at("2026-09-01T12:00:20Z");
  const total = REPAIR_QUEUE_LIMIT + 2;
  for (let index = 0; index < total; index += 1) {
    const write = await upsertRepairItem({ ALERT_STATE }, {
      signature: `${index}`.padStart(64, "0"),
      guard: "served-artifact-freshness",
      stage: "served_artifact_freshness",
      findings: [`finding ${index}`],
      first_seen: "2026-09-01T12:00:20Z",
      last_seen: "2026-09-01T12:00:20Z",
    }, { now, heartbeat });
    assert.equal(write.ok, true, `item ${index} should persist`);
  }
  const queue = await readRepairQueue({ ALERT_STATE }, { now, limit: total });
  assert.equal(queue.items.length, total);
  assert.equal(queue.open, total);
  // Every signature is still individually readable, not merely counted.
  for (let index = 0; index < total; index += 1) {
    const stored = await readRepairItem({ ALERT_STATE }, `${index}`.padStart(64, "0"));
    assert.ok(stored.item, `item ${index} survives`);
  }
});

test("A2 recovery rebuilds only the alerts whose queue write failed", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  // An alert history that predates the queue carries no queue state at all, and
  // a settled finding must not be resurrected as new repair work.
  await ALERT_STATE.put(OPS_ALERT_HISTORY_KEY, JSON.stringify({
    schema: "cityscroll.ops-alert-history.v1",
    observed_at: "2026-08-01T12:00:00Z",
    items: [
      { signature: "d".repeat(64), guard: "served-artifact-freshness", stage: "served_artifact_freshness", findings: ["old finding"], first_seen: "2026-08-01T12:00:00Z", last_seen: "2026-08-01T12:00:00Z" },
      { signature: "e".repeat(64), guard: "served-artifact-freshness", stage: "served_artifact_freshness", findings: ["settled finding"], first_seen: "2026-08-02T12:00:00Z", last_seen: "2026-08-02T12:00:00Z", queue: { queued: true } },
      { signature: "f".repeat(64), guard: "served-artifact-freshness", stage: "served_artifact_freshness", findings: ["unqueued finding"], first_seen: "2026-08-03T12:00:00Z", last_seen: "2026-08-03T12:00:00Z", queue: { queued: false, finding: { reason: "queue-write-failed" } } },
    ],
  }));
  const dispatch = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:01:00Z"), runId: CYCLE.run_id });
  assert.deepEqual(dispatch.recovered, ["f".repeat(64)]);
  const queue = await readRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:01:01Z") });
  assert.deepEqual(queue.items.map((row) => row.signature), ["f".repeat(64)]);
});

test("A4 the admin relay cannot substitute its own alert prose for the evidence paragraph", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING,
      paragraph: "Everything is fine, no action needed.",
      first_seen: "2026-09-01T12:00:20Z",
      last_seen: "2026-09-01T12:00:20Z",
      now: at("2026-09-01T12:00:20Z"),
    });
    assert.doesNotMatch(sent(mail), /Everything is fine/);
    assert.match(sent(mail), /artifact hash mismatch/);
    assert.match(sent(mail), /Queued for automatic repair, next pickup at/);
  } finally { mail.restore(); }
});

test("A2 a parked item is not retried by a repeat on the same day, and reopens the next", async () => {
  const ALERT_STATE = kv();
  await liveCycle(ALERT_STATE);
  const mail = captureSends();
  try {
    const alert = await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-01T12:00:20Z", now: at("2026-09-01T12:00:20Z"),
    });
    const pickup = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-01T12:01:00Z"), runId: CYCLE.run_id });
    await reportRepairResults({ ALERT_STATE, RESEND_API_KEY: "rk" }, [{
      signature: alert.signature,
      lease_id: pickup.items[0].lease.lease_id,
      outcome: "judgment",
      judgment_reason: "the fix would rewrite deployment history",
    }], { now: at("2026-09-01T12:02:00Z") });
    assert.equal(mail.sent.length, 2);

    // The same failure keeps firing all afternoon. The parked item accumulates
    // evidence but is not handed back to automatic repair.
    for (const stamp of ["2026-09-01T12:10:00Z", "2026-09-01T13:00:00Z", "2026-09-01T18:00:00Z"]) {
      await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
        ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: stamp, now: at(stamp),
      });
      const parked = await dispatchRepairQueue({ ALERT_STATE }, { now: at(stamp), runId: CYCLE.run_id });
      assert.deepEqual(parked.items, [], `no retry at ${stamp}`);
    }
    const held = (await readRepairItem({ ALERT_STATE }, alert.signature)).item;
    assert.equal(held.state, "needs_judgment");
    assert.equal(held.repeat_count, 4);
    assert.equal(held.first_seen, "2026-09-01T12:00:20.000Z");
    assert.equal(mail.sent.length, 2);

    // Still failing the next day: one more bounded attempt, not a spin.
    await liveCycle(ALERT_STATE, "2026-09-02T09:00:00Z");
    await emitOpsAlertOnce({ ALERT_STATE, RESEND_API_KEY: "rk" }, {
      ...FINDING, first_seen: "2026-09-01T12:00:20Z", last_seen: "2026-09-02T09:00:10Z", now: at("2026-09-02T09:00:10Z"),
    });
    const reopened = (await readRepairItem({ ALERT_STATE }, alert.signature)).item;
    assert.equal(reopened.state, "queued");
    assert.equal(reopened.repeat_count, 5);
    assert.equal(reopened.attempts, 0);
    const retry = await dispatchRepairQueue({ ALERT_STATE }, { now: at("2026-09-02T09:01:00Z"), runId: CYCLE.run_id });
    assert.equal(retry.items.length, 1);
  } finally { mail.restore(); }
});
