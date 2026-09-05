/**
 * LDP-25: section-aware RER (Racial Equity Report on Housing and
 * Opportunity) extraction over the LDP-23 envelope contract and the LDP-25
 * field schema (ontology/racial_equity_report_fields.mjs).
 *
 * Pipeline order, per field, never reordered:
 *   1. deterministic text  -- explicit-label regex match against a page's
 *      text layer (or an injected OCR/layout text substitute -- this module
 *      does not care which produced the string, only what quality
 *      (warehouse/lib/document_processing.mjs#assessPageQuality) that page
 *      carries).
 *   2. deterministic table -- header-keyword matching against already-parsed
 *      table rows (income-band, job/wage tables). Two candidate tables that
 *      disagree on the same band never get silently reconciled by picking
 *      one; the field abstains with the conflict named.
 *   3. constrained semantic extraction -- only for fields still missing
 *      after 1-2, and only via an injected `semanticExtract(fieldName,
 *      context)` function so no live model call happens inside this module
 *      or its tests. Its result is discarded unless it carries its own
 *      evidence (raw_value + page/span/region); an evidence-free semantic
 *      guess is treated as no result, never trusted.
 *   4. abstention -- any field neither 1, 2, nor 3 filled, or that stage 2
 *      flagged as conflicting, is built via
 *      buildExtractedField({ abstained: true, abstention_reason }).
 *
 * Numeric job/wage fields (permanent_jobs_estimate, construction_jobs_estimate)
 * are never promoted from narrative alone: without a matching job/wage table,
 * they abstain and any narrative job claim lands only in the labelled
 * `workforce_claims` field -- this is what keeps a speculative jobs narrative
 * from reading as a project's adopted job count.
 *
 * This module accepts no "current"/live data source of any kind -- its only
 * inputs are the document's own pages/tables and an injected semantic
 * extractor. The negative rule (current data must never overwrite a
 * historical filed value) is enforced by this absence, not by a runtime
 * check: there is no parameter here a caller could wire live data into.
 */
import { assessPageQuality } from "./document_processing.mjs";
import {
  APPLICATION_SCOPE_FIELDS,
  PROPOSED_DEVELOPMENT_SCOPE_FIELDS,
  RESIDENTIAL_SECTION_FIELDS,
  NON_RESIDENTIAL_SECTION_FIELDS,
  CONSTRUCTION_EMPLOYMENT_SECTION_FIELDS,
  COMMUNITY_PROFILE_INDICATOR_FIELDS,
  buildExtractedField,
  buildApplicationScopeSection,
  buildProposedDevelopmentScopeSection,
  buildResidentialSection,
  buildNonResidentialSection,
  buildConstructionEmploymentSection,
  buildCommunityProfileSection,
  buildDisplacementRiskSection,
  buildExecutiveSummarySection,
  buildFairHousingNarrativeSection,
  summarizeFieldExtractionQuality,
} from "../../ontology/racial_equity_report_fields.mjs";
import { buildRacialEquityReportEnvelope } from "../../ontology/land_use_filing.mjs";

export const LDP25_EXTRACTOR_VERSION = "ldp25_rer_extractor.v1";

const JOB_TABLE_ONLY_FIELDS = Object.freeze(["permanent_jobs_estimate", "construction_jobs_estimate"]);

/* ------------------------------------------------------------------ */
/* Stage 1: deterministic text                                         */
/* ------------------------------------------------------------------ */

// Explicit-label patterns only -- never a bare number scan. Each entry's
// first capture group is the raw value; matched against page text in page
// order, first match wins per field (the form is not expected to repeat a
// top-line label across pages for a different value).
const DETERMINISTIC_TEXT_PATTERNS = Object.freeze({
  project_name: [/project\s*name\s*[:\-]\s*([^\n]{2,200})/i],
  ulurp_number: [/ULURP\s*(?:application\s*)?(?:number|no\.?|#)\s*[:\-]\s*([A-Z0-9]{5,12})/i],
  applicant_name: [/applicant\s*(?:name)?\s*[:\-]\s*([^\n]{2,200})/i],
  block_and_lot: [/block(?:s)?\s*(?:and|\/)\s*lot(?:s)?\s*[:\-]\s*([0-9,\s/]{1,120})/i],
  site_address: [/(?:project|site)\s*address\s*[:\-]\s*([^\n]{2,200})/i],
  actions_requested: [/actions?\s*requested\s*[:\-]\s*([^\n]{2,400})/i],
  residential_units_proposed: [/(?:proposed\s*)?residential\s*units\s*(?:proposed)?\s*[:\-]\s*([\d,]+)/i],
  affordable_units_proposed: [/(?:proposed\s*)?affordable\s*units\s*(?:proposed)?\s*[:\-]\s*([\d,]+)/i],
  non_residential_square_feet_proposed: [/(?:proposed\s*)?non-?residential\s*(?:square\s*feet|sf)\s*(?:proposed)?\s*[:\-]\s*([\d,]+)/i],
  building_height_or_far_proposed: [/(?:proposed\s*)?(?:building\s*height|far)\s*(?:proposed)?\s*[:\-]\s*([\d.]+\s*(?:ft|feet|far)?)/i],
  residential_square_feet: [/residential\s*(?:square\s*feet|sf)\s*[:\-]\s*([\d,]+)/i],
  non_residential_square_feet: [/non-?residential\s*(?:square\s*feet|sf)\s*[:\-]\s*([\d,]+)/i],
  non_residential_use_types: [/non-?residential\s*use\s*types?\s*[:\-]\s*([^\n]{2,300})/i],
});

const NUMERIC_UNIT_BY_FIELD = Object.freeze({
  residential_units_proposed: "units",
  affordable_units_proposed: "units",
  non_residential_square_feet_proposed: "square_feet",
  residential_square_feet: "square_feet",
  non_residential_square_feet: "square_feet",
});

function parseNumeric(rawValue) {
  const cleaned = rawValue.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return cleaned ? Number(cleaned[0]) : null;
}

function runDeterministicTextStage({ pages, fieldNames, extractorVersion }) {
  const found = {};
  for (const fieldName of fieldNames) {
    const patterns = DETERMINISTIC_TEXT_PATTERNS[fieldName];
    if (!patterns) continue;
    for (const page of pages) {
      const text = page.text || "";
      let match = null;
      for (const pattern of patterns) {
        match = pattern.exec(text);
        if (match) break;
      }
      if (!match) continue;
      const rawValue = match[1].trim();
      const unit = NUMERIC_UNIT_BY_FIELD[fieldName] ?? null;
      const numeric = unit ? parseNumeric(rawValue) : null;
      found[fieldName] = buildExtractedField({
        field_name: fieldName,
        value: unit ? numeric : rawValue,
        unit,
        raw_value: rawValue,
        evidence: { page_number: page.page_number },
        method: "deterministic_text",
        extractor_version: extractorVersion,
        confidence: "high",
      });
      break;
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Stage 2: deterministic table                                        */
/* ------------------------------------------------------------------ */

function headerRowOf(table) {
  return (table.rows?.[0] || []).map((c) => String(c ?? "").toLowerCase());
}

function isIncomeBandTable(table) {
  const header = headerRowOf(table);
  return header.some((c) => c.includes("income") && c.includes("band")) || (
    header.some((c) => c.includes("income")) && header.some((c) => c.includes("unit") || c.includes("rent"))
  );
}

function isJobWageTable(table) {
  const header = headerRowOf(table);
  return header.some((c) => c.includes("job") || c.includes("position")) && header.some((c) => c.includes("wage") || c.includes("salary"));
}

function tableToRawSummary(table) {
  return table.rows.map((r) => r.join(" | ")).join("; ").slice(0, 1_000);
}

/**
 * Extract income-band-derived fields from every candidate income-band table
 * found. If more than one candidate table exists and they disagree (a
 * different raw summary), this is a genuine conflict per the card's own
 * negative test ("two competing income-band tables"): the caller gets back
 * `conflict: true` and no field, so the orchestrator abstains explicitly
 * rather than picking one table over the other.
 */
function runIncomeBandTableExtraction({ tables, extractorVersion }) {
  const candidates = tables.filter(isIncomeBandTable);
  if (candidates.length === 0) return { fields: {}, conflict: false };
  const distinctSummaries = new Set(candidates.map(tableToRawSummary));
  if (distinctSummaries.size > 1) {
    return { fields: {}, conflict: true, conflictingTableCount: candidates.length };
  }
  const table = candidates[0];
  const rawSummary = tableToRawSummary(table);
  const evidence = { page_number: table.page_number, region: table.region ?? undefined };
  const fields = {};
  for (const fieldName of ["income_bands", "rents_by_band", "sale_prices_by_band", "eligible_incomes_by_band"]) {
    fields[fieldName] = buildExtractedField({
      field_name: fieldName,
      value: null,
      raw_value: rawSummary,
      evidence,
      method: "deterministic_table",
      extractor_version: extractorVersion,
      confidence: "medium",
      band: "as_tabulated",
      assumptions: ["value left unnormalized (raw table text only); band membership is the table's own stated bands"],
    });
  }
  return { fields, conflict: false };
}

function runJobWageTableExtraction({ tables, extractorVersion }) {
  const candidates = tables.filter(isJobWageTable);
  if (candidates.length === 0) return {};
  const table = candidates[0];
  const rawSummary = tableToRawSummary(table);
  const evidence = { page_number: table.page_number, region: table.region ?? undefined };
  return {
    wage_estimates: buildExtractedField({
      field_name: "wage_estimates",
      value: null,
      raw_value: rawSummary,
      evidence,
      method: "deterministic_table",
      extractor_version: extractorVersion,
      confidence: "medium",
      assumptions: ["wage figures left unnormalized; see raw_value for the filed table"],
    }),
  };
}

/**
 * Which job-count field a job/wage table's total belongs to, from the
 * table's own content -- "construction" vs. "permanent"/"operational"/
 * "ongoing". A table naming neither, or both, is ambiguous and matches
 * nothing: this pass never guesses which typed field an unlabelled total
 * belongs to.
 */
function detectJobTableType(table) {
  const haystack = table.rows.map((r) => r.join(" ")).join(" ").toLowerCase();
  const hasConstruction = haystack.includes("construction");
  const hasPermanent = haystack.includes("permanent") || haystack.includes("operational") || haystack.includes("ongoing");
  if (hasConstruction && !hasPermanent) return "construction_jobs_estimate";
  if (hasPermanent && !hasConstruction) return "permanent_jobs_estimate";
  return null;
}

/**
 * A numeric job-count field is only ever filled when a real job/wage table
 * backs it AND that table's own content identifies which job type (construction
 * vs. permanent) its total row counts -- the count itself requires an
 * explicit total row or count cell, which this deterministic pass looks for
 * as a `total`-labelled row in the matching table.
 */
function runJobCountTableExtraction({ tables, fieldName, extractorVersion }) {
  const candidates = tables.filter(isJobWageTable);
  const table = candidates.find((t) => detectJobTableType(t) === fieldName);
  if (!table) return null;
  const totalRow = table.rows.find((r) => r.some((c) => String(c ?? "").toLowerCase().includes("total")));
  if (!totalRow) return null;
  const numericCell = totalRow.find((c) => /^\s*[\d,]+\s*$/.test(String(c ?? "")));
  if (!numericCell) return null;
  return buildExtractedField({
    field_name: fieldName,
    value: parseNumeric(String(numericCell)),
    unit: "jobs",
    raw_value: String(numericCell).trim(),
    evidence: { page_number: table.page_number, region: table.region ?? undefined },
    method: "deterministic_table",
    extractor_version: extractorVersion,
    confidence: "medium",
  });
}

/* ------------------------------------------------------------------ */
/* Stage 3: constrained semantic extraction                            */
/* ------------------------------------------------------------------ */

/**
 * Run the injected `semanticExtract(fieldName, { pages })` for every field
 * still missing. A result is accepted only if it supplies its own raw_value
 * and at least a page_number/span/region -- an evidence-free result (a bare
 * `{ value }`) is discarded and the field falls through to abstention.
 * `permanent_jobs_estimate`/`construction_jobs_estimate` are never accepted
 * from this stage at all: a numeric job estimate must come from a table
 * (stage 2) or abstain, so a narrative job claim can never be promoted into
 * a typed count.
 */
function runSemanticStage({ missingFieldNames, pages, semanticExtract, extractorVersion }) {
  const found = {};
  if (typeof semanticExtract !== "function") return found;
  for (const fieldName of missingFieldNames) {
    if (JOB_TABLE_ONLY_FIELDS.includes(fieldName)) continue;
    let candidate;
    try {
      candidate = semanticExtract(fieldName, { pages });
    } catch {
      candidate = null;
    }
    if (!candidate || !candidate.raw_value) continue;
    const hasLocation = candidate.page_number != null || candidate.span != null || candidate.region != null;
    if (!hasLocation) continue;
    found[fieldName] = buildExtractedField({
      field_name: fieldName,
      value: candidate.value ?? null,
      unit: candidate.unit ?? null,
      raw_value: candidate.raw_value,
      evidence: { page_number: candidate.page_number, span: candidate.span, region: candidate.region },
      method: "constrained_semantic_extraction",
      extractor_version: extractorVersion,
      confidence: candidate.confidence ?? "low",
      assumptions: candidate.assumptions ?? [],
    });
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Stage 4: abstention                                                 */
/* ------------------------------------------------------------------ */

function abstainMissing({ fieldNames, found, extractorVersion, reasons }) {
  const out = { ...found };
  for (const fieldName of fieldNames) {
    if (out[fieldName]) continue;
    out[fieldName] = buildExtractedField({
      field_name: fieldName,
      abstained: true,
      abstention_reason: reasons[fieldName] ?? "no evidence-bearing extraction (deterministic text/table or constrained semantic) found this field",
      extractor_version: extractorVersion,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Community profile / displacement risk header extraction             */
/* ------------------------------------------------------------------ */

const COMMUNITY_PROFILE_HEADER_PATTERN = /community\s*(?:district\s*)?profile[^\n]{0,40}?[-–:]\s*([^\n(]{2,200})\(([^)]{2,120})\)/i;
const DRI_HEADER_PATTERN = /displacement\s*risk\s*index[^\n]{0,40}?[-–:]\s*([^\n(]{2,200})\(([^)]{2,120})\)/i;

function findHeader(pages, pattern) {
  for (const page of pages) {
    const text = page.text || "";
    const match = pattern.exec(text);
    if (match) return { geography: match[1].trim(), vintage: match[2].trim(), page_number: page.page_number, remainder: text.slice(match.index + match[0].length) };
  }
  return null;
}

function runCommunityProfileExtraction({ pages, extractorVersion, warnings }) {
  const header = findHeader(pages, COMMUNITY_PROFILE_HEADER_PATTERN);
  if (!header) {
    warnings.push("community_profile: no geography/vintage header found; the whole section abstains rather than guessing what an indicator table describes");
    return null;
  }
  const indicatorFields = runDeterministicTextStage({ pages, fieldNames: COMMUNITY_PROFILE_INDICATOR_FIELDS, extractorVersion });
  const indicators = abstainMissing({
    fieldNames: COMMUNITY_PROFILE_INDICATOR_FIELDS,
    found: indicatorFields,
    extractorVersion,
    reasons: {},
  });
  return buildCommunityProfileSection({
    geography: header.geography,
    vintage: header.vintage,
    methodology_state: "measured",
    indicators,
  });
}

function runDisplacementRiskExtraction({ pages, extractorVersion, warnings }) {
  const header = findHeader(pages, DRI_HEADER_PATTERN);
  if (!header) {
    warnings.push("displacement_risk: no geography/vintage header found; the section abstains (contextual value has no identified source)");
    return null;
  }
  // Search only the text *after* the geography/vintage header match itself,
  // never the header line from its start again -- otherwise a numeral inside
  // the geography name (e.g. "Community District 7") could be mistaken for
  // the index value.
  const valueMatch = /^\s*[:\-]?\s*([\d.]+)/.exec(header.remainder);
  return buildDisplacementRiskSection({
    interpretation: "contextual_not_project_prediction",
    geography: header.geography,
    vintage: header.vintage,
    methodology_state: "measured",
    index_value: valueMatch
      ? {
        value: Number(valueMatch[1]),
        raw_value: valueMatch[1],
        evidence: { page_number: header.page_number },
        method: "deterministic_text",
        extractor_version: extractorVersion,
        confidence: "medium",
      }
      : null,
  });
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

/**
 * Run the full four-stage pipeline over one document's already-parsed pages
 * and tables. `pages`: `[{ page_number, text }]`. `tables`:
 * `[{ page_number, rows: [[cell,...],...], region? }]` (row 0 is the header
 * row). `semanticExtract` is optional and injected -- omit it in a test that
 * exercises only stages 1/2/4.
 *
 * Returns `{ sections, field_evidence, extraction_quality, warnings }`;
 * `sections` is shaped to pass straight into `assembleRacialEquityReportEnvelope`.
 */
export function extractRacialEquityReportSections({
  pages = [],
  tables = [],
  semanticExtract = null,
  extractorVersion = LDP25_EXTRACTOR_VERSION,
} = {}) {
  const warnings = [];
  for (const page of pages) {
    const quality = assessPageQuality({ text: page.text, ocrRequired: page.ocr_required, ocrAttempted: page.ocr_used, ocrEngineAvailable: page.ocr_engine_available });
    if (!quality.measured) warnings.push(`page ${page.page_number}: ${quality.reasons.join("; ")}`);
    else if (quality.quality_state === "low") warnings.push(`page ${page.page_number}: low extraction quality (${quality.reasons.join("; ")})`);
  }

  // Stage 1: deterministic text, across every text-bearing field.
  const textFieldNames = [
    ...APPLICATION_SCOPE_FIELDS,
    ...PROPOSED_DEVELOPMENT_SCOPE_FIELDS,
    "residential_square_feet",
    "non_residential_square_feet",
    "non_residential_use_types",
  ];
  const textFound = runDeterministicTextStage({ pages, fieldNames: textFieldNames, extractorVersion });

  // Stage 2: deterministic table.
  const { fields: incomeBandFields, conflict: incomeBandConflict, conflictingTableCount } = runIncomeBandTableExtraction({ tables, extractorVersion });
  if (incomeBandConflict) {
    warnings.push(`residential: ${conflictingTableCount} income-band tables disagree; abstaining rather than picking one`);
  }
  const jobWageFields = runJobWageTableExtraction({ tables, extractorVersion });
  const constructionEmploymentReasons = {};
  const jobCountFields = {};
  for (const fieldName of JOB_TABLE_ONLY_FIELDS) {
    const field = runJobCountTableExtraction({ tables, fieldName, extractorVersion });
    if (field) jobCountFields[fieldName] = field;
    else constructionEmploymentReasons[fieldName] = "no job/wage table with a total row found; a narrative job claim alone is never promoted to a numeric estimate";
  }

  const found = { ...textFound, ...(incomeBandConflict ? {} : incomeBandFields), ...jobWageFields, ...jobCountFields };

  // Stage 3: constrained semantic extraction, only for what's still missing.
  const allFieldNames = [
    ...APPLICATION_SCOPE_FIELDS,
    ...PROPOSED_DEVELOPMENT_SCOPE_FIELDS,
    ...RESIDENTIAL_SECTION_FIELDS,
    ...NON_RESIDENTIAL_SECTION_FIELDS,
    ...CONSTRUCTION_EMPLOYMENT_SECTION_FIELDS,
  ];
  const missingAfterDeterministic = allFieldNames.filter((f) => !found[f]);
  const semanticFound = runSemanticStage({ missingFieldNames: missingAfterDeterministic, pages, semanticExtract, extractorVersion });
  Object.assign(found, semanticFound);

  // Stage 4: abstention for the residual.
  const reasons = { ...constructionEmploymentReasons };
  if (incomeBandConflict) {
    for (const fieldName of ["income_bands", "rents_by_band", "sale_prices_by_band", "eligible_incomes_by_band"]) {
      reasons[fieldName] = `${conflictingTableCount} competing income-band tables disagree; abstaining rather than picking one`;
    }
  }
  const allFields = abstainMissing({ fieldNames: allFieldNames, found, extractorVersion, reasons });

  const applicationScope = buildApplicationScopeSection(Object.fromEntries(APPLICATION_SCOPE_FIELDS.map((f) => [f, allFields[f]])));
  const proposedDevelopmentScope = buildProposedDevelopmentScopeSection(Object.fromEntries(PROPOSED_DEVELOPMENT_SCOPE_FIELDS.map((f) => [f, allFields[f]])));
  const residential = buildResidentialSection(Object.fromEntries(RESIDENTIAL_SECTION_FIELDS.filter((f) => f !== "known_tenant_profile").map((f) => [f, allFields[f]])));
  const nonResidential = buildNonResidentialSection(Object.fromEntries(NON_RESIDENTIAL_SECTION_FIELDS.map((f) => [f, allFields[f]])));
  const constructionEmployment = buildConstructionEmploymentSection(Object.fromEntries(CONSTRUCTION_EMPLOYMENT_SECTION_FIELDS.map((f) => [f, allFields[f]])));
  const communityProfile = runCommunityProfileExtraction({ pages, extractorVersion, warnings });
  const displacementRisk = runDisplacementRiskExtraction({ pages, extractorVersion, warnings });

  const sectionsForRollup = [applicationScope, proposedDevelopmentScope, residential, nonResidential, constructionEmployment];
  const fieldEvidenceSummary = summarizeFieldExtractionQuality(sectionsForRollup);

  return Object.freeze({
    sections: Object.freeze({
      application_scope: applicationScope,
      proposed_development_scope: proposedDevelopmentScope,
      residential,
      non_residential: nonResidential,
      construction_employment: constructionEmployment,
      community_profile: communityProfile,
      displacement_risk: displacementRisk,
    }),
    field_evidence: Object.freeze({ ...fieldEvidenceSummary, warnings: Object.freeze([...warnings]) }),
    extraction_quality: fieldEvidenceSummary.overall_quality,
    warnings: Object.freeze(warnings),
    extractor_version: extractorVersion,
  });
}

/**
 * Assemble a full `racial_equity_report.v1` envelope from one
 * `land_use_filing_document` record (LDP-24) and this pipeline's extraction
 * result. Every envelope is 1:1 with the document it was extracted from
 * (per the ontology's own primary_key_pattern) -- there is deliberately no
 * "merge into an existing envelope for a different document" path here.
 * Re-extracting the same document (same source_bytes_sha256) is expected to
 * be idempotent; a *different* document version (a supersession) always
 * produces its own independent envelope, never a mutation of the earlier
 * one's community_profile or any other as-filed section.
 */
export function assembleRacialEquityReportEnvelope({ document, extraction, applicant = null, preparer = null, reportPreparationDate = null, executiveSummary = null, fairHousingNarrative = null }) {
  if (!document?.document_id?.startsWith("land_use_filing_document:")) {
    throw new TypeError("assembleRacialEquityReportEnvelope: document must be a land_use_filing_document record");
  }
  if (!document.bytes_sha256) {
    throw new TypeError("assembleRacialEquityReportEnvelope: document.bytes_sha256 is required (extraction only ever runs against hashed, immutable bytes)");
  }
  return buildRacialEquityReportEnvelope({
    document_ref: document.document_id,
    project_ref: document.project_ref,
    applicant,
    preparer,
    report_preparation_date: reportPreparationDate,
    source_bytes_sha256: document.bytes_sha256,
    extraction_version: extraction.extractor_version,
    extraction_quality: extraction.extraction_quality,
    application_scope: extraction.sections.application_scope,
    proposed_development_scope: extraction.sections.proposed_development_scope,
    executive_summary: executiveSummary == null ? null : buildExecutiveSummarySection(executiveSummary),
    residential: extraction.sections.residential,
    non_residential: extraction.sections.non_residential,
    construction_employment: extraction.sections.construction_employment,
    community_profile: extraction.sections.community_profile,
    displacement_risk: extraction.sections.displacement_risk,
    fair_housing_narrative: fairHousingNarrative == null ? null : buildFairHousingNarrativeSection(fairHousingNarrative),
    field_evidence: extraction.field_evidence,
  });
}
