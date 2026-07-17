// Saved-search health: a watch that has matched nothing for months is a silent dead end its
// owner still believes is working. Pure decision + formatting (nextSearchHealth/
// searchHealthStatus/alertsFixUrl/searchHealthNoteHtml), then an integration pass proving
// processOneSub actually rides this on the digest — records health regardless of send caps,
// appends the fix-path note to a quiet run, and clears it silently the moment a match resumes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUIET_THRESHOLD_DAYS,
  nextSearchHealth,
  searchHealthStatus,
  alertsFixUrl,
  searchHealthNoteHtml,
} from "../src/lib/search_health.mjs";
import { processOneSub } from "../src/alerts.mjs";

// ---- pure functions ------------------------------------------------------

test("nextSearchHealth: a match resets lastMatchAt to today, overwriting any prior value", () => {
  assert.deepEqual(nextSearchHealth({ lastMatchAt: "2026-01-01" }, true, "2026-07-17"), { lastMatchAt: "2026-07-17" });
  assert.deepEqual(nextSearchHealth(null, true, "2026-07-17"), { lastMatchAt: "2026-07-17" });
});

test("nextSearchHealth: no match carries the prior lastMatchAt forward unchanged", () => {
  assert.deepEqual(nextSearchHealth({ lastMatchAt: "2026-01-01" }, false, "2026-07-17"), { lastMatchAt: "2026-01-01" });
});

test("nextSearchHealth: brand-new / malformed prior record -> lastMatchAt null, never throws", () => {
  assert.deepEqual(nextSearchHealth(undefined, false, "2026-07-17"), { lastMatchAt: null });
  assert.deepEqual(nextSearchHealth({}, false, "2026-07-17"), { lastMatchAt: null });
  assert.deepEqual(nextSearchHealth({ lastMatchAt: 12345 }, false, "2026-07-17"), { lastMatchAt: null }); // wrong type, ignored
  assert.deepEqual(nextSearchHealth("garbage", false, "2026-07-17"), { lastMatchAt: null }); // not even an object
});

test("searchHealthStatus: quiet past the threshold (a real subscription shape, quiet for months)", () => {
  // Last matched 2026-04-01; checked 2026-07-17 -> 107 days, well past the 56-day/8-week gate.
  const s = searchHealthStatus({ health: { lastMatchAt: "2026-04-01" }, createdAt: "2025-01-01T00:00:00.000Z", today: "2026-07-17" });
  assert.equal(s.quiet, true);
  assert.equal(s.quietDays, 107);
});

test("searchHealthStatus: exactly at the threshold counts as quiet (boundary is inclusive)", () => {
  const s = searchHealthStatus({ health: { lastMatchAt: "2026-05-22" }, createdAt: "2025-01-01", today: "2026-07-17" });
  assert.equal(s.quietDays, QUIET_THRESHOLD_DAYS);
  assert.equal(s.quiet, true);
});

test("searchHealthStatus: one day short of the threshold is NOT quiet", () => {
  const s = searchHealthStatus({ health: { lastMatchAt: "2026-05-23" }, createdAt: "2025-01-01", today: "2026-07-17" });
  assert.equal(s.quietDays, QUIET_THRESHOLD_DAYS - 1);
  assert.equal(s.quiet, false);
});

test("searchHealthStatus: a watch that just resumed matching is never quiet", () => {
  const health = nextSearchHealth({ lastMatchAt: "2026-01-01" }, true, "2026-07-17");
  const s = searchHealthStatus({ health, createdAt: "2025-01-01", today: "2026-07-17" });
  assert.equal(s.quiet, false);
  assert.equal(s.quietDays, 0);
});

test("searchHealthStatus: a brand-new watch with no match history yet must NOT be flagged quiet", () => {
  // Created a week ago, never matched -- "no matches yet" is not the same claim as "gone quiet."
  const s = searchHealthStatus({ health: null, createdAt: "2026-07-10", today: "2026-07-17" });
  assert.equal(s.quiet, false);
  assert.equal(s.quietDays, 7);
});

test("searchHealthStatus: a watch old enough with no match ever IS quiet (createdAt anchors it)", () => {
  const s = searchHealthStatus({ health: null, createdAt: "2026-01-01", today: "2026-07-17" });
  assert.equal(s.quiet, true);
});

test("searchHealthStatus: malformed stored health (wrong shape/type) fails soft, never throws, never quiet without a usable date", () => {
  assert.deepEqual(searchHealthStatus({ health: "not-an-object", createdAt: null, today: "2026-07-17" }), { quiet: false, quietDays: null });
  assert.deepEqual(searchHealthStatus({ health: { lastMatchAt: 999 }, createdAt: undefined, today: "2026-07-17" }), { quiet: false, quietDays: null });
  assert.deepEqual(searchHealthStatus({ health: { lastMatchAt: "not-a-date" }, createdAt: null, today: "2026-07-17" }), { quiet: false, quietDays: null });
});

test("alertsFixUrl: builds a hash deep link carrying lens/filter/freq, decodable back to the same filter", () => {
  const url = alertsFixUrl("money", { keywords: ["asbestos"], minAmount: 200000 }, "weekly");
  assert.ok(url.startsWith("https://crol-list.org/#alerts?"), url);
  const q = new URLSearchParams(url.split("?")[1]);
  assert.equal(q.get("lens"), "money");
  assert.deepEqual(JSON.parse(q.get("filter")), { keywords: ["asbestos"], minAmount: 200000 });
  assert.equal(q.get("freq"), "weekly");
});

test("alertsFixUrl: omits freq entirely when not given, rather than emitting freq=undefined", () => {
  const url = alertsFixUrl("land", { keywords: ["rivington"] });
  assert.ok(!url.includes("freq="), url);
});

test("searchHealthNoteHtml: escapes the fix-path URL and states the actual quiet span in whole weeks", () => {
  const html = searchHealthNoteHtml({ lang: "en", quietDays: 70, url: "https://crol-list.org/#alerts?lens=money&filter=%7B%7D" });
  assert.match(html, /10 weeks/); // 70 days -> 10 weeks
  assert.ok(html.includes("&amp;"), "the & in the URL's query string must be escaped for safe HTML embedding");
  assert.ok(!html.includes("filter=%7B%7D&filter="), "sanity: no double-encoding");
});

test("searchHealthNoteHtml: falls back to the threshold's own week count when quietDays is missing/invalid", () => {
  const html = searchHealthNoteHtml({ lang: "en", quietDays: null, url: "https://x/" });
  assert.match(html, /8 weeks/);
});

// ---- integration: processOneSub actually rides this on the digest -------

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
  async delete(k) { this.store.delete(k); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}

function baseCtx(today) {
  return {
    FROM: "CROL-List <alerts@crol-list.org>",
    LIVE: true,
    heartbeatDays: 14,
    today,
    isMonday: true, // never skip a "weekly" sub in these tests
    counts: () => ({ "per-run": 0, daily: 0 }),
    caps: { "per-run": 25, daily: 50 },
    onSent: async () => {},
  };
}

function daysAgoISO(n, from) {
  return new Date(Date.parse(from + "T00:00:00Z") - n * 86400000).toISOString().slice(0, 10);
}

test("processOneSub: a watch quiet past threshold gets a fix-path note on its next (heartbeat) digest, and records health regardless of send caps", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const key = "sub:quiet@example.com:abcd0001";
  const sub = {
    email: "quiet@example.com", lens: "money", filter: { keywords: ["asbestos"] },
    freq: "daily", channel: "email", lang: "en",
    createdAt: daysAgoISO(400, today) + "T00:00:00.000Z",
    health: { lastMatchAt: daysAgoISO(70, today) }, // 70 days quiet -- well past the 56-day gate
  };
  await SUBS.put(key, JSON.stringify(sub));
  await ALERT_STATE.put(`lastsent:${key}`, daysAgoISO(20, today)); // heartbeatDays=14 -> a heartbeat is due

  const env = { SUBS, ALERT_STATE, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us")) return Response.json([]); // nothing matches this run
    if (u.includes("api.resend.com")) { sent.push(JSON.parse(opts.body)); return Response.json({ id: "e1" }); }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const s = { key, ...sub };
    const r = await processOneSub(env, s, baseCtx(today));
    assert.equal(r.sent, true, "a heartbeat should still send: " + JSON.stringify(r));
    assert.equal(sent.length, 1);
    assert.match(sent[0].html, /10 weeks/, "the note must name the actual quiet span (70 days quiet -> 10 weeks)");
    assert.match(sent[0].html, /#alerts\?lens=money/, "must link back to the alerts page pre-filled with this watch");

    const stored = JSON.parse(SUBS.store.get(key));
    assert.equal(stored.health.lastMatchAt, daysAgoISO(70, today), "unmatched run carries lastMatchAt forward unchanged");
  } finally { globalThis.fetch = realFetch; }
});

test("processOneSub: a quiet watch that matches again drops the note without ceremony, and its health resets", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const key = "sub:resumed@example.com:abcd0002";
  const sub = {
    email: "resumed@example.com", lens: "money", filter: { keywords: ["asbestos"] },
    freq: "daily", channel: "email", lang: "en",
    createdAt: daysAgoISO(400, today) + "T00:00:00.000Z",
    health: { lastMatchAt: daysAgoISO(70, today) },
  };
  await SUBS.put(key, JSON.stringify(sub));

  const env = { SUBS, ALERT_STATE, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us")) {
      return Response.json([{ request_id: "20260717001", start_date: today + "T00:00:00.000", agency_name: "DDC", short_title: "Asbestos abatement", contract_amount: "300000", section_name: "Procurement" }]);
    }
    if (u.includes("api.resend.com")) { sent.push(JSON.parse(opts.body)); return Response.json({ id: "e1" }); }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const s = { key, ...sub };
    const r = await processOneSub(env, s, baseCtx(today));
    assert.equal(r.sent, true);
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].html.includes("weeks"), "a run with a real match must never also show the quiet note");

    const stored = JSON.parse(SUBS.store.get(key));
    assert.equal(stored.health.lastMatchAt, today, "a fresh match resets lastMatchAt to today");
  } finally { globalThis.fetch = realFetch; }
});

test("processOneSub: a brand-new watch with no match history is never flagged quiet, even with zero matches", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const key = "sub:new@example.com:abcd0003";
  const sub = {
    email: "new@example.com", lens: "money", filter: { keywords: ["asbestos"] },
    freq: "weekly", channel: "email", lang: "en", // weekly always sends (even empty), so we can inspect the body
    createdAt: daysAgoISO(2, today) + "T00:00:00.000Z", // created 2 days ago, never matched
  };
  await SUBS.put(key, JSON.stringify(sub));

  const env = { SUBS, ALERT_STATE, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us")) return Response.json([]);
    if (u.includes("api.resend.com")) { sent.push(JSON.parse(opts.body)); return Response.json({ id: "e1" }); }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const s = { key, ...sub };
    const r = await processOneSub(env, s, baseCtx(today));
    assert.equal(r.sent, true);
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].html.includes("weeks"), "a 2-day-old watch must never be told it's gone quiet");

    const stored = JSON.parse(SUBS.store.get(key));
    assert.equal(stored.health.lastMatchAt, null);
  } finally { globalThis.fetch = realFetch; }
});

test("processOneSub: a malformed stored health record never breaks digest compilation (fail-soft)", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const key = "sub:malformed@example.com:abcd0004";
  const sub = {
    email: "malformed@example.com", lens: "money", filter: { keywords: ["asbestos"] },
    freq: "daily", channel: "email", lang: "en",
    createdAt: daysAgoISO(400, today) + "T00:00:00.000Z",
    health: "not-even-an-object", // corrupted somehow
  };
  await SUBS.put(key, JSON.stringify(sub));
  await ALERT_STATE.put(`lastsent:${key}`, daysAgoISO(20, today));

  const env = { SUBS, ALERT_STATE, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us")) return Response.json([]);
    if (u.includes("api.resend.com")) { sent.push(JSON.parse(opts.body)); return Response.json({ id: "e1" }); }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const s = { key, ...sub };
    const r = await processOneSub(env, s, baseCtx(today));
    assert.equal(r.error, undefined, "a malformed health record must never throw / error out the whole digest run");
    assert.equal(r.sent, true);
    // createdAt (400 days ago) anchors it instead -- still correctly quiet, just via the fallback.
    assert.match(sent[0].html, /weeks/);

    const stored = JSON.parse(SUBS.store.get(key));
    assert.equal(stored.health.lastMatchAt, null, "malformed prior health is treated as no history, not thrown");
  } finally { globalThis.fetch = realFetch; }
});

test("processOneSub: health is recorded even when the send cap denies the email (caps must not distort the quiet signal)", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const SUBS = new MockKV(), ALERT_STATE = new MockKV();
  const key = "sub:capped@example.com:abcd0005";
  const sub = {
    email: "capped@example.com", lens: "money", filter: { keywords: ["asbestos"] },
    freq: "daily", channel: "email", lang: "en",
    createdAt: daysAgoISO(400, today) + "T00:00:00.000Z",
  };
  await SUBS.put(key, JSON.stringify(sub));

  const env = { SUBS, ALERT_STATE, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("data.cityofnewyork.us")) {
      return Response.json([{ request_id: "20260717002", start_date: today + "T00:00:00.000", agency_name: "DDC", short_title: "Asbestos abatement", contract_amount: "300000", section_name: "Procurement" }]);
    }
    throw new Error("unexpected fetch: " + u); // Resend must never be called -- the cap denies it
  };
  try {
    const s = { key, ...sub };
    const ctx = { ...baseCtx(today), caps: { "per-run": 0, daily: 0 } }; // zero budget -> always capped
    const r = await processOneSub(env, s, ctx);
    assert.equal(r.sent, false);
    assert.ok(r.capped, "capDecision reports the name of the ceiling hit (truthy), not a bare boolean");

    const stored = JSON.parse(SUBS.store.get(key));
    assert.equal(stored.health.lastMatchAt, today, "a real match is recorded even though the email itself was capped");
  } finally { globalThis.fetch = realFetch; }
});
