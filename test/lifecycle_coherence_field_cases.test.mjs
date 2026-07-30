// Characterization tests for lifecycle rendering coherence — named after the
// public symptoms on two live field cases:
//   #notice/20260623008 (HNTB award) and #notice/20260617040 (IDA hearing, no PIN).
//
// Asserts: no transient-error strings, no literal "null" money, no contradictory
// gap registers when a later stage or no-PIN condition already rules the page.
//
// Fixtures mirror current api.cityscroll.org/contract-lifecycle payloads for those
// ids (sha-pinned shapes; re-fetch if the join model changes).
//
//   node --test test/lifecycle_coherence_field_cases.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assembleLifecycle } from "../worker/src/lib/checkbook_lifecycle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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
const { t, tn } = new Function("window", i18nSrc + "\nreturn { t: window.t, tn: window.tn };")(windowStub);

const sandbox = new Function(
  "t", "tn", "window",
  extractFn("money") +
  extractFn("fdate") +
  extractConst("escUiHtml") +
  extractConst("extSR") +
  extractConst("REQ_URL") +
  extractConst("EXT_ATTRS") +
  extractConst("CHECKBOOK_SEARCH_URL") +
  extractConst("CHECKBOOK_SPENDING_URL") +
  extractConst("PASSPORT_CONTRACTS_URL") +
  extractConst("PASSPORT_RFX_URL") +
  extractConst("LIFECYCLE_STAGE_ORDER") +
  extractConst("CURRENT_SOLICITATIONS_URL") +
  extractConst("OCP_AWARDS_URL") +
  extractFn("lifecycleStageLabel") +
  extractFn("lifecycleAmount") +
  extractFn("lifecycleMoney") +
  extractFn("lifecycleSourceName") +
  extractFn("lifecycleGapSourceName") +
  extractFn("lifecycleHasLaterMatched") +
  extractFn("lifecyclePublicStatus") +
  extractFn("lifecycleSourceLink") +
  extractFn("lifecycleDocumentsHTML") +
  extractFn("lifecycleStageHTML") +
  extractFn("lifecycleOcpAwardHTML") +
  extractFn("lifecycleTimelineHTML") +
  extractFn("lifecycleDollarsHTML") +
  // vendorStem used by lifecycleDollarsHTML for mismatch warning
  `function vendorStem(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
   function cleanText(s){ return String(s||"").replace(/\\s+/g," ").trim(); }` +
  "return { lifecycleTimelineHTML, lifecycleDollarsHTML, lifecycleStageHTML, money, lifecycleMoney };"
);

const {
  lifecycleTimelineHTML,
  lifecycleDollarsHTML,
  money,
  lifecycleMoney,
} = sandbox(t, tn, windowStub);

// Live-shaped fixture: HNTB award #notice/20260623008 (registered matched, payment was unknown)
const HNTB_NOTICE = {
  request_id: "20260623008",
  agency_name: "Transportation",
  type_of_notice_description: "Award",
  pin: "84124P0003001",
  vendor_name: "HNTB New York Engineering and Architecture, P.C.",
  contract_amount: "13533763",
  short_title: "TD/CSS for 21st Ave Bridge Over NYCTA-BMT Sea Beach Line (BIN 2-24371-0), Brooklyn",
  start_date: "2026-06-29",
};

const HNTB_LIFECYCLE_RAW = {
  pin: "84124P0003001",
  pin_strategy: "exact",
  ok: false,
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
        vendor: HNTB_NOTICE.vendor_name,
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
        duration: null,
        mwbe: "Non-M/WBE",
      },
    },
    // Symptom: spending lookup failed while registered join succeeded
    { stage: "payment", status: "unknown", source: "checkbook-spending", date: null, detail: null },
  ],
};

// Live-shaped fixture: IDA hearing #notice/20260617040 (no PIN)
const IDA_NOTICE = {
  request_id: "20260617040",
  agency_name: "Industrial Development Agency",
  type_of_notice_description: "Public Hearing",
  pin: null,
  short_title: "NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY - NOTICE OF PUBLIC HEARING - July 16th, 2026",
  start_date: "2026-07-02",
};

const IDA_LIFECYCLE_RAW = {
  pin: null,
  pin_strategy: "none",
  ok: false,
  amendments: [],
  timeline: [
    {
      stage: "solicitation",
      status: "matched",
      source: "city-record",
      date: "2026-07-02",
      detail: {
        request_id: "20260617040",
        agency: "Industrial Development Agency",
        title: IDA_NOTICE.short_title,
        pin: null,
      },
    },
    { stage: "pending", status: "unknown", source: "checkbook-contracts", date: null, detail: null },
    { stage: "registered", status: "unknown", source: "checkbook-contracts", date: null, detail: null },
    { stage: "payment", status: "unknown", source: "checkbook-spending", date: null, detail: null },
  ],
};

const TRANSIENT = /Could not reach/i;
const LITERAL_NULL = /\bnull\b/;
const CLASS_A = /Not yet shown here/;

// ---------------------------------------------------------------------------
// 1. HNTB: no transient error; no null money; no pending gap when registered exists
// ---------------------------------------------------------------------------

test("HNTB field case: timeline never claims Checkbook unreachable when join data exists", () => {
  const html = lifecycleTimelineHTML(HNTB_LIFECYCLE_RAW, HNTB_NOTICE);
  assert.doesNotMatch(html, TRANSIENT, "payments must not show transient-error register");
  assert.doesNotMatch(html, LITERAL_NULL, "no literal null in lifecycle HTML");
});

test("HNTB field case: pending is passed/superseded when registered is matched (not not-yet-shown)", () => {
  const html = lifecycleTimelineHTML(HNTB_LIFECYCLE_RAW, HNTB_NOTICE);
  assert.doesNotMatch(html, /pending contracts live in/i);
  assert.doesNotMatch(html, /Not yet shown here — pending/i);
  // Passed / superseded wording for the earlier stage
  assert.match(html, /Passed|registered/i);
  assert.match(html, /class="box (passed|matched)"/);
});

test("HNTB field case: Follow-the-Dollars and payments stage agree (no unreachable vs Checkbook data)", () => {
  const timeline = lifecycleTimelineHTML(HNTB_LIFECYCLE_RAW, HNTB_NOTICE);
  const dollars = lifecycleDollarsHTML(HNTB_LIFECYCLE_RAW, HNTB_NOTICE);
  assert.doesNotMatch(timeline, TRANSIENT);
  assert.doesNotMatch(dollars, TRANSIENT);
  // Dollars panel shows Checkbook-derived committed amount
  assert.match(dollars, /Follow the dollars/);
  assert.match(dollars, /\$13\.53M|\$13\.54M/);
  // Spent zero formats as $0, never null
  assert.match(dollars + timeline, /\$0/);
  assert.doesNotMatch(dollars + timeline, LITERAL_NULL);
});

test("HNTB field case: registered spent/current line never renders literal null", () => {
  const html = lifecycleTimelineHTML(HNTB_LIFECYCLE_RAW, HNTB_NOTICE);
  // money(0) used to stringify as "null / $13.53M (0%)"
  assert.doesNotMatch(html, /null\s*\/\s*\$/);
  assert.match(html, /\$0\s*\/\s*\$13\.5/);
});

// ---------------------------------------------------------------------------
// 2. IDA no-PIN: single explanation; no stacked could-not-reach / not-yet-shown
// ---------------------------------------------------------------------------

test("IDA no-PIN field case: single no-PIN explanation; dependent slots collapse", () => {
  const html = lifecycleTimelineHTML(IDA_LIFECYCLE_RAW, IDA_NOTICE);
  assert.match(html, /does not publish a Procurement ID \(PIN\)/);
  assert.match(html, /would appear in Checkbook NYC if released with a PIN/);
  assert.doesNotMatch(html, TRANSIENT, "no stacked could-not-reach cards");
  assert.doesNotMatch(html, CLASS_A, "no not-yet-shown cards when no-PIN rules");
  // No pending/registered/payment stage boxes
  assert.doesNotMatch(html, /Pending contract/);
  assert.doesNotMatch(html, /Registered contract/);
  assert.doesNotMatch(html, /lifecycle_stage_payment|>Payments</);
});

// ---------------------------------------------------------------------------
// 3. Assembly coherence for the same shapes (precompute side)
// ---------------------------------------------------------------------------

test("assembleLifecycle: spending error with registered match does not leave payment unknown", () => {
  const registered = [{
    id: "CT184120268807929",
    vendor: "HNTB",
    registered: "2026-06-22",
    original: 13533763.08,
    current: 13533763.08,
    spent: 0,
    start: "2024-10-11",
    end: "2032-10-10",
    mwbe: "Non-M/WBE",
  }];
  const result = assembleLifecycle(HNTB_NOTICE, [], registered, null, {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "error" },
  });
  const pay = result.timeline.find((e) => e.stage === "payment");
  const pending = result.timeline.find((e) => e.stage === "pending");
  assert.notEqual(pay.status, "unknown");
  assert.equal(pay.status, "unmatched"); // spent 0 → taxonomy unmatched, not transient
  assert.equal(pending.status, "passed"); // registered present → pending superseded
  assert.equal(result.ok, true); // recoverable partial join is cacheable
});

test("assembleLifecycle: no PIN marks Checkbook stages not_applicable (not unknown)", () => {
  const result = assembleLifecycle({
    request_id: "20260617040",
    agency_name: "Industrial Development Agency",
    type_of_notice_description: "Solicitation",
    start_date: "2026-07-02",
    short_title: IDA_NOTICE.short_title,
    pin: null,
  }, [], [], [], {
    pinStrategy: "none",
    lookupStatus: { pending: "skip", registered: "skip", spending: "skip" },
  });
  for (const stage of ["pending", "registered", "payment"]) {
    const e = result.timeline.find((t) => t.stage === stage);
    assert.equal(e.status, "not_applicable", stage);
  }
  assert.equal(result.ok, true);
  assert.equal(result.pin, null);
});

// ---------------------------------------------------------------------------
// 4. money formatting helpers
// ---------------------------------------------------------------------------

test("lifecycleMoney formats zero as $0 and nullish as em dash (never literal null)", () => {
  assert.equal(lifecycleMoney(0), "$0");
  assert.equal(lifecycleMoney(null), "—");
  assert.equal(lifecycleMoney(undefined), "—");
  assert.equal(lifecycleMoney(13533763.08), money(13533763.08));
  assert.notEqual(String(lifecycleMoney(0)), "null");
});

// ---------------------------------------------------------------------------
// 5. Source coherence: unmatched pending names the distinct pending dataset
// ---------------------------------------------------------------------------

test("source coherence: unmatched pending names pending contracts dataset, not bare Checkbook when needed", () => {
  // Only when pending is the current gap (no later matched stage)
  const html = lifecycleTimelineHTML({
    pin: "84124P0003001",
    pin_strategy: "exact",
    ok: true,
    amendments: [],
    timeline: [
      {
        stage: "award", status: "matched", source: "city-record", date: "2026-06-23",
        detail: { request_id: "20260623008", agency: "DOT", title: "HNTB", pin: "84124P0003001", vendor: "HNTB", amount: 1 },
      },
      { stage: "pending", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "registered", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "payment", status: "unmatched", source: "checkbook-spending", date: null, detail: null },
    ],
  }, HNTB_NOTICE);

  assert.match(html, CLASS_A);
  // Distinct dataset wording (pending contracts / registered contracts / spending)
  assert.match(html, /pending contracts/i);
  assert.match(html, /registered contracts/i);
  assert.match(html, /payments|spending/i);
  assert.doesNotMatch(html, TRANSIENT);
});
