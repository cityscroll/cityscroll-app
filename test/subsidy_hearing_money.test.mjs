// Build NYC money integrity: parse Total Project / Development Cost from City Record
// hearing bodies, and never claim "city does not publish" when the structured feed
// was simply not joined (city-record-hearing fallback / feed unavailable).
//
// Demo notice: 20220525018 (Global Wood $10,667,606 Total Project Cost;
// St. Ann's Meat $2,900,000 Total Development Cost).
//
//   node --test test/subsidy_hearing_money.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  assembleSubsidyLifecycle,
  parseHearingMoneyFromBody,
  projectFromIdaNotice,
} from "../worker/src/lib/subsidy_lifecycle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = JSON.parse(
  readFileSync(
    join(ROOT, "worker/test/fixtures/subsidy-hearing-money/20220525018.json"),
    "utf8",
  ),
);

const src = readFileSync(join(ROOT, "site", "index.html"), "utf8");
const i18nSrc = readFileSync(join(ROOT, "site", "i18n.js"), "utf8");

function extractFn(name) {
  let start = src.indexOf("async function " + name + "(");
  if (start === -1) start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found`);
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
const { t } = new Function("window", i18nSrc + "\nreturn { t: window.t };")(windowStub);

function money(n) {
  if (n == null || !Number.isFinite(+n)) return null;
  const v = +n;
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(0) + "K";
  return "$" + v.toFixed(0);
}
function fdate(s) { return s ? String(s).slice(0, 10) : ""; }
function cleanText(s) { return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function escUiHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const { subsidyLifecycleHTML, lifecycleMoney } = new Function(
  "t", "money", "fdate", "cleanText", "escUiHtml",
  `
  const extSR = () => '<span class="sr-only"> (opens in new tab)</span>';
  const EXT_ATTRS = 'target="_blank" rel="noopener noreferrer"';
  ` +
  extractFn("lifecycleMoney") +
  extractFn("subsidyStageLabel") +
  extractConst("SUBSIDY_STAGE_EXPECT_LAG_DAYS") +
  extractFn("subsidyLagWeeks") +
  extractFn("subsidyDaysSince") +
  extractFn("subsidyGapKindClient") +
  extractFn("subsidyAnchorFromNotice") +
  extractFn("subsidyStageHTML") +
  extractFn("subsidyPhaseLabel") +
  extractFn("subsidyPhaseActionHTML") +
  extractFn("subsidyPhaseStepperHTML") +
  extractFn("subsidyPhaseNotYetHTML") +
  extractFn("subsidyPhasePanelHTML") +
  extractFn("subsidyPhaseTimelineHTML") +
  extractFn("subsidyLifecycleHTMLFlat") +
  extractFn("subsidyJoinAndFieldChrome") +
  extractFn("subsidyLifecycleHTML") +
  `
  return { subsidyLifecycleHTML, lifecycleMoney };
  `,
)(t, money, fdate, cleanText, escUiHtml);

test("parseHearingMoneyFromBody: Total Project Cost and Total Development Cost", () => {
  const text = "Type of Benefits : PILOT. Total Project Cost : $10,667,606. Jobs : 8. "
    + "Total Development Cost: $2,900,000. Jobs: 57.";
  const parsed = parseHearingMoneyFromBody(text);
  assert.equal(parsed.total_project_cost, 10667606);
  assert.equal(parsed.total_development_cost, 2900000);
  assert.equal(parsed.estimated_cost.status, "matched");
  assert.equal(parsed.estimated_cost.value, 10667606);
  assert.equal(parsed.estimated_cost.field, "total_project_cost");
  assert.equal(parsed.estimated_cost.source, "city-record-hearing");
  assert.equal(parsed.costs.length, 2);
});

test("parseHearingMoneyFromBody: development-only falls back as the money cost field", () => {
  const parsed = parseHearingMoneyFromBody("Total Development Cost: $1,250,000.");
  assert.equal(parsed.total_project_cost, null);
  assert.equal(parsed.total_development_cost, 1250000);
  assert.equal(parsed.estimated_cost.value, 1250000);
  assert.equal(parsed.estimated_cost.field, "total_development_cost");
});

test("parseHearingMoneyFromBody: absent costs stay unknown without claiming withhold", () => {
  const parsed = parseHearingMoneyFromBody("Company Name : Example LLC. No dollar lines.");
  assert.equal(parsed.estimated_cost.status, "unknown");
  assert.equal(parsed.estimated_cost.value, null);
  assert.match(parsed.estimated_cost.reason, /no Total Project Cost/i);
});

test("demo 20220525018: projectFromIdaNotice parses non-null total project cost", () => {
  const derived = projectFromIdaNotice(DEMO);
  assert.ok(derived);
  assert.equal(derived._derived_from, "city-record-hearing");
  assert.equal(derived.estimated_cost.status, "matched");
  assert.equal(derived.estimated_cost.value, 10667606);
  assert.equal(derived.total_project_cost, 10667606);
  assert.equal(derived.total_development_cost, 2900000);
  assert.ok(derived.hearing_costs.length >= 2);
  assert.match(derived.company, /Global Wood/i);
});

test("demo 20220525018: assembleSubsidyLifecycle money is matched (not null seam)", () => {
  const [lc] = assembleSubsidyLifecycle([DEMO], []);
  assert.equal(lc.join.matched, true);
  assert.equal(lc.join.method, "city-record-hearing");
  assert.equal(lc.money.estimated_cost.status, "matched");
  assert.equal(lc.money.estimated_cost.value, 10667606);
  assert.equal(lc.money.total_project_cost, 10667606);
  assert.equal(lc.money.total_development_cost, 2900000);
});

test("UI: city-record-hearing with parsed cost shows amount, never false not-published money label", () => {
  const [lc] = assembleSubsidyLifecycle([DEMO], []);
  // Simulate feed-down path the worker stamps when EDC is unreachable.
  lc.join = { ...lc.join, feed_status: "unavailable", feed_note: "Build NYC document feed unreachable" };
  const html = subsidyLifecycleHTML(lc, DEMO);
  assert.match(html, /total project cost/i);
  assert.match(html, /\$10\.67M|\$10,667,606|\$10667606/i);
  assert.match(html, /City Record hearing notice/i);
  assert.match(html, /Could not reach/i);
  assert.doesNotMatch(html, /does not publish this .* on the Build NYC record/i);
  assert.doesNotMatch(html, /does not publish this estimated public cost/i);
});

test("UI: city-record-hearing without body cost uses not-yet-ingested, not withheld", () => {
  const row = {
    request_id: "20231004016",
    short_title: "NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY - NOTICE OF PUBLIC HEARING",
    agency_name: "Industrial Development Agency",
    type_of_notice_description: "Public Hearings",
    section_name: "Public Hearings and Meetings",
    event_date: "2023-11-02T10:00:00.000",
    start_date: "2023-10-19T00:00:00.000",
    additional_description_1: "Company Name : Example Holdings LLC, a Delaware limited liability company (the Company)",
  };
  const [lc] = assembleSubsidyLifecycle([row], []);
  lc.join = { ...lc.join, feed_status: "unavailable" };
  assert.equal(lc.money.estimated_cost.status, "unknown");
  const html = subsidyLifecycleHTML(lc, row);
  assert.match(html, /Not yet shown here/);
  assert.doesNotMatch(html, /does not publish this .* on the Build NYC record/i);
});

test("UI: real Build NYC match with blank money still uses class (b) not-published", () => {
  const html = subsidyLifecycleHTML({
    join: { matched: true, method: "request_id", source: "Build NYC" },
    project: { id: "BND-1", name: "Sample", company: "Co" },
    company: { status: "matched", value: "Co" },
    place: { status: "matched", boroughs: ["Brooklyn"], addresses: [], bbls: [] },
    money: {
      requested_benefit: { status: "unknown" },
      estimated_cost: { status: "unknown" },
    },
    stage: "hearing",
    timeline: [],
  }, { request_id: "x", short_title: "Sample" });
  assert.match(html, /does not publish this .* on the Build NYC record/i);
  assert.doesNotMatch(html, /Not yet shown here — .* figures live in/i);
});
