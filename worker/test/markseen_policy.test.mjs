// Regression: markSeen must only advance the seen set AFTER a successful send, not on
// every run that happens to be under the send cap. Before the fix, a dry-run or a run
// where send stayed false would silently swallow fresh notices so the next run treated
// them as already-seen — the watermark-poisoning bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { processOneSub } from "../src/alerts.mjs";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
  }
}

const SUB_KEY = "sub:tester@example.com:markfix01";
function seedSub(env) {
  return env.SUBS.put(SUB_KEY, JSON.stringify({
    email: "tester@example.com", lens: "money",
    filter: { minAmount: 500000, keywords: ["construction"] },
    freq: "daily", channel: "email", createdAt: "2026-07-01T00:00:00.000Z", lang: "en",
  }));
}

function mockFetch(notices) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us") || u.includes("dg92-zbpx")) {
      return Response.json(notices);
    }
    if (u.includes("api.resend.com")) {
      return Response.json({ id: "email_1" });
    }
    throw new Error("unexpected fetch: " + u);
  };
}

const FRESH_NOTICES = [
  { request_id: "20260731001", start_date: "2026-07-31T00:00:00.000", agency_name: "DDC", short_title: "Construction project A", contract_amount: "900000", section_name: "Procurement" },
  { request_id: "20260731002", start_date: "2026-07-31T00:00:00.000", agency_name: "DDC", short_title: "Construction project B", contract_amount: "750000", section_name: "Procurement" },
];

test("markSeen regression: dry-run (ALERTS_LIVE false) does NOT advance seen set", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  await seedSub({ SUBS });
  const env = { SUBS, ALERT_STATE, ALERTS_LIVE: "false", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(FRESH_NOTICES);
  try {
    const r = await processOneSub(env, { key: SUB_KEY, email: "tester@example.com", lens: "money", filter: { minAmount: 500000, keywords: ["construction"] }, freq: "daily", channel: "email", createdAt: "2026-07-01T00:00:00.000Z", lang: "en" }, {
      FROM: "CityScroll <alerts@cityscroll.org>", LIVE: false, heartbeatDays: 14,
      today: "2026-07-31", isMonday: false,
      counts: () => ({ "per-run": 0, daily: 0 }),
      caps: { "per-run": 25, daily: 50 },
      onSent: async () => {},
    });
    assert.equal(r.sent, false, "dry-run must not send");
    assert.equal(r.new, 2, "both notices are fresh");
    // The seen set must NOT have been advanced.
    const seenRaw = await ALERT_STATE.get(`seen:${SUB_KEY}`);
    const seen = seenRaw ? JSON.parse(seenRaw) : [];
    assert.equal(seen.length, 0, "dry-run must not mark notices as seen — they must stay fresh for the next live run");
  } finally { globalThis.fetch = realFetch; }
});

test("markSeen regression: simulated Resend failure leaves seen unchanged", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  await seedSub({ SUBS });
  const env = { SUBS, ALERT_STATE, ALERTS_LIVE: "true", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us") || u.includes("dg92-zbpx")) return Response.json(FRESH_NOTICES);
    if (u.includes("api.resend.com")) return new Response("Forbidden", { status: 403 });
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const r = await processOneSub(env, { key: SUB_KEY, email: "tester@example.com", lens: "money", filter: { minAmount: 500000, keywords: ["construction"] }, freq: "daily", channel: "email", createdAt: "2026-07-01T00:00:00.000Z", lang: "en" }, {
      FROM: "CityScroll <alerts@cityscroll.org>", LIVE: true, heartbeatDays: 14,
      today: "2026-07-31", isMonday: false,
      counts: () => ({ "per-run": 0, daily: 0 }),
      caps: { "per-run": 25, daily: 50 },
      onSent: async () => {},
    });
    assert.ok(r.error, "a Resend failure must surface as an error result");
    const seenRaw = await ALERT_STATE.get(`seen:${SUB_KEY}`);
    const seen = seenRaw ? JSON.parse(seenRaw) : [];
    assert.equal(seen.length, 0, "seen must stay empty when the send failed — notices remain fresh for retry");
  } finally { globalThis.fetch = realFetch; }
});

test("markSeen regression: successful send marks only sent IDs as seen", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  await seedSub({ SUBS });
  const env = { SUBS, ALERT_STATE, ALERTS_LIVE: "true", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(FRESH_NOTICES);
  try {
    const r = await processOneSub(env, { key: SUB_KEY, email: "tester@example.com", lens: "money", filter: { minAmount: 500000, keywords: ["construction"] }, freq: "daily", channel: "email", createdAt: "2026-07-01T00:00:00.000Z", lang: "en" }, {
      FROM: "CityScroll <alerts@cityscroll.org>", LIVE: true, heartbeatDays: 14,
      today: "2026-07-31", isMonday: false,
      counts: () => ({ "per-run": 0, daily: 0 }),
      caps: { "per-run": 25, daily: 50 },
      onSent: async () => {},
    });
    assert.equal(r.sent, true, "should send");
    assert.equal(r.new, 2);
    const seenRaw = await ALERT_STATE.get(`seen:${SUB_KEY}`);
    const seen = seenRaw ? JSON.parse(seenRaw) : [];
    assert.deepEqual(seen.sort(), ["20260731001", "20260731002"], "successful send marks the sent notice IDs as seen");
  } finally { globalThis.fetch = realFetch; }
});

test("markSeen regression: quiet day (no fresh, heartbeat send) does not poison future fresh notices", async () => {
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  await seedSub({ SUBS });
  // Seed the seen set with an already-known notice so found > 0 but fresh = 0.
  await ALERT_STATE.put(`seen:${SUB_KEY}`, JSON.stringify(["20260731001"]));
  const env = { SUBS, ALERT_STATE, ALERTS_LIVE: "true", RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(FRESH_NOTICES.slice(0, 1)); // only the already-seen notice
  try {
    const r = await processOneSub(env, { key: SUB_KEY, email: "tester@example.com", lens: "money", filter: { minAmount: 500000, keywords: ["construction"] }, freq: "daily", channel: "email", createdAt: "2026-07-01T00:00:00.000Z", lang: "en" }, {
      FROM: "CityScroll <alerts@cityscroll.org>", LIVE: true, heartbeatDays: 14,
      today: "2026-07-31", isMonday: false,
      counts: () => ({ "per-run": 0, daily: 0 }),
      caps: { "per-run": 25, daily: 50 },
      onSent: async () => {},
    });
    // Heartbeat email goes out (action=heartbeat because createdAt is 30 days ago), but
    // the key check is: seen doesn't grow with anything new (there's nothing new).
    assert.equal(r.new, 0, "no fresh notices on a quiet day");
    const seenRaw = await ALERT_STATE.get(`seen:${SUB_KEY}`);
    const seen = seenRaw ? JSON.parse(seenRaw) : [];
    // Seen stays the same — no phantom advancement.
    assert.deepEqual(seen, ["20260731001"]);
  } finally { globalThis.fetch = realFetch; }
});
