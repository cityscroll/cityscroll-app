import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DIGEST_SHADOW_DARK_DAYS,
  DIGEST_SHADOW_HOLD_CONTRACT,
  buildDigestShadowHoldState,
  digestIdForJob,
  isDigestHeld,
  partitionDigestJobsByHold,
  readDigestShadowDegradedReceipt,
  resolveDigestShadowHold,
} from "../src/digest_shadow_hold.mjs";

const DAY = "2026-08-04";

function redlined(ids = ["digest:one"]) {
  return {
    contract: "digest-shadow.v1",
    run_day: DAY,
    ran_at: `${DAY}T10:00:00.000Z`,
    status: "NEEDS_ATTENTION",
    ok: false,
    affected_digest_ids: ids,
    redlines: ids.map((digestId) => ({ code: "render_error", digest_id: digestId })),
  };
}

function ready() {
  return {
    contract: "digest-shadow.v1",
    run_day: DAY,
    ran_at: `${DAY}T12:50:00.000Z`,
    status: "READY",
    ok: true,
    affected_digest_ids: [],
    redlines: [],
  };
}

test("redlined digest ids become scoped holds at the documented cutoff and remain held at delivery", () => {
  const pending = buildDigestShadowHoldState({
    summary: redlined(["digest:one", "digest:two"]),
    now: `${DAY}T12:44:59.000Z`,
  });
  assert.equal(pending.contract, DIGEST_SHADOW_HOLD_CONTRACT);
  assert.equal(pending.source_status, "REDLINES_REPAIR_WINDOW");
  assert.deepEqual(pending.active_digest_ids, []);

  const cutoff = buildDigestShadowHoldState({
    summary: redlined(["digest:one", "digest:two"]),
    now: `${DAY}T12:45:00.000Z`,
  });
  assert.equal(cutoff.delivery_policy, "AFFECTED_DIGESTS_HELD");
  assert.deepEqual(cutoff.active_digest_ids, ["digest:one", "digest:two"]);

  const boundary = buildDigestShadowHoldState({
    summary: redlined(["digest:one", "digest:two"]),
    now: `${DAY}T13:00:00.000Z`,
  });
  assert.equal(isDigestHeld(boundary, "digest:one"), true);
  assert.equal(isDigestHeld(boundary, "digest:unrelated"), false);
});

test("holds expire automatically after the delivery window", () => {
  const state = buildDigestShadowHoldState({
    summary: redlined(),
    now: `${DAY}T14:00:00.000Z`,
  });
  assert.equal(state.source_status, "REDLINES_HOLD_EXPIRED");
  assert.equal(state.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.deepEqual(state.active_digest_ids, []);
});

test("missing runs and hold-store failures are distinct fail-open states", async () => {
  const missing = buildDigestShadowHoldState({
    summary: null,
    lastReadyRunDay: "2026-08-03",
    now: `${DAY}T13:00:00.000Z`,
  });
  assert.equal(missing.source_status, "MISSING_RUN");
  assert.equal(missing.delivery_policy, "ALL_DIGESTS_ELIGIBLE");

  const unavailable = await resolveDigestShadowHold({
    prepare() { throw new Error("D1 unavailable"); },
  }, { now: `${DAY}T13:00:00.000Z`, retryDelaysMs: [0, 0] });
  assert.equal(unavailable.source_status, "HOLD_STORE_UNAVAILABLE");
  assert.equal(unavailable.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.match(unavailable.observation, /D1 unavailable/);
});

class MockKV {
  constructor() { this.store = new Map(); }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, String(value)); }
  async delete(key) { this.store.delete(key); }
}

function persistedState(overrides = {}) {
  return {
    contract: DIGEST_SHADOW_HOLD_CONTRACT,
    run_day: DAY,
    evaluated_at: `${DAY}T10:00:00.000Z`,
    cutoff_at: `${DAY}T12:45:00.000Z`,
    delivery_boundary_at: `${DAY}T13:00:00.000Z`,
    expires_at: `${DAY}T14:00:00.000Z`,
    source_status: "REDLINES_REPAIR_WINDOW",
    delivery_policy: "ALL_DIGESTS_ELIGIBLE",
    fail_policy: "repair_window_open",
    affected_digest_ids: ["digest:one"],
    overridden_digest_ids: [],
    active_digest_ids: [],
    ...overrides,
  };
}

function graduatedDb({
  failuresBeforeSuccess = 0,
  summary = null,
  lastKnown = null,
  lastReadyRunDay = null,
} = {}) {
  let currentAttempts = 0;
  const writes = [];
  return {
    get currentAttempts() { return currentAttempts; },
    writes,
    prepare(sql) {
      const query = { sql, args: [] };
      query.bind = (...args) => { query.args = args; return query; };
      query.first = async () => {
        if (sql.includes("FROM digest_shadow_hold_states")) {
          return lastKnown ? { state_json: JSON.stringify(lastKnown) } : null;
        }
        if (sql.includes("status = 'READY'")) {
          return lastReadyRunDay ? { run_day: lastReadyRunDay } : null;
        }
        if (sql.includes("FROM digest_shadow_runs WHERE run_day")) {
          currentAttempts++;
          if (currentAttempts <= failuresBeforeSuccess) throw new Error("transient D1 read");
          return summary ? { summary_json: JSON.stringify(summary) } : null;
        }
        return null;
      };
      query.all = async () => ({ results: [] });
      query.run = async () => { writes.push({ sql, args: query.args }); return { success: true }; };
      return query;
    },
  };
}

test("delivery read retries twice before using the successful third attempt", async () => {
  const db = graduatedDb({ failuresBeforeSuccess: 2, summary: ready() });
  const state = await resolveDigestShadowHold(db, {
    now: `${DAY}T13:00:00.000Z`,
    retryDelaysMs: [0, 0],
  });
  assert.equal(db.currentAttempts, 3);
  assert.equal(state.source_status, "READY");
  assert.equal(state.degraded_receipt, undefined);
});

test("store outage uses today's persisted redline state and emits a degraded receipt", async () => {
  const receipts = new MockKV();
  const db = graduatedDb({
    failuresBeforeSuccess: 99,
    lastKnown: persistedState(),
    lastReadyRunDay: "2026-08-03",
  });
  const state = await resolveDigestShadowHold(db, {
    now: `${DAY}T13:00:00.000Z`,
    persist: true,
    receiptStore: receipts,
    retryDelaysMs: [0, 0],
  });
  assert.equal(db.currentAttempts, 3, "bounded at three current-state attempts");
  assert.equal(state.source_status, "LAST_KNOWN_REDLINE");
  assert.equal(state.delivery_policy, "AFFECTED_DIGESTS_HELD");
  assert.deepEqual(state.active_digest_ids, ["digest:one"]);
  assert.equal(state.degraded_receipt.decision, "SEND_ON_LAST_KNOWN_STATE");
  assert.equal(isDigestHeld(state, "digest:one"), true);
  assert.equal(isDigestHeld(state, "digest:other"), false);
  assert.equal((await readDigestShadowDegradedReceipt(receipts)).decision, "SEND_ON_LAST_KNOWN_STATE");
  assert.equal(db.writes.length, 0, "degraded receipt must not overwrite the usable canonical state");
});

test("store outage sends on today's persisted READY state", async () => {
  const state = await resolveDigestShadowHold(graduatedDb({
    failuresBeforeSuccess: 99,
    lastKnown: persistedState({
      source_status: "READY",
      affected_digest_ids: [],
      observation: "ready",
    }),
  }), {
    now: `${DAY}T13:00:00.000Z`,
    retryDelaysMs: [0, 0],
  });
  assert.equal(state.source_status, "LAST_KNOWN_READY");
  assert.equal(state.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.equal(state.degraded_receipt.decision, "SEND_ON_LAST_KNOWN_STATE");
});

test("store outage without usable last-known state fails open loudly inside the dark window", async () => {
  const receipts = new MockKV();
  const db = graduatedDb({
    failuresBeforeSuccess: 99,
    lastReadyRunDay: "2026-08-02",
  });
  const state = await resolveDigestShadowHold(db, {
    now: `${DAY}T13:00:00.000Z`,
    persist: true,
    receiptStore: receipts,
    retryDelaysMs: [0, 0],
  });
  assert.equal(state.source_status, "HOLD_STORE_UNAVAILABLE");
  assert.equal(state.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.equal(state.degraded_receipt.decision, "SEND_FAIL_OPEN");
  assert.equal(state.degraded_receipt.signal, "desk_loud");
});

test("store outage without last-known state holds all when READY history reaches the boundary", async () => {
  const state = await resolveDigestShadowHold(graduatedDb({
    failuresBeforeSuccess: 99,
    lastReadyRunDay: "2026-08-01",
  }), {
    now: `${DAY}T13:00:00.000Z`,
    retryDelaysMs: [0, 0],
  });
  assert.equal(state.source_status, "DARK_PERIOD");
  assert.equal(state.delivery_policy, "ALL_DIGESTS_HELD");
  assert.equal(state.degraded_receipt.retry_attempts, 3);
});

test("missing rehearsal fails open before the three-day boundary and holds all at it", async () => {
  assert.equal(DIGEST_SHADOW_DARK_DAYS, 3);
  const inside = buildDigestShadowHoldState({
    summary: null,
    lastReadyRunDay: "2026-08-02",
    now: `${DAY}T13:00:00.000Z`,
  });
  assert.equal(inside.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.equal(inside.degraded_receipt.decision, "SEND_FAIL_OPEN");
  assert.equal(inside.degraded_receipt.ready_age_days, 2);

  const boundary = buildDigestShadowHoldState({
    summary: null,
    lastReadyRunDay: "2026-08-01",
    now: `${DAY}T13:00:00.000Z`,
  });
  assert.equal(boundary.source_status, "DARK_PERIOD");
  assert.equal(boundary.delivery_policy, "ALL_DIGESTS_HELD");
  assert.equal(boundary.degraded_receipt.decision, "HOLD_ALL_DARK_PERIOD");
  assert.equal(boundary.degraded_receipt.ready_age_days, 3);
  assert.equal(isDigestHeld(boundary, "digest:anything"), true);
});

test("missing rehearsal with no READY history enters the dark hold", () => {
  const state = buildDigestShadowHoldState({
    summary: null,
    lastReadyRunDay: null,
    now: `${DAY}T13:00:00.000Z`,
  });
  assert.equal(state.delivery_policy, "ALL_DIGESTS_HELD");
  assert.equal(state.degraded_receipt.last_ready_run_day, null);
});

test("dark-period decision persists the machine receipt and recovery marker", async () => {
  const receipts = new MockKV();
  const state = await resolveDigestShadowHold(graduatedDb({
    summary: null,
    lastReadyRunDay: "2026-08-01",
  }), {
    now: `${DAY}T13:00:00.000Z`,
    persist: true,
    receiptStore: receipts,
    retryDelaysMs: [0, 0],
  });
  assert.equal(state.delivery_policy, "ALL_DIGESTS_HELD");
  assert.equal((await readDigestShadowDegradedReceipt(receipts)).decision, "HOLD_ALL_DARK_PERIOD");
  assert.match(await receipts.get("digest:shadow:dark-hold:pending"), /HOLD_ALL_DARK_PERIOD/);
});

test("READY recovery carries the pending dark hold into the catch-up path", async () => {
  const receipts = new MockKV();
  await receipts.put("digest:shadow:dark-hold:pending", JSON.stringify({
    decision_id: "2026-08-03:HOLD_ALL_DARK_PERIOD",
    decision: "HOLD_ALL_DARK_PERIOD",
  }));
  const state = await resolveDigestShadowHold(graduatedDb({ summary: ready() }), {
    now: `${DAY}T13:00:00.000Z`,
    receiptStore: receipts,
    retryDelaysMs: [0, 0],
  });
  assert.equal(state.source_status, "READY");
  assert.equal(state.catch_up_required, true);
  assert.equal(state.recovery_of.decision, "HOLD_ALL_DARK_PERIOD");
});

test("partial repair narrows the hold and a READY rerun releases every digest", () => {
  const partial = buildDigestShadowHoldState({
    summary: redlined(["digest:two"]),
    now: `${DAY}T13:00:00.000Z`,
  });
  assert.deepEqual(partial.active_digest_ids, ["digest:two"]);
  assert.equal(isDigestHeld(partial, "digest:one"), false);

  const released = buildDigestShadowHoldState({
    summary: ready(),
    now: `${DAY}T13:00:00.000Z`,
  });
  assert.equal(released.source_status, "READY");
  assert.equal(released.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.deepEqual(released.active_digest_ids, []);
});

test("operator overrides release only named affected digests", () => {
  const state = buildDigestShadowHoldState({
    summary: redlined(["digest:one", "digest:two"]),
    overriddenDigestIds: ["digest:one"],
    now: `${DAY}T13:00:00.000Z`,
  });
  assert.deepEqual(state.overridden_digest_ids, ["digest:one"]);
  assert.deepEqual(state.active_digest_ids, ["digest:two"]);
});

test("queue partition leaves unrelated accounts eligible", async () => {
  const single = { type: "sub", key: "sub:single", email: "single" + "@example.com" };
  const rollup = {
    type: "rollup",
    email: "rollup" + "@example.com",
    keys: ["sub:b", "sub:a"],
  };
  const heldId = await digestIdForJob(single);
  const state = buildDigestShadowHoldState({
    summary: redlined([heldId]),
    now: `${DAY}T13:00:00.000Z`,
  });
  const out = await partitionDigestJobsByHold([single, rollup], state);
  assert.deepEqual(out.eligible, [rollup]);
  assert.equal(out.held.length, 1);
  assert.equal(out.held[0].digest_id, heldId);
  assert.equal(await digestIdForJob({ ...rollup, keys: ["sub:a", "sub:b"] }), await digestIdForJob(rollup));
});

test("dark-period policy partitions every queued digest into the recovery hold", async () => {
  const jobs = [
    { type: "sub", key: "sub:one" },
    { type: "rollup", email: ["example", "example.com"].join("@"), keys: ["sub:two", "sub:three"] },
  ];
  const state = buildDigestShadowHoldState({
    summary: null,
    lastReadyRunDay: "2026-08-01",
    now: `${DAY}T13:00:00.000Z`,
  });
  const partition = await partitionDigestJobsByHold(jobs, state);
  assert.deepEqual(partition.eligible, []);
  assert.deepEqual(partition.held.map((item) => item.job), jobs);
});
