// Before this card: index.html's suggestion chips ("Try" queries under Contracts/Land/etc.)
// were a hardcoded, never-checked array — the site owner reported that under the money lens,
// "IT consulting RFPs" and "shelter services contracts" returned ZERO live results while
// "construction contracts over $500k" worked, so two of three chips were dead ends. These
// tests pin: suggestionCountParams() builds the identical query shape a real click resolves to
// (no bespoke second implementation to drift), and runSuggestionValidation() excludes a
// zero-result candidate from the validated set while keeping a fruitful one — and never
// overwrites yesterday's validated set with an empty one just because today's run failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_INDICES, SUGGESTION_POOL, MIN_SUGGESTION_RESULTS, suggestionCountParams } from "../src/lib/suggestions.mjs";
import {
  codeFloorSuggestionRecord,
  parsePresetFallbackRecord,
  parseValidatedSuggestionRecord,
  PRESET_FALLBACK_KV_KEY,
  PRESET_FALLBACK_SCHEMA,
  SUGGESTION_LENSES,
} from "../src/lib/preset_fallback_kv.mjs";
import { runSuggestionValidation, handleAdminSuggestRefresh, handleSuggestions, SUGGESTIONS_KV_KEY } from "../src/suggest.mjs";

const TODAY = "2026-07-15";

test("suggestionCountParams: money award-shaped filter -> count(1) query, no $order/$limit", () => {
  const q = suggestionCountParams("money", { keywords: ["construction"], minAmount: 500000, maxAmount: null, category: null, agency: null, months: null, noticeType: null, excludeSpecial: false }, TODAY);
  assert.ok(q);
  assert.match(q.url, /dg92-zbpx\.json/);
  assert.equal(q.params["$select"], "count(1) as n");
  assert.ok(!("$order" in q.params));
  assert.ok(!("$limit" in q.params));
  assert.match(q.params["$where"], /type_of_notice_description='Award'/);
});

test("suggestionCountParams: land filter -> ZAP count(1) query", () => {
  const q = suggestionCountParams("land", { keywords: ["brooklyn"], boro: "Brooklyn", status: null }, TODAY);
  assert.ok(q);
  assert.match(q.url, /hgx4-8ukb\.json/);
  assert.equal(q.params["$select"], "count(1) as n");
});

test("suggestionCountParams: alerts rezone watch (watchType:'rezone') maps to a land-shaped count query using place as the keyword", () => {
  const q = suggestionCountParams("alerts", { watchType: "rezone", place: "79 Rivington", keywords: [], agency: null, minAmount: null, maxAmount: null, category: null, months: null, noticeType: null, excludeSpecial: false }, TODAY);
  assert.ok(q);
  assert.match(q.url, /hgx4-8ukb\.json/);
  // compileSub()'s land branch aliases "79 rivington" -> "Allen Street" for $q.
  assert.equal(q.params["$q"], "Allen Street");
});

test("suggestionCountParams: alerts non-rezone watch maps to a money-shaped count query", () => {
  const q = suggestionCountParams("alerts", { watchType: null, place: null, keywords: [], agency: null, minAmount: 1000000, maxAmount: null, category: null, months: null, noticeType: null, excludeSpecial: false }, TODAY);
  assert.ok(q);
  assert.match(q.url, /dg92-zbpx\.json/);
  assert.match(q.params["$where"], /contract_amount >= 1000000/);
});

test("suggestionCountParams: people role suggestions count the payroll title mart before SODA", () => {
  const q = suggestionCountParams("people", { keywords: ["paramedic"], lookupType: "role" }, TODAY);
  assert.equal(q.url, null);
  assert.equal(q.source, "payroll_title_mart");
  assert.ok(q.count >= 1017);
  assert.equal(typeof q.readRows, "function");
  assert.ok(q.readRows().some((row) => /paramedic/i.test(row.title_description)));
});

test("suggestionCountParams: people title mart hit never calls live payroll SODA", async () => {
  const { loadProductSeedRows, buildMaterializationDoc } = await import(
    "../../warehouse/lib/payroll_title_lookup.mjs"
  );
  const mart = buildMaterializationDoc(loadProductSeedRows(), {
    mode: "product_seed",
    now: "2026-08-18T00:00:00.000Z",
  });
  const sodaHits = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    sodaHits.push(String(url));
    throw new Error("live SODA must not run on a payroll title mart hit");
  };
  try {
    const q = suggestionCountParams(
      "people",
      { keywords: ["paramedic"], lookupType: "role" },
      TODAY,
      { payrollTitleMart: mart },
    );
    assert.equal(q.url, null);
    assert.equal(q.source, "payroll_title_mart");
    const n = Number.isFinite(Number(q.count)) ? Number(q.count) : (await q.readRows()).length;
    assert.equal(n, 1017);
    assert.deepEqual(sodaHits, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("suggestionCountParams: people title miss still falls through to payroll SODA", () => {
  const q = suggestionCountParams(
    "people",
    { keywords: ["paramedic"], lookupType: "role" },
    TODAY,
    { payrollTitleMart: { schema_version: 1, fiscal_year: 2025, rows: [] } },
  );
  assert.match(q.url, /k397-673e\.json/);
  assert.equal(q.params["$select"], "count(1) as n");
  assert.match(q.params["$where"], /fiscal_year=2025/);
  assert.match(q.params["$where"], /upper\(title_description\) like '%PARAMEDIC%'/);
});

test("suggestionCountParams: people-name suggestions count Changes in Personnel notices", () => {
  const q = suggestionCountParams("people", { keywords: ["Rodriguez"], lookupType: "person" }, TODAY);
  assert.match(q.url, /dg92-zbpx\.json/);
  assert.equal(q.params["$q"], "Rodriguez");
  assert.match(q.params["$where"], /Changes in Personnel/);
});

test("suggestionCountParams: meetings count the shared materialized read model", () => {
  const q = suggestionCountParams("meetings", { keywords: [], when: "week" }, TODAY);
  assert.equal(q.url, null);
  assert.equal(typeof q.readRows, "function");
  assert.ok(q.readRows().length > 0);
});

// ---- runSuggestionValidation: the daily pipeline ---------------------------------------

test("runSuggestionValidation: a proxy-rich money suggestion is excluded when its resident destination is empty", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.anthropic.com")) {
      const body = JSON.parse((opts && opts.body) || "{}");
      const isConstruction = /construction/i.test(body.messages[0].content);
      const input = isConstruction
        ? { keywords: ["construction"], minAmount: 500000, maxAmount: null, category: "Construction/Construction Services", agency: null, months: null, noticeType: null, excludeSpecial: false }
        : { keywords: body.messages[0].content.toLowerCase().includes("it consulting") ? ["it", "consulting"] : ["shelter", "services"], minAmount: null, maxAmount: null, category: null, agency: null, months: null, noticeType: null, excludeSpecial: false };
      return { ok: true, json: async () => ({ content: [{ type: "tool_use", name: "build_filter", input }] }) };
    }
    // This is the SUGGEST-01 oracle mismatch: Socrata says construction has thousands,
    // while the committed resident snapshot has no row surviving the route's keyword,
    // amount, and category filters.
    const isConstruction = String(url).includes("construction");
    return { ok: true, json: async () => [{ n: isConstruction ? "4955" : "0" }] };
  };
  const kvStore = {};
  const env = { ANTHROPIC_API_KEY: "test-key", ALERT_STATE: { get: async (k) => kvStore[k], put: async (k, v) => { kvStore[k] = v; } } };

  try {
    const res = await runSuggestionValidation(env);
    assert.equal(res.status, "skipped");
    assert.equal(kvStore[SUGGESTIONS_KV_KEY], undefined, "an all-empty destination run must not certify a proxy-rich candidate");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runSuggestionValidation: a candidate whose /nl resolve degrades (no key) is skipped, not fatal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.anthropic.com")) throw new Error("should not be reached — no key");
    return { ok: true, json: async () => [{ n: "10" }] };
  };
  const kvStore = {};
  const env = { ALERT_STATE: { get: async (k) => kvStore[k], put: async (k, v) => { kvStore[k] = v; } } }; // no ANTHROPIC_API_KEY
  try {
    const res = await runSuggestionValidation(env);
    assert.equal(res.status, "skipped");
    assert.equal(res.reason, "no-fruitful-candidates");
    assert.equal(kvStore[SUGGESTIONS_KV_KEY], undefined, "must not write an empty set to KV");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runSuggestionValidation: total outage keeps the previous validated set in KV untouched (fail-soft)", async () => {
  const originalFetch = globalThis.fetch;
  const kvStore = { [SUGGESTIONS_KV_KEY]: JSON.stringify({ generatedAt: "yesterday", minResults: 3, byLens: { money: [{ idx: 0, count: 99 }] } }) };
  globalThis.fetch = async () => { throw new Error("network down"); };
  const env = { ANTHROPIC_API_KEY: "test-key", ALERT_STATE: { get: async (k) => kvStore[k], put: async (k, v) => { kvStore[k] = v; } } };
  try {
    const res = await runSuggestionValidation(env);
    assert.equal(res.status, "skipped");
    assert.equal(kvStore[SUGGESTIONS_KV_KEY], JSON.stringify({ generatedAt: "yesterday", minResults: 3, byLens: { money: [{ idx: 0, count: 99 }] } }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SUGGESTION_POOL: the two field-evidence dead examples are present as fixtures (pool membership, not display)", () => {
  const money = SUGGESTION_POOL.filter((c) => c.lens === "money");
  assert.ok(money.some((c) => c.idx === 1 && c.text === "IT consulting RFPs"));
  assert.ok(money.some((c) => c.idx === 2 && c.text === "shelter services contracts"));
});

// ---- w12-17: lineage-richness / forecast-bearing enrichment -----------------------------
//
// Owner directive: contracts suggestions should surface some queries whose results
// conspicuously carry prior award cycles, and separately mark the ones whose agency has
// forecast (predictive) data — both computed once a day, not on the client's dime.
//
// Real fixtures: "construction contracts over $500k" (SUGGESTION_POOL money idx 0) — its own
// live 25-row result sample and the real 2-stage Award chains within it, queried from dg92-zbpx
// on 2026-07-15 (see test/lineage.test.mjs's header for the full provenance; same fixture,
// reused here to prove enrichCandidate() wires computeLineageSignal() into the real pipeline).
// "school food service contracts" (money idx 4) — two real, live NYC Department of Education
// Solicitation rows for the same query, standing in for a candidate whose agency ("Education")
// has cached Checkbook forecast data; the DOE agency is deliberately absent from the
// construction sample so the two signals are independently demonstrated, not conflated.
const constructionSample = [
  { pin: "85026B0058001", agency_name: "Design and Construction" },
  { pin: "82624B0040001R001", agency_name: "Environmental Protection" },
  { pin: "07222B0008003R001", agency_name: "Correction" },
  { pin: "82624B0038001R001", agency_name: "Environmental Protection" },
  { pin: "82626R0001001", agency_name: "Environmental Protection" },
  { pin: "82624B0041001R001", agency_name: "Environmental Protection" },
  { pin: "82624B0043001R001", agency_name: "Environmental Protection" },
  { pin: "85026B0033001", agency_name: "Design and Construction" },
  { pin: "85023P0003002R001", agency_name: "Design and Construction" },
  { pin: "82624B0042001R001", agency_name: "Environmental Protection" },
  { pin: "85023P0003003R001", agency_name: "Design and Construction" },
  { pin: "84626B0062001", agency_name: "Parks and Recreation" },
  { pin: "84626B0028001", agency_name: "Parks and Recreation" },
  { pin: "85026B0074001", agency_name: "Design and Construction" },
  { pin: "84623B0128001R001", agency_name: "Parks and Recreation" },
  { pin: "07122P0023001R001", agency_name: "Homeless Services" },
  { pin: "85026B0021001", agency_name: "Design and Construction" },
  { pin: "82626W0061001", agency_name: "Environmental Protection" },
  { pin: "84625B0150001", agency_name: "Parks and Recreation" },
  { pin: "84121P0023002R001", agency_name: "Transportation" },
  { pin: "85623B0004001R001", agency_name: "Citywide Administrative Services" },
  { pin: "84124P0003001", agency_name: "Transportation" },
  { pin: "82626E0006001", agency_name: "Environmental Protection" },
  { pin: "07222B0004001R001", agency_name: "Correction" },
  { pin: "84626W0028001", agency_name: "Parks and Recreation" },
];
const constructionBatch = [
  { pin: "07222B0008003", agency_name: "Correction", type_of_notice_description: "Award" },
  { pin: "07222B0008003R001", agency_name: "Correction", type_of_notice_description: "Award" },
  { pin: "84623B0128001", agency_name: "Parks and Recreation", type_of_notice_description: "Award" },
  { pin: "84623B0128001R001", agency_name: "Parks and Recreation", type_of_notice_description: "Award" },
  { pin: "07122P0023001", agency_name: "Homeless Services", type_of_notice_description: "Award" },
  { pin: "07122P0023001R001", agency_name: "Homeless Services", type_of_notice_description: "Award" },
  { pin: "84121P0023002", agency_name: "Transportation", type_of_notice_description: "Award" },
  { pin: "84121P0023002R001", agency_name: "Transportation", type_of_notice_description: "Award" },
  { pin: "85623B0004001", agency_name: "Citywide Administrative Services", type_of_notice_description: "Award" },
  { pin: "85623B0004001R001", agency_name: "Citywide Administrative Services", type_of_notice_description: "Award" },
  { pin: "07222B0004001", agency_name: "Correction", type_of_notice_description: "Award" },
  { pin: "07222B0004001R001", agency_name: "Correction", type_of_notice_description: "Award" },
  ...Array.from({ length: 16 }, (_, i) => ({
    pin: `82626${i}`, agency_name: "Environmental Protection",
    type_of_notice_description: i % 3 === 0 ? "Intent to Award" : "Award",
  })),
];
// Real DOE Solicitation rows (dg92-zbpx, 2026-07-15).
const doeSample = [
  { pin: "B5929040", agency_name: "Education" },
  { pin: "B5954040", agency_name: "Education" },
];

test("runSuggestionValidation: enriches a real lineage-rich candidate and a real forecast-bearing candidate (w12-17)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const s = String(url);
    if (s.includes("api.anthropic.com")) {
      const body = JSON.parse((opts && opts.body) || "{}");
      const text = body.messages[0].content.toLowerCase();
      let input = { keywords: [], minAmount: null, maxAmount: null, category: null, agency: null, months: null, noticeType: null, excludeSpecial: false };
      if (text.includes("construction")) input = { ...input, keywords: ["construction"], minAmount: 500000 };
      else if (text.includes("school food service")) input = { ...input, keywords: ["school", "food", "service"] };
      return { ok: true, json: async () => ({ content: [{ type: "tool_use", name: "build_filter", input }] }) };
    }
    const u = new URL(s);
    const select = u.searchParams.get("$select") || "";
    if (select === "count(1) as n") {
      const n = s.includes("construction") ? "42" : s.includes("school") ? "8" : "0";
      return { ok: true, json: async () => [{ n }] };
    }
    if (select === "pin,agency_name,type_of_notice_description") {
      return { ok: true, json: async () => constructionBatch }; // only construction's sample has a matching key
    }
    if (s.includes("construction")) return { ok: true, json: async () => constructionSample };
    if (s.includes("school")) return { ok: true, json: async () => doeSample };
    return { ok: true, json: async () => [] };
  };
  const kvStore = { "fc:EDUCATION": JSON.stringify([{ source: "checkbook", agency_name: "Education", contract_id: "DOE-1", expiration_date: "2027-09-01" }]) };
  const env = { ANTHROPIC_API_KEY: "test-key", ALERT_STATE: { get: async (k) => kvStore[k], put: async (k, v) => { kvStore[k] = v; } } };
  try {
    const res = await runSuggestionValidation(env, {
      moneyDestination: async (_env, filter) => ({
        finalCount: filter.keywords?.includes("construction") ? 42 : filter.keywords?.includes("school") ? 8 : 0,
        route: "/browse/contracts/",
      }),
    });
    const money = res.byLens.money;
    const construction = money.find((c) => c.idx === 0);
    const school = money.find((c) => c.idx === 4);
    assert.ok(construction, "construction candidate should have validated");
    assert.equal(construction.lineageRich, true, "construction contracts over $500k: 6/25 real rows have a genuine prior-award chain");
    assert.equal(construction.forecastBearing, false, "none of construction's sampled agencies (Education absent) have cached forecast data");
    assert.ok(school, "school food service candidate should have validated");
    assert.equal(school.forecastBearing, true, "Education has a cached renewal-estimate record");
    assert.equal(school.lineageRich, false, "the DOE sample rows carry no PIN chain data in this fixture");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runSuggestionValidation: enrichment failure (bad sample fetch) never blocks the base validated result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const s = String(url);
    if (s.includes("api.anthropic.com")) {
      const body = JSON.parse((opts && opts.body) || "{}");
      const input = { keywords: ["construction"], minAmount: 500000, maxAmount: null, category: null, agency: null, months: null, noticeType: null, excludeSpecial: false };
      return { ok: true, json: async () => ({ content: [{ type: "tool_use", name: "build_filter", input }] }) };
    }
    const u = new URL(s);
    const select = u.searchParams.get("$select") || "";
    if (select === "count(1) as n") return { ok: true, json: async () => [{ n: "42" }] };
    return { ok: false, status: 500 }; // sample fetch fails
  };
  const env = { ANTHROPIC_API_KEY: "test-key", ALERT_STATE: { get: async () => null, put: async () => {} } };
  try {
    const res = await runSuggestionValidation(env, {
      moneyDestination: async () => ({ finalCount: 42, route: "/browse/contracts/" }),
    });
    const construction = res.byLens.money.find((c) => c.idx === 0);
    assert.ok(construction, "candidate still validates on its base count even when enrichment fails");
    assert.equal(construction.lineageRich, false, "uncertain — no indicator, not a guess");
    assert.equal(construction.forecastBearing, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---- GET /suggestions route --------------------------------------------------------------

const FRESH_AT = "2026-08-20T13:00:00.000Z";
const FRESH_NOW = Date.parse(FRESH_AT);

test("handleSuggestions: serves the stored validated set", async () => {
  const stored = { generatedAt: FRESH_AT, minResults: 3, byLens: { money: [{ idx: 0, count: 42 }] } };
  const env = { ALERT_STATE: { get: async () => JSON.stringify(stored) } };
  const req = new Request("https://crol-worker.example/suggestions", { headers: { origin: "https://cityscroll.org" } });
  const res = await handleSuggestions(req, env, undefined, { nowMs: FRESH_NOW });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, stored);
});

test("handleSuggestions: empty KV uses the in-code floor", async () => {
  const env = { ALERT_STATE: { get: async () => null } };
  const req = new Request("https://crol-worker.example/suggestions");
  const res = await handleSuggestions(req, env, undefined, { nowMs: FRESH_NOW });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "code_floor");
  assert.deepEqual(body, codeFloorSuggestionRecord({ nowMs: FRESH_NOW }));
  assert.deepEqual(body.byLens.money.map((row) => row.idx), FALLBACK_INDICES.money);
});

test("handleSuggestions: unparseable KV uses the in-code floor", async () => {
  const env = { ALERT_STATE: { get: async () => "{not-json" } };
  const req = new Request("https://crol-worker.example/suggestions");
  const res = await handleSuggestions(req, env, undefined, { nowMs: FRESH_NOW });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "code_floor");
  assert.deepEqual(body.byLens.people.map((row) => row.idx), FALLBACK_INDICES.people);
});

test("handleSuggestions: KV read failure uses the in-code floor", async () => {
  const env = { ALERT_STATE: { get: async () => { throw new Error("kv unavailable"); } } };
  const req = new Request("https://crol-worker.example/suggestions");
  const res = await handleSuggestions(req, env, undefined, { nowMs: FRESH_NOW });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "code_floor");
});

test("handleSuggestions: missing ALERT_STATE uses the in-code floor", async () => {
  const req = new Request("https://crol-worker.example/suggestions");
  const res = await handleSuggestions(req, {}, undefined, { nowMs: FRESH_NOW });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "code_floor");
});

test("handleSuggestions: stale KV uses the in-code floor", async () => {
  const stored = { generatedAt: "2026-08-17T12:00:00.000Z", minResults: 3, byLens: { money: [{ idx: 0, count: 42 }] } };
  const env = { ALERT_STATE: { get: async () => JSON.stringify(stored) } };
  const req = new Request("https://crol-worker.example/suggestions");
  const res = await handleSuggestions(req, env, undefined, { nowMs: FRESH_NOW });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, "code_floor");
});

test("handleSuggestions: slim preset:fallback payload matches the read path shape", async () => {
  const slim = {
    schema: PRESET_FALLBACK_SCHEMA,
    generatedAt: FRESH_AT,
    minResults: 3,
    byLens: { money: [6], people: [0, 2, 3] },
  };
  const env = {
    ALERT_STATE: {
      async get(key) {
        if (key === SUGGESTIONS_KV_KEY) return null;
        if (key === PRESET_FALLBACK_KV_KEY) return JSON.stringify(slim);
        return null;
      },
    },
  };
  const req = new Request("https://crol-worker.example/suggestions");
  const res = await handleSuggestions(req, env, undefined, { nowMs: FRESH_NOW });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.byLens.money, [{ idx: 6, count: 3 }]);
  assert.deepEqual(body.byLens.people.map((row) => row.idx), [0, 2, 3]);
  assert.equal(parsePresetFallbackRecord(JSON.stringify(slim), { nowMs: FRESH_NOW }).minResults, 3);
});

test("runSuggestionValidation: KV payload has the shape the read path expects", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const s = String(url);
    if (s.includes("api.anthropic.com")) {
      const body = JSON.parse((opts && opts.body) || "{}");
      const input = { keywords: ["construction"], minAmount: 500000, maxAmount: null, category: null, agency: null, months: null, noticeType: null, excludeSpecial: false };
      return { ok: true, json: async () => ({ content: [{ type: "tool_use", name: "build_filter", input }] }) };
    }
    const u = new URL(s);
    if ((u.searchParams.get("$select") || "") === "count(1) as n") {
      return { ok: true, json: async () => [{ n: "42" }] };
    }
    return { ok: true, json: async () => [] };
  };
  const kvStore = {};
  const env = {
    ANTHROPIC_API_KEY: "test-key",
    ALERT_STATE: { get: async (k) => kvStore[k], put: async (k, v) => { kvStore[k] = v; } },
  };
  try {
    const res = await runSuggestionValidation(env, {
      moneyDestination: async () => ({ finalCount: 42, route: "/browse/contracts/" }),
    });
    assert.equal(res.status, "success");
    const written = JSON.parse(kvStore[SUGGESTIONS_KV_KEY]);
    const nowMs = Date.parse(written.generatedAt);
    const parsed = parseValidatedSuggestionRecord(kvStore[SUGGESTIONS_KV_KEY], { nowMs });
    assert.ok(parsed, "written suggestions:validated must parse");
    assert.equal(parsed.minResults, MIN_SUGGESTION_RESULTS);
    assert.ok(parsed.byLens.money.some((row) => row.idx === 0 && row.count === 42));
    const slim = parsePresetFallbackRecord(kvStore[PRESET_FALLBACK_KV_KEY], { nowMs });
    assert.ok(slim, "written preset:fallback must parse");
    assert.ok(slim.byLens.money.some((row) => row.idx === 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseValidatedSuggestionRecord: an empty lens array does not invalidate the rest of the record", () => {
  const raw = JSON.stringify({
    generatedAt: FRESH_AT,
    minResults: 3,
    byLens: { money: [], land: [{ idx: 0, count: 12 }] },
  });
  const parsed = parseValidatedSuggestionRecord(raw, { nowMs: FRESH_NOW });
  assert.ok(parsed, "empty money must not fail-closed the whole KV blob");
  assert.deepEqual(parsed.byLens.money, []);
  assert.deepEqual(parsed.byLens.land, [{ idx: 0, count: 12 }]);
});

test("parsePresetFallbackRecord: an empty lens array does not invalidate the rest of the record", () => {
  const raw = JSON.stringify({
    schema: PRESET_FALLBACK_SCHEMA,
    generatedAt: FRESH_AT,
    minResults: 3,
    byLens: { money: [], people: [0, 2] },
  });
  const parsed = parsePresetFallbackRecord(raw, { nowMs: FRESH_NOW });
  assert.ok(parsed);
  assert.deepEqual(parsed.byLens.money, []);
  assert.deepEqual(parsed.byLens.people.map((row) => row.idx), [0, 2]);
});

test("runSuggestionValidation: an empty money lens stays [] and does not throw or skip the run", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const s = String(url);
    if (s.includes("api.anthropic.com")) {
      const input = { keywords: ["zzzxnotarealtopiczzzz"], minAmount: null, maxAmount: null, category: null, agency: null, months: null, noticeType: null, excludeSpecial: false };
      return { ok: true, json: async () => ({ content: [{ type: "tool_use", name: "build_filter", input }] }) };
    }
    const u = new URL(s);
    if ((u.searchParams.get("$select") || "") === "count(1) as n") {
      return { ok: true, json: async () => [{ n: "42" }] };
    }
    return { ok: true, json: async () => [] };
  };
  const kvStore = {};
  const env = {
    ANTHROPIC_API_KEY: "test-key",
    ALERT_STATE: { get: async (k) => kvStore[k], put: async (k, v) => { kvStore[k] = v; } },
  };
  try {
    const res = await runSuggestionValidation(env, {
      moneyDestination: async () => ({ finalCount: 0, route: "/browse/contracts/?q=maintenance" }),
    });
    assert.equal(res.status, "success");
    for (const lens of SUGGESTION_LENSES) {
      assert.ok(Array.isArray(res.byLens[lens]), `${lens} must be present`);
    }
    assert.deepEqual(res.byLens.money, []);
    assert.ok(res.byLens.land.length, "other lenses still validate");
    const nowMs = Date.parse(JSON.parse(kvStore[SUGGESTIONS_KV_KEY]).generatedAt);
    const parsed = parseValidatedSuggestionRecord(kvStore[SUGGESTIONS_KV_KEY], { nowMs });
    assert.ok(parsed, "KV with empty money must still parse");
    assert.deepEqual(parsed.byLens.money, []);
    const slim = parsePresetFallbackRecord(kvStore[PRESET_FALLBACK_KV_KEY], { nowMs });
    assert.ok(slim);
    assert.deepEqual(slim.byLens.money, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAdminSuggestRefresh: an empty source lens does not throw", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.anthropic.com")) {
      const input = { keywords: ["zzzxnotarealtopiczzzz"], minAmount: null, maxAmount: null, category: null, agency: null, months: null, noticeType: null, excludeSpecial: false };
      return { ok: true, json: async () => ({ content: [{ type: "tool_use", name: "build_filter", input }] }) };
    }
    return { ok: true, json: async () => [{ n: "42" }] };
  };
  const env = { ADMIN_KEY: "s3cr3t", ANTHROPIC_API_KEY: "test-key", ALERT_STATE: { get: async () => null, put: async () => {} } };
  try {
    const r = await handleAdminSuggestRefresh(
      new Request("https://w/admin/suggest-refresh?key=s3cr3t", { method: "POST" }),
      env,
    );
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, "success");
    assert.deepEqual(body.byLens.money, []);
    assert.equal(typeof body.byLens.money.find, "function");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
