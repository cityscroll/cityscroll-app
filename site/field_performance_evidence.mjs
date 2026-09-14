/**
 * Provenance contract for evidence that is allowed to answer a field-performance gate.
 *
 * The Worker returns bounded aggregates, not per-request rows. This contract therefore
 * records the deployed read endpoint's revision, the retained dataset vintage, and the
 * exact aggregate observation window without pretending that a fixture or lab trace is
 * a production distribution.
 */

export const FIELD_PERFORMANCE_PROVENANCE_SCHEMA = "cityscroll.performance.field_provenance.v1";
export const FIELD_PERFORMANCE_SOURCE = "production field";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoInstant(value) {
  if (!nonEmpty(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === new Date(value).toISOString();
}

function validDataVintage(value) {
  if (nonEmpty(value)) return true;
  if (!isRecord(value) || !nonEmpty(value.dataset)) return false;
  return ["first_observation_at", "latest_observation_at"].every((key) => (
    value[key] == null || isoInstant(value[key])
  ));
}

export function buildFieldPerformanceProvenance({
  route,
  codeRevision,
  dataVintage,
  observationWindow,
  sampleCount,
  queriedAt,
  dataset = null,
  codeRevisionScope = "deployed Worker revision used for the read; retained rows may span releases",
} = {}) {
  const vintage = dataVintage || (dataset ? { dataset } : null);
  return {
    schema: FIELD_PERFORMANCE_PROVENANCE_SCHEMA,
    source: FIELD_PERFORMANCE_SOURCE,
    measurement_class: "field",
    route: String(route || ""),
    code_revision: String(codeRevision || ""),
    code_revision_scope: codeRevisionScope,
    data_vintage: vintage,
    observation_window: observationWindow || null,
    sample_count: Number.isSafeInteger(sampleCount) ? sampleCount : null,
    queried_at: queriedAt || null,
  };
}

/**
 * Validate provenance on an evidence document. `requireSufficient` is opt-in so an
 * honest production capture with fewer than 30 retained rows can be committed as
 * insufficient rather than padded; field gates pass this option when evaluating a
 * percentile result.
 */
export function validateFieldPerformanceEvidence(evidence, { requireSufficient = false, sampleFloor = 30 } = {}) {
  const errors = [];
  const provenance = evidence?.provenance;
  if (!isRecord(provenance) || provenance.schema !== FIELD_PERFORMANCE_PROVENANCE_SCHEMA) {
    errors.push("field gate requires production field provenance");
    return { ok: false, errors };
  }
  if (provenance.source !== FIELD_PERFORMANCE_SOURCE || provenance.measurement_class !== "field") {
    errors.push("field gate requires production field provenance, not fixture or lab evidence");
  }
  if (!nonEmpty(provenance.route) || !provenance.route.startsWith("/")) {
    errors.push("field provenance must name the served route");
  }
  if (!/^[a-f0-9]{7,40}$/.test(provenance.code_revision || "")) {
    errors.push("field provenance must name a 7- to 40-character code revision");
  }
  if (!validDataVintage(provenance.data_vintage)) {
    errors.push("field provenance must name the retained data vintage");
  }
  const window = provenance.observation_window;
  if (!isRecord(window) || !isoInstant(window.start) || !isoInstant(window.end)
    || Date.parse(window.start) >= Date.parse(window.end)) {
    errors.push("field provenance must name an ordered observation window");
  }
  if (!Number.isSafeInteger(provenance.sample_count) || provenance.sample_count < 0) {
    errors.push("field provenance must name the retained sample count");
  } else if (requireSufficient && provenance.sample_count < sampleFloor) {
    errors.push(`field provenance has fewer than ${sampleFloor} retained observations`);
  }
  if (provenance.queried_at != null && !isoInstant(provenance.queried_at)) {
    errors.push("field provenance queried_at must be an ISO instant");
  }
  return { ok: errors.length === 0, errors };
}
