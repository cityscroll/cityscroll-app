// Watermark recovery (catch-up digests): when delivery was broken for days, recovery
// must re-send the missed stream since the delivery watermark, not a single post-unclog drip.
// Tests the selection logic, the send path, and the receipt/stats bookkeeping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCatchUpDigests, readCatchUpReceipt } from "../src/alerts.mjs";

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
