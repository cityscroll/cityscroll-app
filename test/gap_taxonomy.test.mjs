// Characterization tests for the two-register lifecycle gap taxonomy:
//   class (a) not_yet_ingested — "Not yet shown here — … live in <source>."
//   class (b) not_published    — "The city does not publish this — it would appear in <where> if released."
//
// Uses real field cases from the procurement stitch fixtures and pins the
// machine-readable registry in site/data/gap_taxonomy.json.
//
//   node --test test/gap_taxonomy.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assembleSubsidyLifecycle } from "../worker/src/lib/subsidy_lifecycle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "site", "index.html"), "utf8");
const i18nSrc = readFileSync(join(ROOT, "site", "i18n.js"), "utf8");
const registry = JSON.parse(
  readFileSync(join(ROOT, "site", "data", "gap_taxonomy.json"), "utf8"),
);
const report = readFileSync(join(ROOT, "docs", "gap-taxonomy.md"), "utf8");

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
const { t, tn } = new Function("window", i18nSrc + "\nreturn { t: window.t, tn: window.tn };")(windowStub);

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

const helpers = new Function(
  "t", "tn", "money", "fdate", "cleanText", "escUiHtml",
  `
  const extSR = () => '<span class="sr-only"> (opens in new tab)</span>';
  const REQ_URL = (id) => 'https://a856-cityrecord.nyc.gov/RequestDetail/' + encodeURIComponent(id);
  const EXT_ATTRS = 'target="_blank" rel="noopener noreferrer"';
  const CHECKBOOK_SEARCH_URL = 'https://www.checkbooknyc.com/contract_search';
  const CHECKBOOK_SPENDING_URL = 'https://www.checkbooknyc.com/spending_search';
  const CHECKBOOK_SMART_SEARCH = 'https://www.checkbooknyc.com/smart_search/citywide';
  const PASSPORT_CONTRACTS_URL = 'https://a0333-passportpublic.nyc.gov/contracts.html';
  const PASSPORT_RFX_URL = 'https://a0333-passportpublic.nyc.gov/rfx.html';
  const CURRENT_SOLICITATIONS_URL = 'https://data.cityofnewyork.us/d/3khw-qi8f';
  const CITY_RECORD_GETFILE_URL = 'https://a856-cityrecord.nyc.gov/Search/GetFile';
  const LIFECYCLE_STAGE_ORDER = {
    solicitation:0, intent_to_negotiate:1, vendor_list:2, intent_to_award:3,
    award:4, pending:5, registered:6, payment:7,
  };
  const OCP_AWARDS_URL = 'https://data.cityofnewyork.us/d/qyyg-4tf5';
  ` +
  extractFn("checkbookDocumentCode") +
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
  extractFn("lifecycleTimelineHTMLFlat") +
  extractFn("lifecycleTimelineHTML") +
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
  extractFn("isCityCouncilNotice") +
  extractFn("matterDetailUrl") +
  extractFn("nonCouncilBodyLinks") +
  extractFn("nonCouncilWhereHTML") +
  extractFn("nonCouncilStageLabel") +
  extractFn("nonCouncilHearingOutcomesHTML") +
  extractFn("meetingOutcomeBucket") +
  extractFn("meetingMatterShortTitle") +
  extractFn("collapseMeetingAgenda") +
  extractFn("officialIdFromPerson") +
  extractFn("officialHref") +
  extractFn("collectRollCallPeople") +
  extractFn("meetingRollCallChipHTML") +
  extractFn("meetingVotesHTML") +
  extractFn("meetingOutcomesHTML") +
  `
  return { lifecycleTimelineHTML, subsidyLifecycleHTML, meetingOutcomesHTML, t };
  `,
)(t, tn, money, fdate, cleanText, escUiHtml);

const { lifecycleTimelineHTML, subsidyLifecycleHTML, meetingOutcomesHTML } = helpers;

const CLASS_A_PREFIX = /Not yet shown here/;
const CLASS_B_PREFIX = /The city does not publish/;

// ---------------------------------------------------------------------------
// Registry shape + ranked ingest list
// ---------------------------------------------------------------------------

test("gap taxonomy registry enumerates class a/b gaps with evidence and ranked ingest list", () => {
  assert.equal(registry.schema_version, 2);
  assert.equal(registry.generated_document, "docs/gap-taxonomy.md");
  assert.ok(Array.isArray(registry.gaps) && registry.gaps.length >= 15);
  assert.ok(Array.isArray(registry.ranked_ingest_list) && registry.ranked_ingest_list.length >= 5);
  // Depot join graph (schema v2)
  assert.ok(Array.isArray(registry.sources) && registry.sources.length >= 10);
  assert.ok(Array.isArray(registry.crosswalks) && registry.crosswalks.length >= 5);
  assert.ok(registry.depot_refresh?.source_contracts_fingerprint);

  for (const gap of registry.gaps) {
    assert.ok(["not_yet_ingested", "not_published"].includes(gap.class), gap.id);
    assert.ok(gap.evidence && gap.evidence.length > 20, gap.id);
    if (gap.class === "not_yet_ingested") {
      assert.ok(gap.public_source?.name, gap.id);
      assert.ok(gap.public_source?.landing_page || gap.public_source?.access, gap.id);
    } else {
      assert.ok(gap.would_appear_in, gap.id);
    }
  }

  // Ranked list is top-down dispatch order
  const ranks = registry.ranked_ingest_list.map((r) => r.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  // PASSPort remains on the queue with measured either-source coverage (docs gap closed as class-b)
  const passportRank = registry.ranked_ingest_list.find((r) => /PASSPort/i.test(r.source));
  assert.ok(passportRank, "PASSPort still ranked");
  assert.ok(passportRank.rank <= 3, `PASSPort near top, got rank ${passportRank.rank}`);
});

test("gap taxonomy report is present and names both registers", () => {
  assert.match(report, /Not yet shown here/);
  assert.match(report, /The city does not publish this/);
  assert.match(report, /Ranked class-\(a\) ingest list/);
  assert.match(report, /PASSPort/);
  assert.match(report, /Join graph/);
  assert.match(report, /Generated by tools\/depot_rederive\.mjs/);
});

// ---------------------------------------------------------------------------
// Class (a) — real procurement field case: unmatched pending/registered/payment
// ---------------------------------------------------------------------------

test("class a: unmatched Checkbook stages collapse in UI; dictionary keeps not-yet-ingested register", () => {
  // Notice-detail presentation collapses empty future stages into the stepper so a fresh
  // award does not paint three "Not yet shown here" paragraphs. The class-(a) strings stay
  // in the English dictionary (and gap inventory) for other surfaces / precompute fill-in.
  const html = lifecycleTimelineHTML({
    pin: "84124P0003001",
    pin_strategy: "exact",
    ok: true,
    amendments: [],
    timeline: [
      {
        stage: "award", status: "matched", source: "city-record", date: "2026-06-23",
        detail: { request_id: "20260623008", agency: "DOT", title: "HNTB", pin: "84124P0003001", vendor: "HNTB", amount: 13533763 },
      },
      { stage: "pending", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "registered", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "payment", status: "unmatched", source: "checkbook-spending", date: null, detail: null },
    ],
  }, { request_id: "20260623008", agency_name: "Transportation", pin: "84124P0003001" });

  assert.doesNotMatch(html, CLASS_A_PREFIX);
  assert.match(html, /class="lc-stepper"/);
  assert.match(html, /Pending contract/);
  assert.match(html, /Registered contract/);
  assert.match(html, /Payments/);
  assert.doesNotMatch(html, CLASS_B_PREFIX);
  assert.doesNotMatch(html, /Disclaimer|This page does not/i);
  // Inventory / i18n still pin the class-(a) register with per-stage specificity
  assert.match(t("lifecycle_unmatched_pending_html", { source: "Checkbook NYC pending contracts" }), CLASS_A_PREFIX);
  assert.match(t("lifecycle_unmatched_pending_html", { source: "x" }), /pending contracts live in/);
  assert.match(t("lifecycle_unmatched_registered_html", { source: "x" }), /registered contracts live in/);
  assert.match(t("lifecycle_unmatched_payment_html", { source: "x" }), /payments live in/);
});

// ---------------------------------------------------------------------------
// Class (b) — real field case: no PIN on the notice
// ---------------------------------------------------------------------------

test("class b: no-PIN provenance uses not-published register with Checkbook pointer", () => {
  const html = lifecycleTimelineHTML({
    pin: null,
    pin_strategy: "none",
    ok: true,
    amendments: [],
    timeline: [
      {
        stage: "solicitation", status: "matched", source: "city-record", date: "2025-01-10",
        detail: { request_id: "X", agency: "A", title: "S", pin: null },
      },
      { stage: "pending", status: "unknown", source: "checkbook-contracts", date: null, detail: null },
      { stage: "registered", status: "unknown", source: "checkbook-contracts", date: null, detail: null },
      { stage: "payment", status: "unknown", source: "checkbook-spending", date: null, detail: null },
    ],
  }, { request_id: "X", agency_name: "A", pin: null });

  assert.match(html, CLASS_B_PREFIX);
  assert.match(html, /Procurement ID \(PIN\)/);
  assert.match(html, /would appear in Checkbook NYC if released with a PIN/);
});

// ---------------------------------------------------------------------------
// Class (b) — subsidy unmatched when no project feed row and notice is not an IDA hearing
// (IDA hearings now derive a City Record hearing-stage join; unmatched is for non-hearing cases.)
// ---------------------------------------------------------------------------

test("class b: unmatched subsidy project uses not-published register", () => {
  const [lifecycle] = assembleSubsidyLifecycle([{
    request_id: "20260101099",
    short_title: "Parks concession award — unrelated to subsidy projects",
    agency_name: "Parks and Recreation",
    type_of_notice_description: "Award",
  }], []);
  const html = subsidyLifecycleHTML(lifecycle, {
    request_id: "20260101099",
    short_title: "Parks concession award — unrelated to subsidy projects",
  });
  assert.equal(lifecycle.join.matched, false);
  assert.match(html, CLASS_B_PREFIX);
  assert.match(html, /linked subsidy project/);
  assert.match(html, /NYCIDA\/Build NYC|would appear/i);
});

// ---------------------------------------------------------------------------
// Class (a) — real Council unmatched meeting outcomes
// ---------------------------------------------------------------------------

test("class a: unmatched Council outcomes use not-yet-ingested register naming Legistar", () => {
  const html = meetingOutcomesHTML({
    request_id: "20260714002",
    join: {
      matched: false,
      reason: "No confident match for this City Record notice on title, date, and agency.",
    },
    council_event: null,
    agenda_items: [],
  }, { agency_name: "City Council", request_id: "20260714002" });
  assert.match(html, CLASS_A_PREFIX);
  assert.match(html, /Council outcomes live in NYC Council Legistar/);
});

test("class b: unmatched non-Council hearings use not-published register with BP/CB pointers", () => {
  const html = meetingOutcomesHTML({
    request_id: "20260701001",
    join: { matched: false, reason: "No Council event matched." },
    council_event: null,
    agenda_items: [],
  }, {
    agency_name: "Community Boards",
    request_id: "20260701001",
    start_date: "2026-06-20",
    event_date: "2026-07-01",
    short_title: "Community Board public hearing",
  });
  assert.match(html, CLASS_B_PREFIX);
  assert.match(html, /borough president|community board/i);
  // Outbound HTTPS landings (not text-only "where")
  assert.match(html, /href="https:\/\/[^"]+"/);
  assert.match(html, /community-boards|bronxboropres/i);
  // Spine presents class-(b) on outcome + minutes stages (not a single bare note)
  assert.match(html, /data-non-council-spine="1"/);
  assert.match(html, /data-gap-class="not_published"/);
  assert.doesNotMatch(html, /Not yet shown here — Council outcomes/);
});

test("class a: matter without votes uses not-yet-ingested register", () => {
  const html = meetingOutcomesHTML({
    request_id: "M1",
    join: { matched: true },
    council_event: { title: "Stated Meeting", start_time: "2026-07-14T13:00:00", event_id: "E1" },
    agenda_items: [{
      matters: [{ matter_id: "Int 1234", title: "A Local Law", votes: [], documents: [] }],
    }],
  });
  assert.match(html, CLASS_A_PREFIX);
  assert.match(html, /votes for matter/);
  assert.match(html, /NYC Council Legistar/);
});

// ---------------------------------------------------------------------------
// Class (b) — subsidy outcome and field gaps on a matched project with blanks
// ---------------------------------------------------------------------------

test("class b: matched subsidy stage with unknown outcome uses not-published register", () => {
  const html = subsidyLifecycleHTML({
    ok: true,
    join: { matched: true, confidence: "confirmed" },
    project: { id: "BND-1", name: "Sample", company: "Co" },
    company: { status: "unknown" },
    place: { status: "unknown" },
    money: {
      requested_benefit: { status: "unknown" },
      estimated_cost: { status: "unknown" },
    },
    stage: "hearing",
    timeline: [{
      stage: "hearing",
      status: "matched",
      date: "2025-02-03",
      official_action: "held",
      outcome: "unknown",
      detail: {},
      source: { status: "matched", url: "https://edc.nyc/example" },
    }],
  }, { request_id: "20260010002", short_title: "Sample" });

  assert.match(html, CLASS_B_PREFIX);
  assert.match(html, /does not publish this outcome/);
  // Company/place field gaps stay in substance (disclosure) but keep class-(b) copy.
  assert.match(html, /does not publish a company name/);
  assert.match(html, /does not publish a project address or BBL/);
});

// ---------------------------------------------------------------------------
// English dictionary pins both registers; all ten shipping locales carry keys
// ---------------------------------------------------------------------------

test("English dictionary pins both gap registers for lifecycle keys", () => {
  assert.match(t("lifecycle_unmatched_pending_html", { source: "Checkbook NYC" }), CLASS_A_PREFIX);
  assert.match(t("lifecycle_unmatched_registered_html", { source: "Checkbook NYC" }), CLASS_A_PREFIX);
  assert.match(t("lifecycle_unmatched_payment_html", { source: "Checkbook NYC" }), CLASS_A_PREFIX);
  assert.match(t("lifecycle_no_pin_note_html"), CLASS_B_PREFIX);
  assert.match(t("lifecycle_documents_not_published_html", { where: "City Record file attachments" }), CLASS_B_PREFIX);
  assert.match(t("subsidy_outcome_unknown_html"), CLASS_B_PREFIX);
  assert.match(t("agency_awards_none_open_data_html"), CLASS_B_PREFIX);
  assert.match(t("meeting_outcomes_no_votes_html", { matter: "Int 1" }), CLASS_A_PREFIX);
});

test("procurement-solicitation-documents is class (b) after RFx document-URL kill criterion", () => {
  const gap = registry.gaps.find((g) => g.id === "procurement-solicitation-documents");
  assert.ok(gap);
  assert.equal(gap.class, "not_published");
  assert.equal(gap.i18n_key, "lifecycle_documents_not_published_html");
  assert.match(gap.would_appear_in, /GetFile|City Record/i);
  assert.match(gap.evidence, /0%|0\/50|document/i);
  assert.equal(gap.class_change?.to, "not_published");
});

test("procurement-planning-budget class (b) pointer names Capital Projects", () => {
  const gap = registry.gaps.find((g) => g.id === "procurement-planning-budget");
  assert.ok(gap);
  assert.equal(gap.class, "not_published");
  assert.match(gap.would_appear_in, /Capital Projects/i);
  assert.match(gap.would_appear_in, /n7gv-k5yt|data\.cityofnewyork\.us\/d\/n7gv/);
  assert.match(gap.evidence, /fuzzy|0%|1%/i);
});

test("meeting-community-board-votes class (b) names borough president and community board homes", () => {
  const gap = registry.gaps.find((g) => g.id === "meeting-community-board-votes");
  assert.ok(gap);
  assert.equal(gap.class, "not_published");
  assert.equal(gap.i18n_key, "meeting_outcomes_non_council_not_published_html");
  assert.match(gap.would_appear_in, /borough president|community board/i);
  assert.match(gap.evidence, /40\/40|non-Council/i);
});

test("unmatched package-documents sub-slot uses not-published register with RequestDetail deep link", () => {
  const html = lifecycleTimelineHTML({
    ok: true,
    pin: "81026B0003",
    pin_strategy: "exact",
    amendments: [],
    timeline: [{
      stage: "solicitation",
      status: "matched",
      date: "2026-07-28",
      source: "city-record",
      documents_status: "unmatched",
      detail: {
        request_id: "20260707026",
        agency: "Transportation",
        title: "Sample",
        pin: "81026B0003",
        documents_status: "unmatched",
        documents: [],
        n_documents: 0,
      },
    }],
  }, { request_id: "20260707026", pin: "81026B0003" });
  assert.match(html, CLASS_B_PREFIX);
  assert.match(html, /package documents|does not publish/i);
  // With request_id known, deep-link the City Record notice — not bare GetFile search
  assert.match(html, /a856-cityrecord\.nyc\.gov\/RequestDetail\/20260707026/);
  assert.doesNotMatch(html, /a856-cityrecord\.nyc\.gov\/Search\/GetFile"/);
  assert.doesNotMatch(html, /Not yet shown here — solicitation package/);
});

test("all ten shipping locales define the gap taxonomy keys", () => {
  const keys = [
    "lifecycle_unmatched_pending_html",
    "lifecycle_unmatched_registered_html",
    "lifecycle_unmatched_payment_html",
    "lifecycle_no_pin_note_html",
    "lifecycle_documents_not_published_html",
    "lifecycle_source_city_record_getfile",
    "lifecycle_passed_pending_html",
    "lifecycle_passed_registered_html",
    "lifecycle_passed_generic_html",
    "lifecycle_paid_to_date_html",
    "lifecycle_payment_summary_html",
    "lifecycle_payment_zero_lag_html",
    "lifecycle_payment_details_link_html",
    "lifecycle_source_checkbook_pending",
    "lifecycle_source_checkbook_registered",
    "lifecycle_source_checkbook_spending",
    "subsidy_outcome_unknown_html",
    "subsidy_stage_unmatched_html",
    "subsidy_unmatched_html",
    "subsidy_unmatched_default_reason",
    "subsidy_company_unknown_html",
    "subsidy_place_unknown_html",
    "subsidy_money_unknown_html",
    "meeting_outcomes_unmatched_html",
    "meeting_outcomes_no_votes_html",
    "meeting_outcomes_no_matters_html",
    "meeting_outcomes_non_council_not_published_html",
    "meeting_outcomes_non_council_where",
    "meeting_outcomes_heading_non_council",
    "agency_awards_none_open_data_html",
    "external_award_none_note_html",
    "career_not_published",
    "career_outcomes_list_joined_note",
    "career_outcomes_list_source_name",
    "career_outcomes_not_yet_ingested_html",
  ];
  const langs = ["es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"];
  for (const lang of langs) {
    const body = readFileSync(join(ROOT, "site", "i18n", "lang", `${lang}.js`), "utf8");
    for (const key of keys) {
      assert.match(body, new RegExp(`${key}:\\s*"`), `${lang} missing ${key}`);
    }
  }
});
