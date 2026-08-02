// Characterization tests for the notice-detail procurement lifecycle stitch:
// contract timeline + dollars panel, subsidy lifecycle, council meeting outcomes,
// and prior-award history — each with real joined field cases and explicit gap
// statements (never a blank "unknown" slot).
//
//   node --test test/procurement_lifecycle_stitch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  assembleSubsidyLifecycle,
  parseNYCIDAProjects,
} from "../worker/src/lib/subsidy_lifecycle.mjs";
import { buildMeetingOutcomes } from "../worker/src/lib/meeting_outcomes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "site", "index.html"), "utf8");
const i18nSrc = readFileSync(join(ROOT, "site", "i18n.js"), "utf8");

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

// Minimal stubs shared by extracted render helpers.
function money(n) {
  if (n == null || !Number.isFinite(+n)) return null;
  const v = +n;
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(0) + "K";
  return "$" + v.toFixed(0);
}
function fdate(s) {
  if (!s) return "";
  return String(s).slice(0, 10);
}
function cleanText(s) { return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function vendorStem(name) {
  return cleanText(name).toUpperCase().replace(/[.,'’&]/g, " ").replace(/\s+/g, " ").trim();
}
function escUiHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const sandbox = new Function(
  "t", "tn", "window", "money", "fdate", "cleanText", "vendorStem", "escUiHtml",
  extractConst("escUiHtml").replace(/^const escUiHtml = /, "const escUiHtmlLocal = ") + "\n" +
  // Prefer the real extracted escUiHtml if present; fall back to injected one.
  "const _esc = (typeof escUiHtmlLocal === 'function') ? escUiHtmlLocal : escUiHtml;\n" +
  extractConst("extSR") + "\n" +
  extractConst("REQ_URL") + "\n" +
  extractConst("EXT_ATTRS") + "\n" +
  extractConst("CHECKBOOK_SEARCH_URL") + "\n" +
  extractConst("CHECKBOOK_SPENDING_URL") + "\n" +
  extractConst("CHECKBOOK_SMART_SEARCH") + "\n" +
  extractConst("PASSPORT_CONTRACTS_URL") + "\n" +
  extractConst("PASSPORT_RFX_URL") + "\n" +
  extractConst("LIFECYCLE_STAGE_ORDER") + "\n" +
  extractConst("CURRENT_SOLICITATIONS_URL") + "\n" +
  extractConst("CITY_RECORD_GETFILE_URL") + "\n" +
  extractConst("OCP_AWARDS_URL") + "\n" +
  extractFn("checkbookSearchUrl") + "\n" +
  extractFn("lifecycleStageLabel") + "\n" +
  extractFn("lifecycleAmount") + "\n" +
  extractFn("lifecycleMoney") + "\n" +
  extractFn("lifecycleSourceName") + "\n" +
  extractFn("lifecycleGapSourceName") + "\n" +
  extractFn("lifecycleHasLaterMatched") + "\n" +
  extractFn("lifecyclePublicStatus") + "\n" +
  extractFn("lifecycleMatchedRegisteredDetail") + "\n" +
  extractConst("LIFECYCLE_DOLLARS_ANCHOR") + "\n" +
  extractFn("lifecycleDollarsFocusHref") + "\n" +
  extractFn("lifecyclePaymentState") + "\n" +
  extractFn("lifecycleResolvedPayment") +
  extractFn("lifecycleTermEnded") +
  extractFn("lifecycleCommittedUnderrun") + "\n" +
  extractFn("lifecyclePaymentSummaryHTML") + "\n" +
  extractFn("lifecycleSourceLink") + "\n" +
  extractFn("lifecycleDocumentsHTML") + "\n" +
  extractFn("lifecycleCurrentStageKey") + "\n" +
  extractFn("lifecycleStepperHTML") + "\n" +
  extractFn("lifecycleStageHTML") + "\n" +
  extractFn("lifecycleOcpAwardHTML") + "\n" +
  extractFn("lifecycleTimelineHTML") + "\n" +
  extractFn("lifecycleDollarsHTML") + "\n" +
  extractConst("VENDOR_SUFFIX") + "\n" +
  extractFn("vendorStem") + "\n" +
  extractFn("vendorNamesMatch") + "\n" +
  extractFn("isSubsidyEligibleNotice") + "\n" +
  extractFn("subsidyStageLabel") + "\n" +
  extractConst("SUBSIDY_STAGE_EXPECT_LAG_DAYS") + "\n" +
  extractFn("subsidyLagWeeks") + "\n" +
  extractFn("subsidyDaysSince") + "\n" +
  extractFn("subsidyGapKindClient") + "\n" +
  extractFn("subsidyAnchorFromNotice") + "\n" +
  extractFn("subsidyStageHTML") + "\n" +
  extractFn("subsidyLifecycleHTML") + "\n" +
  extractFn("isMeetingOutcomesEligible") + "\n" +
  extractFn("isCityCouncilNotice") + "\n" +
  extractFn("matterDetailUrl") + "\n" +
  extractFn("nonCouncilBodyLinks") + "\n" +
  extractFn("nonCouncilWhereHTML") + "\n" +
  extractFn("nonCouncilStageLabel") + "\n" +
  extractFn("nonCouncilHearingOutcomesHTML") + "\n" +
  extractFn("meetingOutcomeBucket") + "\n" +
  extractFn("meetingMatterShortTitle") + "\n" +
  extractFn("collapseMeetingAgenda") + "\n" +
  extractFn("meetingVotesHTML") + "\n" +
  extractFn("meetingOutcomesHTML") + "\n" +
  extractFn("priorCycleHTML") + "\n" +
  extractFn("priorCycleNoneHTML") + "\n" +
  // priorCycleHTML needs fdate/money/pivotA/agencyWho-ish helpers — provide pivots as identity.
  "function pivotA(href, text){ return '<a href=\"'+href+'\">'+text+'</a>'; }\n" +
  "function agencyWho(a){ return a; }\n" +
  "function noticeLink(id){ return '#notice/'+id; }\n" +
  "return {\n" +
  "  lifecycleTimelineHTML, lifecycleDollarsHTML, isSubsidyEligibleNotice,\n" +
  "  subsidyLifecycleHTML, isMeetingOutcomesEligible, meetingOutcomesHTML,\n" +
  "  priorCycleHTML, priorCycleNoneHTML\n" +
  "};"
);

let helpers;
try {
  helpers = sandbox(t, tn, windowStub, money, fdate, cleanText, vendorStem, escUiHtml);
} catch (err) {
  // Fallback: extract with simpler sandbox that injects all deps as args
  const simple = new Function(
    "t", "tn", "money", "fdate", "cleanText", "vendorStem", "escUiHtml",
    `
    const extSR = () => '<span class="sr-only"> (opens in new tab)</span>';
    const REQ_URL = (id) => 'https://a856-cityrecord.nyc.gov/RequestDetail/' + encodeURIComponent(id);
    const EXT_ATTRS = 'target="_blank" rel="noopener noreferrer"';
    const CHECKBOOK_SEARCH_URL = 'https://www.checkbooknyc.com/contract_search';
    const CHECKBOOK_SPENDING_URL = 'https://www.checkbooknyc.com/spending_search';
    const CHECKBOOK_SMART_SEARCH = 'https://www.checkbooknyc.com/smart_search/citywide';
    const PASSPORT_CONTRACTS_URL = 'https://a0333-passportpublic.nyc.gov/contracts.html';
    const PASSPORT_RFX_URL = 'https://a0333-passportpublic.nyc.gov/rfx.html';
    const LIFECYCLE_STAGE_ORDER = {
      solicitation:0, intent_to_negotiate:1, vendor_list:2, intent_to_award:3,
      award:4, pending:5, registered:6, payment:7,
    };
    const CURRENT_SOLICITATIONS_URL = 'https://data.cityofnewyork.us/d/3khw-qi8f';
    const CITY_RECORD_GETFILE_URL = 'https://a856-cityrecord.nyc.gov/Search/GetFile';
    const OCP_AWARDS_URL = 'https://data.cityofnewyork.us/d/qyyg-4tf5';
    function pivotA(href, text){ return '<a href="'+href+'">'+text+'</a>'; }
    ` +
    extractFn("checkbookSearchUrl") +
    extractFn("lifecycleStageLabel") +
    extractFn("lifecycleAmount") +
    extractFn("lifecycleMoney") +
    extractFn("lifecycleSourceName") +
    extractFn("lifecycleGapSourceName") +
    extractFn("lifecycleHasLaterMatched") +
    extractFn("lifecyclePublicStatus") +
    extractFn("lifecycleMatchedRegisteredDetail") +
    extractConst("LIFECYCLE_DOLLARS_ANCHOR") +
    extractFn("lifecycleDollarsFocusHref") +
    extractFn("lifecyclePaymentState") +
    extractFn("lifecycleResolvedPayment") +
  extractFn("lifecycleTermEnded") +
  extractFn("lifecycleCommittedUnderrun") +
    extractFn("lifecyclePaymentSummaryHTML") +
    extractFn("lifecycleSourceLink") +
    extractFn("lifecycleDocumentsHTML") +
    extractFn("lifecycleCurrentStageKey") +
    extractFn("lifecycleStepperHTML") +
    extractFn("lifecycleStageHTML") +
    extractFn("lifecycleOcpAwardHTML") +
    extractFn("lifecycleTimelineHTML") +
    extractFn("lifecycleDollarsHTML") +
    extractConst("VENDOR_SUFFIX") +
    extractFn("vendorStem") +
    extractFn("vendorNamesMatch") +
    extractFn("isSubsidyEligibleNotice") +
    extractFn("subsidyStageLabel") +
    extractConst("SUBSIDY_STAGE_EXPECT_LAG_DAYS") +
    extractFn("subsidyLagWeeks") +
    extractFn("subsidyDaysSince") +
    extractFn("subsidyGapKindClient") +
    extractFn("subsidyAnchorFromNotice") +
    extractFn("subsidyStageHTML") +
    extractFn("subsidyLifecycleHTML") +
    extractFn("isMeetingOutcomesEligible") +
    extractFn("isCityCouncilNotice") +
    extractFn("matterDetailUrl") +
    extractFn("nonCouncilBodyLinks") +
    extractFn("nonCouncilWhereHTML") +
    extractFn("nonCouncilStageLabel") +
    extractFn("nonCouncilHearingOutcomesHTML") +
    extractFn("meetingOutcomeBucket") +
    extractFn("meetingMatterShortTitle") +
    extractFn("collapseMeetingAgenda") +
    extractFn("meetingVotesHTML") +
    extractFn("meetingOutcomesHTML") +
    `
    return {
      lifecycleTimelineHTML, lifecycleDollarsHTML, isSubsidyEligibleNotice,
      subsidyLifecycleHTML, isMeetingOutcomesEligible, meetingOutcomesHTML
    };
    `
  );
  helpers = simple(t, tn, money, fdate, cleanText, vendorStem, escUiHtml);
}

const {
  lifecycleTimelineHTML,
  lifecycleDollarsHTML,
  isSubsidyEligibleNotice,
  subsidyLifecycleHTML,
  isMeetingOutcomesEligible,
  meetingOutcomesHTML,
} = helpers;

// ---------------------------------------------------------------------------
// Real joined field case: HNTB award 20260623008 / PIN 84124P0003001
// Captured from production contract-lifecycle 2026-07-30.
// ---------------------------------------------------------------------------

const HNTB_NOTICE = {
  request_id: "20260623008",
  agency_name: "Transportation",
  type_of_notice_description: "Award",
  short_title: "TD/CSS for 21st Ave Bridge Over NYCTA-BMT Sea Beach Line (BIN 2-24371-0), Brooklyn",
  pin: "84124P0003001",
  vendor_name: "HNTB New York Engineering and Architecture, P.C.",
  contract_amount: "13533763",
};

const HNTB_LIFECYCLE = {
  pin: "84124P0003001",
  pin_strategy: "exact",
  ok: true,
  amendments: [],
  timeline: [
    {
      stage: "award",
      status: "matched",
      source: "city-record",
      date: "2026-06-29",
      detail: {
        request_id: "20260623008",
        agency: "Transportation",
        title: HNTB_NOTICE.short_title,
        pin: "84124P0003001",
        vendor: "HNTB New York Engineering and Architecture, P.C.",
        amount: 13533763,
      },
    },
    { stage: "pending", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
    {
      stage: "registered",
      status: "matched",
      source: "checkbook-contracts",
      date: "2026-06-22",
      detail: {
        contract_id: "CT184120268807929",
        vendor: "HNTB NEW YORK ENGINEERING ARCHITECTURE AND LANDSCAPE ARCHITE",
        registration_date: "2026-06-22",
        original_amount: 13533763.08,
        current_amount: 13533763.08,
        spent_to_date: 0,
        start_date: "2024-10-11",
        end_date: "2032-10-10",
        mwbe: "Non-M/WBE",
      },
    },
    {
      stage: "payment",
      status: "matched",
      source: "checkbook-spending",
      date: null,
      detail: {
        total_payments: null,
        total_spent: 0,
        derived_from: "registered",
        payment_state: "verified_zero",
      },
    },
  ],
};

test("procurement detail: HNTB lifecycle fills award + registration; pending/payment are coherent", () => {
  const html = lifecycleTimelineHTML(HNTB_LIFECYCLE, HNTB_NOTICE);
  assert.match(html, /Contract lifecycle/);
  assert.match(html, /Award/);
  assert.match(html, /Registered contract/);
  assert.match(html, /CT184120268807929|13\.53M|\$13/);
  // Stage succession: pending is passed when registered is matched (not not-yet-shown)
  assert.match(html, /Passed — the contract has registered/);
  assert.doesNotMatch(html, /Not yet shown here — pending contracts live in/);
  // Transient-error register never surfaces on notice detail
  assert.doesNotMatch(html, /Could not reach/);
  assert.doesNotMatch(html, />unknown</i);
});

test("procurement detail: dollars panel uses precomputed registration, not a blank", () => {
  const html = lifecycleDollarsHTML(HNTB_LIFECYCLE, HNTB_NOTICE);
  assert.match(html, /Follow the dollars/);
  assert.match(html, /CT184120268807929/);
  assert.match(html, /Paid to date/);
  assert.doesNotMatch(html, /Could not reach/);
  assert.match(html, /Payments lag|payment|spending/i);
});

// ---------------------------------------------------------------------------
// Subsidy: matched fixture case + unmatched real IDA hearing
// ---------------------------------------------------------------------------

const subsidyProjects = parseNYCIDAProjects([
  {
    request_id: "20260010001",
    project_id: "BND-1001",
    project_name: "East River Redevelopment Subsidy",
    company_name: "Apex Urban Builders LLC",
    project_address: "230 E 20th St, Manhattan, NY",
    requested_benefit_amount: "15000000",
    estimated_public_cost: "32000000",
    application_date: "2025-01-12",
    application_status: "application accepted",
    application_url: "https://edc.nyc/records/10001/application.pdf",
    hearing_date: "2025-02-03",
    hearing_outcome: "held",
    board_decision_date: "2025-03-14",
    board_decision_outcome: "approved",
    board_body: "NYC Industrial Development Agency",
    closing_date: "2025-06-04",
    closing_status: "award package approved",
    closing_amount: "15000000",
    compliance_date: "2026-06-30",
    compliance_status: "annual report submitted",
  },
]);

const matchedSubsidy = assembleSubsidyLifecycle(
  [{ request_id: "20260010001", short_title: "East River Redevelopment Subsidy Application", vendor_name: "Apex Urban Builders LLC" }],
  subsidyProjects,
)[0];

// Non-IDA notice so city-record hearing derivation does not auto-match.
const unmatchedSubsidy = assembleSubsidyLifecycle(
  [{
    request_id: "20260101099",
    short_title: "Parks concession award — no subsidy project link",
    agency_name: "Parks and Recreation",
    type_of_notice_description: "Award",
  }],
  [],
)[0];

// Young IDA hearing: City Record hearing join; later stages too_soon (not unavailable).
const youngIdaSubsidy = assembleSubsidyLifecycle(
  [{
    request_id: "20260617040",
    short_title: "NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY - NOTICE OF PUBLIC HEARING - July 16th, 2026",
    agency_name: "Industrial Development Agency",
    type_of_notice_description: "Public Hearings",
    section_name: "Public Hearings and Meetings",
    event_date: "2026-07-16T10:00:00.000",
    start_date: "2026-07-02T00:00:00.000",
    additional_description_1: "Company Name : Young Co LLC, a Delaware limited liability company (the Company)",
  }],
  [],
)[0];

test("subsidy eligible: IDA and Build NYC agencies qualify", () => {
  assert.equal(isSubsidyEligibleNotice({ agency_name: "Industrial Development Agency" }), true);
  assert.equal(isSubsidyEligibleNotice({ agency_name: "Build NYC Resource Corporation" }), true);
  assert.equal(isSubsidyEligibleNotice({ agency_name: "Economic Development Corporation" }), true);
  assert.equal(isSubsidyEligibleNotice({ agency_name: "Transportation", short_title: "Bridge" }), false);
});

test("subsidy detail: matched project renders stage, action, and outcome", () => {
  const html = subsidyLifecycleHTML(matchedSubsidy, { request_id: "20260010001", short_title: "East River" });
  assert.match(html, /Subsidy lifecycle/);
  assert.match(html, /East River Redevelopment/);
  assert.match(html, /Apex Urban Builders/);
  assert.match(html, /Application|Hearing|Board decision|Closing|Compliance/);
  assert.match(html, /Official action|Outcome/i);
});

test("subsidy detail: unmatched non-IDA notice renders specific gap, never generic unknown", () => {
  const notice = {
    request_id: "20260101099",
    short_title: "Parks concession award — no subsidy project link",
  };
  assert.equal(unmatchedSubsidy.join.matched, false);
  const html = subsidyLifecycleHTML(unmatchedSubsidy, notice);
  assert.match(html, /Subsidy lifecycle/);
  assert.match(html, /does not publish a linked subsidy project for/);
  assert.match(html, /20260101099|Parks concession|would appear on the Build NYC|No matching NYCIDA/i);
  assert.doesNotMatch(html, />\s*unknown\s*</i);
});

test("subsidy detail: young IDA hearing joins City Record hearing; later stages not unavailable", () => {
  assert.equal(youngIdaSubsidy.join.matched, true);
  assert.equal(youngIdaSubsidy.join.method, "city-record-hearing");
  const html = subsidyLifecycleHTML(youngIdaSubsidy, {
    request_id: "20260617040",
    short_title: "NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY - NOTICE OF PUBLIC HEARING - July 16th, 2026",
    event_date: "2026-07-16T10:00:00.000",
  });
  assert.match(html, /Subsidy lifecycle/);
  assert.match(html, /Hearing|Linked project/i);
  assert.doesNotMatch(html, /Could not reach/i);
});

test("subsidy detail: feed_status=unavailable never uses city-does-not-publish for later stages", () => {
  // Production shape for aged City Record hearing joins when Build NYC feed is down.
  const feedDown = {
    ...youngIdaSubsidy,
    join: {
      ...youngIdaSubsidy.join,
      feed_status: "unavailable",
      feed_note: "Build NYC document feed unreachable; hearing stage from City Record notice.",
    },
    timeline: (youngIdaSubsidy.timeline || []).map((entry) => {
      if (!entry || entry.status === "matched") return entry;
      // Force aged class-(b) that production used to emit; UI must remap.
      return { ...entry, gap_kind: "not_published" };
    }),
  };
  // Anchor as aged so client gap helper would also prefer not_published without the feed gate.
  const html = subsidyLifecycleHTML(feedDown, {
    request_id: "20220525018",
    short_title: "NYCIDA SUPPLEMENTAL NOTICE OF PUBLIC HEARING",
    event_date: "2022-06-09T10:00:00.000",
  });
  assert.match(html, /Subsidy lifecycle/);
  assert.match(html, /Not yet shown here/);
  assert.match(html, /data-subsidy-gap="not_yet_ingested"/);
  assert.doesNotMatch(html, /The city does not publish this Board decision/i);
  assert.doesNotMatch(html, /The city does not publish this Closing/i);
  assert.doesNotMatch(html, /The city does not publish this Compliance/i);
  assert.match(html, /Could not reach/i);
});

// ---------------------------------------------------------------------------
// Council meeting outcomes: matched + unmatched
// ---------------------------------------------------------------------------

const meetingFixture = JSON.parse(
  readFileSync(join(ROOT, "test/contract/fixtures/meeting_outcomes.json"), "utf8"),
);

test("meeting outcomes eligible: hearing notices qualify", () => {
  assert.equal(isMeetingOutcomesEligible({
    section_name: "Public Hearings and Meetings",
  }), true);
  assert.equal(isMeetingOutcomesEligible({
    section_name: "Agency Rules",
    type_of_notice_description: "Public Hearings",
  }), true);
  assert.equal(isMeetingOutcomesEligible({
    section_name: "Procurement",
    type_of_notice_description: "Award",
  }), false);
});

test("meeting outcomes: matter-centric agenda shows badge, summary, and vote counts", () => {
  const model = buildMeetingOutcomes(
    meetingFixture.notices,
    meetingFixture.events,
    meetingFixture.event_items,
    meetingFixture.votes,
    meetingFixture.attachments,
  );
  const record = model.records[0];
  assert.equal(record.join.matched, true);
  const html = meetingOutcomesHTML(record);
  assert.match(html, /Council meeting outcomes/);
  // One scan row per matter (not one four-stage chain per Legistar action).
  assert.equal((html.match(/data-meeting-matter/g) || []).length, 1);
  assert.equal((html.match(/data-meeting-spine/g) || []).length, 1);
  assert.match(html, /meeting-badge--approved|Approved/i);
  assert.match(html, /meeting-summary|approved/i);
  assert.match(html, /aye|nay|6|Approved/i);
  assert.match(html, /Staff report/);
  assert.match(html, /Agenda/);
  assert.match(html, /Minutes/);
  // Event docs once at the meeting level — not a 4-stage chain dump.
  assert.doesNotMatch(html, /Agenda item[\s\S]*Council matter[\s\S]*Outcome[\s\S]*Attachments/);
});

test("meeting outcomes: tallies without by_person use not-yet-shown person register", () => {
  // Production shape for notice 20260706036 / event 22526: counts only, no person rows.
  const html = meetingOutcomesHTML({
    request_id: "20260706036",
    join: { matched: true, method: "exact_date_body_tokens", reason: null },
    council_event: {
      event_id: "22526",
      name: "Subcommittee on Landmarks, Public Sitings and Maritime Uses",
      date: "2026-07-06",
      documents: [],
    },
    agenda_items: [{
      agenda_item_id: "1",
      title: "Landmarks item",
      matters: [{
        matter_id: "M1",
        matter_file: "T2026-0001",
        title: "Landmark designation",
        outcome: "Pass",
        votes: [{
          result: "Pass",
          counts: { aye: 4, nay: 0, abstain: 0 },
          kind: "vote",
          source_url: "https://nyc.legistar.com/example",
          // deliberately omit by_person — production KV shape
        }],
        documents: [],
      }],
    }],
  }, {
    agency_name: "City Council",
    section_name: "Public Hearings and Meetings",
  });
  assert.match(html, /Vote: Pass \(aye 4 · nay 0\)/);
  assert.match(html, /data-person-votes-gap="not_yet_ingested"/);
  assert.match(html, /Not yet shown here — person-level roll-call votes live in NYC Council Legistar/);
  assert.doesNotMatch(html, /data-official-votes/);
  assert.doesNotMatch(html, /meeting-roll-call-person/);
});

test("meeting outcomes: unmatched renders the specific join reason", () => {
  const html = meetingOutcomesHTML({
    request_id: "20260714002",
    join: {
      matched: false,
      reason: "No Council event matched this City Record notice on the strict date + body join.",
    },
    council_event: null,
    agenda_items: [],
  });
  assert.match(html, /Council meeting outcomes/);
  assert.match(html, /Not yet shown here — Council outcomes live in NYC Council Legistar/);
  assert.match(html, /date \+ body|strict date|hearing date and committee/i);
});

// ---------------------------------------------------------------------------
// Wiring: detail templates host the new slots and precompute-first loaders
// ---------------------------------------------------------------------------

test("detail templates host lifecycle, subsidy, meeting, and prior-award slots", () => {
  assert.match(src, /id="dlifecycle"/);
  assert.match(src, /id="dsubsidy"/);
  assert.match(src, /id="dmeet"/);
  assert.match(src, /id="dprior"/);
  assert.match(src, /id="nlifecycle"/);
  assert.match(src, /id="nsubsidy"/);
  assert.match(src, /id="nmeet"/);
  assert.match(src, /id="nprior"/);
  assert.match(src, /loadSubsidyLifecycle/);
  assert.match(src, /loadMeetingOutcomes/);
  assert.match(src, /loadLifecycle\(r, \$\("#dlifecycle"\), \$\("#ddollars"\), \$\("#dactions"\)\)/);
  assert.match(src, /loadLifecycle\(r, \$\("#nlifecycle"\), \$\("#ndollars"\), \$\("#nactions"\)\)/);
});

test("precompute-first: notice dollars and matter timeline use /contract-lifecycle, not live /checkbook", () => {
  // The dollars panel is filled from lifecycleDollarsHTML after loadLifecycle — no followDollars.
  assert.equal(src.includes("async function followDollars"), false);
  assert.match(src, /lifecycleDollarsHTML/);
  // Matter timeline fetches the precomputed lifecycle
  assert.match(src, /showMatter[\s\S]*?\/contract-lifecycle\?id=/);
});

test("worker meeting-outcomes supports per-notice ?id= lookup", () => {
  const route = readFileSync(join(ROOT, "worker/src/meeting_outcomes.mjs"), "utf8");
  assert.match(route, /searchParams\.get\("id"\)/);
  assert.match(route, /No Council meeting-outcomes record for this notice/);
});

test("worker subsidy endpoint returns structured gaps, not only unresolved", () => {
  const route = readFileSync(join(ROOT, "worker/src/subsidy_lifecycle.mjs"), "utf8");
  assert.match(route, /source_status/);
  assert.match(route, /structured lifecycle/);
});
