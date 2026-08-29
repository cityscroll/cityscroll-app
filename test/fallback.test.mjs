import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Proves the on-device fallback actually works — so the README can claim it honestly.
//
// CityScroll is one static index.html with no build step, so there's nothing to import.
// Instead we read index.html, pull the three real functions out of it by name (brace-
// matched, so the test can't drift from the source), and run them under node:test.
//
//   node --test            (from the repository root)
//
// What we assert: deviceParse() turns plain English into a usable filter for every lens,
// and nlResolve() falls back to that device parse whenever the worker is unset, errors,
// or returns a degraded result — i.e. the page never hard-depends on the worker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = SITE_SOURCE;
// parseNL() now lives in its own module (nl_parse.js) — a plain global-declaring script in
// the browser, so its source can be inlined into the Function body the same way the
// brace-extracted index.html functions below are.
const nlParseSrc = readFileSync(join(ROOT, "site", "nl_parse.js"), "utf8");

// Pull `function NAME(...){ ... }` (or `async function`) out of the source by brace matching.
function extractFn(name) {
  let start = src.indexOf("async function " + name + "(");
  if (start === -1) start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let depth = 0, seen = false;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") { depth++; seen = true; }
    else if (src[j] === "}" && --depth === 0 && seen) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// Build live functions from the extracted source. nlResolve closes over API + fetch, so
// we inject those as params to drive each fallback branch deterministically.
const make = (API, fetchImpl) =>
  new Function("API", "fetch",
    ["const API_FALLBACK = API; let apiBase = API;", // fallback base mirrors the injected one in tests
     nlParseSrc,
     extractFn("workerFetch"), extractFn("personName"), extractFn("withPersonName"),
     extractFn("deviceParse"), extractFn("enrichNeighborhoodFilter"), extractFn("attachCitedQuotes"), extractFn("nlResolve"),
     "return { parseNL, deviceParse, nlResolve };"].join("\n")
  )(API, fetchImpl);

const { deviceParse } = make("", null);

test("deviceParse: money — pulls keyword + dollar threshold", () => {
  const f = deviceParse("construction contracts over $500k", "money");
  assert.ok(f.keywords.includes("construction"), "keyword");
  assert.equal(f.minAmount, 500000, "minAmount");
});

test("deviceParse: land — pulls the borough", () => {
  const f = deviceParse("rezonings in Brooklyn", "land");
  assert.equal(f.boro, "Brooklyn");
});

test("deviceParse: land — council district filter", () => {
  const f = deviceParse("rezonings in council district 33", "land");
  assert.equal(f.councilDistrict, "33");
});

test("deviceParse: normalization handles ordinals and agency word order", () => {
  const district = deviceParse("rezonings in Queens community district 3rd", "land");
  assert.equal(district.communityDistrict, "Q03");
  const rules = deviceParse("rules from recreation and parks department", "rules");
  assert.equal(rules.agency, "Parks and Recreation");
});

test("deviceParse: rules — open for comment process rail", () => {
  const f = deviceParse("rules open for comment", "rules");
  assert.equal(f.process, "public_process");
});

test("deviceParse: meetings — this week window", () => {
  const f = deviceParse("hearings this week", "meetings");
  assert.equal(f.when, "week");
});

test("deviceParse: people — exam guide surface", () => {
  const f = deviceParse("open competitive exams", "people");
  assert.equal(f.view, "guide");
});

test("deviceParse: every lens returns a usable keywords array (never throws/empty-undefined)", () => {
  for (const [text, lens] of [
    ["HPD property sales", "property"],
    ["sanitation rules", "rules"],
    ["recent landmarks hearings", "meetings"],
    ["paramedic roles", "people"],
  ]) {
    const f = deviceParse(text, lens);
    assert.ok(Array.isArray(f.keywords) && f.keywords.length > 0, `${lens}: "${text}" -> ${JSON.stringify(f)}`);
  }
});

test("the deterministic NL parser stays off the home cold path", () => {
  assert.doesNotMatch(src, /<script[^>]+src=["']nl_parse\.js["']/);
  assert.match(src, /function loadNlParser\(\)/);
});

test("nlResolve: no worker configured -> device parse", async () => {
  const { nlResolve } = make("", null);
  const f = await nlResolve("rezonings in Brooklyn", "land");
  assert.equal(f.source, "device");
  assert.equal(f.boro, "Brooklyn");
});

test("nlResolve: worker throws -> device parse (the real-world flaky case)", async () => {
  const { nlResolve } = make("https://worker.example", async () => { throw new Error("network down"); });
  const f = await nlResolve("construction over $500k", "money");
  assert.equal(f.source, "device");
  assert.equal(f.minAmount, 500000);
});

test("nlResolve: worker returns degraded -> device parse", async () => {
  const { nlResolve } = make("https://worker.example",
    async () => ({ ok: true, json: async () => ({ degraded: true }) }));
  const f = await nlResolve("sanitation rules", "rules");
  assert.equal(f.source, "device");
});

test("nlResolve: degraded /nl still keeps cited quotes from the worker", async () => {
  const quotes = {
    schema: "cityscroll.ask_cited_quotes.v1",
    query: "energy conservation",
    coverage: { state: "partial", quoted_count: 1, omitted_unknown_count: 0 },
    quotes: [{ citation_id: "city_record_notice:20260715041:p0001" }],
  };
  const { nlResolve } = make("https://worker.example",
    async () => ({ ok: true, json: async () => ({ degraded: true, reason: "api-529", cited_quotes: quotes }) }));
  const f = await nlResolve("energy conservation", "money");
  assert.equal(f.source, "device");
  assert.equal(f.cited_quotes.quotes[0].citation_id, "city_record_notice:20260715041:p0001");
});

test("nlResolve: worker succeeds -> model result is used", async () => {
  const { nlResolve } = make("https://worker.example",
    async () => ({ ok: true, json: async () => ({ filter: { keywords: ["x"], agency: "DSNY" } }) }));
  const f = await nlResolve("sanitation rules", "rules");
  assert.equal(f.source, "model");
  assert.equal(f.agency, "DSNY");
});
