// Pins lifecycleTimelineHTML()'s output shape: stage boxes, status-aware styling, source
// links, unmatched/unknown/ambiguous "no record found" register statements, amendments,
// and provenance notes. The rendering functions are extracted from index.html's inline
// <script> (same pattern as test/forecast_render.test.mjs) so a change to the output is
// caught here, not in production.
//
//   node --test test/lifecycle_render.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  extractConst("CITY_RECORD_GETFILE_URL") +
  extractConst("OCP_AWARDS_URL") +
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
  extractFn("lifecycleTimelineHTML") +
  "return { lifecycleStageLabel, lifecycleAmount, lifecycleSourceLink, lifecycleStageHTML, lifecycleOcpAwardHTML, lifecycleTimelineHTML, lifecycleMoney, checkbookSearchUrl, lifecycleDollarsFocusHref, lifecyclePaymentSummaryHTML, lifecyclePaymentState };"
);

const {
  lifecycleStageLabel,
  lifecycleAmount,
  lifecycleSourceLink,
  lifecycleStageHTML,
  lifecycleOcpAwardHTML,
  lifecycleTimelineHTML,
  lifecycleMoney,
  checkbookSearchUrl,
  lifecycleDollarsFocusHref,
  lifecyclePaymentSummaryHTML,
} = sandbox(t, tn, windowStub);

// ---------------------------------------------------------------------------
// Fixtures: mirrors the lifecycle data model from worker/src/lib/checkbook_lifecycle.mjs
// ---------------------------------------------------------------------------

const FULL_LIFECYCLE = {
  pin: "08250R0001001",
  pin_strategy: "exact",
  ok: true,
  amendments: [],
  timeline: [
    {
      stage: "solicitation",
      status: "matched",
      source: "city-record",
      date: "2025-01-10",
      source_timestamp: "2025-01-10",
      detail: { request_id: "20250110001", agency: "Sanitation", title: "Collection Services", pin: "08250R0001001" },
    },
    {
      stage: "pending",
      status: "matched",
      source: "checkbook-contracts",
      date: "2025-03-15",
      source_timestamp: "2025-03-15",
      detail: { contract_id: "C-1001", vendor: "ACME CORP", received_date: "2025-03-15", start_date: "2025-03-01", amount: 5000000 },
    },
    {
      stage: "registered",
      status: "matched",
      source: "checkbook-contracts",
      date: "2025-04-01",
      source_timestamp: "2025-04-01",
      detail: {
        contract_id: "C-1001", vendor: "ACME CORP", registration_date: "2025-04-01",
        original_amount: 5000000, current_amount: 5000000, spent_to_date: 1500000,
        start_date: "2025-03-01", end_date: "2028-03-01", duration: "3 years", mwbe: "Non-M/WBE",
      },
    },
    {
      stage: "payment",
      status: "matched",
      source: "checkbook-spending",
      date: "2025-05-15",
      source_timestamp: "2025-05-15",
      detail: { total_payments: 3, total_spent: 750000, latest_payment_date: "2025-05-15", latest_payment_amount: 250000, fiscal_year: "2025" },
    },
  ],
};

const UNMATCHED_LIFECYCLE = {
  pin: "09876R0001001",
  pin_strategy: "exact",
  ok: true,
  amendments: [],
  timeline: [
    {
      stage: "solicitation", status: "matched", source: "city-record",
      date: "2025-01-10", source_timestamp: "2025-01-10",
      detail: { request_id: "X", agency: "Aging", title: "Meals", pin: "09876R0001001" },
    },
    { stage: "pending", status: "unmatched", source: "checkbook-contracts", date: null, source_timestamp: null, detail: null },
    { stage: "registered", status: "unmatched", source: "checkbook-contracts", date: null, source_timestamp: null, detail: null },
    { stage: "payment", status: "unmatched", source: "checkbook-spending", date: null, source_timestamp: null, detail: null },
  ],
};

const UNKNOWN_LIFECYCLE = {
  pin: "09876R0001001",
  pin_strategy: "exact",
  ok: false,
  amendments: [],
  timeline: [
    {
      stage: "solicitation", status: "matched", source: "city-record",
      date: "2025-01-10", source_timestamp: "2025-01-10",
      detail: { request_id: "X", agency: "Aging", title: "Meals", pin: "09876R0001001" },
    },
    { stage: "pending", status: "unknown", source: "checkbook-contracts", date: null, source_timestamp: null, detail: null },
    { stage: "registered", status: "unknown", source: "checkbook-contracts", date: null, source_timestamp: null, detail: null },
    { stage: "payment", status: "unknown", source: "checkbook-spending", date: null, source_timestamp: null, detail: null },
  ],
};

const AMBIGUOUS_LIFECYCLE = {
  pin: "08250R0001001",
  pin_strategy: "exact",
  ok: true,
  amendments: [],
  timeline: [
    {
      stage: "solicitation", status: "matched", source: "city-record",
      date: "2025-01-10", source_timestamp: "2025-01-10",
      detail: { request_id: "X", agency: "Sanitation", title: "S", pin: "08250R0001001" },
    },
    { stage: "pending", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
    {
      stage: "registered", status: "ambiguous", source: "checkbook-contracts",
      date: null, detail: {
        candidates: [
          { contract_id: "C1", vendor: "V1", registration_date: "2025-04-01", current_amount: 1000000 },
          { contract_id: "C2", vendor: "V2", registration_date: "2025-04-05", current_amount: 2000000 },
        ],
      },
    },
    { stage: "payment", status: "unmatched", source: "checkbook-spending", date: null, detail: null },
  ],
};

const AMENDED_LIFECYCLE = {
  pin: "08250R0001001",
  pin_strategy: "exact",
  ok: true,
  amendments: [{ contract_id: "C-1001", original_amount: 5000000, current_amount: 7500000, delta: 2500000, date: "2025-04-01" }],
  timeline: [
    {
      stage: "solicitation", status: "matched", source: "city-record",
      date: "2025-01-10", detail: { request_id: "X", agency: "A", title: "S", pin: "08250R0001001" },
    },
    { stage: "pending", status: "matched", source: "checkbook-contracts", date: "2025-03-15",
      detail: { contract_id: "C-1001", vendor: "V", amount: 5000000 } },
    {
      stage: "registered", status: "matched", source: "checkbook-contracts", date: "2025-04-01",
      detail: { contract_id: "C-1001", vendor: "V", registration_date: "2025-04-01",
        original_amount: 5000000, current_amount: 7500000, spent_to_date: 2000000 },
    },
    { stage: "payment", status: "matched", source: "checkbook-spending", date: "2025-05-15",
      detail: { total_payments: 2, total_spent: 500000, latest_payment_date: "2025-05-15", latest_payment_amount: 250000 } },
  ],
};

const notice = { request_id: "20250110001", agency_name: "Sanitation", pin: "08250R0001001" };

// ---------------------------------------------------------------------------
// 1. FULL LIFECYCLE: all stages matched
// ---------------------------------------------------------------------------

test("lifecycle: full lifecycle renders all stages with dates, amounts, and source links", () => {
  const html = lifecycleTimelineHTML(FULL_LIFECYCLE, notice);
  assert.match(html, /class="chain-h"/);
  assert.match(html, /Contract lifecycle/);
  assert.match(html, /class="chain"/);

  // Stage labels
  assert.match(html, /Solicitation/);
  assert.match(html, /Pending contract/);
  assert.match(html, /Registered contract/);
  assert.match(html, /Payments/);

  // Dates
  assert.match(html, /2025-01-10/);
  assert.match(html, /2025-03-15/);
  assert.match(html, /2025-04-01/);
  assert.match(html, /2025-05-15/);

  // Amounts
  assert.match(html, /\$5\.00M/);
  assert.match(html, /\$750K/);

  // One actionable source link on the current stage (payments → Checkbook)
  assert.match(html, /checkbooknyc\.com/);
  // City Record is named in methodology; outbound link only when that stage is current
  assert.match(html, /City Record/);
});

test("lifecycle: matched stages have green box class", () => {
  const html = lifecycleTimelineHTML(FULL_LIFECYCLE, notice);
  assert.match(html, /class="box matched"/);
});

test("lifecycle: connectors between expanded matched stages", () => {
  const html = lifecycleTimelineHTML(FULL_LIFECYCLE, notice);
  const connectors = (html.match(/class="connector"/g) || []).length;
  assert.equal(connectors, 3, "4 matched detail cards = 3 connectors");
  // Compact stepper also lists every stage
  assert.match(html, /class="lc-stepper"/);
  assert.equal((html.match(/class="lc-step /g) || []).length, 4);
});

test("lifecycle: registered stage owns registration amount, not a second paid bar", () => {
  const html = lifecycleTimelineHTML(FULL_LIFECYCLE, notice);
  // Committed amount still on the registered card; paid-to-date is payments + dollars
  assert.match(html, /\$5\.00M/);
  assert.doesNotMatch(html, /\$1\.50M \/ \$5\.00M \(30%\)/);
});

test("lifecycle: payment stage shows payment count, summary, and dollars link", () => {
  const html = lifecycleTimelineHTML(FULL_LIFECYCLE, notice);
  assert.match(html, /3 payments/);
  assert.match(html, /Latest:/);
  assert.match(html, /\$250K/);
  // total_spent from payment detail (not registered.spent_to_date) when present
  assert.match(html, /\$750K paid of \$5\.00M committed/);
  // Notice-scoped deep link — bare #follow-the-dollars ejects applyHash to money tab
  assert.match(html, /href="#notice\/20250110001\?focus=follow-the-dollars"/);
  assert.doesNotMatch(html, /href="#follow-the-dollars"/);
});

test("lifecycle: provenance note names City Record, Checkbook, PASSPort, and the PIN", () => {
  const html = lifecycleTimelineHTML(FULL_LIFECYCLE, notice);
  // Methodology is demoted to a disclosure — names sources without duplicating outbound links
  assert.match(html, /How this timeline works/);
  assert.match(html, /This timeline joins/);
  assert.match(html, /City Record/);
  assert.match(html, /Checkbook NYC/);
  assert.match(html, /PASSPort Public/);
  assert.match(html, /<code>08250R0001001<\/code>/);
  assert.match(html, /<details class="inline-disclose lc-how">/);
  // Disclosure body uses text names, not a second set of source URLs
  const howBody = html.match(/inline-disclose-body">([\s\S]*?)<\/div><\/details>/);
  assert.ok(howBody);
  assert.doesNotMatch(howBody[1], /href=/);
});

// ---------------------------------------------------------------------------
// 2. UNMATCHED: future stages collapse into grey stepper chips (no gap paragraphs)
// ---------------------------------------------------------------------------

test("lifecycle: unmatched future stages are greyed stepper chips, not gap paragraphs", () => {
  const html = lifecycleTimelineHTML(UNMATCHED_LIFECYCLE, notice);
  // Compact stepper still names every stage
  assert.match(html, /class="lc-stepper"/);
  assert.match(html, /Solicitation/);
  assert.match(html, /Pending contract/);
  assert.match(html, /Registered contract/);
  assert.match(html, /Payments/);
  // Future unmatched: grey chips only — no class-(a) paragraphs or unmatched boxes
  assert.doesNotMatch(html, /class="box unmatched"/);
  assert.doesNotMatch(html, /Not yet shown here/);
  assert.doesNotMatch(html, /pending contracts live in/);
  assert.doesNotMatch(html, /registered contracts live in/);
  assert.doesNotMatch(html, /payments live in/);
  // Current matched stage still expands as a detail card
  assert.match(html, /class="box matched/);
  // No repeated Checkbook outbound on empty future stages
  const checkbookLinks = (html.match(/checkbooknyc\.com/g) || []).length;
  assert.ok(checkbookLinks <= 1, `at most one Checkbook URL in methodology, got ${checkbookLinks}`);
});

// ---------------------------------------------------------------------------
// 3. UNKNOWN: never surface transient "could not reach" on notice detail
// ---------------------------------------------------------------------------

test("lifecycle: unknown stages map to collapsed future steps (never transient-error register)", () => {
  const html = lifecycleTimelineHTML(UNKNOWN_LIFECYCLE, notice);
  // Public UI coerces unknown → unmatched (collapsed), never "Could not reach"
  assert.doesNotMatch(html, /Could not reach/);
  assert.doesNotMatch(html, /class="box unmatched"/);
  assert.doesNotMatch(html, /Not yet shown here/);
  assert.match(html, /class="lc-stepper"/);
  assert.match(html, /class="box matched/);
});

// ---------------------------------------------------------------------------
// 4. AMBIGUOUS: candidates list
// ---------------------------------------------------------------------------

test("lifecycle: ambiguous stage lists candidates", () => {
  const html = lifecycleTimelineHTML(AMBIGUOUS_LIFECYCLE, notice);
  assert.match(html, /class="box ambiguous/);
  assert.match(html, /Multiple contracts found/);
  assert.match(html, /class="lc-candidates"/);
  assert.match(html, /C1/);
  assert.match(html, /C2/);
  assert.match(html, /\$1\.00M/);
  assert.match(html, /\$2\.00M/);
});

// ---------------------------------------------------------------------------
// 5. AMENDMENTS: amendment note
// ---------------------------------------------------------------------------

test("lifecycle: amendment renders a budget-change note", () => {
  const html = lifecycleTimelineHTML(AMENDED_LIFECYCLE, notice);
  assert.match(html, /Budget changed/);
  assert.match(html, /\$5\.00M/);
  assert.match(html, /\$7\.50M/);
  assert.match(html, /\$2\.50M/);
});

test("lifecycle: amended registered stage shows 'amended from' inside the box", () => {
  const html = lifecycleTimelineHTML(AMENDED_LIFECYCLE, notice);
  assert.match(html, /class="lc-amend"/);
  assert.match(html, /amended from/);
});

// ---------------------------------------------------------------------------
// 6. SOURCE LINKS: each stage links to its authoritative source
// ---------------------------------------------------------------------------

test("lifecycleSourceLink: city-record stage links to City Record detail page", () => {
  const link = lifecycleSourceLink({
    source: "city-record",
    detail: { request_id: "20250110001" },
  });
  assert.match(link, /a856-cityrecord\.nyc\.gov\/RequestDetail\/20250110001/);
  assert.match(link, /City Record/);
});

test("lifecycleSourceLink: checkbook-contracts with contract_id links to smart search", () => {
  const link = lifecycleSourceLink({
    source: "checkbook-contracts",
    detail: { contract_id: "C-1001" },
  });
  assert.match(link, /checkbooknyc\.com\/smart_search/);
  assert.match(link, /C-1001/);
});

test("lifecycleSourceLink: checkbook-contracts without contract_id links to contract search", () => {
  const link = lifecycleSourceLink({
    source: "checkbook-contracts",
    detail: null,
  });
  assert.match(link, /checkbooknyc\.com\/contract_search/);
});

test("lifecycleSourceLink: checkbook-spending without context links to spending search", () => {
  const link = lifecycleSourceLink({
    source: "checkbook-spending",
    detail: null,
  });
  assert.match(link, /checkbooknyc\.com\/spending_search/);
});

test("lifecycleSourceLink: checkbook-spending with contract_id links to smart search", () => {
  const link = lifecycleSourceLink(
    { source: "checkbook-spending", detail: null },
    { contractId: "CT184120268807929" },
  );
  assert.match(link, /checkbooknyc\.com\/smart_search/);
  assert.match(link, /CT184120268807929/);
  assert.doesNotMatch(link, /spending_search/);
});

test("checkbookSearchUrl: prefers contract id, then pin, then vendor", () => {
  assert.match(checkbookSearchUrl({ contractId: "CT1" }), /search_term=CT1/);
  assert.match(checkbookSearchUrl({ pin: "84124P0003001" }), /search_term=84124P0003001/);
  assert.match(checkbookSearchUrl({ vendor: "HNTB" }), /search_term=HNTB/);
  assert.equal(checkbookSearchUrl({ kind: "spending" }), "https://www.checkbooknyc.com/spending_search");
});

test("checkbookSearchUrl: agid builds citywide contract-detail deep link", () => {
  assert.equal(
    checkbookSearchUrl({ contractId: "CT107120248803393", agid: "6032530", documentCode: "CT1" }),
    "https://www.checkbooknyc.com/contract_details/agid/6032530/doctype/CT1",
  );
  // Infer CT1 from the leading letters+digit of the contract id when doctype omitted.
  assert.equal(
    checkbookSearchUrl({ contractId: "CT107120248803393", agid: "6032530" }),
    "https://www.checkbooknyc.com/contract_details/agid/6032530/doctype/CT1",
  );
});

test("lifecycleDollarsFocusHref: keeps notice context on the deep link", () => {
  assert.equal(
    lifecycleDollarsFocusHref("20260623008"),
    "#notice/20260623008?focus=follow-the-dollars",
  );
  assert.equal(lifecycleDollarsFocusHref(null), "#follow-the-dollars");
});

test("lifecyclePaymentSummaryHTML: notice-scoped dollars link", () => {
  const html = lifecyclePaymentSummaryHTML(0, 100, { noticeId: "20260623008" });
  assert.match(html, /href="#notice\/20260623008\?focus=follow-the-dollars"/);
});

// ---------------------------------------------------------------------------
// 7. LABELS + AMOUNTS
// ---------------------------------------------------------------------------

test("lifecycleStageLabel: maps each stage to a human-readable label", () => {
  assert.equal(lifecycleStageLabel("solicitation"), "Solicitation");
  assert.equal(lifecycleStageLabel("intent_to_negotiate"), "Intent to negotiate");
  assert.equal(lifecycleStageLabel("vendor_list"), "Vendor list");
  assert.equal(lifecycleStageLabel("intent_to_award"), "Intent to award");
  assert.equal(lifecycleStageLabel("award"), "Award");
  assert.equal(lifecycleStageLabel("pending"), "Pending contract");
  assert.equal(lifecycleStageLabel("registered"), "Registered contract");
  assert.equal(lifecycleStageLabel("payment"), "Payments");
});

test("lifecycleAmount: extracts the right amount field per stage", () => {
  assert.equal(lifecycleAmount({ stage: "award", detail: { amount: 5000000 } }), 5000000);
  assert.equal(lifecycleAmount({ stage: "pending", detail: { amount: 3000000 } }), 3000000);
  assert.equal(lifecycleAmount({ stage: "registered", detail: { current_amount: 7500000 } }), 7500000);
  assert.equal(lifecycleAmount({ stage: "payment", detail: { total_spent: 250000 } }), 250000);
  assert.equal(lifecycleAmount({ stage: "solicitation", detail: {} }), null);
  assert.equal(lifecycleAmount({ stage: "registered", detail: null }), null);
});

// ---------------------------------------------------------------------------
// 8. AWARD NOTICE: starts with Award stage instead of Solicitation
// ---------------------------------------------------------------------------

test("lifecycle: award notice renders Award stage with vendor and amount", () => {
  const awardLifecycle = {
    pin: "08250R0001001", pin_strategy: "exact", ok: true, amendments: [],
    timeline: [
      {
        stage: "award", status: "matched", source: "city-record",
        date: "2025-02-15",
        detail: { request_id: "X", agency: "Sanitation", title: "Collection", pin: "08250R0001001", vendor: "ACME CORP", amount: 5000000 },
      },
      { stage: "pending", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "registered", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "payment", status: "unmatched", source: "checkbook-spending", date: null, detail: null },
    ],
  };
  const html = lifecycleTimelineHTML(awardLifecycle, notice);
  assert.match(html, /Award/);
  assert.match(html, /ACME CORP/);
  assert.match(html, /\$5\.00M/);
  assert.match(html, /class="box matched/);
  // Future Checkbook stages stay grey chips — no not-yet-shown paragraphs
  assert.doesNotMatch(html, /Not yet shown here/);
});

test("lifecycle: intermediate City Record stages render as distinct stepper chips in order", () => {
  const intermediateLifecycle = {
    pin: "08250R0001001", pin_strategy: "exact", ok: true, amendments: [],
    timeline: [
      {
        stage: "solicitation", status: "matched", source: "city-record",
        date: "2025-01-10",
        detail: { request_id: "S1", agency: "Sanitation", title: "Collection", pin: "08250R0001001" },
      },
      {
        stage: "intent_to_award", status: "matched", source: "city-record",
        date: "2025-02-01",
        detail: { request_id: "I1", agency: "Sanitation", title: "Collection", pin: "08250R0001001", vendor: "ACME CORP", amount: 5000000 },
      },
      {
        stage: "award", status: "matched", source: "city-record",
        date: "2025-02-15",
        detail: { request_id: "A1", agency: "Sanitation", title: "Collection", pin: "08250R0001001", vendor: "ACME CORP", amount: 5000000 },
      },
      { stage: "pending", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "registered", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "payment", status: "unmatched", source: "checkbook-spending", date: null, detail: null },
    ],
  };
  const html = lifecycleTimelineHTML(intermediateLifecycle, notice);
  // Stepper carries all three City Record stages as distinct labels.
  assert.match(html, /lc-stepper/);
  assert.match(html, /Intent to award/);
  assert.match(html, /Solicitation/);
  assert.match(html, /Award/);
  // Intent detail card shows vendor (matched intermediate is not a grey-only chip).
  assert.match(html, /ACME CORP/);
  assert.doesNotMatch(html, /Not yet shown here/);
});

// ---------------------------------------------------------------------------
// 9. NO PIN: no-pin note
// ---------------------------------------------------------------------------

test("lifecycle: no PIN renders the no-pin note instead of the provenance note", () => {
  const noPinLifecycle = {
    pin: null, pin_strategy: "none", ok: true, amendments: [],
    timeline: [
      {
        stage: "solicitation", status: "matched", source: "city-record",
        date: "2025-01-10",
        detail: { request_id: "X", agency: "A", title: "S", pin: null },
      },
      { stage: "pending", status: "unknown", source: "checkbook-contracts", date: null, detail: null },
      { stage: "registered", status: "unknown", source: "checkbook-contracts", date: null, detail: null },
      { stage: "payment", status: "unknown", source: "checkbook-spending", date: null, detail: null },
    ],
  };
  const html = lifecycleTimelineHTML(noPinLifecycle, { request_id: "X", agency_name: "A", pin: null });
  assert.match(html, /does not publish a Procurement ID \(PIN\)/);
  assert.match(html, /would appear in Checkbook NYC if released with a PIN/);
  assert.doesNotMatch(html, /matched by PIN/);
  // Dependent Checkbook stages collapse into the single no-PIN explanation
  assert.doesNotMatch(html, /Could not reach/);
  assert.doesNotMatch(html, /Not yet shown here/);
  assert.doesNotMatch(html, /Pending contract/);
});

// ---------------------------------------------------------------------------
// 10. SOLICITATION DOCUMENTS: joined package links vs not-yet-ingested gap
// ---------------------------------------------------------------------------

test("lifecycle: solicitation with joined package documents renders real links", () => {
  const docsLifecycle = {
    pin: "85725P0001", pin_strategy: "exact", ok: true, amendments: [],
    timeline: [
      {
        stage: "solicitation", status: "matched", source: "city-record",
        date: "2024-10-01", documents_status: "matched",
        detail: {
          request_id: "20240816113",
          agency: "Citywide Administrative Services",
          title: "Mentor Program",
          pin: "85725P0001",
          due_date: "2024-10-07T10:30:00.000",
          documents: [
            "https://a856-cityrecord.nyc.gov/Search/GetFile?SectionID=6&RequestStatus=Archived&RequestID=20240816113&DocumentID=38698",
          ],
          n_documents: 1,
          documents_status: "matched",
        },
      },
      { stage: "pending", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "registered", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "payment", status: "unmatched", source: "checkbook-spending", date: null, detail: null },
    ],
  };
  const html = lifecycleTimelineHTML(docsLifecycle, {
    request_id: "20240816113", agency_name: "Citywide Administrative Services", pin: "85725P0001",
  });
  assert.match(html, /package document/);
  assert.match(html, /Document 1/);
  assert.match(html, /a856-cityrecord\.nyc\.gov\/Search\/GetFile/);
  assert.doesNotMatch(html, /Not yet shown here — solicitation package/);
});

test("lifecycle: solicitation without package documents uses short not-published caveat", () => {
  const gapLifecycle = {
    pin: "85726B0067", pin_strategy: "exact", ok: true, amendments: [],
    timeline: [
      {
        stage: "solicitation", status: "matched", source: "city-record",
        date: "2026-07-10", documents_status: "unmatched",
        detail: {
          request_id: "20260709023",
          agency: "Citywide Administrative Services",
          title: "FORKLIFTS DIESEL",
          pin: "85726B0067",
          documents: [],
          n_documents: 0,
          documents_status: "unmatched",
        },
      },
      { stage: "pending", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "registered", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "payment", status: "unmatched", source: "checkbook-spending", date: null, detail: null },
    ],
  };
  const html = lifecycleTimelineHTML(gapLifecycle, {
    request_id: "20260709023", agency_name: "Citywide Administrative Services", pin: "85726B0067",
  });
  assert.match(html, /The city does not publish package documents as an open feed/);
  // With request_id known, deep-link RequestDetail (not bare GetFile search)
  assert.match(html, /a856-cityrecord\.nyc\.gov\/RequestDetail\/20260709023/);
  assert.match(html, /City Record/);
  assert.doesNotMatch(html, /a856-cityrecord\.nyc\.gov\/Search\/GetFile/);
  assert.doesNotMatch(html, /Not yet shown here — solicitation package/);
  // RequestDetail deep-link present; bare GetFile hunt page absent when request_id known
  // (solicitation stage may also emit RequestDetail as its source link — not a multi-GetFile hedge)
  assert.ok((html.match(/RequestDetail\/20260709023/g) || []).length >= 1);
  assert.equal((html.match(/GetFile/g) || []).length, 0);
});

// ---------------------------------------------------------------------------
// OCP award side-car render (qyyg-4tf5)
// ---------------------------------------------------------------------------

test("lifecycle OCP: unmatched collapses (no empty OCP gap paragraph)", () => {
  const data = {
    ...UNMATCHED_LIFECYCLE,
    ocp_award: {
      status: "unmatched",
      source: "ocp-recent-awards",
      join_key: null,
      detail: null,
      corroboration: null,
    },
  };
  const html = lifecycleTimelineHTML(data, notice);
  assert.doesNotMatch(html, /OCP award record/);
  assert.doesNotMatch(html, /Not yet shown here — recent OCP awards/);
  assert.doesNotMatch(html, /qyyg-4tf5/);
});

test("lifecycle OCP: matched + agreement shows corroboration copy", () => {
  const data = {
    ...FULL_LIFECYCLE,
    ocp_award: {
      status: "matched",
      source: "ocp-recent-awards",
      join_key: "request_id",
      detail: {
        request_id: "20260723031",
        pin: "81626W0043001",
        date: "2026-07-30",
        amount: 250000,
        vendor: "Make it Zesty LLC",
      },
      corroboration: {
        agree: true,
        disagreements: [],
        fields: {
          amount: { city_record: 250000, ocp: 250000, agree: true },
          date: { city_record: "2026-07-30", ocp: "2026-07-30", agree: true },
        },
      },
    },
  };
  const html = lifecycleOcpAwardHTML(data);
  assert.match(html, /Make it Zesty LLC/);
  assert.match(html, /agree on award date and amount/);
  assert.doesNotMatch(html, /disagree/);
});

test("lifecycle OCP: disagreement names both City Record and OCP amounts and dates", () => {
  const data = {
    ocp_award: {
      status: "matched",
      source: "ocp-recent-awards",
      join_key: "request_id",
      detail: {
        request_id: "20260723031",
        date: "2026-07-30",
        amount: 250000,
        vendor: "Make it Zesty LLC",
      },
      corroboration: {
        agree: false,
        disagreements: [
          {
            field: "amount",
            city_record: 999999,
            ocp: 250000,
            claim_layer: {
              version: "claim_layer_v1",
              assertions: [
                { classification: "source_assertion", source_system: "city_record", value: 999999 },
                { classification: "source_assertion", source_system: "ocp-recent-awards", value: 250000 },
              ],
              interpretation: {
                classification: "cityscroll_interpretation",
                resolution: "unresolved",
                summary: "Values differ",
              },
              derived_conclusion: null,
            },
          },
          {
            field: "date",
            city_record: "2026-07-15",
            ocp: "2026-07-30",
            claim_layer: {
              version: "claim_layer_v1",
              assertions: [
                { classification: "source_assertion", source_system: "city_record", value: "2026-07-15" },
                { classification: "source_assertion", source_system: "ocp-recent-awards", value: "2026-07-30" },
              ],
              interpretation: {
                classification: "cityscroll_interpretation",
                resolution: "unresolved",
                summary: "Values differ",
              },
              derived_conclusion: null,
            },
          },
        ],
        fields: {
          amount: { city_record: 999999, ocp: 250000, agree: false },
          date: { city_record: "2026-07-15", ocp: "2026-07-30", agree: false },
        },
      },
    },
  };
  const html = lifecycleOcpAwardHTML(data);
  assert.match(html, /disagree/);
  assert.match(html, /City Record/);
  assert.match(html, /Recent Contract Awards \(OCP\)/);
  // Both amounts present (site money() short form) — never silently prefer one
  assert.match(html, /\$1000K|\$999,999|999999/);
  assert.match(html, /\$250K|\$250,000|250000/);
  // Claim layer: source assertion vs unresolved interpretation vs no derived winner
  assert.match(html, /data-claim-layer="claim_layer_v1"/);
  assert.match(html, /source assertion/i);
  assert.match(html, /CityScroll interpretation/i);
  assert.match(html, /no derived conclusion/i);
  assert.match(html, /data-claim="source_assertion"/);
  assert.match(html, /data-claim="cityscroll_interpretation"/);
  assert.doesNotMatch(html, /data-claim="derived_conclusion"/);
});
