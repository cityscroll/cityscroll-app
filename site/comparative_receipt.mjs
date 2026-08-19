/**
 * Frozen, presentation-neutral envelope for materialized comparative facts.
 *
 * This module owns the receipt boundary only. Metric-family arithmetic and
 * publication decisions stay in their respective pure compilers.
 */

export const COMPARATIVE_FACT_SCHEMA = "cityscroll.comparative_fact.v1";
export const COMPARATIVE_FACT_READ_MODEL_SCHEMA = "cityscroll.comparative_fact_read_model.v1";
export const COMPARATIVE_COVERAGE_RECEIPT_SCHEMA = "cityscroll.comparative_coverage_receipt.v1";

function required(value, name) {
  if (value == null || value === "") throw new TypeError(`${name} is required`);
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Create one validated comparative-fact receipt without calculating a metric. */
export function createComparativeFact({
  factId,
  subject,
  metric,
  value,
  peerClass,
  comparison,
  observation,
  evidence,
  provenance,
  generatedAt,
} = {}) {
  required(subject?.id, "subject.id");
  required(subject?.ref, "subject.ref");
  required(metric?.id, "metric.id");
  required(metric?.method, "metric.method");
  if (!Number.isFinite(value)) throw new TypeError("value must be a finite number");
  required(peerClass?.class_id, "peerClass.class_id");
  required(comparison?.population, "comparison.population");
  if (!Number.isInteger(comparison?.eligible_count) || comparison.eligible_count < 0) {
    throw new TypeError("comparison.eligible_count must be a non-negative integer");
  }
  if (!Number.isInteger(comparison?.observed_count) || comparison.observed_count < 0) {
    throw new TypeError("comparison.observed_count must be a non-negative integer");
  }
  required(comparison?.window?.start, "comparison.window.start");
  required(comparison?.window?.end, "comparison.window.end");
  if (!Number.isInteger(comparison?.rank) || comparison.rank < 1) {
    throw new TypeError("comparison.rank must be a positive integer");
  }
  required(observation?.basis, "observation.basis");
  required(observation?.negative_inference, "observation.negative_inference");
  if (!Array.isArray(observation?.source_vintages) || observation.source_vintages.length === 0) {
    throw new TypeError("observation.source_vintages is required");
  }
  if (!Array.isArray(evidence) || evidence.length === 0) throw new TypeError("evidence is required");
  required(provenance?.compiler_method, "provenance.compiler_method");
  required(generatedAt, "generatedAt");

  return deepFreeze({
    schema: COMPARATIVE_FACT_SCHEMA,
    fact_id: required(factId, "factId"),
    subject,
    metric,
    value,
    peer_class: peerClass,
    comparison,
    observation,
    evidence,
    provenance,
    generated_at: generatedAt,
  });
}
