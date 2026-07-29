// Full-profile performance regression.
//
// A vendor-profile bucket is an edge read model: opening a profile may read that
// bucket, but it must not consult Socrata before the whole profile paints.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(ROOT, "index.html"), "utf8");

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

const RECENT = Array.from({ length: 15 }, (_, i) => ({
  request_id: `camba-${i + 1}`,
  start_date: `2026-07-${String(27 - i).padStart(2, "0")}`,
  agency_name: i % 2 ? "Homeless Services" : "Human Resources Administration",
  type_of_notice_description: "Award",
  short_title: `CAMBA notice ${i + 1}`,
  contract_amount: String((i + 1) * 1000),
}));

const CAMBA = {
  stem: "CAMBA",
  display: "Camba Inc.",
  variants: [{ name: "Camba Inc.", n: 271, total: 1946316522.9, first: "2007-09-14", last: "2026-07-27" }],
  awardCount: 271,
  total: 1946316522.9,
  first: "2007-09-14",
  last: "2026-07-27",
  topAgencies: [
    { name: "Human Resources Administration", n: 140, total: 1_100_000_000 },
    { name: "Homeless Services", n: 131, total: 846_316_522.9 },
  ],
  recentNotices: RECENT,
  forecasts: [{
    source: "checkbook",
    vendor_name: "Camba Inc.",
    agency_name: "Homeless Services",
    amount: 2_000_000,
    expiration_date: "2027-03-01",
  }],
};

const SPARSE = {
  stem: "SPARSE VENDOR",
  display: "Sparse Vendor LLC",
  variants: [{ name: "Sparse Vendor LLC", n: 1, total: 7500, first: "2020-01-02", last: "2020-01-02" }],
  awardCount: 1,
  total: 7500,
  first: "2020-01-02",
  last: "2020-01-02",
  topAgencies: [],
  recentNotices: [],
  forecasts: [],
};

function fakeBox() {
  let html = "";
  return {
    dataset: {},
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; },
    querySelector() { return null; },
  };
}

function makeHarness(bucketBody) {
  const box = fakeBox();
  const renders = [];
  const socrataRequests = [];
  const fallbackCalls = [];
  const workerFetch = async (path) => {
    assert.match(path, /^\/vendor-profile\?name=/);
    return new Response(JSON.stringify(bucketBody), {
      status: bucketBody?.ok ? 200 : 404,
      headers: { "Content-Type": "application/json" },
    });
  };
  const vendorStem = (name) => String(name).toUpperCase()
    .replace(/[.,]/g, "")
    .replace(/\s+(INC|LLC|CORPORATION)$/, "")
    .trim();
  const loadVendorProfileRecord = new Function(
    "workerFetch", "cleanText", "vendorStem",
    `${extractFn("loadVendorProfileRecord")}; return loadVendorProfileRecord;`,
  )(workerFetch, String, vendorStem);
  const renderVendorProfile = (_box, profile, details, _tab, hydrating) => {
    renders.push({ profile, details, hydrating });
    _box.dataset.vendorStem = profile.stem;
    _box.innerHTML = JSON.stringify({ details, hydrating });
  };
  const hydrateVendorProfile = async () => {
    socrataRequests.push("hydrate");
  };
  const showVendorLive = async (name) => {
    fallbackCalls.push(name);
    box.innerHTML = `LIVE_FALLBACK:${name}`;
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
    vendorStem,
    loadVendorProfileRecord,
    renderVendorProfile,
    hydrateVendorProfile,
    showVendorLive,
    () => {},
    (key) => key,
    () => {},
  );

  return { box, fallbackCalls, renders, showVendor, socrataRequests };
}

test("CAMBA paints its complete mocked bucket with zero live Socrata requests", async () => {
  const generated = "2026-07-27T13:00:00.000Z";
  const harness = makeHarness({ ok: true, generated, profile: CAMBA });

  await harness.showVendor("Camba Inc.");

  assert.equal(harness.socrataRequests.length, 0);
  assert.equal(harness.renders.length, 1);
  assert.equal(harness.renders[0].hydrating, false);
  assert.deepEqual(harness.renders[0].details.agencies, CAMBA.topAgencies);
  assert.deepEqual(harness.renders[0].details.rows, RECENT);
  assert.deepEqual(harness.renders[0].details.forecasts, CAMBA.forecasts);
  assert.equal(harness.renders[0].profile.asOf, generated);
  assert.doesNotMatch(harness.box.innerHTML, /loading|aria-busy/i);
});

test("a sparse precomputed vendor paints once without skeletons or live requests", async () => {
  const harness = makeHarness({
    ok: true,
    generated: "2026-07-27T13:00:00.000Z",
    profile: SPARSE,
  });

  await harness.showVendor("Sparse Vendor LLC");

  assert.equal(harness.socrataRequests.length, 0);
  assert.equal(harness.renders.length, 1);
  assert.equal(harness.renders[0].hydrating, false);
  assert.deepEqual(harness.renders[0].details.rows, []);
  assert.deepEqual(harness.renders[0].details.forecasts, []);
  assert.doesNotMatch(harness.box.innerHTML, /loading|aria-busy/i);
});

test("a missing bucket preserves the existing live fallback", async () => {
  const harness = makeHarness({ ok: false, reason: "missing-index" });

  await harness.showVendor("Missing Bucket Vendor LLC");

  assert.deepEqual(harness.fallbackCalls, ["Missing Bucket Vendor LLC"]);
  assert.equal(harness.box.innerHTML, "LIVE_FALLBACK:Missing Bucket Vendor LLC");
});
