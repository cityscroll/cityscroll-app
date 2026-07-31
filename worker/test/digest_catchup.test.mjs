// Watermark recovery (catch-up digests): when delivery was broken for days, recovery
// must re-send the missed stream since the delivery watermark, not a single post-unclog drip.
// Tests the selection logic, the send path, and the receipt/stats bookkeeping.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runCatchUpDigests,
  readCatchUpReceipt,
  readDigestDayLog,
  isMultiDayLagRecovery,
  processOneSub,
} from "../src/alerts.mjs";
import { toDayLogEntry, correctnessCheck, buildDayLog } from "../src/lib/digest_ops.mjs";
import { toRollupDayLogEntry } from "../src/lib/rollup.mjs";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
  }
}

const DAY = () => new Date().toISOString().slice(0, 10);

function seedSub(env, key, { lastsent = null, lens = "money", filter = { minAmount: 500000, keywords: ["construction"] } } = {}) {
  const rec = { email: key.replace("sub:", "").replace(/:\w+$/, "") + "@example.com", lens, filter, freq: "daily", channel: "email", createdAt: "2026-07-01T00:00:00.000Z", lang: "en" };
  env.SUBS.store.set(key, JSON.stringify(rec));
  if (lastsent) env.ALERT_STATE.store.set(`lastsent:${key}`, lastsent);
}

function mockFetch(notices) {
  return async (url) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us") || u.includes("dg92-zbpx")) return Response.json(notices);
    if (u.includes("api.resend.com")) return Response.json({ id: "catchup_1" });
    throw new Error("unexpected fetch: " + u);
  };
}

test("catch-up selection: sub with lastsent >= minLagDays is targeted", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const today = DAY();
  const laggingKey = "sub:lagging@example.com:k01";
  const freshKey = "sub:fresh@example.com:k02";
  seedSub({ SUBS, ALERT_STATE }, laggingKey, { lastsent: "2026-07-28" });
  seedSub({ SUBS, ALERT_STATE }, freshKey, { lastsent: today });
  const env = { SUBS, ALERT_STATE, ALERTS_LIVE: "false", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch([]);
  try {
    const r = await runCatchUpDigests(env, { minLagDays: 2 });
    const targetedKeys = r.results.map((x) => x.sub);
    assert.ok(targetedKeys.some((s) => s.includes("la***")), "lagging sub is targeted");
    assert.ok(!targetedKeys.some((s) => s.includes("fr***") && !s.includes("la***")), "fresh sub is NOT targeted");
    assert.equal(r.candidates, 1, "exactly one lagging sub");
  } finally { globalThis.fetch = realFetch; }
});

test("catch-up send: clears seen, sends all missed notices, advances watermark", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const key = "sub:catchup@example.com:c01";
  seedSub({ SUBS, ALERT_STATE }, key, { lastsent: "2026-07-28" });
  // Poison the seen set (simulating the old bug): mark notices that should be re-sent.
  await ALERT_STATE.put(`seen:${key}`, JSON.stringify(["20260729001", "20260730001"]));
  const env = { SUBS, ALERT_STATE, ALERTS_LIVE: "true", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const sent = [];
  const notices = [
    { request_id: "20260729001", start_date: "2026-07-29T00:00:00.000", agency_name: "DDC", short_title: "Missed A", contract_amount: "900000", section_name: "Procurement" },
    { request_id: "20260730001", start_date: "2026-07-30T00:00:00.000", agency_name: "DDC", short_title: "Missed B", contract_amount: "800000", section_name: "Procurement" },
    { request_id: "20260731001", start_date: "2026-07-31T00:00:00.000", agency_name: "DDC", short_title: "Today C", contract_amount: "700000", section_name: "Procurement" },
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us") || u.includes("dg92-zbpx")) return Response.json(notices);
    if (u.includes("api.resend.com")) { sent.push(JSON.parse(opts.body)); return Response.json({ id: "catchup_1" }); }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const r = await runCatchUpDigests(env, { minLagDays: 2 });
    assert.equal(r.candidates, 1, "one lagging sub");
    const sub = r.results[0];
    assert.equal(sub.action, "catch_up");
    assert.equal(sub.sent, true, "catch-up email was sent");
    assert.ok(sub.new >= 2, "all missed notices found as fresh (seen was cleared)");
    assert.equal(sent.length, 1, "exactly one catch-up email");
    assert.match(sent[0].subject, /missed/i, "subject clearly says catch-up");
    // Watermark advanced to today.
    const lastsent = await ALERT_STATE.get(`lastsent:${key}`);
    assert.equal(lastsent, DAY(), "watermark advanced to today after catch-up send");
    // digest_catchup stat was bumped.
    const catchupStat = await ALERT_STATE.get("stats:alltime:digest_catchup");
    assert.equal(catchupStat, "1", "catch-up stat bumped");
  } finally { globalThis.fetch = realFetch; }
});

test("catch-up receipt: written with mode 'catch_up' and readable", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const key = "sub:receipt@example.com:r01";
  seedSub({ SUBS, ALERT_STATE }, key, { lastsent: "2026-07-28" });
  const env = { SUBS, ALERT_STATE, ALERTS_LIVE: "false", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch([]);
  try {
    await runCatchUpDigests(env, { minLagDays: 2 });
    const receipt = await readCatchUpReceipt(env);
    assert.ok(receipt, "receipt exists");
    assert.equal(receipt.mode, "catch_up");
    assert.equal(receipt.candidates, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("catch-up: no lagging subs returns skipped_reason 'no_lagging_subs'", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const today = DAY();
  const key = "sub:current@example.com:n01";
  seedSub({ SUBS, ALERT_STATE }, key, { lastsent: today });
  const env = { SUBS, ALERT_STATE, ALERTS_LIVE: "true", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch([]);
  try {
    const r = await runCatchUpDigests(env, { minLagDays: 2 });
    assert.equal(r.candidates, 0, "no lagging subs");
    assert.equal(r.receipt.skipped_reason, "no_lagging_subs");
  } finally { globalThis.fetch = realFetch; }
});

test("catch-up: explicit subKeys forces catch-up for specified subs regardless of lag", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const today = DAY();
  const key = "sub:forced@example.com:f01";
  seedSub({ SUBS, ALERT_STATE }, key, { lastsent: today }); // NOT lagging
  const env = { SUBS, ALERT_STATE, ALERTS_LIVE: "false", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch([
    { request_id: "20260731001", start_date: "2026-07-31T00:00:00.000", agency_name: "DDC", short_title: "Forced", contract_amount: "600000", section_name: "Procurement" },
  ]);
  try {
    const r = await runCatchUpDigests(env, { subKeys: [key] });
    assert.equal(r.candidates, 1, "forced sub is targeted even though it's not lagging");
  } finally { globalThis.fetch = realFetch; }
});

// QUEUE_DIGESTS must not skip catch-up daylog merge — desk phantom_send exemption
// requires stamped daylog rows (action/traffic_class catch_up).
test("catch-up under queue mode: daylog entries are written with catch_up stamp", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const key = "sub:queuecu@example.com:q01";
  seedSub({ SUBS, ALERT_STATE }, key, { lastsent: "2026-07-28" });
  const env = {
    SUBS,
    ALERT_STATE,
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "rk",
    TOKEN_SECRET: "s".repeat(32),
    // Simulate production queue mode: catch-up must still write daylog (was gated off).
    QUEUE_DIGESTS: "true",
    DIGEST_QUEUE: { send: async () => {} },
  };
  const notices = [
    { request_id: "20260729001", start_date: "2026-07-29T00:00:00.000", agency_name: "DDC", short_title: "Missed A", contract_amount: "900000", section_name: "Procurement" },
    { request_id: "20260730001", start_date: "2026-07-30T00:00:00.000", agency_name: "DDC", short_title: "Missed B", contract_amount: "800000", section_name: "Procurement" },
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(notices);
  // Force Resend success path via mockFetch (ALERTS_LIVE true).
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us") || u.includes("dg92-zbpx")) return Response.json(notices);
    if (u.includes("api.resend.com")) return Response.json({ id: "catchup_q1" });
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const r = await runCatchUpDigests(env, { minLagDays: 2 });
    assert.equal(r.candidates, 1);
    assert.ok(r.results[0]?.sent, "catch-up send happened");
    const day = DAY();
    const dayLog = await readDigestDayLog(env, day);
    assert.ok(dayLog, "daylog must exist under queue mode after catch-up");
    assert.ok(Array.isArray(dayLog.entries) && dayLog.entries.length >= 1, "daylog has catch-up entries");
    const stamped = dayLog.entries.filter((e) => e.action === "catch_up" || e.traffic_class === "catch_up");
    assert.ok(stamped.length >= 1, "at least one entry stamped catch_up");
    assert.equal(stamped[0].traffic_class, "catch_up");
    // Desk correctness: multi-day noticeCount vs day-scoped expected=0 is exempt.
    const c = correctnessCheck({
      day,
      dayLog,
      recounts: { [stamped[0].id]: { noticeCount: 0, noticeIds: [] } },
    });
    assert.equal(c.status, "ok", "stamped catch-up must not phantom_send");
    assert.ok(c.catchUpExempt >= 1);
  } finally {
    globalThis.fetch = realFetch;
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
