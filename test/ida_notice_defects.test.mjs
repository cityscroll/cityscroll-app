// Characterization for the owner-reported IDA hearing defect cluster:
//   #notice/20250227021 (homepage demo "Past IDA meetings")
// 1) participation links: trailing-comma body URLs must collapse to one affordance
// 2) list + detail share the same participation derivation
// 3) contract lifecycle / OCP / PIN modules are category-gated off hearings
// 4) subsidy: City Record hearing derivation when Build NYC feed is empty
//
//   node --test test/ida_notice_defects.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeHearing } from "../worker/src/lib/hearings.mjs";
import {
  assembleSubsidyLifecycle,
  projectFromIdaNotice,
  isIdaHearingNotice,
} from "../worker/src/lib/subsidy_lifecycle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "site", "index.html"), "utf8");
const i18nSrc = readFileSync(join(ROOT, "site", "i18n.js"), "utf8");
const hearingLoc = readFileSync(join(ROOT, "site", "hearing_location.js"), "utf8");

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

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t, tn } = new Function("window", i18nSrc + "\nreturn { t: window.t, tn: window.tn };")(windowStub);

// Browser hearing normalizer (same contract as worker normalizeHearing)
const normalizeHearingRow = new Function(
  hearingLoc + "\nreturn normalizeHearingRow;",
)();

const EXT_ATTRS = 'target="_blank" rel="noopener noreferrer"';
const escUiHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const extSR = () => '<span class="sr-only"> (opens in new tab)</span>';

const ui = new Function(
  "t", "tn", "escUiHtml", "extSR", "EXT_ATTRS",
  extractFn("hearingSafeURL") +
  extractFn("participationLinksHTML") +
  extractFn("isContractLifecycleEligible") +
  "return { hearingSafeURL, participationLinksHTML, isContractLifecycleEligible };"
)(t, tn, escUiHtml, extSR, EXT_ATTRS);

// Live-shaped body for #notice/20250227021: same URL twice, once with trailing comma.
const IDA_BODY = `For those members of the public desiring to review project applications and cost
benefit analyses before the date of the hearing, copies of these materials will be made
available at: https://edc.nyc/nycida-board-meetings-public-hearings, starting on or about
12:00 P.M. fourteen (14) days prior to the hearing. Information regarding such removals will
be available on the Agency's website at https://edc.nyc/nycida-board-meetings-public-hearings
on or about 12:00 P.M. on the Friday preceding the hearing.
Company Name : NYM 145 Wolcott LLC, a Delaware limited liability company (the Company)`;

const IDA_ROW = {
  request_id: "20250227021",
  short_title: "IDA March 20th, 2025 Public Hearing Notice",
  agency_name: "Industrial Development Agency",
  type_of_notice_description: "Public Hearings",
  section_name: "Public Hearings and Meetings",
  event_date: "2025-03-20T10:00:00.000",
  start_date: "2025-02-27T00:00:00.000",
  additional_description_1: IDA_BODY,
  pin: null,
};

test("participation: trailing-comma duplicate URLs collapse to one IDA meetings link", () => {
  const worker = normalizeHearing(IDA_ROW);
  const browser = normalizeHearingRow(IDA_ROW);
  assert.equal(worker.participation.links.length, 1, "worker: one link");
  assert.equal(browser.participation.links.length, 1, "browser: one link");
  assert.equal(
    worker.participation.links[0].url,
    "https://edc.nyc/nycida-board-meetings-public-hearings",
  );
  assert.equal(worker.participation.links[0].label, "IDA meetings page");
  assert.equal(browser.participation.links[0].label, "IDA meetings page");
  assert.deepEqual(
    worker.participation.links.map((l) => l.url),
    browser.participation.links.map((l) => l.url),
    "list and detail share the same cleaned URL",
  );
});

test("participation: list and detail HTML use the same single affordance", () => {
  const record = normalizeHearing(IDA_ROW);
  const html = ui.participationLinksHTML(record);
  assert.match(html, /IDA meetings page/);
  assert.match(html, /href="https:\/\/edc\.nyc\/nycida-board-meetings-public-hearings"/);
  assert.equal((html.match(/class="act"/g) || []).length, 1);
  assert.doesNotMatch(html, /Participation link/);
});

test("category dispatch: contract lifecycle ineligible on hearings, rules, property, staffing", () => {
  assert.equal(ui.isContractLifecycleEligible(IDA_ROW), false);
  assert.equal(ui.isContractLifecycleEligible({
    section_name: "Agency Rules", type_of_notice_description: "Public Hearings",
  }), false);
  assert.equal(ui.isContractLifecycleEligible({
    section_name: "Property Disposition", type_of_notice_description: "Public Hearing",
  }), false);
  assert.equal(ui.isContractLifecycleEligible({
    section_name: "Changes in Personnel", type_of_notice_description: "Notice",
  }), false);
  assert.equal(ui.isContractLifecycleEligible({
    section_name: "Procurement", type_of_notice_description: "Award", pin: "123",
  }), true);
  assert.equal(ui.isContractLifecycleEligible({
    section_name: "", type_of_notice_description: "Solicitation",
  }), true);
  assert.equal(ui.isContractLifecycleEligible({
    section_name: "", type_of_notice_description: "Public Hearings",
  }), false);
});

test("subsidy: IDA hearing derives City Record hearing stage when project feed is empty", () => {
  assert.equal(isIdaHearingNotice(IDA_ROW), true);
  const derived = projectFromIdaNotice(IDA_ROW);
  assert.ok(derived);
  assert.equal(derived.project_id, "city-record:20250227021");
  assert.match(derived.company, /NYM 145 Wolcott/i);

  const [lifecycle] = assembleSubsidyLifecycle([IDA_ROW], []);
  assert.equal(lifecycle.join.matched, true);
  assert.equal(lifecycle.join.method, "city-record-hearing");
  assert.equal(lifecycle.join.source, "City Record");
  const hearing = lifecycle.timeline.find((e) => e.stage === "hearing");
  assert.equal(hearing.status, "matched");
  assert.equal(hearing.date, "2025-03-20");
  assert.equal(lifecycle.source_status, undefined);
});

test("subsidy: non-IDA notice stays unmatched when feed empty (class-b path)", () => {
  const [lifecycle] = assembleSubsidyLifecycle([{
    request_id: "x",
    short_title: "Parks award",
    agency_name: "Parks",
    type_of_notice_description: "Award",
  }], []);
  assert.equal(lifecycle.join.matched, false);
});
