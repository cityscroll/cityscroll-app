// Award-arrival alerts: "tell me when this notice's award registers", delivered through the
// existing digest machinery. currentAwardCandidates() (external_award.mjs) reuses the exact
// precomputed state /externalaward already serves — no second, divergent notion of "has this
// notice's award appeared yet." processAwardSub() (alerts.mjs) diffs those candidates against a
// per-sub seen-set (the same getSeen/markSeen mechanism every other lens's fresh/seen diff
// uses) so a genuinely new award notifies once, a re-surfacing one never re-notifies, and a
// malformed watch or a lookup failure never breaks digest compilation.
//
//   node --test test/award_watch.test.mjs   (from crol-list/worker/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { currentAwardCandidates } from "../src/external_award.mjs";
import { processOneSub } from "../src/alerts.mjs";

// ---- in-memory D1 (external_award_matches) + KV (award:*, seen:*, lastsent:* etc.) stubs,
// same shape worker/test/external_award.test.mjs already uses for this module.
function fakeDB(seed = {}) {
  const cache = seed.cache || {};
  return {
    _cache: cache,
    prepare(sql) {
      return {
        _sql: sql, _args: [],
        bind(...a) { this._args = a; return this; },
        async first() {
          if (/FROM notices/.test(this._sql)) return null; // not exercised — every case here pre-seeds the D1 match cache
          if (/FROM external_award_matches/.test(this._sql)) return cache[this._args[0]] || null;
          return null;
        },
        async run() { return { success: true }; },
      };
    },
  };
}
function seedNychaCache(db, requestId, matches) {
  db._cache[requestId] = { matches: JSON.stringify({ matches }) };
}
class MockKV {
  constructor(seed = {}) { this.store = new Map(Object.entries(seed)); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}

const NYCHA_MATCH = { key: "nycha:C1", vendor: "NELLIGAN WHITE ARCHITECTS PLLC", amount: 7310000, date: "2025-03-01" };

// ---- currentAwardCandidates: the diff source --------------------------------------------------

test("currentAwardCandidates: NYCHA exact match, fingerprinted by contract id", async () => {
  const DB = fakeDB();
  seedNychaCache(DB, "20250110001", [{ id: "C1", pin: "337474", vendor: "NELLIGAN WHITE ARCHITECTS PLLC", amount: 7310000, approved: "2025-03-01" }]);
  const r = await currentAwardCandidates({ DB }, "20250110001", "Housing Authority");
  assert.equal(r.ok, true);
  assert.deepEqual(r.candidates, [{ key: "nycha:C1", kind: "exact", vendor: "NELLIGAN WHITE ARCHITECTS PLLC", amount: 7310000, date: "2025-03-01" }]);
});

test("currentAwardCandidates: NYCHA with no cached match yet — confirmed empty, not a failure", async () => {
  const DB = fakeDB();
  seedNychaCache(DB, "20250110001", []);
  const r = await currentAwardCandidates({ DB }, "20250110001", "Housing Authority");
  assert.deepEqual(r, { ok: true, candidates: [] });
});

const SODA_NOTICE_ROW = [{ request_id: "20250110001", start_date: "2025-01-10", agency_name: "Housing Authority", type_of_notice_description: "Solicitation", pin: "337474" }];

test("currentAwardCandidates: NYCHA Checkbook/WAF failure (no D1 cache, live lookup fails) is ok:false, not a confirmed empty", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => (String(u).includes("checkbooknyc")
    ? { ok: false, status: 403, text: async () => "" }
    : { ok: true, json: async () => SODA_NOTICE_ROW });
  try {
    const DB = fakeDB(); // no cache entry -> getOrComputeNycha must compute live, and the live lookup fails
    const r = await currentAwardCandidates({ DB }, "20250110001", "Housing Authority");
    assert.deepEqual(r, { ok: false, candidates: [] });
  } finally { globalThis.fetch = orig; }
});

test("currentAwardCandidates: ABO fuzzy, fingerprinted by vendor+date+amount (no stable id exists)", async () => {
  const ALERT_STATE = new MockKV({
    "award:8w5p-k45m:New York City School Construction Authority": JSON.stringify({
      dataset: "8w5p-k45m", authority: "New York City School Construction Authority", refreshed: "2025-12-01",
      awards: [{ vendor: "Roux Environmental", description: "HAZMAT SVS", process: "Competitive Bid", date: "2024-05-06", amount: 5000000, source: "nys-abo" }],
    }),
  });
  const r = await currentAwardCandidates({ ALERT_STATE }, "20250110002", "School Construction Authority");
  assert.equal(r.ok, true);
  assert.deepEqual(r.candidates, [{
    key: "abo:8w5p-k45m:New York City School Construction Authority:Roux Environmental:2024-05-06:5000000",
    kind: "fuzzy", vendor: "Roux Environmental", amount: 5000000, date: "2024-05-06",
  }]);
});

test("currentAwardCandidates: verified-absent and unknown agencies both resolve to empty, ok:true — nothing to watch", async () => {
  assert.deepEqual(await currentAwardCandidates({}, "x", "Tax Commission"), { ok: true, candidates: [] });
  assert.deepEqual(await currentAwardCandidates({}, "x", "Sanitation"), { ok: true, candidates: [] });
});

// ---- processOneSub (lens: "award"): the digest side --------------------------------------------

function baseCtx(today) {
  return {
    FROM: "CROL-List <alerts@crol-list.org>", LIVE: true, heartbeatDays: 14, today, isMonday: true,
    counts: () => ({ "per-run": 0, daily: 0 }), caps: { "per-run": 25, daily: 50 }, onSent: async () => {},
  };
}

test("processOneSub (award): a watched NYCHA notice whose PIN match appears in a fresh precompute — digest includes the exact match", async () => {
  const today = "2026-07-17";
  const DB = fakeDB();
  seedNychaCache(DB, "20250110001", [{ id: "C1", pin: "337474", vendor: "NELLIGAN WHITE ARCHITECTS PLLC", amount: 7310000, approved: "2025-03-01" }]);
  const ALERT_STATE = new MockKV(), SUBS = new MockKV();
  const env = { DB, ALERT_STATE, SUBS, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const sent = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.resend.com")) { sent.push(JSON.parse(opts.body)); return Response.json({ id: "e1" }); }
    throw new Error("unexpected fetch: " + url);
  };
  try {
    const s = { key: "sub:reader@example.com:award0001", email: "reader@example.com", lens: "award", filter: { requestId: "20250110001", agency: "Housing Authority" }, freq: "daily", channel: "email", lang: "en", createdAt: today };
    const r = await processOneSub(env, s, baseCtx(today));
    assert.equal(r.error, undefined);
    assert.equal(r.sent, true);
    assert.equal(r.new, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].html, /Award registered/);
    assert.match(sent[0].html, /NELLIGAN WHITE ARCHITECTS PLLC/);
    assert.match(sent[0].html, /#notice\/20250110001/);
    assert.ok(!sent[0].html.includes("Possible award match"), "an exact NYCHA match must never render with the fuzzy label");
  } finally { globalThis.fetch = orig; }
});

test("processOneSub (award): a watched ABO-authority notice gaining a new fuzzy candidate — digest includes it labeled possible", async () => {
  const today = "2026-07-17";
  const ALERT_STATE = new MockKV({
    "award:8w5p-k45m:New York City School Construction Authority": JSON.stringify({
      dataset: "8w5p-k45m", authority: "New York City School Construction Authority", refreshed: "2025-12-01",
      awards: [{ vendor: "Roux Environmental", description: "HAZMAT SVS", process: "Competitive Bid", date: "2024-05-06", amount: 5000000, source: "nys-abo" }],
    }),
  });
  const SUBS = new MockKV();
  const env = { ALERT_STATE, SUBS, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const sent = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.resend.com")) { sent.push(JSON.parse(opts.body)); return Response.json({ id: "e1" }); }
    throw new Error("unexpected fetch: " + url);
  };
  try {
    const s = { key: "sub:reader@example.com:award0002", email: "reader@example.com", lens: "award", filter: { requestId: "20250110002", agency: "School Construction Authority" }, freq: "daily", channel: "email", lang: "en", createdAt: today };
    const r = await processOneSub(env, s, baseCtx(today));
    assert.equal(r.sent, true);
    assert.equal(r.new, 1);
    assert.match(sent[0].html, /Possible award match/);
    assert.match(sent[0].html, /Matched by vendor and award date, not certain/);
  } finally { globalThis.fetch = orig; }
});

test("processOneSub (award): a watched notice with no change — no digest item, no email (silence, not a heartbeat)", async () => {
  const today = "2026-07-17";
  const DB = fakeDB();
  seedNychaCache(DB, "20250110001", []); // confirmed: nothing found yet
  const ALERT_STATE = new MockKV(), SUBS = new MockKV();
  const env = { DB, ALERT_STATE, SUBS, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error("must never call Resend/anything else with nothing new: " + url); };
  try {
    const s = { key: "sub:reader@example.com:award0003", email: "reader@example.com", lens: "award", filter: { requestId: "20250110001", agency: "Housing Authority" }, freq: "daily", channel: "email", lang: "en", createdAt: today };
    const r = await processOneSub(env, s, baseCtx(today));
    assert.equal(r.error, undefined);
    assert.equal(r.sent, false);
    assert.equal(r.new, 0);
    assert.equal(r.found, 0);
  } finally { globalThis.fetch = orig; }
});

test("processOneSub (award): a malformed watch record (no requestId) — digest compiles, watch skipped, never throws", async () => {
  const today = "2026-07-17";
  const ALERT_STATE = new MockKV(), SUBS = new MockKV();
  const env = { ALERT_STATE, SUBS, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error("a malformed watch must never reach the network: " + url); };
  try {
    const bad1 = { key: "sub:reader@example.com:bad1", email: "reader@example.com", lens: "award", filter: { agency: "Housing Authority" }, freq: "daily", channel: "email", lang: "en" };
    const r1 = await processOneSub(env, bad1, baseCtx(today));
    assert.equal(r1.error, undefined);
    assert.equal(r1.skipped, "malformed-award-watch");

    const bad2 = { key: "sub:reader@example.com:bad2", email: "reader@example.com", lens: "award", filter: null, freq: "daily", channel: "email", lang: "en" };
    const r2 = await processOneSub(env, bad2, baseCtx(today));
    assert.equal(r2.error, undefined);
    assert.equal(r2.skipped, "malformed-award-watch");
  } finally { globalThis.fetch = orig; }
});

test("processOneSub (award): the SAME award re-surfacing on a later run must NOT re-notify", async () => {
  const today = "2026-07-17";
  const DB = fakeDB();
  seedNychaCache(DB, "20250110001", [{ id: "C1", pin: "337474", vendor: "NELLIGAN WHITE ARCHITECTS PLLC", amount: 7310000, approved: "2025-03-01" }]);
  const ALERT_STATE = new MockKV(), SUBS = new MockKV();
  const env = { DB, ALERT_STATE, SUBS, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const sent = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.resend.com")) { sent.push(JSON.parse(opts.body)); return Response.json({ id: "e1" }); }
    throw new Error("unexpected fetch: " + url);
  };
  try {
    const s = { key: "sub:reader@example.com:award0005", email: "reader@example.com", lens: "award", filter: { requestId: "20250110001", agency: "Housing Authority" }, freq: "daily", channel: "email", lang: "en", createdAt: today };
    const r1 = await processOneSub(env, s, baseCtx(today));
    assert.equal(r1.sent, true);
    assert.equal(sent.length, 1);

    // Second run, identical precompute state (the same award, unchanged) — must be silent.
    const r2 = await processOneSub(env, s, baseCtx(today));
    assert.equal(r2.sent, false);
    assert.equal(r2.new, 0);
    assert.equal(sent.length, 1, "the same award must not produce a second email");
  } finally { globalThis.fetch = orig; }
});

test("processOneSub (award): the source disappearing (award vanishes from the precompute) must not crash or notify", async () => {
  const today = "2026-07-17";
  const DB = fakeDB();
  seedNychaCache(DB, "20250110001", [{ id: "C1", pin: "337474", vendor: "NELLIGAN WHITE ARCHITECTS PLLC", amount: 7310000, approved: "2025-03-01" }]);
  const ALERT_STATE = new MockKV(), SUBS = new MockKV();
  const env = { DB, ALERT_STATE, SUBS, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
  const sent = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.resend.com")) { sent.push(JSON.parse(opts.body)); return Response.json({ id: "e1" }); }
    throw new Error("unexpected fetch: " + url);
  };
  try {
    const s = { key: "sub:reader@example.com:award0006", email: "reader@example.com", lens: "award", filter: { requestId: "20250110001", agency: "Housing Authority" }, freq: "daily", channel: "email", lang: "en", createdAt: today };
    const r1 = await processOneSub(env, s, baseCtx(today));
    assert.equal(r1.sent, true);

    // The award disappears from the D1 cache entirely (e.g. a re-compute that found no match).
    seedNychaCache(DB, "20250110001", []);
    const r2 = await processOneSub(env, s, baseCtx(today));
    assert.equal(r2.error, undefined, "a disappearing source must never throw");
    assert.equal(r2.sent, false);
    assert.equal(sent.length, 1, "a disappearing award must not trigger any notification");
  } finally { globalThis.fetch = orig; }
});

test("processOneSub (award): a lookup failure (Checkbook/WAF down) is skipped, not marked seen, never sends a false 'nothing yet'", async () => {
  const today = "2026-07-17";
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => (String(u).includes("checkbooknyc")
    ? { ok: false, status: 403, text: async () => "" }
    : { ok: true, json: async () => SODA_NOTICE_ROW });
  try {
    const DB = fakeDB(); // no cache -> forces a live (failing) lookup
    const ALERT_STATE = new MockKV(), SUBS = new MockKV();
    const env = { DB, ALERT_STATE, SUBS, RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32) };
    const s = { key: "sub:reader@example.com:award0007", email: "reader@example.com", lens: "award", filter: { requestId: "20250110001", agency: "Housing Authority" }, freq: "daily", channel: "email", lang: "en", createdAt: today };
    const r = await processOneSub(env, s, baseCtx(today));
    assert.equal(r.error, undefined);
    assert.equal(r.sent, undefined);
    assert.equal(r.skipped, "award-lookup-failed");
  } finally { globalThis.fetch = orig; }
});
