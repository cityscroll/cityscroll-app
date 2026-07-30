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

const helpers = new Function(
  "t", "money", "fdate", "cleanText", "escUiHtml",
  `
  const extSR = () => '<span class="sr-only"> (opens in new tab)</span>';
  const REQ_URL = (id) => 'https://a856-cityrecord.nyc.gov/RequestDetail/' + encodeURIComponent(id);
  const EXT_ATTRS = 'target="_blank" rel="noopener noreferrer"';
  const CHECKBOOK_SEARCH_URL = 'https://www.checkbooknyc.com/contract_search';
  const CHECKBOOK_SPENDING_URL = 'https://www.checkbooknyc.com/spending_search';
  const PASSPORT_CONTRACTS_URL = 'https://a0333-passportpublic.nyc.gov/contracts.html';
  const PASSPORT_RFX_URL = 'https://a0333-passportpublic.nyc.gov/rfx.html';
  ` +
  extractFn("lifecycleStageLabel") +
  extractFn("lifecycleAmount") +
  extractFn("lifecycleSourceName") +
  extractFn("lifecycleSourceLink") +
  extractFn("lifecycleStageHTML") +
  extractFn("lifecycleTimelineHTML") +
  extractFn("subsidyStageLabel") +
  extractFn("subsidyStageHTML") +
  extractFn("subsidyLifecycleHTML") +
  extractFn("meetingOutcomesHTML") +
  `
  return { lifecycleTimelineHTML, subsidyLifecycleHTML, meetingOutcomesHTML, t };
  `,
)(t, money, fdate, cleanText, escUiHtml);

const { lifecycleTimelineHTML, subsidyLifecycleHTML, meetingOutcomesHTML } = helpers;

const CLASS_A_PREFIX = /Not yet shown here/;
const CLASS_B_PREFIX = /The city does not publish/;

// ---------------------------------------------------------------------------
// Registry shape + ranked ingest list
// ---------------------------------------------------------------------------

test("gap taxonomy registry enumerates class a/b gaps with evidence and ranked ingest list", () => {
  assert.equal(registry.schema_version, 1);
  assert.equal(registry.generated_document, "docs/gap-taxonomy.md");
  assert.ok(Array.isArray(registry.gaps) && registry.gaps.length >= 15);
  assert.ok(Array.isArray(registry.ranked_ingest_list) && registry.ranked_ingest_list.length >= 5);

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
  assert.ok(registry.ranked_ingest_list[0].source.includes("PASSPort"));
});

test("gap taxonomy report is present and names both registers", () => {
  assert.match(report, /Not yet shown here/);
  assert.match(report, /The city does not publish this/);
  assert.match(report, /Ranked class-\(a\) ingest list/);
  assert.match(report, /PASSPort/);
});

// ---------------------------------------------------------------------------
// Class (a) — real procurement field case: unmatched pending/registered/payment
// ---------------------------------------------------------------------------

test("class a: unmatched Checkbook stages use not-yet-ingested register with per-stage specificity", () => {
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

  assert.match(html, CLASS_A_PREFIX);
  assert.match(html, /pending contracts live in/);
  assert.match(html, /registered contracts live in/);
  assert.match(html, /payments live in/);
  assert.match(html, /Checkbook NYC/);
  assert.doesNotMatch(html, CLASS_B_PREFIX);
  // No page-level disclaimer shape
  assert.doesNotMatch(html, /Disclaimer|This page does not/i);
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
// Class (b) — real subsidy unmatched IDA hearing 20260617040
// ---------------------------------------------------------------------------

test("class b: unmatched subsidy project uses not-published register", () => {
  const [lifecycle] = assembleSubsidyLifecycle([{
    request_id: "20260617040",
    short_title: "NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY - NOTICE OF PUBLIC HEARING - July 16th, 2026",
    agency_name: "Industrial Development Agency",
  }], []);
  const html = subsidyLifecycleHTML(lifecycle, {
    request_id: "20260617040",
    short_title: "NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY - NOTICE OF PUBLIC HEARING - July 16th, 2026",
  });
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
  });
  assert.match(html, CLASS_A_PREFIX);
  assert.match(html, /Council outcomes live in NYC Council Legistar/);
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
  assert.match(t("subsidy_outcome_unknown_html"), CLASS_B_PREFIX);
  assert.match(t("agency_awards_none_open_data_html"), CLASS_B_PREFIX);
  assert.match(t("meeting_outcomes_no_votes_html", { matter: "Int 1" }), CLASS_A_PREFIX);
});

test("all ten shipping locales define the gap taxonomy keys", () => {
  const keys = [
    "lifecycle_unmatched_pending_html",
    "lifecycle_unmatched_registered_html",
    "lifecycle_unmatched_payment_html",
    "lifecycle_no_pin_note_html",
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
    "agency_awards_none_open_data_html",
    "external_award_none_note_html",
    "career_not_published",
  ];
  const langs = ["es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"];
  for (const lang of langs) {
    const body = readFileSync(join(ROOT, "site", "i18n", "lang", `${lang}.js`), "utf8");
    for (const key of keys) {
      assert.match(body, new RegExp(`${key}:\\s*"`), `${lang} missing ${key}`);
    }
  }
});
