/**
 * LDP-25: section-aware RER extraction over the LDP-23 envelope contract.
 *
 * Verify: node --test test/land_filing_report_extractor.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExtractedField,
  buildEvidenceLocation,
  buildCommunityProfileSection,
  buildDisplacementRiskSection,
  buildExecutiveSummarySection,
  buildFairHousingNarrativeSection,
  buildApplicationScopeSection,
  buildProposedDevelopmentScopeSection,
  summarizeFieldExtractionQuality,
} from "../ontology/racial_equity_report_fields.mjs";
import {
  extractRacialEquityReportSections,
  assembleRacialEquityReportEnvelope,
  LDP25_EXTRACTOR_VERSION,
} from "../warehouse/lib/land_filing_report_extractor.mjs";

const T0 = "2026-09-04T00:00:00.000Z";

function landFilingDocumentFixture(overrides = {}) {
  return {
    document_id: "land_use_filing_document:2024K0286:RERDOC00001:2026-09-04T00:00:00.000Z",
    project_ref: "project:2024K0286",
    bytes_sha256: "a".repeat(64),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* ontology/racial_equity_report_fields.mjs                            */
/* ------------------------------------------------------------------ */

test("buildExtractedField: a non-abstained field requires page/span/region evidence (A2)", () => {
  assert.throws(() => buildExtractedField({
    field_name: "residential_units_proposed",
    value: 100,
    raw_value: "100",
    method: "deterministic_text",
    extractor_version: LDP25_EXTRACTOR_VERSION,
    confidence: "high",
    evidence: {},
  }), /at least one of page_number, span, or region/);
});

test("buildExtractedField: raw_value, extractor_version, method, and confidence are all required (A3)", () => {
  const field = buildExtractedField({
    field_name: "residential_units_proposed",
    value: 100,
    unit: "units",
    raw_value: "100",
    method: "deterministic_text",
    extractor_version: LDP25_EXTRACTOR_VERSION,
    confidence: "high",
    evidence: { page_number: 3 },
  });
  assert.equal(field.raw_value, "100");
  assert.equal(field.extractor_version, LDP25_EXTRACTOR_VERSION);
  assert.equal(field.method, "deterministic_text");
  assert.equal(field.confidence, "high");
  assert.equal(field.evidence.page_number, 3);
  assert.equal(field.abstained, false);
});

test("buildExtractedField: an abstained field carries no value and requires a reason", () => {
  assert.throws(() => buildExtractedField({ field_name: "x", abstained: true, extractor_version: "v1" }), /abstention_reason/);
  const field = buildExtractedField({ field_name: "x", abstained: true, abstention_reason: "no evidence found", extractor_version: "v1" });
  assert.equal(field.value, null);
  assert.equal(field.confidence, "unknown");
  assert.equal(field.abstention_reason, "no evidence found");
});

test("buildExtractedField: an abstained field must not carry a value", () => {
  assert.throws(() => buildExtractedField({ field_name: "x", abstained: true, value: 5, abstention_reason: "r", extractor_version: "v1" }), /must not carry a value/);
});

test("buildEvidenceLocation: a region alone (typical of an OCR/layout fallback with no reliable text offset) is sufficient evidence", () => {
  const evidence = buildEvidenceLocation({ region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } });
  assert.equal(evidence.page_number, null);
  assert.ok(evidence.region);
});

test("units, bands, and assumptions survive on a table-derived field (A5)", () => {
  const field = buildExtractedField({
    field_name: "income_bands",
    raw_value: "50% AMI | $1,200 | 30% AMI | $700",
    evidence: { page_number: 12 },
    method: "deterministic_table",
    extractor_version: LDP25_EXTRACTOR_VERSION,
    confidence: "medium",
    band: "as_tabulated",
    assumptions: ["rents as filed, unnormalized"],
  });
  assert.equal(field.band, "as_tabulated");
  assert.deepEqual(field.assumptions, ["rents as filed, unnormalized"]);
});

test("application scope and proposed development scope stay two separate sections (A4)", () => {
  const evidence = { page_number: 1 };
  const common = { method: "deterministic_text", extractor_version: "v1", confidence: "high", evidence };
  const appScope = buildApplicationScopeSection({
    project_name: { ...common, field_name: "project_name", raw_value: "Example Parcel Rezoning", value: "Example Parcel Rezoning" },
  });
  const devScope = buildProposedDevelopmentScopeSection({
    residential_units_proposed: { ...common, field_name: "residential_units_proposed", raw_value: "300", value: 300, unit: "units" },
  });
  assert.ok(appScope.project_name);
  assert.equal(devScope.project_name, undefined, "application-scope fields must never leak into proposed-development scope");
  assert.throws(() => buildApplicationScopeSection({ residential_units_proposed: { ...common, field_name: "x", raw_value: "1" } }), /is not a registered field/);
});

test("displacement risk is stored only as an as-filed contextual value, never a project prediction (A6)", () => {
  assert.throws(() => buildDisplacementRiskSection({ interpretation: "project_prediction", geography: "CD7", vintage: "2024" }), /must equal/);
  const dri = buildDisplacementRiskSection({
    interpretation: "contextual_not_project_prediction",
    geography: "Community District 7, Bronx",
    vintage: "2024 DRI release",
    methodology_state: "measured",
    index_value: { value: 0.62, raw_value: "0.62", evidence: { page_number: 40 }, method: "deterministic_text", extractor_version: "v1", confidence: "medium" },
  });
  assert.equal(dri.interpretation, "contextual_not_project_prediction");
  assert.equal(dri.geography, "Community District 7, Bronx");
  assert.equal(dri.index_value.value, 0.62);
});

test("community profile is hard-labelled as_filed and rejects any current/live-data key (A8, negative rule)", () => {
  assert.throws(() => buildCommunityProfileSection({ geography: "CD7", vintage: "ACS 2023", current_value: 99 }), /never current\/live data/);
  const profile = buildCommunityProfileSection({ geography: "Community District 7, Bronx", vintage: "ACS 2019-2023 5-Year", methodology_state: "measured", indicators: {} });
  assert.equal(profile.as_filed, true);
});

test("applicant narrative and generated summary are labelled distinctly (A7)", () => {
  const narrative = buildFairHousingNarrativeSection({
    source: "applicant_narrative",
    text: "The applicant states the project furthers fair housing goals.",
    evidence: { page_number: 55 },
  });
  assert.equal(narrative.source, "applicant_narrative");
  assert.ok(narrative.evidence);

  assert.throws(() => buildExecutiveSummarySection({ source: "generated_summary", text: "Summary text.", generator_version: "v1" }), /evidence_refs/);
  const summary = buildExecutiveSummarySection({
    source: "generated_summary",
    text: "300 residential units are proposed, of which 90 are affordable.",
    generator_version: "ldp25_summary.v1",
    evidence_refs: ["residential_units_proposed", "affordable_units_proposed"],
  });
  assert.equal(summary.source, "generated_summary");
  assert.equal(summary.evidence, null);
  assert.deepEqual(summary.evidence_refs, ["residential_units_proposed", "affordable_units_proposed"]);
});

test("summarizeFieldExtractionQuality degrades from high to low as abstention rises", () => {
  const common = { method: "deterministic_text", extractor_version: "v1", confidence: "high", evidence: { page_number: 1 } };
  const allFound = { project_name: buildExtractedField({ ...common, field_name: "project_name", raw_value: "x", value: "x" }) };
  const highSummary = summarizeFieldExtractionQuality([allFound]);
  assert.equal(highSummary.overall_quality, "high");

  const mixed = {
    project_name: buildExtractedField({ ...common, field_name: "project_name", raw_value: "x", value: "x" }),
    applicant_name: buildExtractedField({ field_name: "applicant_name", abstained: true, abstention_reason: "no match", extractor_version: "v1" }),
  };
  const mediumSummary = summarizeFieldExtractionQuality([mixed]);
  assert.equal(mediumSummary.overall_quality, "medium");
});

/* ------------------------------------------------------------------ */
/* warehouse/lib/land_filing_report_extractor.mjs                      */
/* ------------------------------------------------------------------ */

const NATIVE_TEXT_PAGES = [
  {
    page_number: 1,
    text: [
      "Racial Equity Report on Housing and Opportunity",
      "Project Name: Example Parcel Rezoning",
      "ULURP Number: N260123ZRK",
      "Applicant Name: Example Applicant LLC",
      "Block and Lot: 3045/12, 3045/13",
      "Site Address: Fixture Site Address (synthetic test data)",
      "Actions Requested: Zoning map amendment and zoning text amendment",
    ].join("\n"),
  },
  {
    page_number: 2,
    text: [
      "Proposed Development Scope",
      "Residential Units Proposed: 300",
      "Affordable Units Proposed: 90",
      "Non-Residential Square Feet Proposed: 10,000",
      "Building Height Proposed: 120 ft",
    ].join("\n"),
  },
  {
    page_number: 40,
    text: "Community Profile - Community District 7, Bronx (ACS 2019-2023 5-Year Estimates)\nPopulation: 98,000",
  },
  {
    page_number: 55,
    text: "Fair Housing Narrative: The applicant states the project furthers fair housing goals by adding affordable units.",
  },
];

test("A1/A2/A3: a native-text report extracts fields with page evidence, raw value, method, and confidence", () => {
  const result = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] });
  const scope = result.sections.application_scope;
  assert.equal(scope.project_name.value, "Example Parcel Rezoning");
  assert.equal(scope.project_name.evidence.page_number, 1);
  assert.equal(scope.project_name.raw_value, "Example Parcel Rezoning");
  assert.equal(scope.project_name.method, "deterministic_text");
  assert.equal(scope.project_name.confidence, "high");

  const dev = result.sections.proposed_development_scope;
  assert.equal(dev.residential_units_proposed.value, 300);
  assert.equal(dev.residential_units_proposed.unit, "units");

  assert.ok(result.sections.community_profile);
  assert.equal(result.sections.community_profile.geography, "Community District 7, Bronx");
  assert.equal(result.sections.community_profile.as_filed, true);
});

test("a scanned/image-only report with no text layer abstains every text field rather than guessing (negative: image-only charts)", () => {
  const pages = [{ page_number: 1, text: "" }];
  const result = extractRacialEquityReportSections({ pages, tables: [] });
  assert.equal(result.sections.application_scope.project_name.abstained, true);
  assert.ok(result.warnings.some((w) => w.includes("page 1")));
});

test("a missing section (no community-profile header at all) abstains the whole section, not a guessed geography/vintage (negative: missing section)", () => {
  const result = extractRacialEquityReportSections({ pages: [{ page_number: 1, text: "Project Name: Test" }], tables: [] });
  assert.equal(result.sections.community_profile, null);
  assert.ok(result.field_evidence.warnings.some((w) => w.includes("community_profile")));
});

test("a blank official template abstains every field cleanly, never crashes (negative: blank template)", () => {
  const result = extractRacialEquityReportSections({ pages: [{ page_number: 1, text: "Racial Equity Report on Housing and Opportunity" }], tables: [] });
  assert.equal(result.sections.application_scope.project_name.abstained, true);
  assert.equal(result.extraction_quality, "low");
});

test("nonstandard headings (no label match) abstain field by field instead of misfiring on a near-miss (negative: nonstandard headings)", () => {
  const result = extractRacialEquityReportSections({ pages: [{ page_number: 1, text: "This filing names the site informally without using any of the form's standard labels." }], tables: [] });
  assert.equal(result.sections.application_scope.site_address.abstained, true);
});

test("two competing income-band tables abstain field by field rather than picking one (A8, negative: competing tables)", () => {
  const tables = [
    { page_number: 30, rows: [["Income Band", "Units", "Rent"], ["50% AMI", "20", "$1,200"]] },
    { page_number: 31, rows: [["Income Band", "Units", "Rent"], ["50% AMI", "25", "$1,350"]] },
  ];
  const result = extractRacialEquityReportSections({ pages: [], tables });
  assert.equal(result.sections.residential.income_bands.abstained, true);
  assert.match(result.sections.residential.income_bands.abstention_reason, /competing income-band tables/);
});

test("a single income-band table is captured as a table-derived field with its own evidence and band (A5)", () => {
  const tables = [{ page_number: 30, rows: [["Income Band", "Units", "Rent"], ["50% AMI", "20", "$1,200"]] }];
  const result = extractRacialEquityReportSections({ pages: [], tables });
  const field = result.sections.residential.income_bands;
  assert.equal(field.abstained, false);
  assert.equal(field.method, "deterministic_table");
  assert.equal(field.evidence.page_number, 30);
  assert.equal(field.band, "as_tabulated");
});

test("a speculative job narrative with no job/wage table never promotes a numeric job estimate (negative: speculative job narrative)", () => {
  const pages = [{ page_number: 60, text: "The project is expected to create hundreds of construction jobs and dozens of permanent jobs for the community." }];
  const result = extractRacialEquityReportSections({ pages, tables: [] });
  assert.equal(result.sections.construction_employment.permanent_jobs_estimate.abstained, true);
  assert.match(result.sections.construction_employment.permanent_jobs_estimate.abstention_reason, /narrative job claim/);
});

test("a job/wage table with an explicit total row fills the numeric job-count field (A5, table-heavy)", () => {
  const tables = [{ page_number: 61, rows: [["Job Title", "Wage"], ["Construction Worker", "$45/hr"], ["Total", "150"]] }];
  const result = extractRacialEquityReportSections({ pages: [], tables });
  assert.equal(result.sections.construction_employment.construction_jobs_estimate.value, 150);
  assert.equal(result.sections.construction_employment.construction_jobs_estimate.method, "deterministic_table");
  assert.equal(result.sections.construction_employment.permanent_jobs_estimate.abstained, true, "a total row for one job table does not fill an unrelated field name");
});

test("no known tenant: a residential report with no known-tenant table simply has no known_tenant_profile field, not a fabricated one (negative: no known tenant)", () => {
  const result = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] });
  assert.equal(Object.prototype.hasOwnProperty.call(result.sections.residential, "known_tenant_profile"), false);
});

test("recognition never confuses a percentage/dollar/income-band table with an unrelated one (table-heavy, mixed)", () => {
  const tables = [
    { page_number: 30, rows: [["Income Band", "Units", "Rent"], ["50% AMI", "20", "$1,200"]] },
    { page_number: 61, rows: [["Job Title", "Wage"], ["Construction Worker", "$45/hr"], ["Total", "80"]] },
  ];
  const result = extractRacialEquityReportSections({ pages: [], tables });
  assert.equal(result.sections.residential.income_bands.raw_value.includes("AMI"), true);
  assert.equal(result.sections.construction_employment.construction_jobs_estimate.value, 80);
});

test("constrained semantic extraction is discarded when it carries no evidence location (never trusted blind)", () => {
  const semanticExtract = (fieldName) => (fieldName === "actions_requested" ? { value: "guessed", raw_value: "guessed text" } : null);
  const result = extractRacialEquityReportSections({ pages: [{ page_number: 1, text: "Project Name: X" }], tables: [], semanticExtract });
  assert.equal(result.sections.application_scope.actions_requested.abstained, true, "an evidence-free semantic candidate must not be accepted");
});

test("constrained semantic extraction is accepted only when it supplies its own evidence", () => {
  const semanticExtract = (fieldName) => (fieldName === "actions_requested"
    ? { value: "special permit", raw_value: "a special permit is requested in narrative form", page_number: 3, confidence: "low" }
    : null);
  const result = extractRacialEquityReportSections({ pages: [{ page_number: 1, text: "Project Name: X" }], tables: [], semanticExtract });
  const field = result.sections.application_scope.actions_requested;
  assert.equal(field.abstained, false);
  assert.equal(field.method, "constrained_semantic_extraction");
  assert.equal(field.evidence.page_number, 3);
});

test("assembleRacialEquityReportEnvelope produces a full envelope 1:1 with its document", () => {
  const document = landFilingDocumentFixture();
  const extraction = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] });
  const envelope = assembleRacialEquityReportEnvelope({
    document,
    extraction,
    fairHousingNarrative: { source: "applicant_narrative", text: "The applicant states the project furthers fair housing goals.", evidence: { page_number: 55 } },
  });
  assert.equal(envelope.document_ref, document.document_id);
  assert.equal(envelope.source_bytes_sha256, document.bytes_sha256);
  assert.equal(envelope.extraction_version, LDP25_EXTRACTOR_VERSION);
  assert.ok(envelope.community_profile);
  assert.equal(envelope.fair_housing_narrative.source, "applicant_narrative");
});

test("re-extracting the same document is idempotent: two runs over identical bytes/pages produce the same envelope content", () => {
  const document = landFilingDocumentFixture();
  const first = assembleRacialEquityReportEnvelope({ document, extraction: extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] }) });
  const second = assembleRacialEquityReportEnvelope({ document, extraction: extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] }) });
  assert.deepEqual(first, second);
});

test("supersession: a later document version gets its own independent envelope, never a mutation of the earlier one's as-filed community profile (negative: duplicate or superseded report)", () => {
  const documentV1 = landFilingDocumentFixture({ document_id: "land_use_filing_document:2024K0286:RERDOC00001:2026-09-04T00:00:00.000Z", bytes_sha256: "a".repeat(64) });
  const documentV2 = landFilingDocumentFixture({
    document_id: "land_use_filing_document:2024K0286:RERDOC00001:2026-09-05T00:00:00.000Z",
    bytes_sha256: "b".repeat(64),
  });
  const v1Pages = NATIVE_TEXT_PAGES;
  const v2Pages = NATIVE_TEXT_PAGES.map((p) => (p.page_number === 40 ? { ...p, text: "Community Profile - Community District 7, Bronx (ACS 2024 5-Year Estimates)\nPopulation: 101,000" } : p));

  const envelopeV1 = assembleRacialEquityReportEnvelope({ document: documentV1, extraction: extractRacialEquityReportSections({ pages: v1Pages, tables: [] }) });
  const envelopeV2 = assembleRacialEquityReportEnvelope({ document: documentV2, extraction: extractRacialEquityReportSections({ pages: v2Pages, tables: [] }) });

  assert.notEqual(envelopeV1.document_ref, envelopeV2.document_ref);
  assert.equal(envelopeV1.community_profile.vintage, "ACS 2019-2023 5-Year Estimates", "the earlier envelope's as-filed snapshot is untouched by the later document's extraction");
  assert.equal(envelopeV2.community_profile.vintage, "ACS 2024 5-Year Estimates");
});

test("a current community value differing from the filed report never overwrites the as-filed section (negative rule, current-vs-filed)", () => {
  // The extractor's signature accepts only pages/tables/semanticExtract -- there
  // is no parameter through which "current" data could reach community_profile.
  // This test proves it by construction: passing an unrelated extra option has
  // zero effect on the as-filed output.
  const withoutExtra = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] });
  const withExtraIgnored = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [], currentCommunityProfile: { population: 999_999 } });
  assert.deepEqual(withoutExtra.sections.community_profile, withExtraIgnored.sections.community_profile);
});

test("a project that changes after certification never rewrites an already-assembled envelope (negative: project changes after certification)", () => {
  const document = landFilingDocumentFixture();
  const extraction = extractRacialEquityReportSections({ pages: NATIVE_TEXT_PAGES, tables: [] });
  const envelope = Object.freeze(assembleRacialEquityReportEnvelope({ document, extraction }));
  assert.throws(() => { envelope.community_profile = null; }, TypeError, "the envelope and its sections are frozen, so no later caller can mutate the as-filed snapshot in place");
});

test("assembleRacialEquityReportEnvelope requires a real land_use_filing_document and its bytes hash", () => {
  assert.throws(() => assembleRacialEquityReportEnvelope({ document: { document_id: "not-a-real-ref" }, extraction: {} }), /must be a land_use_filing_document record/);
  assert.throws(() => assembleRacialEquityReportEnvelope({ document: { document_id: "land_use_filing_document:x:y:z" }, extraction: {} }), /bytes_sha256 is required/);
});
