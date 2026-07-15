// Live end-to-end tests for the deployed /nl endpoint. Costs a few Haiku calls.
// Run against prod:   npm run test:live
// Run against local:  CROL_WORKER_URL=http://localhost:8787 npm run test:live
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.CROL_WORKER_URL || "https://crol-worker.crol-worker.workers.dev").replace(/\/+$/, "");
const NL = `${BASE}/nl`;

const post = (body, headers = {}) =>
  fetch(NL, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

// ---- per-lens translation (the headline feature) --------------------------

test("money lens: canonical construction example -> correct filter", async () => {
  const r = await post({ lens: "money", text: "I'm a construction company doing affordable housing — show contracts over $500k, no special requirements, deadline within 3 months." });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.lens, "money");
  assert.ok(j.filter, `expected a filter, got ${JSON.stringify(j)}`);
  assert.equal(j.filter.minAmount, 500000);
  assert.equal(j.filter.months, 3);
  assert.equal(j.filter.excludeSpecial, true);
  assert.ok(j.filter.keywords.includes("construction"), `keywords: ${j.filter.keywords}`);
});

test("land lens: borough + topic extracted into land fields", async () => {
  const r = await post({ lens: "land", text: "affordable housing rezonings in Brooklyn" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.lens, "land");
  assert.deepEqual(Object.keys(j.filter).sort(), ["boro", "keywords", "status"]); // only land fields
  assert.equal(j.filter.boro, "Brooklyn");
  assert.ok(j.filter.keywords.length >= 1 && j.filter.keywords.length <= 4);
});

test("alerts lens: 'awards over $1M' -> minAmount, not a place/rezone watch", async () => {
  const r = await post({ lens: "alerts", text: "email me contract awards over $1M" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.lens, "alerts");
  assert.equal(j.filter.watchType, null);
  assert.equal(j.filter.minAmount, 1000000);
});

test("alerts lens: category + amount + deadline extracted together (not one-at-a-time)", async () => {
  const r = await post({ lens: "alerts", text: "education contracts over $200K due in 3 months" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.lens, "alerts");
  assert.equal(j.filter.minAmount, 200000);
  assert.equal(j.filter.months, 3);
  assert.ok(j.filter.keywords.includes("education"), `keywords: ${j.filter.keywords}`);
});

// ---- paraphrase robustness (w12-02) ---------------------------------------
// Field evidence 2026-07-14: the ask box "required very specific wording" — a paraphrase of
// the exact same request came back as a silent, unexplained empty result, which read as "the
// feature is broken." These pin the fixture above (education / >$200k / due in 3 months)
// under real paraphrasing — word order, synonyms ("school"/"deals"/"RFPs" for "education"/
// "contracts"/"solicitations"), and currency/duration format ("$200k" vs "200,000" vs spelled
// out; "3 months" vs "90 days" vs "12 weeks" vs "next quarter"). Before this card, only the
// one exact wording above was verified — a differently-worded but identical request had no
// coverage and, per the field report, no guarantee of the same result. Live model behavior
// only (not unit-testable) — see test/nl.test.mjs for the offline-testable parts of this
// pipeline (sanitize() normalization, filterConfidence()).
const PARAPHRASES = [
  "over 200k education contracts next 3 months",
  "RFPs about schools > $200,000 due within 90 days",
  "school bids worth more than $200,000 closing within the next 3 months",
  "education RFPs exceeding two hundred thousand dollars due in the next quarter",
  "show me contracts about education valued over $200k that close in the next twelve weeks",
  "education contracts north of $200,000 due in 3 months",
  "solicitations for schools greater than 200000 due in the next 3 months",
];

for (const text of PARAPHRASES) {
  test(`alerts lens paraphrase -> same interpreted filter as the canonical fixture: "${text}"`, async () => {
    const r = await post({ lens: "alerts", text });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.filter, `expected a filter, got ${JSON.stringify(j)}`);
    assert.equal(j.filter.minAmount, 200000, `minAmount for "${text}": ${JSON.stringify(j.filter)}`);
    assert.equal(j.filter.months, 3, `months for "${text}": ${JSON.stringify(j.filter)}`);
    assert.ok(j.filter.keywords.some(k => /educat|school/i.test(k)), `keywords for "${text}": ${j.filter.keywords}`);
  });
}

test("alerts lens: vague urgency with no stated duration doesn't invent a number (conservative-parsing design decision)", async () => {
  // This is the one named example from the field report that carries no explicit duration —
  // "closing soon" is not equivalent to "due in 3 months" and forcing it to guess 3 would be
  // the same kind of over-eager guess the schema's field description explicitly forbids (see
  // FIELD_DEFS.months in nl.mjs). Deliberately NOT folded into the equal-filter set above.
  const r = await post({ lens: "alerts", text: "school deals worth more than $200k closing soon" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.filter.minAmount, 200000);
  assert.equal(j.filter.months, null, `should not invent a duration from "closing soon": ${JSON.stringify(j.filter)}`);
});

// ---- defense in depth -----------------------------------------------------

test("GET is rejected (405)", async () => {
  const r = await fetch(NL, { method: "GET" });
  assert.equal(r.status, 405);
});

test("empty text -> 400, no model call", async () => {
  const r = await post({ text: "" });
  assert.equal(r.status, 400);
});

test("OPTIONS preflight -> 204 with CORS for an allowed origin", async () => {
  const r = await fetch(NL, { method: "OPTIONS", headers: { Origin: "https://crol-list.jimdc.com" } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "https://crol-list.jimdc.com");
});

test("CORS allowlist: an unknown origin is NOT echoed back", async () => {
  const r = await fetch(NL, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  const acao = r.headers.get("access-control-allow-origin");
  assert.notEqual(acao, "https://evil.example");
  assert.equal(acao, "https://crol-list.jimdc.com");
});

test("input cap: oversized input still returns a bounded response (no crash)", async () => {
  const huge = "construction ".repeat(500);
  const r = await post({ lens: "money", text: huge });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.filter || j.degraded, `responds without error: ${JSON.stringify(j)}`);
});
