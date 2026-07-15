// Pins pastWinnersHTML()'s roll-up of chainHTML()'s own award-type stages into an
// at-a-glance "who won, when, for how much" strip (crol-list/w12-05).
//
// Before this fix: a reader could only learn who won each cycle of a recurring contract by
// opening chainHTML()'s stage-by-stage boxes one at a time and reading each one's vendor line.
// There was no single place that listed every cycle's awardee, year, and amount together.
//
// Fixtures below are real award rows queried live from the City Record dataset (SODA
// dg92-zbpx), not invented — same sourcing discipline as test/pin_chain.test.mjs and
// test/cadence_estimate.test.mjs.
//
//   node --test test/past_winners.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "index.html"), "utf8");
const i18nSrc = readFileSync(join(ROOT, "i18n.js"), "utf8");

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
function extractConst(name) {
  const m = src.match(new RegExp(`^const ${name} = .*$`, "m"));
  assert.ok(m, `const ${name} not found`);
  return m[0];
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t, tn } = new Function("window", i18nSrc + "\nreturn { t: window.t, tn: window.tn };")(windowStub);

const { pastWinnersHTML, chainHTML } = new Function(
  "t", "tn", "window",
  extractFn("cleanText") + extractFn("money") + extractFn("fdate") +
  extractConst("REQ_URL") + extractConst("EXT_ATTRS") + extractConst("extSR") +
  extractConst("pivotA") + extractConst("vendorHref") +
  extractFn("boxClass") +
  src.match(/const RENEWAL_SUFFIX_RE = [^;]*;/)[0] + extractFn("pinBase") +
  src.match(/const JUNK_PINS = new Set\(\[[^\]]*\]\);/)[0] + extractConst("JUNK_PIN_TEXT_RE") +
  extractFn("usablePin") +
  extractFn("pastWinnersHTML") +
  extractFn("chainHTML") +
  "return { pastWinnersHTML, chainHTML };"
)(t, tn, windowStub);

// Real 3-cycle chain, NYC DOE PIN base 04021B0003005 ("Assessments for Special Education
// Services") — same vendor across all three rounds (a name-variant LLC/PLLC suffix change in
// the last cycle), amounts shrinking each round.
const eduCycle2022 = {
  request_id: "20220520112", pin: "04021B0003005", agency_name: "Education",
  type_of_notice_description: "Award", short_title: "Assessments for Special Education Services",
  start_date: "2022-05-26", vendor_name: "The Perfect Playground OT PT & SLP LLC", contract_amount: "515252",
};
const eduCycle2024 = {
  request_id: "20241210007", pin: "04021B0003005R001", agency_name: "Education",
  type_of_notice_description: "Award", short_title: "B3275 - Assessments for Special Education",
  start_date: "2024-12-16", vendor_name: "The Perfect Playground OT PT & SLP LLC", contract_amount: "45690",
};
const eduCycle2026 = {
  request_id: "20260127005", pin: "04021B0003005R002", agency_name: "Education",
  type_of_notice_description: "Award", short_title: "B3275 - Assessments for Special Education",
  start_date: "2026-02-02", vendor_name: "The Perfect Playground OT PT & SLP PLLC", contract_amount: "29850",
};
const eduChain = [eduCycle2022, eduCycle2024, eduCycle2026];

// Real 3-stage chain, NYC DHS PIN base 07106R0045CNV ("Homeless Shelter") — the third stage
// (R002) is on record with NEITHER a vendor_name NOR a contract_amount field at all.
const dhsStage1 = {
  request_id: "20110513014", pin: "07106R0045CNVR001", agency_name: "Homeless Services",
  type_of_notice_description: "Award", short_title: "HOMELESS SHELTER",
  start_date: "2011-05-20", vendor_name: "CHILDREN`S AID SOCIETY", contract_amount: "459684",
};
const dhsStage2 = {
  request_id: "20110805014", pin: "07106R0045CNVR001", agency_name: "Homeless Services",
  type_of_notice_description: "Award", short_title: "TIER II HOMELESS SHELTER",
  start_date: "2011-08-12", vendor_name: "Milbank Housing Develop./ Children`s Aid Society", contract_amount: "459684",
};
const dhsStage3NoVendor = {
  request_id: "20120228020", pin: "07106R0045CNVR002", agency_name: "Homeless Services",
  type_of_notice_description: "Award", short_title: "HOMELESS SHELTER SERVICES",
  start_date: "2012-03-05",
  // vendor_name and contract_amount are absent from the live record, not just empty.
};
const dhsChain = [dhsStage1, dhsStage2, dhsStage3NoVendor];

test("pastWinnersHTML: a real multi-cycle chain lists every award's year, vendor, and amount", () => {
  const html = pastWinnersHTML(eduChain);
  assert.match(html, /Past winners/);
  assert.match(html, /2022/);
  assert.match(html, /2024/);
  assert.match(html, /2026/);
  assert.match(html, /The Perfect Playground OT PT & SLP LLC/);
  assert.match(html, /The Perfect Playground OT PT & SLP PLLC/);
  assert.match(html, /\$515K/);
  assert.match(html, /\$46K/);
  assert.match(html, /\$30K/);
});

test("pastWinnersHTML: lists the most recent cycle first", () => {
  const html = pastWinnersHTML(eduChain);
  const i2026 = html.indexOf("2026"), i2024 = html.indexOf("2024"), i2022 = html.indexOf("2022");
  assert.ok(i2026 < i2024 && i2024 < i2022, "expected 2026, then 2024, then 2022");
});

test("pastWinnersHTML: a stage with no vendor name shows 'Award, vendor unlisted' honestly, not omitted", () => {
  const html = pastWinnersHTML(dhsChain);
  // Before this fix, a stage lacking a vendor_name field had nothing to render it with at
  // all in a rolled-up summary — the honest fallback line stands in for it instead of
  // silently dropping the 2012 cycle.
  assert.match(html, /Award, vendor unlisted/);
  assert.match(html, /2012/);
  // The other two (named) cycles still show their real vendor.
  assert.match(html, /CHILDREN`S AID SOCIETY/);
  assert.match(html, /Milbank Housing Develop/);
});

test("pastWinnersHTML: a chain with only one award-type stage renders nothing — nothing to roll up yet", () => {
  assert.equal(pastWinnersHTML([eduCycle2022]), "");
});

test("pastWinnersHTML: a chain with no award-type stage (e.g. a bare Solicitation) renders nothing", () => {
  const solicitation = { ...eduCycle2022, type_of_notice_description: "Solicitation", vendor_name: null, contract_amount: null };
  assert.equal(pastWinnersHTML([solicitation]), "");
});

test("chainHTML: wires the past-winners strip into its own output for a multi-cycle chain", () => {
  const html = chainHTML(eduCycle2026, eduChain);
  assert.match(html, /Past winners/);
});

test("chainHTML: a single-notice chain gets no past-winners strip (nothing to roll up)", () => {
  const html = chainHTML(eduCycle2022, [eduCycle2022]);
  assert.doesNotMatch(html, /Past winners/);
});
