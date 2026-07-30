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
  extractConst("PASSPORT_CONTRACTS_URL") +
  extractConst("PASSPORT_RFX_URL") +
  extractFn("lifecycleStageLabel") +
  extractFn("lifecycleAmount") +
  extractFn("lifecycleSourceName") +
  extractFn("lifecycleSourceLink") +
  extractFn("lifecycleStageHTML") +
  extractFn("lifecycleTimelineHTML") +
  "return { lifecycleStageLabel, lifecycleAmount, lifecycleSourceLink, lifecycleStageHTML, lifecycleTimelineHTML };"
);

const {
  lifecycleStageLabel,
  lifecycleAmount,
  lifecycleSourceLink,
  lifecycleStageHTML,
  lifecycleTimelineHTML,
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

  // Source links
  assert.match(html, /a856-cityrecord\.nyc\.gov/);
  assert.match(html, /checkbooknyc\.com/);
});

test("lifecycle: matched stages have green box class", () => {
  const html = lifecycleTimelineHTML(FULL_LIFECYCLE, notice);
  assert.match(html, /class="box matched"/);
});

test("lifecycle: connectors between stages", () => {
  const html = lifecycleTimelineHTML(FULL_LIFECYCLE, notice);
  const connectors = (html.match(/class="connector"/g) || []).length;
  assert.equal(connectors, 3, "4 stages = 3 connectors");
});

test("lifecycle: registered stage shows spent-to-date percentage", () => {
  const html = lifecycleTimelineHTML(FULL_LIFECYCLE, notice);
  assert.match(html, /\$1\.50M \/ \$5\.00M \(30%\)/);
  assert.match(html, /class="lbar"/);
});

test("lifecycle: payment stage shows payment count and latest", () => {
  const html = lifecycleTimelineHTML(FULL_LIFECYCLE, notice);
  assert.match(html, /3 payments/);
  assert.match(html, /Latest:/);
  assert.match(html, /\$250K/);
});

test("lifecycle: provenance note names City Record, Checkbook, PASSPort, and the PIN", () => {
  const html = lifecycleTimelineHTML(FULL_LIFECYCLE, notice);
  assert.match(html, /This timeline joins/);
  assert.match(html, /City Record/);
  assert.match(html, /Checkbook NYC/);
  assert.match(html, /PASSPort Public/);
  assert.match(html, /<code>08250R0001001<\/code>/);
});

// ---------------------------------------------------------------------------
// 2. UNMATCHED: specific "no record found" statements (never blank)
// ---------------------------------------------------------------------------

test("lifecycle: unmatched stages render specific statements, never blank", () => {
  const html = lifecycleTimelineHTML(UNMATCHED_LIFECYCLE, notice);
  assert.match(html, /class="box unmatched"/);

  const norecordDivs = (html.match(/class="lc-norecord"/g) || []).length;
  assert.equal(norecordDivs, 3, "pending + registered + payment each have a no-record statement");

  // Two-register class-(a) copy: not-yet-ingested, per-stage specificity
  assert.match(html, /Not yet shown here/);
  assert.match(html, /pending contracts live in/);
  assert.match(html, /registered contracts live in/);
  assert.match(html, /payments live in/);

  // Each names the source
  const checkbookCount = (html.match(/Checkbook NYC/g) || []).length;
  assert.ok(checkbookCount >= 3, "each unmatched statement names Checkbook NYC");
});

// ---------------------------------------------------------------------------
// 3. UNKNOWN: could-not-reach statements
// ---------------------------------------------------------------------------

test("lifecycle: unknown stages render 'could not reach' statements", () => {
  const html = lifecycleTimelineHTML(UNKNOWN_LIFECYCLE, notice);
  assert.match(html, /class="box unknown"/);

  const norecordDivs = (html.match(/class="lc-norecord"/g) || []).length;
  assert.equal(norecordDivs, 3, "each unknown stage has a statement");

  assert.match(html, /Could not reach/);
});

// ---------------------------------------------------------------------------
// 4. AMBIGUOUS: candidates list
// ---------------------------------------------------------------------------

test("lifecycle: ambiguous stage lists candidates", () => {
  const html = lifecycleTimelineHTML(AMBIGUOUS_LIFECYCLE, notice);
  assert.match(html, /class="box ambiguous"/);
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

test("lifecycleSourceLink: checkbook-spending links to spending search", () => {
  const link = lifecycleSourceLink({
    source: "checkbook-spending",
    detail: null,
  });
  assert.match(link, /checkbooknyc\.com\/spending_search/);
});

// ---------------------------------------------------------------------------
// 7. LABELS + AMOUNTS
// ---------------------------------------------------------------------------

test("lifecycleStageLabel: maps each stage to a human-readable label", () => {
  assert.equal(lifecycleStageLabel("solicitation"), "Solicitation");
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
  assert.match(html, /class="box matched"/);
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
});
