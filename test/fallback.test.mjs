// Proves the on-device fallback actually works — so the README can claim it honestly.
//
// crol-list is one static index.html with no build step, so there's nothing to import.
// Instead we read index.html, pull the three real functions out of it by name (brace-
// matched, so the test can't drift from the source), and run them under node:test.
//
//   node --test            (from the crol-list/ dir)
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
const src = readFileSync(join(ROOT, "index.html"), "utf8");
// parseNL() now lives in its own module (nl_parse.js) — a plain global-declaring script in
// the browser, so its source can be inlined into the Function body the same way the
// brace-extracted index.html functions below are.
const nlParseSrc = readFileSync(join(ROOT, "nl_parse.js"), "utf8");

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
     extractFn("deviceParse"), extractFn("nlResolve"),
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

test("nlResolve: worker succeeds -> model result is used", async () => {
  const { nlResolve } = make("https://worker.example",
    async () => ({ ok: true, json: async () => ({ filter: { keywords: ["x"], agency: "DSNY" } }) }));
  const f = await nlResolve("sanitation rules", "rules");
  assert.equal(f.source, "model");
  assert.equal(f.agency, "DSNY");
});
