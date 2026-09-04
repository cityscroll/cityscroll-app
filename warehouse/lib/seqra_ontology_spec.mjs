/**
 * SEQRA/CEQR process ontology (SEQRA-02): declarative field specs for the
 * fifteen commissioned core entities, plus the required relation edges and
 * a hand-rolled validator over that spec.
 *
 * This module is the single source both the committed JSON Schema documents
 * (warehouse/schemas/seqra_ontology_*.v1.schema.json, built deterministically
 * by tools/build_seqra_ontology_schemas.mjs) and the runtime validator
 * (validateSeqraEntity below) are derived from, so the two can never drift
 * out of sync the way two independently hand-maintained copies could.
 *
 * Scope discipline: most entities here define only durable identity and
 * relationship shape -- the fields a later card's adapter will populate --
 * not an observation envelope. Only the entities that are inherently
 * point-in-time observations (review_event, technical_topic_assessment,
 * mitigation_commitment, public_position) carry the full commissioned
 * temporal-integrity envelope (observed_at, available_to_public_at,
 * source_id, source_record_id, source_vintage, evidence, confidence,
 * rival_explanation, suppression_rule). No entity here is populated with
 * invented observations; the fixtures that exercise these specs are
 * synthetic identity/shape examples, not claims about a real review.
 */

export const SEQRA_ONTOLOGY_SCHEMA_PREFIX = "cityscroll.seqra_ontology";
export const SEQRA_ONTOLOGY_SCHEMA_VERSION = "v1";

// ---- small field-descriptor helpers -------------------------------------

function str(extra = {}) {
  return { type: "string", ...extra };
}
function strOrNull(extra = {}) {
  return { type: ["string", "null"], ...extra };
}
function enumStr(values, extra = {}) {
  return { type: "string", enum: [...values], ...extra };
}
function enumStrOrNull(values, extra = {}) {
  return { type: ["string", "null"], enum: [...values, null], ...extra };
}
function numRange(min, max, extra = {}) {
  return { type: "number", minimum: min, maximum: max, ...extra };
}
function arrOfStr(extra = {}) {
  return { type: "array", items: { type: "string" }, ...extra };
}
function dateOnly(extra = {}) {
  return str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", ...extra });
}
function dateOnlyOrNull(extra = {}) {
  return strOrNull({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", ...extra });
}
function dateTime(extra = {}) {
  return str({ format: "date-time", ...extra });
}

// ---- shared vocabularies --------------------------------------------------

export const SEQRA_JURISDICTION_LEVELS = Object.freeze(["NYS", "NYC"]);
export const SEQRA_ENVIRONMENTAL_REGIMES = Object.freeze(["SEQRA", "CEQR"]);
export const SEQRA_JUDICIAL_REVIEW_REGIMES = Object.freeze([
  "NY_ARTICLE_78",
  "NY_HYBRID",
  "NONE",
  "UNKNOWN",
]);

// The commission's candidate-milestone list, modeled as review_event types.
// Document publication is generic (draft_document_published /
// final_document_published) with the specific document family carried in
// the event payload, so DEIS/FEIS/EAS/technical-memo/SEIS all reuse one pair
// of lifecycle event types instead of one enum value per document family.
export const SEQRA_REVIEW_EVENT_TYPES = Object.freeze([
  "eas_or_eaf_accepted",
  "lead_agency_established",
  "type_ii_classified",
  "negative_declaration_issued",
  "conditioned_negative_declaration_issued",
  "positive_declaration_issued",
  "draft_scope_issued",
  "scoping_hearing_held",
  "final_scope_issued",
  "draft_document_published",
  "public_hearing_held",
  "final_document_published",
  "findings_adopted",
  "final_determination_issued",
  "technical_memorandum_issued",
  "supplemental_eis_initiated",
  "document_superseded",
  "determination_superseded",
  "topic_assessed",
  "mitigation_committed",
  "alternative_considered",
  "position_taken",
]);

export const SEQRA_TECHNICAL_TOPICS = Object.freeze([
  "land_use_zoning_public_policy",
  "socioeconomic_conditions",
  "community_facilities_services",
  "open_space",
  "shadows",
  "historic_cultural_resources",
  "urban_design_visual_resources",
  "natural_resources",
  "hazardous_materials",
  "water_sewer_infrastructure",
  "solid_waste_sanitation",
  "energy",
  "transportation",
  "air_quality",
  "greenhouse_gas_climate",
  "noise",
  "public_health",
  "neighborhood_character",
  "construction",
  "disadvantaged_communities",
  "alternatives",
]);

export const SEQRA_TOPIC_ASSESSMENT_STATES = Object.freeze([
  "not_located",
  "screened_out",
  "detailed_analysis",
  "impact_identified",
  "mitigation_proposed",
  "mitigated",
  "unmitigated",
  "disputed_in_comments",
  "agency_response_complete",
  "supplementation_requested",
  "supplementation_denied",
]);

export const SEQRA_REVIEW_DOCUMENT_TYPES = Object.freeze([
  "eas",
  "eaf",
  "draft_scope",
  "final_scope",
  "deis",
  "feis",
  "findings",
  "negative_declaration",
  "conditioned_negative_declaration",
  "positive_declaration",
  "technical_memorandum",
  "supplemental_eis",
  "comment_letter",
  "agency_response",
  "final_determination",
]);

export const SEQRA_DOCUMENT_STAGES = Object.freeze(["draft", "final"]);

// ---- temporal-integrity envelope (Tier C: append-only observations) -----

function temporalIntegrityFields() {
  return {
    observed_at: dateTime(),
    available_to_public_at: dateTime(),
    source_id: str(),
    source_record_id: str(),
    source_vintage: strOrNull(),
    evidence: strOrNull(),
    confidence: numRange(0, 1),
    rival_explanation: strOrNull(),
    suppression_rule: strOrNull(),
  };
}
const TEMPORAL_INTEGRITY_REQUIRED = [
  "observed_at",
  "available_to_public_at",
  "source_id",
  "source_record_id",
  "source_vintage",
  "evidence",
  "confidence",
  "rival_explanation",
  "suppression_rule",
];

// ---- minimal provenance (Tier A/B: identity + relationship shape) -------

function minimalProvenanceFields() {
  return {
    observed_at: dateTime(),
    source_id: str(),
    source_record_id: str(),
  };
}
const MINIMAL_PROVENANCE_REQUIRED = ["observed_at", "source_id", "source_record_id"];

function entitySchemaName(entityType) {
  return `${SEQRA_ONTOLOGY_SCHEMA_PREFIX}.${entityType}.${SEQRA_ONTOLOGY_SCHEMA_VERSION}`;
}

function entity({ type, description, required, properties }) {
  return {
    schema: entitySchemaName(type),
    entity_type: type,
    description,
    required: [...required],
    properties,
    additionalProperties: false,
  };
}

// ---- the fifteen commissioned core entities ------------------------------

export const SEQRA_ONTOLOGY_ENTITY_SPECS = Object.freeze({
  project: entity({
    type: "project",
    description: "A CityScroll land-use/environmental-review project: the durable subject that requires one or more government actions.",
    required: ["project_key", "title", "source_system", "source_project_id", "bbl_list", "borough", "observed_at", "source_id", "source_record_id"],
    properties: {
      project_key: str({ pattern: "^project:[a-z0-9_-]+:[a-z0-9_-]+$" }),
      title: str(),
      source_system: str(),
      source_project_id: str(),
      bbl_list: arrOfStr({ description: "Every BBL this project touches; a rezoning or large project may carry many." }),
      borough: strOrNull(),
      ...minimalProvenanceFields(),
    },
  }),

  government_action: entity({
    type: "government_action",
    description: "One discretionary or ministerial government action a project requires (project -> requires_action -> government_action).",
    required: ["action_key", "project_key", "agency", "source_system", "source_action_id", "action_type", "observed_at", "source_id", "source_record_id"],
    properties: {
      action_key: str({ pattern: "^action:[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+$" }),
      project_key: str({ pattern: "^project:[a-z0-9_-]+:[a-z0-9_-]+$" }),
      agency: str(),
      source_system: str(),
      source_action_id: str(),
      action_type: strOrNull(),
      ...minimalProvenanceFields(),
    },
  }),

  environmental_review: entity({
    type: "environmental_review",
    description: "One SEQRA or CEQR environmental review of a government action (environmental_review -> reviews_action -> government_action).",
    required: [
      "review_key", "action_key", "jurisdiction_level", "environmental_regime",
      "review_label_as_published", "judicial_review_regime", "lead_agency",
      "ceqr_number", "source_review_id", "observed_at", "source_id", "source_record_id",
    ],
    properties: {
      review_key: str({ pattern: "^environmental_review:(ceqr|seqra):.+$" }),
      action_key: str({ pattern: "^action:[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+$" }),
      jurisdiction_level: enumStr(SEQRA_JURISDICTION_LEVELS),
      environmental_regime: enumStr(SEQRA_ENVIRONMENTAL_REGIMES),
      review_label_as_published: str(),
      judicial_review_regime: enumStr(SEQRA_JUDICIAL_REVIEW_REGIMES),
      lead_agency: str(),
      ceqr_number: strOrNull(),
      source_review_id: strOrNull(),
      ...minimalProvenanceFields(),
    },
  }),

  review_document: entity({
    type: "review_document",
    description: "One versioned document of an environmental review (environmental_review -> has_document -> review_document); draft and final versions coexist and are linked by supersedes_document_key, never overwritten.",
    required: [
      "document_key", "review_key", "document_type", "document_stage", "issued_date",
      "content_hash", "supersedes_document_key", "available_to_public_at",
      "observed_at", "source_id", "source_record_id",
    ],
    properties: {
      document_key: str({ pattern: "^review_document:environmental_review:(ceqr|seqra):.+$" }),
      review_key: str({ pattern: "^environmental_review:(ceqr|seqra):.+$" }),
      document_type: enumStr(SEQRA_REVIEW_DOCUMENT_TYPES),
      document_stage: enumStr(SEQRA_DOCUMENT_STAGES),
      issued_date: dateOnly(),
      content_hash: str({ pattern: "^(sha256:)?[a-f0-9]{12,64}$" }),
      supersedes_document_key: strOrNull({ pattern: "^review_document:environmental_review:(ceqr|seqra):.+$" }),
      available_to_public_at: dateTime(),
      ...minimalProvenanceFields(),
    },
  }),

  review_event: entity({
    type: "review_event",
    description: "One append-only event in an environmental review's history (environmental_review -> has_event -> review_event). The event log is the only place review state is recorded; there is no mutable current-state row.",
    required: [
      "event_key", "review_key", "event_type", "effective_at",
      "supersedes_event_key", "payload", ...TEMPORAL_INTEGRITY_REQUIRED,
    ],
    properties: {
      event_key: str({ pattern: "^review_event:.+$" }),
      review_key: str({ pattern: "^environmental_review:(ceqr|seqra):.+$" }),
      event_type: enumStr(SEQRA_REVIEW_EVENT_TYPES),
      effective_at: dateTime(),
      supersedes_event_key: strOrNull({ pattern: "^review_event:.+$" }),
      payload: { type: "object" },
      ...temporalIntegrityFields(),
    },
  }),

  technical_topic_assessment: entity({
    type: "technical_topic_assessment",
    description: "One observation of a technical topic's assessment state for a review, document version, and cutoff (environmental_review -> has_topic_assessment -> technical_topic_assessment). Absence of a mention is not screened_out.",
    required: [
      "assessment_key", "review_key", "document_key", "technical_topic", "state",
      ...TEMPORAL_INTEGRITY_REQUIRED,
    ],
    properties: {
      assessment_key: str({ pattern: "^technical_topic_assessment:.+$" }),
      review_key: str({ pattern: "^environmental_review:(ceqr|seqra):.+$" }),
      document_key: strOrNull({ pattern: "^review_document:environmental_review:(ceqr|seqra):.+$" }),
      technical_topic: enumStr(SEQRA_TECHNICAL_TOPICS),
      state: enumStr(SEQRA_TOPIC_ASSESSMENT_STATES),
      ...temporalIntegrityFields(),
    },
  }),

  mitigation_commitment: entity({
    type: "mitigation_commitment",
    description: "One mitigation or monitoring commitment tied to a review (environmental_review -> has_mitigation -> mitigation_commitment).",
    required: [
      "commitment_key", "review_key", "technical_topic", "description", "status",
      ...TEMPORAL_INTEGRITY_REQUIRED,
    ],
    properties: {
      commitment_key: str({ pattern: "^mitigation_commitment:.+$" }),
      review_key: str({ pattern: "^environmental_review:(ceqr|seqra):.+$" }),
      technical_topic: enumStrOrNull(SEQRA_TECHNICAL_TOPICS),
      description: str(),
      status: enumStr(["proposed", "adopted", "monitoring", "fulfilled", "unfulfilled", "unknown"]),
      ...temporalIntegrityFields(),
    },
  }),

  alternative: entity({
    type: "alternative",
    description: "One alternative considered in a review (environmental_review -> considers_alternative -> alternative).",
    required: ["alternative_key", "review_key", "name", "status", "observed_at", "source_id", "source_record_id"],
    properties: {
      alternative_key: str({ pattern: "^alternative:.+$" }),
      review_key: str({ pattern: "^environmental_review:(ceqr|seqra):.+$" }),
      name: str(),
      description: strOrNull(),
      status: enumStr(["considered", "selected", "rejected", "withdrawn", "unknown"]),
      ...minimalProvenanceFields(),
    },
  }),

  organization: entity({
    type: "organization",
    description: "One organization or institutional actor capable of taking a public position (organization -> takes_position -> public_position).",
    required: ["organization_key", "name", "organization_type", "observed_at", "source_id", "source_record_id"],
    properties: {
      organization_key: str({ pattern: "^organization:[a-z0-9_]+:[a-z0-9_]+$" }),
      name: str(),
      organization_type: enumStr([
        "community_board", "elected_official_office", "advocacy_group", "developer",
        "government_agency", "labor_organization", "other", "unknown",
      ]),
      ...minimalProvenanceFields(),
    },
  }),

  public_position: entity({
    type: "public_position",
    description: "One dated, sourced position an organization took on a review (organization -> takes_position -> public_position; public_position -> concerns_review -> environmental_review). Named issue evidence is kept distinct from generic opposition; lobbying or union participation is never a misconduct label here.",
    required: [
      "position_key", "organization_key", "review_key", "position", "named_issue",
      ...TEMPORAL_INTEGRITY_REQUIRED,
    ],
    properties: {
      position_key: str({ pattern: "^public_position:.+$" }),
      organization_key: str({ pattern: "^organization:[a-z0-9_]+:[a-z0-9_]+$" }),
      review_key: str({ pattern: "^environmental_review:(ceqr|seqra):.+$" }),
      position: enumStr(["support", "oppose", "conditional", "neutral", "no_position_recorded"]),
      named_issue: strOrNull(),
      ...temporalIntegrityFields(),
    },
  }),

  land_use_determination: entity({
    type: "land_use_determination",
    description: "One final land-use determination that relies on a review (land_use_determination -> relies_on_review -> environmental_review). Supersession is explicit; a later determination never overwrites an earlier one in place.",
    required: [
      "determination_key", "action_key", "review_key", "agency", "date", "outcome",
      "supersedes_determination_key", "observed_at", "source_id", "source_record_id",
    ],
    properties: {
      determination_key: str({ pattern: "^determination:[a-z0-9_]+:[a-z0-9_]+:\\d{4}-\\d{2}-\\d{2}$" }),
      action_key: str({ pattern: "^action:[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+$" }),
      review_key: str({ pattern: "^environmental_review:(ceqr|seqra):.+$" }),
      agency: str(),
      date: dateOnly(),
      outcome: enumStr(["approved", "approved_with_conditions", "denied", "withdrawn", "no_action", "unknown"]),
      supersedes_determination_key: strOrNull({ pattern: "^determination:[a-z0-9_]+:[a-z0-9_]+:\\d{4}-\\d{2}-\\d{2}$" }),
      ...minimalProvenanceFields(),
    },
  }),

  judicial_case: entity({
    type: "judicial_case",
    description: "One New York Article 78 or hybrid case challenging a determination (judicial_case -> challenges_determination -> land_use_determination). Out of the hard jurisdiction boundary, no other case type is represented.",
    required: [
      "case_key", "determination_key", "court", "index_number", "filed_date",
      "judicial_review_regime", "observed_at", "source_id", "source_record_id",
    ],
    properties: {
      case_key: str({ pattern: "^judicial_case:.+$" }),
      determination_key: str({ pattern: "^determination:[a-z0-9_]+:[a-z0-9_]+:\\d{4}-\\d{2}-\\d{2}$" }),
      court: str(),
      index_number: strOrNull(),
      filed_date: dateOnlyOrNull(),
      judicial_review_regime: enumStr(["NY_ARTICLE_78", "NY_HYBRID"]),
      ...minimalProvenanceFields(),
    },
  }),

  case_filing: entity({
    type: "case_filing",
    description: "One filing within a judicial case (procedural, not merits or remedy).",
    required: ["filing_key", "case_key", "filing_type", "filed_date", "document_key", "observed_at", "source_id", "source_record_id"],
    properties: {
      filing_key: str({ pattern: "^case_filing:.+$" }),
      case_key: str({ pattern: "^judicial_case:.+$" }),
      filing_type: enumStr(["petition", "answer", "motion", "decision", "order", "stipulation", "other"]),
      filed_date: dateOnlyOrNull(),
      document_key: strOrNull(),
      ...minimalProvenanceFields(),
    },
  }),

  claim_theory: entity({
    type: "claim_theory",
    description: "One legal theory raised within a case, kept separate from procedural survival, merits, and remedy outcomes.",
    required: ["claim_key", "case_key", "theory_category", "description", "observed_at", "source_id", "source_record_id"],
    properties: {
      claim_key: str({ pattern: "^claim_theory:.+$" }),
      case_key: str({ pattern: "^judicial_case:.+$" }),
      theory_category: enumStr(["procedural", "substantive_seqra_ceqr", "constitutional", "other"]),
      description: str(),
      ...minimalProvenanceFields(),
    },
  }),

  search_coverage: entity({
    type: "search_coverage",
    description: "One bounded court-record search coverage assessment for a determination, graded A-U. A search miss under low coverage is never treated as proof no case was filed.",
    required: ["coverage_key", "determination_key", "systems_searched", "coverage_grade", "search_date", "observed_at", "source_id", "source_record_id"],
    properties: {
      coverage_key: str({ pattern: "^search_coverage:.+$" }),
      determination_key: strOrNull({ pattern: "^determination:[a-z0-9_]+:[a-z0-9_]+:\\d{4}-\\d{2}-\\d{2}$" }),
      systems_searched: arrOfStr(),
      coverage_grade: enumStr(["A", "B", "C", "U"]),
      search_date: dateOnly(),
      ...minimalProvenanceFields(),
    },
  }),
});

export const SEQRA_ONTOLOGY_ENTITY_TYPES = Object.freeze(Object.keys(SEQRA_ONTOLOGY_ENTITY_SPECS));

// ---- required relations ---------------------------------------------------

export const SEQRA_ONTOLOGY_RELATIONS = Object.freeze([
  { from: "project", relation: "requires_action", to: "government_action" },
  { from: "environmental_review", relation: "reviews_action", to: "government_action" },
  { from: "environmental_review", relation: "has_document", to: "review_document" },
  { from: "environmental_review", relation: "has_event", to: "review_event" },
  { from: "environmental_review", relation: "has_topic_assessment", to: "technical_topic_assessment" },
  { from: "environmental_review", relation: "has_mitigation", to: "mitigation_commitment" },
  { from: "environmental_review", relation: "considers_alternative", to: "alternative" },
  { from: "organization", relation: "takes_position", to: "public_position" },
  { from: "public_position", relation: "concerns_review", to: "environmental_review" },
  { from: "land_use_determination", relation: "relies_on_review", to: "environmental_review" },
  { from: "judicial_case", relation: "challenges_determination", to: "land_use_determination" },
  { from: "review_document", relation: "supersedes_document", to: "review_document" },
  { from: "land_use_determination", relation: "decision_supersedes", to: "land_use_determination" },
]);

// ---- generic hand-rolled validator ---------------------------------------

function typeMatches(value, typeSpec) {
  const types = Array.isArray(typeSpec) ? typeSpec : [typeSpec];
  return types.some((type) => {
    if (type === "null") return value === null;
    if (type === "string") return typeof value === "string";
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "boolean") return typeof value === "boolean";
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return false;
  });
}

/**
 * Validate one plain object against one entity spec from
 * SEQRA_ONTOLOGY_ENTITY_SPECS. Returns an array of human-readable findings
 * (empty when valid), following this repository's `findings.push(...)`
 * convention (see tools/architecture_watermark.mjs#validateShard) rather
 * than throwing, so a caller can report every violation at once.
 */
export function validateSeqraEntity(entityType, obj, label = entityType) {
  const spec = SEQRA_ONTOLOGY_ENTITY_SPECS[entityType];
  const findings = [];
  if (!spec) {
    findings.push(`${label}: unknown SEQRA ontology entity type ${JSON.stringify(entityType)}`);
    return findings;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    findings.push(`${label}: malformed ${entityType} (not an object)`);
    return findings;
  }
  for (const field of spec.required) {
    if (!(field in obj)) findings.push(`${label}: missing required field ${field}`);
  }
  const allowed = new Set(Object.keys(spec.properties));
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) findings.push(`${label}: unsupported field ${key}`);
  }
  for (const [field, fieldSpec] of Object.entries(spec.properties)) {
    if (!(field in obj)) continue;
    const value = obj[field];
    if (!typeMatches(value, fieldSpec.type)) {
      findings.push(`${label}: ${field} has wrong type (expected ${JSON.stringify(fieldSpec.type)})`);
      continue;
    }
    if (fieldSpec.enum && !fieldSpec.enum.includes(value)) {
      findings.push(`${label}: ${field} value ${JSON.stringify(value)} is not one of ${JSON.stringify(fieldSpec.enum)}`);
    }
    if (fieldSpec.pattern && typeof value === "string" && !new RegExp(fieldSpec.pattern).test(value)) {
      findings.push(`${label}: ${field} value ${JSON.stringify(value)} does not match ${fieldSpec.pattern}`);
    }
    if (fieldSpec.type === "number" || (Array.isArray(fieldSpec.type) && fieldSpec.type.includes("number"))) {
      if (typeof value === "number") {
        if (fieldSpec.minimum != null && value < fieldSpec.minimum) findings.push(`${label}: ${field} below minimum ${fieldSpec.minimum}`);
        if (fieldSpec.maximum != null && value > fieldSpec.maximum) findings.push(`${label}: ${field} above maximum ${fieldSpec.maximum}`);
      }
    }
    if (fieldSpec.type === "array" && Array.isArray(value) && fieldSpec.items) {
      value.forEach((item, index) => {
        if (!typeMatches(item, fieldSpec.items.type)) {
          findings.push(`${label}: ${field}[${index}] has wrong item type (expected ${JSON.stringify(fieldSpec.items.type)})`);
        }
      });
    }
  }
  return findings;
}

/** Convert one entity spec into a full JSON Schema (draft 2020-12) document. */
export function buildEntityJsonSchema(entityType) {
  const spec = SEQRA_ONTOLOGY_ENTITY_SPECS[entityType];
  if (!spec) throw new Error(`unknown SEQRA ontology entity type ${JSON.stringify(entityType)}`);
  const properties = {};
  for (const [field, fieldSpec] of Object.entries(spec.properties)) {
    const out = { type: fieldSpec.type };
    if (fieldSpec.enum) out.enum = fieldSpec.enum;
    if (fieldSpec.pattern) out.pattern = fieldSpec.pattern;
    if (fieldSpec.format) out.format = fieldSpec.format;
    if (fieldSpec.description) out.description = fieldSpec.description;
    if (fieldSpec.minimum != null) out.minimum = fieldSpec.minimum;
    if (fieldSpec.maximum != null) out.maximum = fieldSpec.maximum;
    if (fieldSpec.items) out.items = { type: fieldSpec.items.type };
    if (fieldSpec.description !== undefined) out.description = fieldSpec.description;
    properties[field] = out;
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://cityscroll.org/schemas/seqra_ontology_${entityType}.v1.schema.json`,
    title: `SEQRA/CEQR ontology: ${entityType}`,
    description: spec.description,
    type: "object",
    additionalProperties: false,
    required: spec.required,
    properties,
  };
}
