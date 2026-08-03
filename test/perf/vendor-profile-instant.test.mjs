import { SITE_SOURCE } from "../helpers/site_source.mjs";
// Characterization/performance regression for vendor deep links.
//
// Fixtures are pinned from City Record Online (dg92-zbpx), measured 2026-07-27:
// CAMBA's exact normalized stem has nine published spellings, 271 award notices, and
// $1,946,316,522.90 awarded; CASTLE OIL CORPORATION has one spelling and six awards.
// The test mocks every network boundary so CI measures the render path, never Socrata.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = SITE_SOURCE;

function extractFn(name) {
  const asyncStart = src.indexOf(`async function ${name}(`);
  const start = asyncStart === -1 ? src.indexOf(`function ${name}(`) : asyncStart;
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const CAMBA_VARIANTS = [
  ["CAMBA", 3, 11800080, "2008-03-10", "2011-05-02"],
  ["Camba Inc.", 135, 1106326956.53, "2010-10-05", "2025-07-31"],
  ["Camba, Inc", 7, 85947407.33, "2016-01-28", "2020-11-04"],
  ["CAMBA Inc", 9, 147676229, "2026-05-13", "2026-07-27"],
  ["CAMBA  Inc", 17, 141415368.94, "2019-07-12", "2022-12-07"],
  ["CAMBA, Inc.", 92, 352563435.1, "2007-09-14", "2026-03-18"],
  ["CAMBA, Inc.,", 4, 9496422, "2012-06-13", "2022-06-06"],
  ["CAMBA. Inc.", 2, 61057155, "2015-09-03", "2021-07-21"],
  ["CAMBA., Inc.", 2, 30033469, "2010-05-12", "2022-07-08"],
].map(([name, n, total, first, last]) => ({ name, n, total, first, last }));

const CAMBA = {
  stem: "CAMBA",
  display: "Camba Inc.",
  variants: CAMBA_VARIANTS,
  awardCount: 271,
  total: 1946316522.9,
  first: "2007-09-14",
  last: "2026-07-27",
  topAgencies: [],
};

const CASTLE = {
  stem: "CASTLE OIL",
  display: "CASTLE OIL CORPORATION",
  variants: [{
    name: "CASTLE OIL CORPORATION",
    n: 6,
    total: 518146048,
    first: "2004-01-14",
    last: "2012-10-05",
  }],
  awardCount: 6,
  total: 518146048,
  first: "2004-01-14",
  last: "2012-10-05",
  topAgencies: [],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeBox() {
  const history = [];
  let html = "";
  return {
    history,
    dataset: {},
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; history.push(value); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function money(value) {
  const n = Number(value);
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${Math.round(n / 1e6)}M`;
  return `$${n.toLocaleString("en-US")}`;
}

function t(key, vars = {}) {
  if (key === "vendor_profile_variants") {
    return `${vars.n} name variant${vars.s}`;
  }
  return key;
}

function makeHarness(precomputed) {
  const box = fakeBox();
  const fallbackCalls = [];
  const headerHTML = new Function(
    "money", "fdate", "t", "cleanText",
    `${extractFn("renderVendorVariants")}; ${extractFn("vendorProfileHeaderHTML")}; return vendorProfileHeaderHTML;`,
  )(money, (value) => String(value || "").slice(0, 10), t, String);

  const renderVendorProfile = (_box, profile) => {
    _box.innerHTML = headerHTML(profile);
  };
  const loadVendorProfileRecord = async () => {
    await sleep(25);
    return precomputed;
  };
  const hydrateVendorProfile = async () => {};
  const showVendorLive = async (name, _initialTab, _box) => {
    fallbackCalls.push(name);
    _box.innerHTML = `LIVE_FALLBACK:${name}`;
  };

  const showVendor = new Function(
    "$", "showTab", "cleanText", "vendorStem", "loadVendorProfileRecord",
    "renderVendorProfile", "hydrateVendorProfile", "showVendorLive", "announce", "t",
    "focusItemRouteTarget",
    `${extractFn("showVendor")}; return showVendor;`,
  )(
    (selector) => selector === "#entityview" ? box : null,
    () => {},
    String,
    (name) => String(name).toUpperCase().replace(/\s+(INC|INC\.|CORPORATION)$/, ""),
    loadVendorProfileRecord,
    renderVendorProfile,
    hydrateVendorProfile,
    showVendorLive,
    () => {},
    t,
    () => {},
  );

  return { box, fallbackCalls, showVendor };
}

async function waitForHeader(box, pattern, budgetMs = 1000) {
  const started = performance.now();
  while (!pattern.test(box.innerHTML) && performance.now() - started < budgetMs) {
    await sleep(5);
  }
  return performance.now() - started;
}

test("CAMBA identity paints from the precomputed record within one second", async () => {
  const { box, showVendor } = makeHarness(CAMBA);
  const render = showVendor("Camba Inc.");
  const elapsed = await waitForHeader(box, /9 name variants/);

  assert.ok(elapsed < 1000, `identity header took ${elapsed.toFixed(1)}ms`);
  assert.match(box.innerHTML, /9 name variants/);
  assert.match(box.innerHTML, /\$1\.95B/);
  assert.match(box.innerHTML, />271</);
  assert.match(box.innerHTML, /2007-09-14/);
  assert.match(box.innerHTML, /2026-07-27/);
  assert.equal((box.innerHTML.match(/vendor-variant-item/g) || []).length, 9);
  assert.match(box.innerHTML, /<details[^>]*open/);
  assert.match(box.innerHTML, />Camba Inc\.<\/span> · <span class="vendor-variant-meta">135 · \$1\.11B/);
  assert.equal(box.history.some((html) => /resolving vendor/i.test(html)), false);
  await render;
});

test("single-variant vendors use the same immediate precomputed path", async () => {
  const { box, showVendor } = makeHarness(CASTLE);
  const render = showVendor("CASTLE OIL CORPORATION");
  const elapsed = await waitForHeader(box, /1 name variant(?!s)/);

  assert.ok(elapsed < 1000, `identity header took ${elapsed.toFixed(1)}ms`);
  assert.match(box.innerHTML, /1 name variant(?!s)/);
  assert.match(box.innerHTML, /\$518M/);
  assert.match(box.innerHTML, />6</);
  assert.doesNotMatch(box.innerHTML, /<details/);
  await render;
});

test("a missing precomputed record preserves the live resolver fallback", async () => {
  const { box, fallbackCalls, showVendor } = makeHarness(null);
  await showVendor("Missing Index Vendor LLC");

  assert.deepEqual(fallbackCalls, ["Missing Index Vendor LLC"]);
  assert.equal(box.innerHTML, "LIVE_FALLBACK:Missing Index Vendor LLC");
});
