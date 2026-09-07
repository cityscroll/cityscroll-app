// The queue used to be fed only by owner alerts, so a monitor could report the
// same condition every morning and nothing machine-readable ever came of it.
// These cases pin the other feed: a degraded monitor run becomes queue items, a
// recovered one closes them, and a condition that repeats stays one item.
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMonitorFindings,
  dispatchRepairQueue,
  recordSchedulerHeartbeat,
} from "../src/reliability_watchdogs.mjs";
import {
  readRepairItem,
  readRepairQueue,
  recoverRepairItem,
  repairScopeMembers,
  repairScopeSubject,
} from "../src/lib/repair_queue.mjs";
import { handleAdminSchedulerHeartbeat } from "../src/admin.mjs";

function kv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key) { return store.get(key) || null; },
    async put(key, value) { store.set(key, String(value)); },
  };
}

const CYCLE = Object.freeze({
  workflow: "com.cityscroll.external-schedules",
  run_id: "2026-09-07T10-23:runner-3:991",
  source_revision: "42ab127935d09b99afa1fc88d6065212efd4b04a",
  result: "degraded",
  repair_dispatch: true,
});

const STALE = "monitor:source-contracts-live:source-contract-stale:cfb-campaign-contributions";
const STALE_SCOPE = "monitor:source-contracts-live:source-contract-stale";
const OUTAGE = "monitor:source-contracts-live:source-contract-outage:some-outage-source";

function finding(signature, overrides = {}) {
  return {
    signature,
    guard: "source-contracts-live",
    stage: "source-contract-stale",
    findings: ["cfb-campaign-contributions: source is stale (261 days; limit 30)"],
    last_seen: "2026-09-07T10:24:11.166Z",
    ...overrides,
  };
}

async function liveCycle(ALERT_STATE, observedAt = "2026-09-07T10:24:00Z") {
  const write = await recordSchedulerHeartbeat({ ALERT_STATE }, CYCLE, new Date(observedAt));
  assert.equal(write.accepted, true);
  return write.heartbeat;
}

test("a degraded monitor run becomes one queue item per failure signature", async () => {
  const ALERT_STATE = kv();
  const env = { ALERT_STATE };
  const heartbeat = await liveCycle(ALERT_STATE);
  const applied = await applyMonitorFindings(env, {
    findings: [finding(STALE), finding(OUTAGE, { stage: "source-contract-outage" })],
    recovered: [{ prefix: STALE_SCOPE, still_failing: ["cfb-campaign-contributions"] }],
    now: new Date("2026-09-07T10:24:11.166Z"),
    heartbeat,
  });
  assert.deepEqual(applied.queued.map((row) => row.signature).sort(), [OUTAGE, STALE].sort());
  assert.deepEqual(applied.rejected, []);
  const { item } = await readRepairItem(env, STALE);
  assert.equal(item.state, "queued");
  assert.equal(item.guard, "source-contracts-live");
  assert.equal(item.stage, "source-contract-stale");
  assert.equal(item.repeat_count, 1);
  assert.match(item.context.findings[0], /261 days/);
  // The cycle that observed it also named a pickup, because it declared a
  // dispatcher on the same heartbeat.
  assert.ok(item.next_pickup_at);
  assert.equal(item.pickup_blocked_reason, null);
});

test("the same condition on a later day advances one item rather than opening a second", async () => {
  const ALERT_STATE = kv();
  const env = { ALERT_STATE };
  const heartbeat = await liveCycle(ALERT_STATE);
  for (const day of ["2026-09-07", "2026-09-08", "2026-09-09"]) {
    await applyMonitorFindings(env, {
      findings: [finding(STALE, { last_seen: `${day}T10:24:11.166Z` })],
      now: new Date(`${day}T10:24:11.166Z`),
      heartbeat,
    });
  }
  const queue = await readRepairQueue(env, { now: new Date("2026-09-09T10:30:00Z") });
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].repeat_count, 3);
  // First-seen is the condition's history and is never reset by a repeat.
  assert.equal(queue.items[0].first_seen.slice(0, 10), "2026-09-07");
  assert.equal(queue.items[0].last_seen.slice(0, 10), "2026-09-09");
});

test("a monitor that no longer reports a subject closes its item as recovered", async () => {
  const ALERT_STATE = kv();
  const env = { ALERT_STATE };
  const heartbeat = await liveCycle(ALERT_STATE);
  await applyMonitorFindings(env, { findings: [finding(STALE)], now: new Date("2026-09-07T10:24:11Z"), heartbeat });

  // The next run evaluated the same scope and found nothing failing in it. The
  // run cannot know what was failing yesterday, so it states the scope and the
  // queue closes what is no longer in it.
  const applied = await applyMonitorFindings(env, {
    findings: [],
    recovered: [{ prefix: STALE_SCOPE, still_failing: [] }],
    now: new Date("2026-09-08T10:24:11Z"),
    heartbeat,
  });
  assert.deepEqual(applied.recovered, [STALE]);
  const { item } = await readRepairItem(env, STALE);
  assert.equal(item.state, "repaired");
  // A separate word from `repaired`, so an operator can tell a playbook that
  // worked from a condition that went away by itself.
  assert.equal(item.result.outcome, "recovered");
});

test("a scope closes only the subjects the monitor stopped reporting", async () => {
  const ALERT_STATE = kv();
  const env = { ALERT_STATE };
  const heartbeat = await liveCycle(ALERT_STATE);
  const second = `${STALE_SCOPE}:dsny-district-boundaries`;
  await applyMonitorFindings(env, {
    findings: [finding(STALE), finding(second)],
    now: new Date("2026-09-07T10:24:11Z"),
    heartbeat,
  });
  const applied = await applyMonitorFindings(env, {
    findings: [finding(second)],
    recovered: [{ prefix: STALE_SCOPE, still_failing: ["dsny-district-boundaries"] }],
    now: new Date("2026-09-08T10:24:11Z"),
    heartbeat,
  });
  assert.deepEqual(applied.recovered, [STALE]);
  assert.equal((await readRepairItem(env, second)).item.state, "queued");
});

test("a recovery scope never sweeps up a neighbouring class that starts the same way", async () => {
  // `monitor:m:stale` must not close `monitor:m:stale-artifact`, or recovering
  // one condition would silently retire an unrelated open finding.
  const signatures = [
    "monitor:m:freshness-stale",
    "monitor:m:freshness-stale:a",
    "monitor:m:freshness-staleness:a",
    "monitor:other:freshness-stale:a",
  ];
  assert.deepEqual(repairScopeMembers(signatures, "monitor:m:freshness-stale"), [
    "monitor:m:freshness-stale",
    "monitor:m:freshness-stale:a",
  ]);
  assert.equal(repairScopeSubject("monitor:m:freshness-stale", "monitor:m:freshness-stale"), null);
  assert.equal(repairScopeSubject("monitor:m:freshness-stale:a", "monitor:m:freshness-stale"), "a");
});

test("an item a cycle is holding is left to that cycle's own report", async () => {
  const ALERT_STATE = kv();
  const env = { ALERT_STATE };
  const heartbeat = await liveCycle(ALERT_STATE);
  await applyMonitorFindings(env, { findings: [finding(STALE)], now: new Date("2026-09-07T10:24:11Z"), heartbeat });
  const dispatch = await dispatchRepairQueue(env, { now: new Date("2026-09-07T10:25:00Z"), runId: CYCLE.run_id });
  assert.equal(dispatch.items.length, 1);
  assert.equal(dispatch.items[0].state, "leased");

  const closed = await recoverRepairItem(env, STALE, { now: new Date("2026-09-07T10:25:30Z") });
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, "leased");
  assert.equal((await readRepairItem(env, STALE)).item.state, "leased");
});

test("a malformed signature is rejected rather than stored as a key", async () => {
  const ALERT_STATE = kv();
  const env = { ALERT_STATE };
  const heartbeat = await liveCycle(ALERT_STATE);
  const applied = await applyMonitorFindings(env, {
    findings: [
      finding("not-a-signature"),
      finding("monitor:source-contracts-live:Source Contract Stale:x"),
      finding(`monitor:source-contracts-live:source-contract-stale:${"x".repeat(200)}`),
    ],
    recovered: [{ prefix: "nonsense", still_failing: [] }],
    now: new Date("2026-09-07T10:24:11Z"),
    heartbeat,
  });
  assert.deepEqual(applied.queued, []);
  assert.equal(applied.rejected.length, 4);
  assert.deepEqual([...new Set(applied.rejected.map((row) => row.reason))].sort(), ["scope-malformed", "signature-malformed"]);
  assert.equal((await readRepairQueue(env, { now: new Date("2026-09-07T10:30:00Z") })).items.length, 0);
});

test("one heartbeat reports the last cycle's outcomes, ingests this cycle's findings, and leases", async () => {
  // The whole loop runs on the existing heartbeat: no second endpoint, no
  // second schedule, and a finding observed in this run is eligible for pickup
  // in this run because ingestion happens before leasing.
  const ALERT_STATE = kv();
  const request = new Request("https://api.example.test/admin/reliability/scheduler", {
    method: "POST",
    headers: { authorization: "Bearer admin-key", "content-type": "application/json" },
    body: JSON.stringify({
      ...CYCLE,
      repair_results: [],
      repair_findings: [finding(STALE)],
      repair_recovered: [{ prefix: STALE_SCOPE, still_failing: ["cfb-campaign-contributions"] }],
    }),
  });
  const response = await handleAdminSchedulerHeartbeat(request, { ALERT_STATE, ADMIN_KEY: "admin-key" }, {
    now: new Date("2026-09-07T10:24:11.166Z"),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.repair_queue.queued.length, 1);
  assert.deepEqual(body.repair_queue.recovered, []);
  assert.deepEqual(body.repair_queue.rejected, []);
  assert.equal(body.repair_queue.items.length, 1);
  assert.equal(body.repair_queue.items[0].signature, STALE);
  assert.equal(body.repair_queue.items[0].state, "leased");
  assert.equal(body.repair_queue.items[0].repair_scope, "diagnose-and-propose");
  // Nothing in a leased item names anything to run: the dispatcher selects a
  // committed playbook from the signature alone.
  assert.equal(body.repair_queue.items[0].command, undefined);
});

test("a cycle with no dispatcher ingests findings but leases none of them", async () => {
  const ALERT_STATE = kv();
  const request = new Request("https://api.example.test/admin/reliability/scheduler", {
    method: "POST",
    headers: { authorization: "Bearer admin-key", "content-type": "application/json" },
    body: JSON.stringify({
      ...CYCLE,
      repair_dispatch: false,
      repair_findings: [finding(STALE)],
    }),
  });
  const response = await handleAdminSchedulerHeartbeat(request, { ALERT_STATE, ADMIN_KEY: "admin-key" }, {
    now: new Date("2026-09-07T10:24:11.166Z"),
  });
  const body = await response.json();
  assert.equal(body.repair_queue.queued.length, 1);
  assert.deepEqual(body.repair_queue.items, []);
  // Spending an attempt on work nothing will run is how a queue exhausts itself
  // into mail, so the item says why no pickup can be named instead.
  const { item } = await readRepairItem({ ALERT_STATE }, STALE);
  assert.equal(item.next_pickup_at, null);
  assert.match(item.pickup_blocked_reason, /no dispatcher/);
});
