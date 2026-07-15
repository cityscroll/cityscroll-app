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
import { SUGGESTION_POOL, MIN_SUGGESTION_RESULTS, suggestionCountParams } from "../src/lib/suggestions.mjs";
import { runSuggestionValidation, handleSuggestions, SUGGESTIONS_KV_KEY } from "../src/suggest.mjs";

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

test("suggestionCountParams: people has no compileSub() replay path -> null (documented, deliberate gap)", () => {
  assert.equal(suggestionCountParams("people", { keywords: ["paramedic"], lookupType: "role" }, TODAY), null);
});

// ---- runSuggestionValidation: the daily pipeline ---------------------------------------

test("runSuggestionValidation: field-evidence fixture — the dead money examples are excluded, the working one survives", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.anthropic.com")) {
      const body = JSON.parse((opts && opts.body) || "{}");
      const isConstruction = /construction/i.test(body.messages[0].content);
      const input = isConstruction
        ? { keywords: ["construction"], minAmount: 500000, maxAmount: null, category: null, agency: null, months: null, noticeType: null, excludeSpecial: false }
        : { keywords: body.messages[0].content.toLowerCase().includes("it consulting") ? ["it", "consulting"] : ["shelter", "services"], minAmount: null, maxAmount: null, category: null, agency: null, months: null, noticeType: null, excludeSpecial: false };
      return { ok: true, json: async () => ({ content: [{ type: "tool_use", name: "build_filter", input }] }) };
    }
    // The two dead field-evidence examples: zero live rows. Construction: plenty.
    const isConstruction = String(url).includes("construction");
    return { ok: true, json: async () => [{ n: isConstruction ? "42" : "0" }] };
  };
  const kvStore = {};
  const env = { ANTHROPIC_API_KEY: "test-key", ALERT_STATE: { get: async (k) => kvStore[k], put: async (k, v) => { kvStore[k] = v; } } };

  try {
    const res = await runSuggestionValidation(env);
    assert.equal(res.status, "success");
    const money = res.byLens.money.map((c) => c.idx);
    assert.ok(money.includes(0), `expected idx 0 (construction) to survive: ${JSON.stringify(res.byLens.money)}`);
    assert.ok(!money.includes(1), `expected idx 1 (IT consulting RFPs) excluded: ${JSON.stringify(res.byLens.money)}`);
    assert.ok(!money.includes(2), `expected idx 2 (shelter services) excluded: ${JSON.stringify(res.byLens.money)}`);

    const stored = JSON.parse(kvStore[SUGGESTIONS_KV_KEY]);
    assert.equal(stored.minResults, MIN_SUGGESTION_RESULTS);
    assert.ok(stored.byLens.money.some((c) => c.idx === 0));
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

// ---- GET /suggestions route --------------------------------------------------------------

test("handleSuggestions: serves the stored validated set", async () => {
  const stored = { generatedAt: "2026-07-15T13:00:00.000Z", minResults: 3, byLens: { money: [{ idx: 0, count: 42 }] } };
  const env = { ALERT_STATE: { get: async () => JSON.stringify(stored) } };
  const req = new Request("https://crol-worker.example/suggestions", { headers: { origin: "https://crol-list.org" } });
  const res = await handleSuggestions(req, env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, stored);
});

test("handleSuggestions: 404s when the cron hasn't populated KV yet (client should fall back to static)", async () => {
  const env = { ALERT_STATE: { get: async () => null } };
  const req = new Request("https://crol-worker.example/suggestions");
  const res = await handleSuggestions(req, env);
  assert.equal(res.status, 404);
});
