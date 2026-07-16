// Pins worker/src/prior_cycle.mjs — the SODA-query + D1-cache layer around the ported ranking
// lib (lib/prior_cycle.mjs, tested separately in prior_cycle_lib.test.mjs). Verifies:
//   - computeMatches runs the two queries the client did and returns { strict, near,
//     eligibleCount, ok }
//   - getOrCompute reads the D1 cache, computes + upserts on a miss, and reuses it on a hit;
//     a failed compute or an unresolvable id is returned but never cached; a cached row from
//     before Phase 1b (no eligibleCount) is treated as a miss and recomputed
//   - prewarm is bounded, idempotent (skips already-cached), and fail-soft per notice
//   - GET /priorcycle/<id> returns { id, strict, near, eligibleCount, ok } with the edge-cache
//     header (no-store when ok is false) and validates/sanitizes the id
//
//   node --test test/prior_cycle.test.mjs   (from the crol-list/worker/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMatches, getOrCompute, prewarm, handlePriorCycle } from "../src/prior_cycle.mjs";

// --- a minimal in-memory D1 stub covering only the two prepared statements this module runs ----
function fakeDB(seed = {}) {
  const notices = seed.notices || {};        // request_id -> notice row (D1 column names)
  const cache = seed.cache || {};            // request_id -> stored prior_cycle_matches row
  const db = {
    _notices: notices,
    _cache: cache,
    prepare(sql) {
      return {
        _sql: sql,
        _args: [],
        bind(...args) { this._args = args; return this; },
        async first() {
          if (/FROM notices/.test(this._sql)) {
            // Mirror the column aliases fetchNoticeRow's real SQL applies (agency AS agency_name,
            // type_of_notice AS type_of_notice_description) so the stub returns the same shape.
            const n = notices[this._args[0]];
            if (!n) return null;
            return {
              request_id: n.request_id, start_date: n.start_date,
              agency_name: n.agency, type_of_notice_description: n.type_of_notice,
              short_title: n.short_title, pin: n.pin,
              contract_amount: n.contract_amount, vendor_name: n.vendor_name,
            };
          }
          if (/FROM prior_cycle_matches/.test(this._sql)) {
            return cache[this._args[0]] || null;
          }
          return null;
        },
        async run() {
          if (/INSERT OR REPLACE INTO prior_cycle_matches/.test(this._sql)) {
            const [request_id, agency, matches, computed_at] = this._args;
            cache[request_id] = { request_id, agency, matches, computed_at };
          }
          return { success: true };
        },
      };
    },
  };
  return db;
}

// Real notice + a real prior round (the HPD near-match pair, live-queried 2026-07-15).
const hpdNotice = {
  request_id: "20220314107", start_date: "2022-03-18",
  agency: "Housing Preservation and Development",
  type_of_notice: "Award", short_title: "IMMEDIATE EMERGENCY DEMOLITION OF 28 W 130th St, MANHATTAN (DM00121 E-6038R)",
  pin: "80622E0016001", contract_amount: 550000, vendor_name: "Granite Environmental, LLC",
};
const hpdPriorRound = {
  request_id: "20190621041", agency_name: "Housing Preservation and Development",
  type_of_notice_description: "Award", short_title: "IMMEDIATE EMERGENCY DEMOLITION",
  start_date: "2019-06-28", contract_amount: "1311926", vendor_name: "Granite Environmental, LLC",
  pin: "80619E0021001",
};

// Mock SODA: the strict query (top-6 $q, no date bound) returns nothing but the notice itself;
// the near query (top-2 $q, start_date <) returns the true prior round. Mirrors the real live
// behavior documented in test/near_match_prior_cycles.test.mjs.
function withMockedSoda(fn, { strictRows = [], nearRows = [] } = {}) {
  return async () => {
    const orig = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      const u = new URL(String(url));
      const where = u.searchParams.get("$where") || "";
      let rows;
      if (/start_date < /.test(where)) rows = nearRows;         // near tier
      else rows = strictRows;                                    // strict tier
      return { ok: true, status: 200, json: async () => rows };
    };
    try { await fn(calls); } finally { globalThis.fetch = orig; }
  };
}

test("computeMatches: runs both tiers and returns { strict, near, eligibleCount }", withMockedSoda(async (calls) => {
  const env = { DB: fakeDB() };
  const matches = await computeMatches(env, hpdNotice.request_id, {
    request_id: hpdNotice.request_id, start_date: hpdNotice.start_date,
    agency_name: hpdNotice.agency, short_title: hpdNotice.short_title,
    pin: hpdNotice.pin, contract_amount: hpdNotice.contract_amount, vendor_name: hpdNotice.vendor_name,
  });
  assert.deepEqual(matches.strict, []); // no strict cross-PIN match for this notice
  assert.equal(matches.near.length, 1);
  assert.equal(matches.near[0].c.request_id, "20190621041");
  assert.equal(typeof matches.eligibleCount, "number");
  // The strict query returned only the notice itself (no prior-eligible rows), so the pre-0.5-bar
  // pool is empty — the client renders 67's no_candidates message from this.
  assert.equal(matches.eligibleCount, 0);
  // Both SODA queries fired.
  assert.equal(calls.length, 2);
}, { strictRows: [], nearRows: [hpdPriorRound] }));

test("computeMatches: eligibleCount counts the prior-eligible strict rows before the 0.5 bar", withMockedSoda(async () => {
  // The strict query returns an earlier same-agency award that clears the >=180-day gap but is
  // titled generically enough to fall under the 0.5 title bar — a prior-eligible candidate that
  // is NOT a strict match. eligibleCount must count it (→ 67's low_confidence message), even
  // though strict stays empty.
  const priorButWeak = {
    request_id: "20200101001", agency_name: "Housing Preservation and Development",
    type_of_notice_description: "Award", short_title: "IMMEDIATE ROOF REPAIR",
    start_date: "2020-01-01", pin: "80620E0099001", contract_amount: "200000",
  };
  const env = { DB: fakeDB() };
  const matches = await computeMatches(env, hpdNotice.request_id, {
    request_id: hpdNotice.request_id, start_date: hpdNotice.start_date,
    agency_name: hpdNotice.agency, short_title: hpdNotice.short_title,
    pin: hpdNotice.pin, contract_amount: hpdNotice.contract_amount,
  });
  assert.deepEqual(matches.strict, []);
  assert.equal(matches.eligibleCount, 1, "the earlier weak-title award is prior-eligible");
}, { strictRows: [{
  request_id: "20200101001", agency_name: "Housing Preservation and Development",
  type_of_notice_description: "Award", short_title: "IMMEDIATE ROOF REPAIR",
  start_date: "2020-01-01", pin: "80620E0099001", contract_amount: "200000",
}], nearRows: [] }));

test("computeMatches: too-generic a title short-circuits without a SODA call", withMockedSoda(async (calls) => {
  const env = { DB: fakeDB() };
  const matches = await computeMatches(env, "X", {
    request_id: "X", agency_name: "Sanitation", short_title: "the of and", start_date: "2024-01-01",
  });
  assert.deepEqual(matches, { strict: [], near: [], eligibleCount: 0, ok: true });
  assert.equal(calls.length, 0, "no query for a title with < 2 significant words");
}));

test("computeMatches: a SODA failure is fail-soft (empty tier, ok:false, never throws)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => [] });
  try {
    const matches = await computeMatches({ DB: fakeDB() }, hpdNotice.request_id, {
      request_id: hpdNotice.request_id, start_date: hpdNotice.start_date,
      agency_name: hpdNotice.agency, short_title: hpdNotice.short_title, pin: hpdNotice.pin,
    });
    assert.deepEqual(matches, { strict: [], near: [], eligibleCount: 0, ok: false });
  } finally { globalThis.fetch = orig; }
});

test("getOrCompute: cache hit returns stored matches without a SODA call", async () => {
  const orig = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { ok: true, status: 200, json: async () => [] }; };
  try {
    const stored = { strict: [{ request_id: "S1" }], near: [], eligibleCount: 2 };
    const env = { DB: fakeDB({ cache: { "20220314107": { matches: JSON.stringify(stored) } } }) };
    const matches = await getOrCompute(env, "20220314107");
    assert.deepEqual(matches, { ...stored, ok: true });
    assert.equal(fetched, false, "a cache hit must not hit SODA");
  } finally { globalThis.fetch = orig; }
});

test("getOrCompute: cache miss computes, upserts, and the next read is a hit", withMockedSoda(async () => {
  const db = fakeDB({ notices: { "20220314107": hpdNotice } });
  const env = { DB: db };
  const first = await getOrCompute(env, "20220314107");
  assert.equal(first.near.length, 1);
  // Now cached, including the eligibleCount field the client needs for 67's empty-state message.
  assert.ok(db._cache["20220314107"], "computed matches were upserted");
  const stored = JSON.parse(db._cache["20220314107"].matches);
  assert.equal(stored.near[0].c.request_id, "20190621041");
  assert.equal(typeof stored.eligibleCount, "number", "eligibleCount is persisted in the cache row");
  assert.equal(db._cache["20220314107"].agency, "Housing Preservation and Development");
}, { strictRows: [], nearRows: [hpdPriorRound] }));

test("getOrCompute: a pre-Phase-1b cache row (no eligibleCount) is treated as a miss and recomputed", withMockedSoda(async () => {
  // A legacy cached row from before Phase 1b lacks eligibleCount. Serving it would leave the
  // client unable to pick 67's no_candidates-vs-low_confidence message, so it must be treated as
  // a cache miss: recompute, and re-upsert a row that now carries the field.
  const legacy = JSON.stringify({ strict: [], near: [] }); // no eligibleCount
  const db = fakeDB({
    notices: { "20220314107": hpdNotice },
    cache: { "20220314107": { matches: legacy } },
  });
  const matches = await getOrCompute({ DB: db }, "20220314107");
  assert.equal(typeof matches.eligibleCount, "number", "recompute filled in the missing field");
  assert.equal(matches.near.length, 1, "recompute ran the tiers, not served the legacy empty row");
  const restored = JSON.parse(db._cache["20220314107"].matches);
  assert.equal(typeof restored.eligibleCount, "number", "the cache row was upgraded in place");
}, { strictRows: [], nearRows: [hpdPriorRound] }));

test("getOrCompute: a transient SODA failure is returned but NOT cached (retry-on-next-request)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => [] });
  try {
    const db = fakeDB({ notices: { "20220314107": hpdNotice } });
    const matches = await getOrCompute({ DB: db }, "20220314107");
    assert.deepEqual(matches, { strict: [], near: [], eligibleCount: 0, ok: false });
    assert.equal(db._cache["20220314107"], undefined, "a failed compute must not be cached");
  } finally { globalThis.fetch = orig; }
});

test("getOrCompute: an id that resolves to no notice writes no cache row and looks it up once", async () => {
  const orig = globalThis.fetch;
  let lookups = 0;
  globalThis.fetch = async () => { lookups++; return { ok: true, status: 200, json: async () => [] }; };
  try {
    const db = fakeDB();
    const matches = await getOrCompute({ DB: db }, "NOPE1234");
    assert.deepEqual(matches, { strict: [], near: [], eligibleCount: 0, ok: false });
    assert.equal(db._cache["NOPE1234"], undefined, "an unresolvable id must not grow the table");
    assert.equal(lookups, 1, "the notice row is resolved once, not re-fetched by computeMatches");
  } finally { globalThis.fetch = orig; }
});

test("getOrCompute: with no D1 binding it still computes (no cache layer)", withMockedSoda(async () => {
  const env = {}; // no DB — fetchNoticeRow falls to SODA; strict $where=request_id lookup
  const matches = await getOrCompute(env, "20220314107");
  assert.equal(matches.near.length, 1);
}, {
  // First call is the request_id lookup (no start_date filter) → the notice itself; then strict;
  // then near. The mock keys off "start_date < " so the id-lookup + strict both return strictRows.
  strictRows: [{
    request_id: "20220314107", start_date: "2022-03-18",
    agency_name: "Housing Preservation and Development", type_of_notice_description: "Award",
    short_title: "IMMEDIATE EMERGENCY DEMOLITION OF 28 W 130th St, MANHATTAN (DM00121 E-6038R)",
    pin: "80622E0016001", contract_amount: "550000",
  }],
  nearRows: [hpdPriorRound],
}));

test("prewarm: bounded, idempotent, fail-soft; skips already-cached ids", withMockedSoda(async () => {
  const db = fakeDB({
    notices: { "20220314107": hpdNotice },
    cache: { "ALREADY": { matches: JSON.stringify({ strict: [], near: [], eligibleCount: 0 }) } },
  });
  const env = { DB: db };
  const r = await prewarm(env, ["20220314107", "ALREADY", "20220314107"]); // dedupes too
  assert.equal(r.requested, 2, "deduped to 2 unique ids");
  assert.equal(r.skipped, 1, "ALREADY was already cached");
  assert.equal(r.computed, 1);
  assert.equal(r.failed, 0);
}, { strictRows: [], nearRows: [hpdPriorRound] }));

test("GET /priorcycle/<id>: returns { id, strict, near, eligibleCount, ok } with the edge-cache header", async () => {
  const stored = { strict: [], near: [{ c: { request_id: "20190621041" } }], eligibleCount: 3 };
  const env = { DB: fakeDB({ cache: { "20220314107": { matches: JSON.stringify(stored) } } }) };
  const req = new Request("https://w/priorcycle/20220314107", { method: "GET" });
  const res = await handlePriorCycle(req, env, "/priorcycle/20220314107");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300");
  const body = await res.json();
  assert.equal(body.id, "20220314107");
  assert.deepEqual(body.strict, []);
  assert.equal(body.near[0].c.request_id, "20190621041");
  assert.equal(body.eligibleCount, 3);
  assert.equal(body.ok, true);
});

test("GET /priorcycle/<id>: a compute failure returns ok:false and is not edge-cached", async () => {
  // No D1 cache; every SODA fetch 503s → computeMatches returns ok:false. The 200 body must carry
  // ok:false (so the client says nothing rather than a confident 'no earlier awards') and must not
  // be cached at the edge (no-store), so a later request re-computes.
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => [] });
  try {
    const env = {}; // no DB binding
    const req = new Request("https://w/priorcycle/20220314107", { method: "GET" });
    const res = await handlePriorCycle(req, env, "/priorcycle/20220314107");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const body = await res.json();
    assert.equal(body.ok, false);
  } finally { globalThis.fetch = orig; }
});

test("GET /priorcycle/<id>: rejects a malformed id", async () => {
  const env = { DB: fakeDB() };
  const req = new Request("https://w/priorcycle/..%2Fetc", { method: "GET" });
  const res = await handlePriorCycle(req, env, "/priorcycle/..%2Fetc");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.reason, "bad-id");
});

test("GET /priorcycle/<id>: malformed percent-encoding returns 400, not a 500", async () => {
  const env = { DB: fakeDB() };
  const req = new Request("https://w/priorcycle/%", { method: "GET" });
  const res = await handlePriorCycle(req, env, "/priorcycle/%");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.reason, "bad-id");
});

test("GET /priorcycle/<id>: OPTIONS preflight returns 204", async () => {
  const req = new Request("https://w/priorcycle/20220314107", { method: "OPTIONS" });
  const res = await handlePriorCycle(req, {}, "/priorcycle/20220314107");
  assert.equal(res.status, 204);
});
