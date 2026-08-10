// Catch-up evaluation (no-send outbox backfill). The legacy operator route keeps its
// input shape, but it now evaluates source predicates into durable owed identities.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  runCatchUpDigests,
  readCatchUpReceipt,
  readDigestDayLog,
  isMultiDayLagRecovery,
  processOneSub,
  runDigestShadowRecoveryCatchUp,
} from "../src/alerts.mjs";
import { readDigestShadowDegradedReceipt } from "../src/digest_shadow_hold.mjs";
import { toDayLogEntry, correctnessCheck, buildDayLog } from "../src/lib/digest_ops.mjs";
import { toRollupDayLogEntry } from "../src/lib/rollup.mjs";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
  async delete(k) { this.store.delete(k); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
  }
}

const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");
const DAY = () => new Date().toISOString().slice(0, 10);

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            run() {
              const result = statement.run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            },
            all() { return { results: statement.all(...params) }; },
            first() { return statement.get(...params) || null; },
          };
        },
      };
    },
    async batch(statements) { return statements.map((statement) => statement.run()); },
  };
  return { sqlite, db };
}

function seedSub(env, key, {
  email = "test-recipient-" + key.replace("sub:", "").replace(/:\w+$/, ""),
  lastsent = null,
  lens = "money",
  filter = { minAmount: 500000, keywords: ["construction"] },
  paused = false,
  subscriberId = null,
  watchId = null,
} = {}) {
  const rec = {
    email, lens, filter, freq: "daily", channel: "email",
    createdAt: "2026-07-01T00:00:00.000Z", lang: "en",
    subscriber_id: subscriberId || "subscriber:" + email,
    watch_id: watchId || "watch:" + key,
    ...(paused ? { paused: true } : {}),
  };
  env.SUBS.store.set(key, JSON.stringify(rec));
  if (lastsent) env.ALERT_STATE.store.set("lastsent:" + key, lastsent);
}

function createEnv(options = {}) {
  const SUBS = new MockKV();
  const ALERT_STATE = new MockKV();
  const { sqlite, db } = makeDb();
  return {
    env: { SUBS, ALERT_STATE, DB: db, ALERTS_LIVE: "true", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32), ...options },
    sqlite,
  };
}

function withFetch(handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => handler(String(url), options);
  return () => { globalThis.fetch = previous; };
}

test("shadow recovery remains pending because catch-up evaluation does not send", async () => {
  const ALERT_STATE = new MockKV();
  const pending = {
    contract: "digest-shadow-degraded-decision.v1",
    decision_id: "2026-08-01:HOLD_ALL_DARK_PERIOD",
    run_day: "2026-08-01",
    decision: "HOLD_ALL_DARK_PERIOD",
    attention_status: "open",
    catch_up_required: true,
  };
  await ALERT_STATE.put("digest:shadow:dark-hold:pending", JSON.stringify(pending));
  const calls = [];
  const out = await runDigestShadowRecoveryCatchUp(
    { ALERT_STATE },
    { catch_up_required: true, recovery_of: pending },
    {
      now: "2026-08-04T13:00:00.000Z",
      runCatchUpFn: async (_env, options) => {
        calls.push(options);
        return { live: false, evaluation_only: true, candidates: 2, sentThisRun: 0, results: [] };
      },
    },
  );
  assert.deepEqual(calls, [{ minLagDays: 1 }]);
  assert.equal(out.pending, true);
  assert.equal(out.receipt, null);
  assert.ok(await ALERT_STATE.get("digest:shadow:dark-hold:pending"));
});

test("catch-up evaluates a non-date meetings predicate without a lastsent date floor", async () => {
  const { env, sqlite } = createEnv();
  const key = "sub:meeting-old:m01";
  seedSub(env, key, {
    lens: "meetings",
    filter: { keywords: ["hearing"] },
    lastsent: "2026-08-09",
  });
  await env.ALERT_STATE.put("seen:" + key, JSON.stringify(["MEETING-OLD"]));
  const fetches = [];
  let resendCalls = 0;
  const restore = withFetch((url) => {
    fetches.push(url);
    if (url.includes("api.resend.com")) { resendCalls++; return Response.json({ id: "must-not-send" }); }
    return Response.json([{
      request_id: "MEETING-OLD",
      start_date: "2020-01-02",
      event_date: "2026-08-11",
      section_name: "Public Hearings and Meetings",
      short_title: "Old publication, current hearing",
    }]);
  });
  try {
    const result = await runCatchUpDigests(env, { subKeys: [key] });
    assert.equal(result.live, false);
    assert.equal(result.sentThisRun, 0);
    assert.equal(result.receipt.enqueued, 1);
    assert.equal(result.results[0].sections[0].status, "success");
    assert.equal(resendCalls, 0, "evaluation never calls the provider");
    assert.equal(await env.ALERT_STATE.get("lastsent:" + key), "2026-08-09", "lastsent is telemetry only");
    assert.equal(await env.ALERT_STATE.get("seen:" + key), JSON.stringify(["MEETING-OLD"]), "legacy seen is untouched");
    assert.equal(sqlite.prepare("SELECT item_id FROM digest_outbox_items").get().item_id, "notice:MEETING-OLD");
    const sourceRequest = fetches.find((url) => url.includes("dg92-zbpx"));
    assert.ok(sourceRequest);
    assert.ok(!sourceRequest.includes("start_date%20%3E%3D") && !sourceRequest.includes("start_date+%3E%3D"), "source request has no lastsent floor");
  } finally {
    restore();
    sqlite.close();
  }
});

test("catch-up enqueues distinct land identities by project_id", async () => {
  const { env, sqlite } = createEnv();
  const key = "sub:land-projects:l01";
  seedSub(env, key, { lens: "land", filter: { status: "all", keywords: [] }, lastsent: "2026-08-09" });
  let resendCalls = 0;
  const restore = withFetch((url) => {
    if (url.includes("api.resend.com")) { resendCalls++; return Response.json({ id: "must-not-send" }); }
    return Response.json([
      { project_id: "P-1", project_name: "Same title", current_milestone_date: "2020-01-01" },
      { project_id: "P-2", project_name: "Same title", current_milestone_date: "2020-01-01" },
    ]);
  });
  try {
    const result = await runCatchUpDigests(env, { subKeys: [key] });
    assert.equal(result.receipt.enqueued, 2);
    assert.equal(result.results[0].sections[0].new, 2);
    assert.equal(resendCalls, 0);
    assert.deepEqual(
      sqlite.prepare("SELECT item_id FROM digest_outbox_items ORDER BY item_id").all().map((row) => row.item_id),
      ["land:P-1", "land:P-2"],
    );
  } finally {
    restore();
    sqlite.close();
  }
});

test("catch-up reruns are idempotent and do not drain the outbox", async () => {
  const { env, sqlite } = createEnv();
  const key = "sub:idempotent:i01";
  seedSub(env, key, { lens: "land", filter: { status: "all", keywords: [] }, lastsent: "2026-08-09" });
  const restore = withFetch((url) => {
    if (url.includes("api.resend.com")) throw new Error("provider must not be called");
    return Response.json([{ project_id: "P-1", project_name: "One" }]);
  });
  try {
    const first = await runCatchUpDigests(env, { subKeys: [key] });
    const second = await runCatchUpDigests(env, { subKeys: [key] });
    assert.equal(first.receipt.enqueued, 1);
    assert.equal(second.receipt.enqueued, 0);
    assert.equal(second.results[0].sections[0].enqueued, 0);
    assert.equal(second.results[0].sections[0].status, "success");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items").get().n, 1);
  } finally {
    restore();
    sqlite.close();
  }
});

test("catch-up surfaces partial_error and failed sections instead of complete", async () => {
  const { env, sqlite } = createEnv();
  const goodKey = "sub:partial-good:p01";
  const badKey = "sub:partial-bad:p02";
  const email = "partial@example.com";
  seedSub(env, goodKey, {
    email, lens: "meetings", filter: { keywords: ["meet"] }, lastsent: "2026-08-09",
  });
  seedSub(env, badKey, {
    email, lens: "money", filter: { minAmount: 500000, keywords: ["fail"] }, lastsent: "2026-08-09",
  });
  const restore = withFetch((url) => {
    if (url.includes("api.resend.com")) throw new Error("provider must not be called");
    if (url.includes("fail")) throw new Error("money source unavailable");
    return Response.json([{
      request_id: "MEETING-OK",
      event_date: "2026-08-11",
      section_name: "Public Hearings and Meetings",
      short_title: "Meeting",
    }]);
  });
  try {
    const result = await runCatchUpDigests(env, { subKeys: [goodKey] });
    assert.equal(result.status, "partial_error");
    assert.equal(result.results[0].complete, false);
    const sections = result.results[0].sections;
    assert.deepEqual(sections.map((section) => section.status), ["success", "failed"]);
    assert.equal(sections[1].error, "money source unavailable");
    assert.equal(result.receipt.outcomes.partial_error, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items").get().n, 1);
  } finally {
    restore();
    sqlite.close();
  }
});

test("catch-up reports all-source failure as failed", async () => {
  const { env, sqlite } = createEnv();
  const key = "sub:failed-source:f01";
  seedSub(env, key, { lens: "money", filter: { minAmount: 500000, keywords: ["fail"] }, lastsent: "2026-08-09" });
  const restore = withFetch((url) => {
    if (url.includes("fail")) throw new Error("source unavailable");
    return Response.json([]);
  });
  try {
    const result = await runCatchUpDigests(env, { subKeys: [key] });
    assert.equal(result.status, "failed");
    assert.equal(result.results[0].status, "failed");
    assert.equal(result.results[0].complete, false);
    assert.equal(result.receipt.outcomes.failed, 1);
  } finally {
    restore();
    sqlite.close();
  }
});

test("catch-up receipt: written with mode 'catch_up' and readable", async () => {
  const { env, sqlite } = createEnv();
  const key = "sub:receipt:r01";
  seedSub(env, key, { lens: "land", filter: { status: "all", keywords: [] }, lastsent: "2026-08-09" });
  const restore = withFetch(() => Response.json([]));
  try {
    await runCatchUpDigests(env, { subKeys: [key] });
    const receipt = await readCatchUpReceipt(env);
    assert.ok(receipt);
    assert.equal(receipt.mode, "catch_up");
    assert.equal(receipt.evaluation_only, true);
    assert.equal(receipt.sent, 0);
  } finally {
    restore();
    sqlite.close();
  }
});

test("isMultiDayLagRecovery: lag > 1 day with fresh notices is recovery", () => {
  assert.equal(isMultiDayLagRecovery("2026-07-28", "2026-07-31", 3), true);
  assert.equal(isMultiDayLagRecovery("2026-07-30", "2026-07-31", 2), false, "1-day lag is normal daily");
  assert.equal(isMultiDayLagRecovery("2026-07-31", "2026-07-31", 1), false);
  assert.equal(isMultiDayLagRecovery("2026-07-28", "2026-07-31", 0), false, "no fresh → not recovery stamp");
  assert.equal(isMultiDayLagRecovery(null, "2026-07-31", 2), false);
});

test("processOneSub lag recovery: stamps traffic_class catch_up; email stays match action", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const key = "sub:lagrec@example.com:l01";
  seedSub({ SUBS, ALERT_STATE }, key, { lastsent: "2026-07-28" });
  const env = { SUBS, ALERT_STATE, ALERTS_LIVE: "true", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const notices = [
    { request_id: "20260729001", start_date: "2026-07-29T00:00:00.000", agency_name: "DDC", short_title: "Backlog A construction", contract_amount: "900000", section_name: "Procurement" },
    { request_id: "20260730001", start_date: "2026-07-30T00:00:00.000", agency_name: "DDC", short_title: "Backlog B construction", contract_amount: "800000", section_name: "Procurement" },
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us") || u.includes("dg92-zbpx")) return Response.json(notices);
    if (u.includes("api.resend.com")) return Response.json({ id: "lag_1" });
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const r = await processOneSub(
      env,
      {
        key,
        email: "lagrec@example.com",
        lens: "money",
        filter: { minAmount: 500000, keywords: ["construction"] },
        freq: "daily",
        channel: "email",
        createdAt: "2026-07-01T00:00:00.000Z",
        lang: "en",
      },
      {
        FROM: "CityScroll <alerts@cityscroll.org>",
        LIVE: true,
        heartbeatDays: 14,
        today: "2026-07-31",
        isMonday: false,
        counts: () => ({ "per-run": 0, daily: 0 }),
        caps: { "per-run": 25, daily: 50 },
        onSent: async () => {},
      },
    );
    assert.equal(r.sent, true);
    assert.equal(r.action, "match", "daily path keeps match action (not catch_up branded)");
    assert.equal(r.traffic_class, "catch_up");
    const entry = toDayLogEntry(r, { day: "2026-07-31" });
    assert.equal(entry.traffic_class, "catch_up");
    assert.equal(entry.action, "match");
    const c = correctnessCheck({
      day: "2026-07-31",
      dayLog: buildDayLog({ day: "2026-07-31", mode: "queue", results: [r] }),
      recounts: { [entry.id]: { noticeCount: 0, noticeIds: [] } },
    });
    assert.equal(c.status, "ok");
    assert.equal(c.catchUpExempt, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("processOneSub normal daily: lag=1 does not stamp catch_up", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const key = "sub:normal@example.com:n01";
  seedSub({ SUBS, ALERT_STATE }, key, { lastsent: "2026-07-30" });
  const env = { SUBS, ALERT_STATE, ALERTS_LIVE: "true", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const notices = [
    { request_id: "20260731001", start_date: "2026-07-31T00:00:00.000", agency_name: "DDC", short_title: "Today construction", contract_amount: "900000", section_name: "Procurement" },
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us") || u.includes("dg92-zbpx")) return Response.json(notices);
    if (u.includes("api.resend.com")) return Response.json({ id: "n1" });
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const r = await processOneSub(
      env,
      {
        key,
        email: "normal@example.com",
        lens: "money",
        filter: { minAmount: 500000, keywords: ["construction"] },
        freq: "daily",
        channel: "email",
        createdAt: "2026-07-01T00:00:00.000Z",
        lang: "en",
      },
      {
        FROM: "CityScroll <alerts@cityscroll.org>",
        LIVE: true,
        heartbeatDays: 14,
        today: "2026-07-31",
        isMonday: false,
        counts: () => ({ "per-run": 0, daily: 0 }),
        caps: { "per-run": 25, daily: 50 },
        onSent: async () => {},
      },
    );
    assert.equal(r.action, "match");
    assert.equal(r.traffic_class, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("toRollupDayLogEntry: traffic_class catch_up is preserved", () => {
  const e = toRollupDayLogEntry({
    sub: "account:ed***",
    kind: "rollup",
    found: 3,
    new: 3,
    noticeIds: ["a", "b", "c"],
    action: "match",
    traffic_class: "catch_up",
    sent: true,
    sections: [{ sub: "sub:a***", lens: "money", queryLabel: "education", new: 3, action: "match" }],
  }, { day: "2026-07-31" });
  assert.equal(e.action, "match");
  assert.equal(e.traffic_class, "catch_up");
});
