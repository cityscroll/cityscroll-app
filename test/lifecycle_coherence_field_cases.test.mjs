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
  extractConst("CHECKBOOK_SMART_SEARCH") +
  extractConst("PASSPORT_CONTRACTS_URL") +
  extractConst("PASSPORT_RFX_URL") +
  extractConst("LIFECYCLE_STAGE_ORDER") +
  extractConst("CURRENT_SOLICITATIONS_URL") +
  extractConst("OCP_AWARDS_URL") +
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
  extractFn("lifecycleStageHTML") +
  extractFn("lifecycleOcpAwardHTML") +
  extractFn("lifecycleTimelineHTML") +
  extractFn("lifecycleDollarsHTML") +
  // Real vendorStem + vendorNamesMatch (entity-resolution for mismatch warning)
  extractConst("VENDOR_SUFFIX") +
  extractFn("cleanText") +
  extractFn("vendorStem") +
  extractFn("vendorNamesMatch") +
  "return { lifecycleTimelineHTML, lifecycleDollarsHTML, lifecycleStageHTML, money, lifecycleMoney, vendorNamesMatch, checkbookSearchUrl, lifecyclePaymentState, lifecycleResolvedPayment, lifecycleCommittedUnderrun, lifecyclePaymentSummaryHTML };"
);

const {
  lifecycleTimelineHTML,
  lifecycleDollarsHTML,
  money,
  lifecycleMoney,
  vendorNamesMatch,
  checkbookSearchUrl,
  lifecyclePaymentState,
  lifecycleResolvedPayment,
  lifecycleCommittedUnderrun,
  lifecyclePaymentSummaryHTML,
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
    // Healthy spending feed empty + registered spent 0 → verified $0 (not unavailable).
    {
      stage: "payment",
      status: "matched",
      source: "checkbook-spending",
      date: null,
      detail: {
        total_payments: null,
        total_spent: 0,
        latest_payment_date: null,
        latest_payment_amount: null,
        fiscal_year: null,
        derived_from: "registered",
        payment_state: "verified_zero",
      },
    },
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

// Named after the live symptom on #notice/20260623008: payments card + Follow-the-Dollars
// both showed "Not yet shown here — payments live in Checkbook NYC spending" while the same
// panel also showed Paid to date $0 (0%) with the normal-lag explanation.
test("joined payments rendered as not-shown, duplicated: payments card summarizes join; gap only when absent", () => {
  const timeline = lifecycleTimelineHTML(HNTB_LIFECYCLE_RAW, HNTB_NOTICE);
  const dollars = lifecycleDollarsHTML(HNTB_LIFECYCLE_RAW, HNTB_NOTICE);
  const both = timeline + dollars;
  // No class-(a) payment gap while registered join exists
  assert.doesNotMatch(both, /Not yet shown here — payments live in/i);
  assert.doesNotMatch(both, /payments live in Checkbook NYC spending/i);
  // Payments card: summary + $0 lag + notice-scoped deep link to dollars
  assert.match(timeline, /\$0 paid of \$13\.5/i);
  assert.match(timeline, /Payments lag invoicing/i);
  assert.match(timeline, /href="#notice\/20260623008\?focus=follow-the-dollars"/);
  assert.doesNotMatch(timeline, /href="#follow-the-dollars"/);
  assert.match(timeline, /class="box matched"/);
  // Outbound Checkbook links carry the contract id (not bare spending_search)
  assert.match(timeline, /smart_search\/citywide\?search_term=CT184120268807929/);
  assert.doesNotMatch(timeline, /href="https:\/\/www\.checkbooknyc\.com\/spending_search"/);
  // Dollars is the detail owner: Paid to date $0, lag in provenance — no second gap line
  assert.match(dollars, /Paid to date/i);
  assert.match(dollars, /\$0/);
  assert.match(dollars, /id="follow-the-dollars"/);
  assert.doesNotMatch(dollars, CLASS_A);
  // Gap copy must not appear twice across the panel
  const gapHits = (both.match(/Not yet shown here/g) || []).length;
  assert.equal(gapHits, 0, "no not-yet-shown when Checkbook join is present");
});

test("HNTB field case: registration card owns registration, not a second paid bar", () => {
  const html = lifecycleTimelineHTML(HNTB_LIFECYCLE_RAW, HNTB_NOTICE);
  assert.doesNotMatch(html, /null\s*\/\s*\$/);
  // Paid summary lives on the payments card, not as $0 / $13.53M on registered
  assert.doesNotMatch(html, /\$0\s*\/\s*\$13\.5/);
  assert.match(html, /Registered contract/i);
  assert.match(html, /\$0 paid of \$13\.5/i);
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

test("assembleLifecycle: spending error never invents confident $0 (payment_state unavailable)", () => {
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
  assert.equal(pay.status, "matched");
  assert.equal(pay.detail.payment_state, "unavailable");
  assert.equal(pay.detail.total_spent, null, "must not fall back to registered $0 on spending error");
  assert.equal(pending.status, "passed"); // registered present → pending superseded
  assert.equal(result.ok, true); // unavailable is resolved, still cacheable
});

test("assembleLifecycle: spending error + registered spent > 0 → from_registered (panels agree)", () => {
  const registered = [{
    id: "CT1-071-20258800377",
    vendor: "ACACIA",
    registered: "2024-07-22",
    original: 7397875,
    current: 7397875,
    spent: 4018484.1,
  }];
  const result = assembleLifecycle({
    request_id: "20240723114",
    agency_name: "Homeless Services",
    type_of_notice_description: "Award",
    pin: "07124N0022001",
    vendor_name: "Acacia Network Housing Inc.",
    contract_amount: "7397875",
    short_title: "NAE-Millennium Adult Family Facility",
    start_date: "2024-07-29",
  }, [], registered, null, {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "error" },
  });
  const pay = result.timeline.find((e) => e.stage === "payment");
  assert.equal(pay.status, "matched");
  assert.equal(pay.detail.payment_state, "from_registered");
  assert.equal(pay.detail.total_spent, 4018484.1);
});

test("assembleLifecycle: healthy empty spending + registered $0 → verified_zero", () => {
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
  const result = assembleLifecycle(HNTB_NOTICE, [], registered, [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const pay = result.timeline.find((e) => e.stage === "payment");
  assert.equal(pay.status, "matched");
  assert.equal(pay.detail.total_spent, 0);
  assert.equal(pay.detail.payment_state, "verified_zero");
  assert.equal(pay.detail.derived_from, "registered");
});

test("assembleLifecycle: spending transactions → paid state with summed total", () => {
  const registered = [{
    id: "CT1", vendor: "ACME", registered: "2025-04-01",
    original: 100, current: 100, spent: 40,
  }];
  const spending = [
    { amount: 25, date: "2025-05-01" },
    { amount: 15, date: "2025-06-01" },
  ];
  const result = assembleLifecycle(
    { request_id: "x", pin: "P1", type_of_notice_description: "Award", start_date: "2025-01-01", agency_name: "A", short_title: "T" },
    [], registered, spending,
    { pinStrategy: "exact", lookupStatus: { pending: "ok", registered: "ok", spending: "ok" } },
  );
  const pay = result.timeline.find((e) => e.stage === "payment");
  assert.equal(pay.detail.payment_state, "paid");
  assert.equal(pay.detail.total_spent, 40);
  assert.equal(pay.detail.total_payments, 2);
});

test("UI: unavailable payment does not show confident $0", () => {
  const data = {
    pin: "84124P0003001",
    pin_strategy: "exact",
    ok: true,
    amendments: [],
    timeline: [
      {
        stage: "registered", status: "matched", source: "checkbook-contracts", date: "2026-06-22",
        detail: {
          contract_id: "CT184120268807929", vendor: "HNTB",
          registration_date: "2026-06-22", original_amount: 100, current_amount: 100,
          spent_to_date: 0, start_date: "2024-10-11", end_date: "2032-10-10", mwbe: null,
        },
      },
      {
        stage: "payment", status: "matched", source: "checkbook-spending", date: null,
        detail: {
          total_payments: null, total_spent: null, payment_state: "unavailable",
        },
      },
    ],
  };
  const timeline = lifecycleTimelineHTML(data, HNTB_NOTICE);
  const dollars = lifecycleDollarsHTML(data, HNTB_NOTICE);
  assert.match(timeline, /Payment data unavailable right now/i);
  assert.doesNotMatch(timeline, /\$0 paid of/i);
  assert.match(dollars, /Unavailable right now/i);
  // Paid cell is unavailable — not a dollar amount (lag copy lives only on verified $0)
  assert.match(dollars, /Paid to date<\/dt><dd>Unavailable right now<\/dd>/);
  assert.doesNotMatch(dollars, /\$0 paid on a freshly registered/);
});

// Field case #notice/20240723114: Checkbook spending/pending unknown; PASSPort filled
// registered with spent_to_date $4.02M. Live symptom was payments card "unavailable"
// while Follow-the-Dollars showed $4.02M (54%). Both surfaces must use the join.
const MILLENNIUM_NOTICE = {
  request_id: "20240723114",
  agency_name: "Homeless Services",
  type_of_notice_description: "Award",
  pin: "07124N0022001",
  vendor_name: "Acacia Network Housing Inc.",
  contract_amount: "7397875",
  short_title: "NAE-Millennium Adult Family Facility+ Allowance - 100 Units",
  start_date: "2024-07-29",
};

const MILLENNIUM_LIFECYCLE_LIVE_SHAPE = {
  pin: "07124N0022001",
  pin_strategy: "exact",
  ok: false,
  amendments: [],
  timeline: [
    {
      stage: "award",
      status: "matched",
      source: "city-record",
      date: "2024-07-29T00:00:00.000",
      detail: {
        request_id: "20240723114",
        agency: "Homeless Services",
        title: MILLENNIUM_NOTICE.short_title,
        pin: "07124N0022001",
        vendor: MILLENNIUM_NOTICE.vendor_name,
        amount: 7397875,
      },
    },
    { stage: "pending", status: "unknown", source: "checkbook-contracts", date: null, detail: null },
    {
      stage: "registered",
      status: "matched",
      source: "passport-public-contracts",
      date: "2024-07-22",
      detail: {
        contract_id: "CT1-071-20258800377",
        vendor: "ACACIA NETWORK HOUSING INC",
        registration_date: "07/22/2024",
        original_amount: 7397875,
        current_amount: 7397875,
        spent_to_date: 4018484.1,
        start_date: "07/01/2024",
        end_date: "06/30/2025",
        duration: null,
        mwbe: null,
      },
    },
    // Payment never recovered pre-fix — detail null, status unknown.
    { stage: "payment", status: "unknown", source: "checkbook-spending", date: null, detail: null },
  ],
};

test("Millennium field case: join has paid-to-date → payments card and dollars agree (no unavailable)", () => {
  const timeline = lifecycleTimelineHTML(MILLENNIUM_LIFECYCLE_LIVE_SHAPE, MILLENNIUM_NOTICE);
  const dollars = lifecycleDollarsHTML(MILLENNIUM_LIFECYCLE_LIVE_SHAPE, MILLENNIUM_NOTICE);
  const both = timeline + dollars;
  assert.doesNotMatch(both, /Payment data unavailable right now/i);
  assert.doesNotMatch(both, /Unavailable right now/i);
  // Joined amount appears on both surfaces (~$4.02M of $7.40M)
  assert.match(timeline, /\$4\.02M paid of \$7\.4/i);
  assert.match(dollars, /\$4\.02M/);
  assert.match(dollars, /\(54%\)/);
  assert.match(dollars, /CT1-071-20258800377/);
  // Shared resolver: registration spent wins over empty payment detail
  const resolved = lifecycleResolvedPayment(
    MILLENNIUM_LIFECYCLE_LIVE_SHAPE.timeline.find((e) => e.stage === "registered").detail,
    null,
  );
  assert.equal(resolved.state, "from_registered");
  assert.equal(resolved.spent, 4018484.1);
});

// Field case #notice/20230728114 — Urban Resource Institute / MOCJ FJC case management.
// Verified against Checkbook: single Prime Vendor row, spending txs sum to spent_to_date
// ($344,117.23), no sibling contract ids under this PIN. 57% of current is complete data
// (committed ceiling after amendment from $1.22M → $608k), not missing fiscal-year slices.
const URI_NOTICE = {
  request_id: "20230728114",
  agency_name: "Mayor's Office of Criminal Justice",
  type_of_notice_description: "Award",
  pin: "00222P0004003",
  vendor_name: "Urban Resource Institute",
  contract_amount: "1217316",
  short_title: "Family Justice Center - Case Mngt",
  start_date: "2023-08-03",
};

const URI_LIFECYCLE = {
  pin: "00222P0004003",
  pin_strategy: "exact",
  ok: true,
  amendments: [{
    contract_id: "CT100220248801490",
    original_amount: 1217316,
    current_amount: 608658,
    delta: 608658 - 1217316,
    date: "2023-07-27",
  }],
  timeline: [
    {
      stage: "award",
      status: "matched",
      source: "city-record",
      date: "2023-08-03",
      detail: {
        request_id: "20230728114",
        agency: "Mayor's Office of Criminal Justice",
        title: URI_NOTICE.short_title,
        pin: "00222P0004003",
        vendor: URI_NOTICE.vendor_name,
        amount: 1217316,
      },
    },
    { stage: "pending", status: "passed", source: "checkbook-contracts", date: null, detail: null },
    {
      stage: "registered",
      status: "matched",
      source: "checkbook-contracts",
      date: "2023-07-27",
      detail: {
        contract_id: "CT100220248801490",
        vendor: "URBAN RESOURCE INSTITUTE",
        registration_date: "2023-07-27",
        original_amount: 1217316,
        current_amount: 608658,
        spent_to_date: 344117.23,
        start_date: "2023-07-01",
        end_date: "2024-06-30",
        duration: null,
        mwbe: null,
      },
    },
    {
      stage: "payment",
      status: "matched",
      source: "checkbook-spending",
      date: null,
      detail: {
        total_payments: 7,
        total_spent: 344117.23,
        latest_payment_date: null,
        latest_payment_amount: 82821.3,
        fiscal_year: "2025",
        payment_state: "paid",
      },
    },
  ],
};

test("URI field case: single-row 57% of ceiling is complete — no multi-contract warning, ceiling note shown", () => {
  assert.equal(
    lifecycleCommittedUnderrun(344117.23, 608658, "2024-06-30"),
    true,
    "term ended + underrun → ceiling framing",
  );
  assert.equal(
    lifecycleCommittedUnderrun(344117.23, 608658, "2099-01-01"),
    false,
    "open term does not show ceiling underrun note",
  );

  const timeline = lifecycleTimelineHTML(URI_LIFECYCLE, URI_NOTICE);
  const dollars = lifecycleDollarsHTML(URI_LIFECYCLE, URI_NOTICE);
  const both = timeline + dollars;
  assert.doesNotMatch(both, /Multiple contracts found/i);
  assert.doesNotMatch(both, /Payment data unavailable/i);
  // ~$344K of $609K committed (~57%)
  assert.match(timeline, /\$344K paid of \$609K committed/i);
  assert.match(dollars, /\$344K/);
  assert.match(dollars, /\(57%\)/);
  assert.match(dollars, /CT100220248801490/);
  // Ceiling framing, not an unpaid-debt implication
  assert.match(both, /registration ceiling|not a remaining balance/i);
  // Amendment from original award still visible
  assert.match(dollars, /amended from \$1\.22M/i);
});

// Same notice as a pre-fix cache shape (payment unknown + PASSPort spent) — finding-2
// coherence: must show $344k, not unavailable.
test("URI field case: pre-fix unknown payment + registration spent still shows 57% (not unavailable)", () => {
  const liveShape = {
    ...URI_LIFECYCLE,
    ok: false,
    timeline: URI_LIFECYCLE.timeline.map((e) => {
      if (e.stage === "payment") {
        return { stage: "payment", status: "unknown", source: "checkbook-spending", date: null, detail: null };
      }
      if (e.stage === "registered") {
        return {
          ...e,
          source: "passport-public-contracts",
          detail: {
            ...e.detail,
            contract_id: "CT1-002-20248801490", // PASSPort hyphen form of the same id
            registration_date: "07/27/2023",
            start_date: "07/01/2023",
            end_date: "06/30/2024",
          },
        };
      }
      return e;
    }),
  };
  const timeline = lifecycleTimelineHTML(liveShape, URI_NOTICE);
  const dollars = lifecycleDollarsHTML(liveShape, URI_NOTICE);
  assert.doesNotMatch(timeline + dollars, /Payment data unavailable/i);
  assert.match(timeline, /\$344K paid of/i);
  assert.match(dollars, /\(57%\)/);
  assert.match(timeline + dollars, /registration ceiling|not a remaining balance/i);
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
// 4. Entity resolution: HNTB truncation is same firm; true mismatch still warns
// ---------------------------------------------------------------------------

test("HNTB vendor pair: entity resolution matches Checkbook truncation to notice name", () => {
  const checkbook = "HNTB NEW YORK ENGINEERING ARCHITECTURE AND LANDSCAPE ARCHITE";
  const noticeName = "HNTB New York Engineering and Architecture, P.C.";
  assert.equal(vendorNamesMatch(checkbook, noticeName), true);
  const dollars = lifecycleDollarsHTML(HNTB_LIFECYCLE_RAW, HNTB_NOTICE);
  // Soft variant note (or quiet match) — never the red mismatch warning
  assert.doesNotMatch(dollars, /differs from the notice/i);
  assert.doesNotMatch(dollars, /note warn/);
  // Soft note when display strings differ but entity resolves
  assert.match(dollars, /Same vendor as the notice|Checkbook shows the name/i);
  // Specific outbound Checkbook link
  assert.match(dollars, /smart_search\/citywide\?search_term=CT184120268807929/);
});

test("true vendor mismatch still warns", () => {
  const other = {
    ...HNTB_NOTICE,
    vendor_name: "Acme Bridge Demolition LLC",
  };
  assert.equal(
    vendorNamesMatch(
      "HNTB NEW YORK ENGINEERING ARCHITECTURE AND LANDSCAPE ARCHITE",
      other.vendor_name,
    ),
    false,
  );
  const dollars = lifecycleDollarsHTML(HNTB_LIFECYCLE_RAW, other);
  assert.match(dollars, /differs from the notice/i);
  assert.match(dollars, /note warn/);
  assert.match(dollars, /Acme Bridge Demolition/);
});

test("checkbookSearchUrl constructs scoped Checkbook URLs", () => {
  const u = checkbookSearchUrl({ contractId: "CT184120268807929" });
  assert.equal(
    u,
    "https://www.checkbooknyc.com/smart_search/citywide?search_term=CT184120268807929",
  );
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
