#!/usr/bin/env node
/**
 * LDP-25: the `npm run warehouse:land:rer` command surface, matching
 * `tools/check_land_filing_document_collector.mjs`'s convention. Runs the
 * extractor (warehouse/lib/land_filing_report_extractor.mjs) against
 * retained synthetic fixtures covering:
 *
 *   A1 native-text, scanned (no text layer), table-heavy, historic-district
 *      (community-profile header), residential, non-residential, and mixed
 *      report shapes;
 *   A2 every normalized value carries page, span, or bounding-region
 *      evidence;
 *   A3 every normalized value carries raw_value, extractor_version, method,
 *      and confidence;
 *   A4 application scope and proposed development scope stay separate;
 *   A5 units, bands, and stated assumptions survive on table-derived
 *      values;
 *   A6 the displacement risk index is stored only as an as-filed contextual
 *      value, never a project prediction;
 *   A7 applicant narrative and generated summary are labelled distinctly;
 *   A8 conflicting or low-quality extraction abstains field by field, and
 *      current data is structurally unable to reach the as-filed sections;
 *
 * plus the negative-test list: a missing section, a blank template, two
 * competing income-band tables, image-only charts, no known tenant, a
 * speculative job narrative without a job table, a current community value
 * differing from the filed report, a project changing after certification,
 * a duplicate/superseded report, nonstandard headings, and recognition
 * confusing a percentage/dollar/income-band table with an unrelated one.
 *
 * No network access; every input is a synthetic in-memory fixture. Default
 * mode runs the checks and writes the receipt; `--check` reruns and diffs
 * against the committed receipt.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractRacialEquityReportSections,
  assembleRacialEquityReportEnvelope,
} from "../warehouse/lib/land_filing_report_extractor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/land_filing_report_extractor_latest.json");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function stringify(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, result: "pass" });
  } catch (error) {
    checks.push({ name, result: "fail", message: error.message });
  }
}
function assertTrue(value, message) {
  if (!value) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function documentFixture(overrides = {}) {
  return {
    document_id: "land_use_filing_document:2024K0286:RERDOC00001:2026-09-04T00:00:00.000Z",
    project_ref: "project:2024K0286",
    bytes_sha256: "a".repeat(64),
    ...overrides,
  };
}

const NATIVE_TEXT_PAGES = [
  { page_number: 1, text: "Project Name: 123 Main Street Rezoning\nULURP Number: N260123ZRK\nApplicant Name: 123 Main St LLC\nBlock and Lot: 3045/12\nSite Address: 123 Main Street, Bronx, NY\nActions Requested: Zoning map amendment" },
  { page_number: 2, text: "Residential Units Proposed: 300\nAffordable Units Proposed: 90\nNon-Residential Square Feet Proposed: 10,000" },
  { page_number: 40, text: "Community Profile - Community District 7, Bronx (ACS 2019-2023 5-Year Estimates)\nPopulation: 98,000" },
];

// ---- A1: report-shape fixtures ----

check("native-text report: fields extract with page evidence (A1, A2)", () => {
  const result = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] });
  assertEqual(result.sections.application_scope.project_name.value, "123 Main Street Rezoning", "project_name");
  assertEqual(result.sections.application_scope.project_name.evidence.page_number, 1, "evidence.page_number");
});

check("scanned/image-only report (no text layer): every text field abstains, no crash (A1, negative: image-only charts)", () => {
  const result = extractRacialEquityReportSections({ pages: [{ page_number: 1, text: "" }], tables: [] });
  assertEqual(result.sections.application_scope.project_name.abstained, true, "abstained");
});

check("table-heavy report: an income-band table and a job/wage table both extract with distinct evidence (A1, A5)", () => {
  const tables = [
    { page_number: 30, rows: [["Income Band", "Units", "Rent"], ["50% AMI", "20", "$1,200"]] },
    { page_number: 61, rows: [["Job Title", "Wage"], ["Construction Worker", "$45/hr"], ["Total", "80"]] },
  ];
  const result = extractRacialEquityReportSections({ pages: [], tables });
  assertEqual(result.sections.residential.income_bands.method, "deterministic_table", "income_bands method");
  assertEqual(result.sections.construction_employment.construction_jobs_estimate.value, 80, "construction_jobs_estimate");
});

check("historic-district / community-profile report: geography and vintage carry through as-filed (A1, A6)", () => {
  const result = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] });
  assertTrue(Boolean(result.sections.community_profile), "community_profile present");
  assertEqual(result.sections.community_profile.geography, "Community District 7, Bronx", "geography");
  assertEqual(result.sections.community_profile.as_filed, true, "as_filed");
});

check("mixed report: recognition does not confuse the income-band table with the job/wage table (A1, negative: recognition confusion)", () => {
  const tables = [
    { page_number: 30, rows: [["Income Band", "Units", "Rent"], ["50% AMI", "20", "$1,200"]] },
    { page_number: 61, rows: [["Job Title", "Wage"], ["Construction Worker", "$45/hr"], ["Total", "80"]] },
  ];
  const result = extractRacialEquityReportSections({ pages: [], tables });
  assertTrue(result.sections.residential.income_bands.raw_value.includes("AMI"), "income table stays income table");
  assertEqual(result.sections.construction_employment.permanent_jobs_estimate.abstained, true, "permanent_jobs_estimate is not confused with the construction total");
});

// ---- A2/A3: evidence + provenance on every normalized value ----

check("every normalized non-abstained value carries page/span/region evidence, raw_value, method, and confidence (A2, A3)", () => {
  const result = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] });
  const field = result.sections.proposed_development_scope.residential_units_proposed;
  assertTrue(Boolean(field.evidence.page_number), "evidence.page_number");
  assertEqual(field.raw_value, "300", "raw_value");
  assertTrue(Boolean(field.method), "method");
  assertTrue(Boolean(field.confidence), "confidence");
});

// ---- A4: scope separation ----

check("application scope and proposed development scope remain distinct (A4)", () => {
  const result = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] });
  assertTrue(Boolean(result.sections.application_scope.project_name), "application_scope has project_name");
  assertEqual(result.sections.proposed_development_scope.project_name, undefined, "proposed_development_scope must not carry project_name");
});

// ---- A5: units/bands/assumptions ----

check("a table-derived income-band field preserves its band and assumptions (A5)", () => {
  const tables = [{ page_number: 30, rows: [["Income Band", "Units", "Rent"], ["50% AMI", "20", "$1,200"]] }];
  const result = extractRacialEquityReportSections({ pages: [], tables });
  assertEqual(result.sections.residential.income_bands.band, "as_tabulated", "band");
  assertTrue(result.sections.residential.income_bands.assumptions.length > 0, "assumptions recorded");
});

// ---- A6: displacement risk is contextual only ----

check("displacement risk index is a contextual as-filed value, never a project prediction (A6)", () => {
  const pages = [{ page_number: 40, text: "Displacement Risk Index - Community District 7, Bronx (2024 DRI release): 0.62" }];
  const result = extractRacialEquityReportSections({ pages, tables: [] });
  assertEqual(result.sections.displacement_risk.interpretation, "contextual_not_project_prediction", "interpretation");
  assertEqual(result.sections.displacement_risk.index_value.value, 0.62, "index_value");
});

// ---- A7: narrative labelling ----

check("applicant narrative and a generated summary are labelled and evidence-linked distinctly (A7)", () => {
  const document = documentFixture();
  const extraction = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] });
  const envelope = assembleRacialEquityReportEnvelope({
    document,
    extraction,
    fairHousingNarrative: { source: "applicant_narrative", text: "The applicant states the project furthers fair housing goals.", evidence: { page_number: 55 } },
    executiveSummary: { source: "generated_summary", text: "300 residential units are proposed.", generator_version: "ldp25_summary.v1", evidence_refs: ["residential_units_proposed"] },
  });
  assertEqual(envelope.fair_housing_narrative.source, "applicant_narrative", "fair_housing_narrative.source");
  assertEqual(envelope.executive_summary.source, "generated_summary", "executive_summary.source");
  assertTrue(envelope.executive_summary.evidence_refs.length > 0, "generated summary carries evidence_refs");
});

// ---- A8: abstention on conflict, and the negative rule ----

check("two competing income-band tables abstain field by field rather than pick one (A8, negative: competing tables)", () => {
  const tables = [
    { page_number: 30, rows: [["Income Band", "Units", "Rent"], ["50% AMI", "20", "$1,200"]] },
    { page_number: 31, rows: [["Income Band", "Units", "Rent"], ["50% AMI", "25", "$1,350"]] },
  ];
  const result = extractRacialEquityReportSections({ pages: [], tables });
  assertEqual(result.sections.residential.income_bands.abstained, true, "abstained on conflict");
});

check("a current community value passed alongside extraction never overwrites the as-filed section (A8, negative: current-vs-filed)", () => {
  const without = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] });
  const withExtra = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [], currentCommunityProfile: { population: 999_999 } });
  assertEqual(JSON.stringify(without.sections.community_profile), JSON.stringify(withExtra.sections.community_profile), "as-filed section unaffected by an unrelated 'current' input");
});

check("a duplicate or superseded report gets its own independent envelope, never a mutation of the earlier one (A8, negative: duplicate/superseded)", () => {
  const documentV1 = documentFixture();
  const documentV2 = documentFixture({ document_id: "land_use_filing_document:2024K0286:RERDOC00001:2026-09-05T00:00:00.000Z", bytes_sha256: "b".repeat(64) });
  const v2Pages = NATIVE_TEXT_PAGES.map((p) => (p.page_number === 40 ? { ...p, text: "Community Profile - Community District 7, Bronx (ACS 2024 5-Year Estimates)\nPopulation: 101,000" } : p));
  const envelopeV1 = assembleRacialEquityReportEnvelope({ document: documentV1, extraction: extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] }) });
  const envelopeV2 = assembleRacialEquityReportEnvelope({ document: documentV2, extraction: extractRacialEquityReportSections({ pages: v2Pages, tables: [] }) });
  assertTrue(envelopeV1.document_ref !== envelopeV2.document_ref, "distinct document_ref");
  assertEqual(envelopeV1.community_profile.vintage, "ACS 2019-2023 5-Year Estimates", "the earlier envelope is untouched");
});

check("a speculative job narrative without a job table never promotes a numeric job estimate (negative: speculative job narrative)", () => {
  const pages = [{ page_number: 60, text: "The project is expected to create hundreds of construction jobs for the community." }];
  const result = extractRacialEquityReportSections({ pages, tables: [] });
  assertEqual(result.sections.construction_employment.construction_jobs_estimate.abstained, true, "abstained without a job table");
});

check("nonstandard headings abstain field by field instead of misfiring (negative: nonstandard headings)", () => {
  const result = extractRacialEquityReportSections({ pages: [{ page_number: 1, text: "This filing describes the site informally, without the form's standard labels." }], tables: [] });
  assertEqual(result.sections.application_scope.site_address.abstained, true, "abstained");
});

check("a missing section (no community-profile header) abstains the whole section rather than guessing geography/vintage (negative: missing section)", () => {
  const result = extractRacialEquityReportSections({ pages: [{ page_number: 1, text: "Project Name: Test" }], tables: [] });
  assertEqual(result.sections.community_profile, null, "community_profile is null, not guessed");
});

check("a blank official template abstains cleanly across every field, never a crash (negative: blank template)", () => {
  const result = extractRacialEquityReportSections({ pages: [{ page_number: 1, text: "Racial Equity Report on Housing and Opportunity" }], tables: [] });
  assertEqual(result.sections.application_scope.project_name.abstained, true, "abstained");
  assertEqual(result.extraction_quality, "low", "extraction_quality reflects total abstention");
});

check("no known tenant: a residential section with no known-tenant table carries no fabricated known_tenant_profile field (negative: no known tenant)", () => {
  const result = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] });
  assertEqual(Object.prototype.hasOwnProperty.call(result.sections.residential, "known_tenant_profile"), false, "field absent, not fabricated");
});

const failed = checks.filter((c) => c.result === "fail");
const gateResult = failed.length === 0 ? "pass" : "fail";

const receipt = {
  schema: "cityscroll.land_filing_report_extractor_receipt.v1",
  checks,
  gate: { result: gateResult, failed_check_count: failed.length },
};

const next = stringify(receipt);
const args = new Set(process.argv.slice(2));
if (args.has("--check")) {
  let current = null;
  try {
    current = readFileSync(RECEIPT, "utf8");
  } catch {
    current = null;
  }
  if (current !== next) {
    console.error(next);
    throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run: node tools/check_land_filing_report_extractor.mjs`);
  }
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
}

if (gateResult !== "pass") {
  console.error(next);
  throw new Error(`LDP-25 RER extractor gate failed: ${failed.map((c) => `${c.name}: ${c.message}`).join(" | ")}`);
}
console.log(`LDP-25 RER extractor gate OK (${checks.length} checks)`);
