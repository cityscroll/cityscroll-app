// Pins worker/src/external_award.mjs — the precompute + cache + endpoint layer for awards
// published outside the City Record (registry in lib/external_award.mjs). The registry drives the
// sweep, the join, and the claim, so the fixtures walk every class boundary the registry defines:
//   - an EXACT-key agency (NYCHA): resolves a real PIN match against Checkbook, caches it in D1
//   - a FUZZY-source agency (SCA): serves the weekly ABO cache from KV, labeled by refresh date
//   - a VERIFIED-ABSENT agency (Tax Commission): says absent, fetches nothing
//   - a COVERED agency whose source has ZERO rows for it: still "fuzzy", empty award set
//   - MALFORMED source rows (bad dates, non-numeric amounts): dropped before caching
// Before this feature the two live fetches happened in the browser; an unguarded server port would
// have cached a transient failure as a confident "no awards".
//
//   node --test test/external_award.test.mjs   (from crol-list/worker/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleExternalAward, refreshAboAwards, prewarmNycha } from "../src/external_award.mjs";

// --- in-memory D1 (external_award_matches) + KV (award:* keys) stubs ---------------------------
function fakeDB(seed = {}) {
  const notices = seed.notices || {};
  const cache = seed.cache || {};
  return {
    _cache: cache,
    prepare(sql) {
      return {
        _sql: sql, _args: [],
        bind(...a) { this._args = a; return this; },
        async first() {
          if (/FROM notices/.test(this._sql)) {
            const n = notices[this._args[0]];
            return n ? { request_id: n.request_id, start_date: n.start_date, agency_name: n.agency, type_of_notice_description: n.type_of_notice, pin: n.pin } : null;
          }
          if (/FROM external_award_matches/.test(this._sql)) return cache[this._args[0]] || null;
          return null;
        },
        async run() {
          if (/INSERT OR REPLACE INTO external_award_matches/.test(this._sql)) {
            const [request_id, agency, matches, computed_at] = this._args;
            cache[request_id] = { request_id, agency, matches, computed_at };
          }
          return { success: true };
        },
      };
    },
  };
}

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return { _store: store, async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); } };
}

// Checkbook NYCHA response for one PIN — the Contracts_NYCHA field shape.
function nychaResponse(agreements) {
  const tx = agreements.map((a) =>
    `<transaction><contract_id>${a.id}</contract_id><record_type>${a.recordType || "Agreement"}</record_type>`
    + `<pin>${a.pin}</pin><vendor>${a.vendor || ""}</vendor>`
    + `<contract_current_amount>${a.amount || ""}</contract_current_amount>`
    + `<approved_date>${a.approved || ""}</approved_date><start_date>${a.start || ""}</start_date>`
    + `<award_method>${a.method || ""}</award_method><purpose>${a.purpose || ""}</purpose></transaction>`).join("");
  return `<response><status><result>success</result></status><contract_transactions>${tx}</contract_transactions></response>`;
}

// Mock fetch dispatcher: routes Checkbook POSTs, data.ny.gov resource GETs, and view-metadata GETs.
function withMockedFetch(routes, fn) {
  return async () => {
    const orig = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith("https://www.checkbooknyc.com/api")) return { ok: true, status: 200, text: async () => routes.checkbook || nychaResponse([]) };
      if (u.startsWith("https://data.ny.gov/api/views/")) return { ok: true, status: 200, json: async () => ({ rowsUpdatedAt: routes.rowsUpdatedAt || 1764547200 }) }; // 2025-12-01
      if (u.startsWith("https://data.ny.gov/resource/")) return { ok: true, status: 200, json: async () => routes.aboRows || [] };
      if (u.startsWith("https://data.cityofnewyork.us/resource/")) return { ok: true, status: 200, json: async () => routes.sodaNotice || [] };
      throw new Error("unexpected fetch " + u);
    };
    try { await fn(calls); } finally { globalThis.fetch = orig; }
  };
}

const req = (qs, method = "GET") => new Request("https://w/externalaward" + qs, { method });

// ---- EXACT key (NYCHA) ------------------------------------------------------------------------
test("EXACT NYCHA: resolves a temporally-valid PIN match, caches it in D1", withMockedFetch({
  checkbook: nychaResponse([{ id: "C1", pin: "337474", vendor: "NELLIGAN WHITE ARCHITECTS PLLC", amount: "7310000.00", approved: "2025-03-01", start: "2025-02-15", method: "SEALED BID", purpose: "DESIGN" }]),
}, async () => {
  const db = fakeDB({ notices: { "20250110001": { request_id: "20250110001", start_date: "2025-01-10", agency: "Housing Authority", type_of_notice: "Solicitation", pin: "337474" } } });
  const res = await handleExternalAward(req("?id=20250110001"), { DB: db });
  const body = await res.json();
  assert.equal(body.coverage, "exact");
  assert.equal(body.matches.length, 1);
  assert.equal(body.matches[0].vendor, "NELLIGAN WHITE ARCHITECTS PLLC");
  assert.equal(body.source.kind, "checkbook-nycha");
  assert.ok(db._cache["20250110001"], "the exact match was cached in D1");
}));

test("EXACT NYCHA: a stale PIN-reuse contract dated before the solicitation is rejected", withMockedFetch({
  checkbook: nychaResponse([{ id: "PO1", pin: "510394", vendor: "KHUSHI CONSTRUCTION", amount: "2800", approved: "2012-12-05", start: "2012-12-05", purpose: "PO" }]),
}, async () => {
  const db = fakeDB({ notices: { "20250501001": { request_id: "20250501001", start_date: "2025-05-01", agency: "Housing Authority", type_of_notice: "Solicitation", pin: "510394" } } });
  const res = await handleExternalAward(req("?id=20250501001"), { DB: db });
  const body = await res.json();
  assert.equal(body.coverage, "exact");
  assert.deepEqual(body.matches, [], "the 2012 PO must not resolve for a 2025 solicitation");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300", "a completed empty answer is cacheable");
}));

test("EXACT NYCHA: a Checkbook/WAF failure is ok:false and NOT cached (retry next request)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => (String(u).includes("checkbooknyc") ? { ok: false, status: 403, text: async () => "" } : { ok: true, json: async () => [] });
  try {
    const db = fakeDB({ notices: { "20250110001": { request_id: "20250110001", start_date: "2025-01-10", agency: "Housing Authority", type_of_notice: "Solicitation", pin: "337474" } } });
    const res = await handleExternalAward(req("?id=20250110001"), { DB: db });
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(db._cache["20250110001"], undefined, "a failed lookup must not be cached");
  } finally { globalThis.fetch = orig; }
});

test("EXACT NYCHA: agency-only lookup (no id) returns the claim with an empty match set", withMockedFetch({}, async (calls) => {
  const res = await handleExternalAward(req("?agency=" + encodeURIComponent("Housing Authority")), { DB: fakeDB() });
  const body = await res.json();
  assert.equal(body.coverage, "exact");
  assert.deepEqual(body.matches, []);
  assert.equal(calls.filter((c) => c.includes("checkbooknyc")).length, 0, "no PIN to join → no Checkbook call");
}));

// ---- FUZZY source (SCA) -----------------------------------------------------------------------
test("FUZZY ABO: serves the weekly KV cache with dataset + refresh date", withMockedFetch({}, async (calls) => {
  const kv = fakeKV({
    "award:8w5p-k45m:New York City School Construction Authority": JSON.stringify({
      dataset: "8w5p-k45m", authority: "New York City School Construction Authority", refreshed: "2025-12-01",
      awards: [{ vendor: "Roux Environmental", description: "HAZMAT SVS", process: "Competitive Bid", date: "2024-05-06T00:00:00.000", amount: 5000000, source: "nys-abo" }],
    }),
  });
  const res = await handleExternalAward(req("?agency=" + encodeURIComponent("School Construction Authority")), { ALERT_STATE: kv });
  const body = await res.json();
  assert.equal(body.coverage, "fuzzy");
  assert.equal(body.agencyAwards.length, 1);
  assert.equal(body.source.dataset, "8w5p-k45m");
  assert.equal(body.source.refreshed, "2025-12-01");
  assert.equal(calls.length, 0, "served from cache — no live data.ny.gov call at request time");
}));

test("COVERED but ZERO rows: still fuzzy, empty award set (drives the 'checked, none found' note)", withMockedFetch({}, async () => {
  const kv = fakeKV({
    "award:d84c-dk28:Brooklyn Bridge Park Corporation": JSON.stringify({
      dataset: "d84c-dk28", authority: "Brooklyn Bridge Park Corporation", refreshed: "2025-12-01", awards: [],
    }),
  });
  const res = await handleExternalAward(req("?agency=" + encodeURIComponent("Brooklyn Bridge Park")), { ALERT_STATE: kv });
  const body = await res.json();
  assert.equal(body.coverage, "fuzzy");
  assert.deepEqual(body.agencyAwards, []);
  assert.equal(body.source.refreshed, "2025-12-01");
}));

test("FUZZY ABO: no cache yet (cron hasn't run) → empty set, still names the source", withMockedFetch({}, async () => {
  const res = await handleExternalAward(req("?agency=" + encodeURIComponent("Hudson River Park Trust")), { ALERT_STATE: fakeKV() });
  const body = await res.json();
  assert.equal(body.coverage, "fuzzy");
  assert.deepEqual(body.agencyAwards, []);
  assert.equal(body.source.dataset, "ehig-g5x3");
}));

// ---- VERIFIED-ABSENT + unknown ----------------------------------------------------------------
test("ABSENT: a verified-absent agency says absent and fetches nothing", withMockedFetch({}, async (calls) => {
  const res = await handleExternalAward(req("?agency=" + encodeURIComponent("Tax Commission")), { ALERT_STATE: fakeKV(), DB: fakeDB() });
  const body = await res.json();
  assert.equal(body.coverage, "absent");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
  assert.equal(calls.length, 0);
}));

test("UNKNOWN: an agency that publishes awards in the City Record itself resolves to unknown", withMockedFetch({}, async () => {
  const res = await handleExternalAward(req("?agency=Sanitation"), { ALERT_STATE: fakeKV() });
  const body = await res.json();
  assert.equal(body.coverage, "unknown");
}));

// ---- weekly cron refresh + malformed rows -----------------------------------------------------
test("refreshAboAwards: pulls each source, drops malformed rows, stamps refresh date", withMockedFetch({
  aboRows: [
    { authority_name: "X", vendor_name: "GOOD VENDOR", award_date: "2024-05-06T00:00:00.000", contract_amount: "$5,000,000.00" },
    { authority_name: "X", vendor_name: "BAD DATE", award_date: "not-a-date", contract_amount: "10" },
    { authority_name: "X", vendor_name: "NO DATE" },
    { authority_name: "X", vendor_name: "JUNK AMOUNT", award_date: "2024-04-01T00:00:00.000", contract_amount: "N/A" },
  ],
  rowsUpdatedAt: 1764547200,
}, async () => {
  const kv = fakeKV();
  const r = await refreshAboAwards({ ALERT_STATE: kv }, "2026-07-16T00:00:00.000Z");
  assert.ok(r.updated > 0, "at least one source refreshed");
  assert.equal(r.failed, 0);
  const one = JSON.parse(kv._store.get("award:8w5p-k45m:New York City School Construction Authority"));
  assert.equal(one.refreshed, "2025-12-01");
  // Only the two well-formed-date rows survive; the junk amount normalizes to 0 but keeps its date.
  assert.equal(one.awards.length, 2, "bad-date and no-date rows are dropped");
  assert.equal(one.awards.find((a) => a.vendor === "JUNK AMOUNT").amount, 0, "non-numeric amount → 0, not NaN");
  assert.ok(kv._store.get("award:meta:last_refresh"), "the weekly gate timestamp was written");
}));

test("refreshAboAwards: weekly gate skips a run inside the refresh window", withMockedFetch({}, async (calls) => {
  const kv = fakeKV({ "award:meta:last_refresh": "2026-07-14T00:00:00.000Z" }); // 2 days ago
  const r = await refreshAboAwards({ ALERT_STATE: kv }, "2026-07-16T00:00:00.000Z");
  assert.equal(r.skipped, "fresh");
  assert.equal(calls.length, 0, "no source pulled inside the weekly window");
}));

test("refreshAboAwards: a per-source failure leaves the previous cache untouched", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => [] });
  try {
    const kv = fakeKV({ "award:8w5p-k45m:New York City School Construction Authority": JSON.stringify({ awards: [{ vendor: "OLD GOOD" }] }) });
    const r = await refreshAboAwards({ ALERT_STATE: kv }, "2026-07-16T00:00:00.000Z");
    assert.ok(r.failed > 0);
    const kept = JSON.parse(kv._store.get("award:8w5p-k45m:New York City School Construction Authority"));
    assert.equal(kept.awards[0].vendor, "OLD GOOD", "a transient outage must not blank yesterday's good cache");
    assert.equal(kv._store.get("award:meta:last_refresh"), undefined, "a fully-failed run does not stamp the gate");
  } finally { globalThis.fetch = orig; }
});

// ---- prewarm ----------------------------------------------------------------------------------
test("prewarmNycha: bounded, idempotent, fail-soft; skips already-cached ids", withMockedFetch({
  checkbook: nychaResponse([]),
}, async () => {
  const db = fakeDB({
    notices: { "20250110001": { request_id: "20250110001", start_date: "2025-01-10", agency: "Housing Authority", type_of_notice: "Solicitation", pin: "337474" } },
    cache: { "ALREADY": { matches: JSON.stringify({ matches: [] }) } },
  });
  const r = await prewarmNycha({ DB: db }, ["20250110001", "ALREADY", "20250110001"]);
  assert.equal(r.requested, 2, "deduped");
  assert.equal(r.skipped, 1);
  assert.equal(r.computed, 1);
}));

// ---- routing/validation -----------------------------------------------------------------------
test("GET /externalaward: rejects a malformed id and a missing id/agency", async () => {
  const bad = await handleExternalAward(req("?id=..%2Fetc"), { DB: fakeDB() });
  assert.equal(bad.status, 400);
  const none = await handleExternalAward(req(""), { DB: fakeDB() });
  assert.equal(none.status, 400);
});

test("GET /externalaward: OPTIONS preflight returns 204", async () => {
  const res = await handleExternalAward(req("?agency=Sanitation", "OPTIONS"), {});
  assert.equal(res.status, 204);
});

test("GET /externalaward: an id that resolves to no notice returns ok:false, unknown", withMockedFetch({ sodaNotice: [] }, async () => {
  const res = await handleExternalAward(req("?id=99999999999"), { DB: fakeDB() });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.coverage, "unknown");
}));
