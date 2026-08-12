import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Characterization: Money notice paper trail phase-group / aggregate / City Record dedupe.
//
//   node --test test/paper_trail_phase.test.mjs

import assert from "node:assert/strict";
import { constellationLink } from "../site/affordance_grammar.mjs";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PAPER_TRAIL_PHASES,
  mapNoticeTypeToPhase,
  aggregatePaperTrailNotices,
  isBlanketPaperTrail,
  countCityRecordLinkCandidates,
  buildPaperTrailPhaseView,
} from "../site/paper_trail_phase.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexSrc = SITE_SOURCE;
const i18nSrc = readFileSync(join(ROOT, "site", "i18n.js"), "utf8");

// Real Sanitation blanket-code chain — same-day multi-vendor awards under one PIN.
const blanketChain = [
  { request_id: "20140226007", pin: "82714CC00040", start_date: "2014-02-28", type_of_notice_description: "Award", short_title: "Demolition and carting services", contract_amount: "117636.5", vendor_name: "Abruzzi Contracting Inc." },
  { request_id: "20140226013", pin: "82714CC00040", start_date: "2014-02-28", type_of_notice_description: "Award", short_title: "Demolition and carting services", contract_amount: "12312", vendor_name: "Statewide Demolition Corp." },
  { request_id: "20140226004", pin: "82714CC00040", start_date: "2014-02-28", type_of_notice_description: "Award", short_title: "Demolition and carting services", contract_amount: "13500", vendor_name: "Cliffco II, Inc." },
  { request_id: "20140226019", pin: "82714CC00040", start_date: "2014-02-28", type_of_notice_description: "Award", short_title: "Demolition and carting services", contract_amount: "14850", vendor_name: "Gpd 90 Services Inc." },
  { request_id: "20140226012", pin: "82714CC00040", start_date: "2014-02-28", type_of_notice_description: "Award", short_title: "Demolition and carting services", contract_amount: "11970", vendor_name: "JRM Construction Corp." },
  { request_id: "20140226016", pin: "82714CC00040", start_date: "2014-02-28", type_of_notice_description: "Award", short_title: "Demolition and carting services", contract_amount: "12150", vendor_name: "Paul Toth Excavation, Inc." },
];

const multiStageChain = [
  { request_id: "S1", pin: "06823N0030001", start_date: "2023-01-10", type_of_notice_description: "Solicitation", short_title: "Housing Navigation", contract_amount: null, vendor_name: null },
  { request_id: "I1", pin: "06823N0030001", start_date: "2023-06-01", type_of_notice_description: "Intent to Award", short_title: "Housing Navigation", contract_amount: "15000000", vendor_name: "Anthos Home Inc" },
  { request_id: "R1", pin: "06823N0030001", start_date: "2023-08-17", type_of_notice_description: "Award", short_title: "Housing Navigation and Stabilization Services", contract_amount: "15458333.34", vendor_name: "Anthos Home Inc" },
  { request_id: "R2", pin: "06823N0030001R001", start_date: "2026-01-09", type_of_notice_description: "Award", short_title: "Housing Navigation and Stabilization Services", contract_amount: "16000000", vendor_name: "Anthos Home Inc" },
];

test("PAPER_TRAIL_PHASES follows solicitation → selection → award", () => {
  assert.deepEqual([...PAPER_TRAIL_PHASES], ["solicitation", "selection", "award"]);
});

test("mapNoticeTypeToPhase covers City Record notice types", () => {
  assert.equal(mapNoticeTypeToPhase("Solicitation"), "solicitation");
  assert.equal(mapNoticeTypeToPhase("Intent to Negotiate"), "selection");
  assert.equal(mapNoticeTypeToPhase("Vendor List"), "selection");
  assert.equal(mapNoticeTypeToPhase("Intent to Award"), "selection");
  assert.equal(mapNoticeTypeToPhase("Award"), "award");
});

test("aggregatePaperTrailNotices collapses same-day same-type awards", () => {
  const aggs = aggregatePaperTrailNotices(blanketChain);
  assert.equal(aggs.length, 1);
  assert.equal(aggs[0].count, 6);
  assert.equal(aggs[0].vendor_count, 6);
  assert.equal(aggs[0].first, "2014-02-28");
  assert.equal(aggs[0].last, "2014-02-28");
  assert.equal(aggs[0].members.length, 6);
});

test("isBlanketPaperTrail recognizes multi-vendor award pools", () => {
  assert.equal(isBlanketPaperTrail(blanketChain), true);
  assert.equal(isBlanketPaperTrail(multiStageChain), false);
});

test("countCityRecordLinkCandidates equals flat per-row link spam", () => {
  assert.equal(countCityRecordLinkCandidates(blanketChain), 6);
  assert.equal(countCityRecordLinkCandidates(multiStageChain), 4);
});

test("blanket PIN view: one default City Record link, award pool aggregate, current=award", () => {
  const opened = blanketChain[0];
  const view = buildPaperTrailPhaseView(blanketChain, opened);
  assert.equal(view.blanket, true);
  assert.equal(view.notice_count, 6);
  assert.equal(view.city_record_link_candidates, 6);
  assert.equal(view.default_city_record_links, 1);
  assert.equal(view.default_city_record_request_id, opened.request_id);
  assert.equal(view.current.phase_id, "award");
  const award = view.phases.find((p) => p.id === "award");
  assert.equal(award.state, "current");
  assert.equal(award.event_count, 6);
  assert.equal(award.aggregates.length, 1);
  assert.equal(award.aggregates[0].count, 6);
  // All members remain reachable for disclosure.
  assert.equal(award.aggregates[0].members.length, 6);
});

test("multi-stage chain groups solicitation / selection / award and sets next", () => {
  const opened = multiStageChain[2]; // Award
  const view = buildPaperTrailPhaseView(multiStageChain, opened);
  assert.equal(view.current.phase_id, "award");
  assert.equal(view.phases.find((p) => p.id === "solicitation")?.state, "passed");
  assert.equal(view.phases.find((p) => p.id === "selection")?.state, "passed");
  assert.equal(view.phases.find((p) => p.id === "award")?.event_count, 2);
  // Two award dates → two aggregates (not same-day pool).
  assert.equal(view.phases.find((p) => p.id === "award")?.aggregates.length, 2);
  assert.equal(view.next, null); // award is terminal on paper trail
});

test("public template uses phase spine surface and shared lc-phase chrome", () => {
  assert.match(indexSrc, /function paperTrailPhaseHTML/);
  assert.match(indexSrc, /buildPaperTrailPhaseView|paper_trail_phase/);
  assert.match(indexSrc, /lc-phase-stepper|lc-phase-lead/);
  assert.match(indexSrc, /paper_trail_open_notice/);
  assert.match(indexSrc, /function paintPaperTrail/);
  assert.match(indexSrc, /function chainHTMLFlat/);
});

test("i18n ships paper trail phase keys in English catalog", () => {
  assert.match(i18nSrc, /paper_trail_now_label:/);
  assert.match(i18nSrc, /paper_trail_phase_solicitation:/);
  assert.match(i18nSrc, /paper_trail_open_notice:/);
  assert.match(i18nSrc, /paper_trail_how_html:/);
});

// Render path with tools: default closed HTML has one City Record portal + disclosure members.
test("chainHTML with phase tools: one default City Record link for blanket pool", () => {
  function extractFn(name) {
    let start = indexSrc.indexOf("async function " + name + "(");
    if (start === -1) start = indexSrc.indexOf("function " + name + "(");
    assert.notEqual(start, -1, `function ${name} not found`);
    let depth = 0, seen = false;
    for (let j = indexSrc.indexOf("{", start); j < indexSrc.length; j++) {
      if (indexSrc[j] === "{") { depth++; seen = true; }
      else if (indexSrc[j] === "}" && --depth === 0 && seen) return indexSrc.slice(start, j + 1);
    }
    throw new Error(`unbalanced braces extracting ${name}`);
  }
  function extractConst(name) {
    const m = indexSrc.match(new RegExp(`^const ${name} = .*$`, "m"));
    assert.ok(m, `const ${name} not found`);
    return m[0];
  }

  const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
  const { t, tn } = new Function("window", i18nSrc + "\nreturn { t: window.t, tn: window.tn };")(windowStub);

  const tools = {
    buildPaperTrailPhaseView,
  };

  const { chainHTML } = new Function(
    "t", "tn", "window", "constellationLink",
    "const v=x=>escUiHtml(x);\n" +
    extractConst("RENEWAL_SUFFIX_RE") + extractFn("pinBase") +
    extractFn("cleanText") + extractFn("boxClass") + extractFn("money") + extractFn("fdate") +
    extractConst("REQ_URL") + extractConst("EXT_ATTRS") + extractConst("extSR") +
    extractConst("escUiHtml") + extractConst("pivotA") + extractConst("vendorHref") +
    indexSrc.match(/const JUNK_PINS = new Set\(\[[^\]]*\]\);/)[0] + extractConst("JUNK_PIN_TEXT_RE") +
    extractFn("usablePin") +
    extractFn("pastWinnersHTML") +
    extractFn("daysBetween") +
    extractConst("CADENCE_MIN_AWARDS") + extractConst("CADENCE_MIN_GAP_DAYS") + extractConst("CADENCE_MAX_GAP_RATIO") +
    extractConst("CADENCE_YEAR_THRESHOLD_MONTHS") +
    extractFn("isBlanketChain") + extractFn("cadenceEstimate") + extractFn("cadenceMonthYear") +
    extractFn("cadenceApart") + extractFn("cadenceHTML") +
    extractFn("paperTrailPhaseLabel") +
    extractFn("paperTrailMemberRowHTML") +
    extractFn("paperTrailAggregateHTML") +
    extractFn("paperTrailPhasePanelHTML") +
    extractFn("paperTrailPhaseStepperHTML") +
    extractFn("paperTrailPhaseHTML") +
    extractFn("chainHTMLFlat") +
    extractFn("chainHTML") +
    "return { chainHTML };"
  )(t, tn, windowStub, constellationLink);

  const opened = blanketChain[0];
  const html = chainHTML(opened, blanketChain, tools);
  // One portal-class City Record link for the opened notice (default chrome).
  const portalLinks = html.match(/class="view lc-phase-portal"/g) || [];
  assert.equal(portalLinks.length, 1);
  assert.match(html, /RequestDetail\/20140226007/);
  // Aggregate pool, not 6 equal stage boxes.
  assert.match(html, /lc-phase-count|>×6</);
  assert.match(html, /paper_trail_pool|Award pool|pool/i);
  // Member City Record links live inside disclosure lists (not default equal boxes).
  assert.match(html, /lc-phase-dates/);
  assert.match(html, /data-pt-dates/);
  // Action lead present.
  assert.match(html, /lc-phase-lead/);
  assert.match(html, /lc-phase-action/);
});
