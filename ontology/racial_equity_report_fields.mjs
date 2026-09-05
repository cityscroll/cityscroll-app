/**
 * LDP-25: the real per-field schema for the `racial_equity_report.v1`
 * envelope's reserved narrative sections (LDP-23,
 * ontology/land_use_filing.mjs#buildRacialEquityReportEnvelope), which that
 * card typed as bounded opaque JSON placeholders on purpose -- "LDP-25 owns
 * their real per-field schema, extraction, and page/span evidence; this card
 * does not populate or parse report contents."
 *
 * Every extracted value is wrapped in `buildExtractedField`: a figure without
 * its page/span evidence, raw value, extractor version, method, and
 * confidence is not evidence, it is a number that happened to appear. A field
 * that stage 1-3 extraction could not fill with evidence-bearing output must
 * abstain explicitly (`abstained: true` + a stated reason) rather than be
 * silently left null or guessed -- this module makes that structural: a
 * non-abstained field cannot be built without evidence, and an abstained one
 * cannot carry a value.
 *
 * The community-profile section is the as-filed snapshot and nothing else:
 * it carries a hard `as_filed: true` and rejects any key that smells like
 * "current"/"live"/"refreshed" data at construction time, mirroring
 * land_use_filing.mjs's own RER_FORBIDDEN_KEYS pattern. No caller of this
 * module can wire a current-data source into it, because no builder here
 * accepts one.
 */
import { FILING_CONFIDENCE_LEVELS, DRI_INTERPRETATION } from "./land_use_filing.mjs";

export const RER_FIELD_SCHEMA = "cityscroll.racial_equity_report_field.v1";
export const RER_FIELD_VERSION = "1.0.0";

export const RER_FIELD_EXTRACTION_METHODS = Object.freeze([
  "deterministic_text",
  "deterministic_table",
  "ocr_layout_fallback",
  "constrained_semantic_extraction",
]);

export const RER_NARRATIVE_SOURCES = Object.freeze(["applicant_narrative", "generated_summary"]);
export const RER_METHODOLOGY_STATES = Object.freeze(["measured", "modeled", "unknown"]);

export const APPLICATION_SCOPE_FIELDS = Object.freeze([
  "project_name",
  "ulurp_number",
  "applicant_name",
  "block_and_lot",
  "site_address",
  "actions_requested",
]);

export const PROPOSED_DEVELOPMENT_SCOPE_FIELDS = Object.freeze([
  "residential_units_proposed",
  "affordable_units_proposed",
  "non_residential_square_feet_proposed",
  "building_height_or_far_proposed",
]);

export const RESIDENTIAL_SECTION_FIELDS = Object.freeze([
  "income_bands",
  "rents_by_band",
  "sale_prices_by_band",
  "eligible_incomes_by_band",
  "residential_square_feet",
  "known_tenant_profile",
]);

export const NON_RESIDENTIAL_SECTION_FIELDS = Object.freeze([
  "non_residential_square_feet",
  "non_residential_use_types",
]);

export const CONSTRUCTION_EMPLOYMENT_SECTION_FIELDS = Object.freeze([
  "permanent_jobs_estimate",
  "construction_jobs_estimate",
  "wage_estimates",
  "workforce_claims",
]);

export const COMMUNITY_PROFILE_INDICATOR_FIELDS = Object.freeze([
  "population",
  "median_household_income",
  "renter_share",
  "racial_composition",
  "poverty_rate",
]);

/**
 * Section-level keys this module hard-refuses on any as-filed community
 * profile input -- a caller that tries to smuggle a live/current value in
 * under a different name fails at construction, not at review time.
 */
const COMMUNITY_PROFILE_FORBIDDEN_KEYS = Object.freeze([
  "current_data",
  "current_value",
  "refreshed_at",
  "refreshed_from",
  "updated_from_current",
  "live_value",
  "edde_ref",
]);

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function requireString(value, field, max = 500) {
  const result = clean(value, max);
  if (!result) throw new TypeError(`${field} is required`);
  return result;
}

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function positiveInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new TypeError(`${field} must be a positive integer`);
  return n;
}

/* ------------------------------------------------------------------ */
/* Evidence location: page, span, and/or bounding region               */
/* ------------------------------------------------------------------ */

function buildSpan(value) {
  if (value == null) return null;
  const start = positiveInt(value.start ?? value.start_offset, "evidence.span.start");
  const end = positiveInt(value.end ?? value.end_offset, "evidence.span.end");
  if (end < start) throw new TypeError("evidence.span.end must be >= evidence.span.start");
  return Object.freeze({ start, end });
}

function boundedRatio(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new TypeError(`${field} must be a number between 0 and 1`);
  return n;
}

function buildRegion(value) {
  if (value == null) return null;
  return Object.freeze({
    x: boundedRatio(value.x, "evidence.region.x"),
    y: boundedRatio(value.y, "evidence.region.y"),
    width: boundedRatio(value.width, "evidence.region.width"),
    height: boundedRatio(value.height, "evidence.region.height"),
  });
}

/**
 * At least one of page_number, span, or region must identify where a value
 * came from -- "a page number" alone is enough for a deterministic-text hit,
 * a span narrows it, a region is what an OCR/layout fallback typically has
 * instead of a reliable text offset.
 */
export function buildEvidenceLocation(value = {}) {
  const pageNumber = value.page_number == null ? null : positiveInt(value.page_number, "evidence.page_number");
  const span = buildSpan(value.span);
  const region = buildRegion(value.region);
  if (pageNumber == null && span == null && region == null) {
    throw new TypeError("evidence requires at least one of page_number, span, or region");
  }
  return Object.freeze({ page_number: pageNumber, span, region });
}

/* ------------------------------------------------------------------ */
/* Extracted field: the evidence-bearing per-value wrapper              */
/* ------------------------------------------------------------------ */

const EXTRACTED_VALUE_TYPES = Object.freeze(["string", "number", "boolean"]);

function boundedScalar(value, field) {
  if (value == null) return null;
  if (!EXTRACTED_VALUE_TYPES.includes(typeof value)) {
    throw new TypeError(`${field} must be a string, number, boolean, or null (a single normalized scalar, not a nested structure)`);
  }
  return typeof value === "string" ? clean(value, 1_000) : value;
}

/**
 * The one wrapper every RER field-level value goes through. Two disjoint
 * shapes, enforced structurally:
 *
 *  - abstained: `value` must be absent; `abstention_reason` is required.
 *    Confidence is always "unknown" -- an abstained field never fakes a
 *    confidence level for a value it doesn't have.
 *  - extracted: `raw_value`, `method`, `extractor_version`, `confidence`,
 *    and `evidence` (page/span/region) are all required. A method,
 *    confidence, or evidence-free "extraction" cannot be built at all.
 */
export function buildExtractedField(input = {}) {
  const fieldName = requireString(input.field_name, "field_name", 200);
  const extractorVersion = requireString(input.extractor_version, "extractor_version", 60);

  if (input.abstained === true) {
    if (input.value != null) throw new TypeError(`${fieldName}: an abstained field must not carry a value`);
    return Object.freeze({
      schema: RER_FIELD_SCHEMA,
      version: RER_FIELD_VERSION,
      field_name: fieldName,
      abstained: true,
      abstention_reason: requireString(input.abstention_reason, `${fieldName}.abstention_reason`, 500),
      value: null,
      unit: null,
      raw_value: null,
      evidence: null,
      method: null,
      extractor_version: extractorVersion,
      confidence: "unknown",
      band: null,
      assumptions: Object.freeze([]),
    });
  }

  const method = requireEnum(input.method, RER_FIELD_EXTRACTION_METHODS, `${fieldName}.method`);
  const confidence = requireEnum(input.confidence, FILING_CONFIDENCE_LEVELS, `${fieldName}.confidence`);
  const rawValue = requireString(input.raw_value, `${fieldName}.raw_value`, 1_000);
  const evidence = buildEvidenceLocation(input.evidence);

  return Object.freeze({
    schema: RER_FIELD_SCHEMA,
    version: RER_FIELD_VERSION,
    field_name: fieldName,
    abstained: false,
    abstention_reason: null,
    value: boundedScalar(input.value, `${fieldName}.value`),
    unit: input.unit == null ? null : clean(input.unit, 60),
    raw_value: rawValue,
    evidence,
    method,
    extractor_version: extractorVersion,
    confidence,
    band: input.band == null ? null : clean(input.band, 200),
    assumptions: Object.freeze((input.assumptions || []).map((a) => clean(a, 500))),
  });
}

/* ------------------------------------------------------------------ */
/* Field sections                                                      */
/* ------------------------------------------------------------------ */

function buildFieldSection(value, allowedFields, sectionName) {
  if (value == null) return null;
  const out = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!allowedFields.includes(key)) {
      throw new TypeError(`${sectionName}.${key} is not a registered field (expected one of ${allowedFields.join("|")})`);
    }
    out[key] = buildExtractedField({ ...fieldValue, field_name: fieldValue?.field_name ?? key });
  }
  return Object.freeze(out);
}

export function buildApplicationScopeSection(value) {
  return buildFieldSection(value, APPLICATION_SCOPE_FIELDS, "application_scope");
}

export function buildProposedDevelopmentScopeSection(value) {
  return buildFieldSection(value, PROPOSED_DEVELOPMENT_SCOPE_FIELDS, "proposed_development_scope");
}

export function buildResidentialSection(value) {
  return buildFieldSection(value, RESIDENTIAL_SECTION_FIELDS, "residential");
}

export function buildNonResidentialSection(value) {
  return buildFieldSection(value, NON_RESIDENTIAL_SECTION_FIELDS, "non_residential");
}

export function buildConstructionEmploymentSection(value) {
  return buildFieldSection(value, CONSTRUCTION_EMPLOYMENT_SECTION_FIELDS, "construction_employment");
}

/**
 * The as-filed community-profile snapshot. `as_filed` is hard-coded true --
 * no caller can set it false or omit it -- and geography/vintage/
 * methodology_state are required at the section level: if extraction cannot
 * identify what the embedded table even claims to describe, the whole
 * section must abstain (return null upstream), never guess a geography or
 * vintage to attach real-looking indicator values to.
 */
export function buildCommunityProfileSection(value) {
  if (value == null) return null;
  for (const key of COMMUNITY_PROFILE_FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`community_profile must not carry "${key}" -- this section is the as-filed snapshot only, never current/live data`);
    }
  }
  return Object.freeze({
    as_filed: true,
    geography: requireString(value.geography, "community_profile.geography", 300),
    vintage: requireString(value.vintage, "community_profile.vintage", 120),
    methodology_state: requireEnum(value.methodology_state ?? "unknown", RER_METHODOLOGY_STATES, "community_profile.methodology_state"),
    indicators: buildFieldSection(value.indicators, COMMUNITY_PROFILE_INDICATOR_FIELDS, "community_profile.indicators") ?? Object.freeze({}),
  });
}

/**
 * The Displacement Risk Index, typed on top of LDP-23's opaque placeholder.
 * `interpretation` is re-checked here (buildRacialEquityReportEnvelope also
 * checks it) so this section is independently valid even if constructed
 * outside that envelope builder, e.g. in a unit test.
 */
export function buildDisplacementRiskSection(value) {
  if (value == null) return null;
  if (value.interpretation !== DRI_INTERPRETATION) {
    throw new TypeError(`displacement_risk.interpretation must equal "${DRI_INTERPRETATION}"`);
  }
  return Object.freeze({
    interpretation: DRI_INTERPRETATION,
    geography: requireString(value.geography, "displacement_risk.geography", 300),
    vintage: requireString(value.vintage, "displacement_risk.vintage", 120),
    methodology_state: requireEnum(value.methodology_state ?? "unknown", RER_METHODOLOGY_STATES, "displacement_risk.methodology_state"),
    index_value: value.index_value == null ? null : buildExtractedField({ ...value.index_value, field_name: value.index_value.field_name ?? "displacement_risk_index" }),
  });
}

/**
 * A narrative section is labelled by its source, never left ambiguous.
 * `applicant_narrative` carries direct page/span evidence (it is the
 * applicant's own filed text); `generated_summary` carries no evidence
 * location of its own and instead must link back to `evidence_refs`
 * naming the extracted fields it summarizes -- a generated summary with no
 * evidence trail at all cannot be built.
 */
function buildNarrativeSection(value, sectionName) {
  if (value == null) return null;
  const source = requireEnum(value.source, RER_NARRATIVE_SOURCES, `${sectionName}.source`);
  const text = requireString(value.text, `${sectionName}.text`, 20_000);
  if (source === "applicant_narrative") {
    return Object.freeze({
      source,
      text,
      evidence: buildEvidenceLocation(value.evidence),
      evidence_refs: Object.freeze([]),
      generator_version: null,
    });
  }
  const evidenceRefs = Object.freeze((value.evidence_refs || []).map((r) => requireString(r, `${sectionName}.evidence_refs[]`, 200)));
  if (evidenceRefs.length === 0) {
    throw new TypeError(`${sectionName}: a generated_summary requires at least one evidence_refs[] entry linking back to an extracted field`);
  }
  return Object.freeze({
    source,
    text,
    evidence: null,
    evidence_refs: evidenceRefs,
    generator_version: requireString(value.generator_version, `${sectionName}.generator_version`, 40),
  });
}

export function buildExecutiveSummarySection(value) {
  return buildNarrativeSection(value, "executive_summary");
}

export function buildFairHousingNarrativeSection(value) {
  return buildNarrativeSection(value, "fair_housing_narrative");
}

/* ------------------------------------------------------------------ */
/* Field-evidence rollup                                                */
/* ------------------------------------------------------------------ */

function* leafFields(sections) {
  for (const section of sections) {
    if (section == null) continue;
    for (const value of Object.values(section)) {
      if (value && typeof value === "object" && "abstained" in value) yield value;
      // community_profile nests its fields one level deeper, under `indicators`
      else if (value && typeof value === "object" && value.indicators) yield* Object.values(value.indicators);
    }
  }
}

/**
 * Roll every field this extraction touched up into one quality summary,
 * matching LDP-33's summarizeDocumentExtractionQuality shape (page_count /
 * measured / low-quality) but at field granularity: field_count,
 * abstained_count, a method histogram, and an overall_quality bucket that
 * degrades as the abstention ratio rises.
 */
export function summarizeFieldExtractionQuality(sections = []) {
  const fields = [...leafFields(sections)];
  const abstained = fields.filter((f) => f.abstained);
  const byMethod = {};
  const byConfidence = {};
  for (const f of fields) {
    const methodKey = f.method ?? "abstained";
    byMethod[methodKey] = (byMethod[methodKey] ?? 0) + 1;
    byConfidence[f.confidence] = (byConfidence[f.confidence] ?? 0) + 1;
  }
  const abstentionRatio = fields.length === 0 ? 0 : abstained.length / fields.length;
  const lowConfidenceCount = byConfidence.low ?? 0;
  const overallQuality = fields.length === 0
    ? "unknown"
    : abstentionRatio > 0.5
      ? "low"
      : (abstentionRatio > 0 || lowConfidenceCount > 0)
        ? "medium"
        : "high";
  return Object.freeze({
    field_count: fields.length,
    abstained_count: abstained.length,
    abstention_ratio: fields.length === 0 ? null : Number(abstentionRatio.toFixed(4)),
    by_method: Object.freeze(byMethod),
    by_confidence: Object.freeze(byConfidence),
    overall_quality: overallQuality,
  });
}
