// entity_resolution/review — desk-only soft review cards and human-gated alias review.
// This module deliberately does not decide identity; alias promotion is an explicit clerk action.

export const REVIEW_VERSION = "possibly_same_v1";
export const REVIEW_DECISION = "review";

export { ACTIVE_REVIEW_VERSION, activeReviewItems, rankActiveReviewItems } from "./active_review.mjs";

export {
  CURATION_EFFECT_VERSION,
  CURATION_PROVISIONAL_STATE,
  CURATION_REVIEW_POLICY_VERSION,
  CURATION_VERDICT,
  CURATION_VERDICT_SCHEMA_VERSION,
  buildCurationVerdictReceipt,
  projectCurationVerdictState,
} from "./curation_verdicts.mjs";

export {
  INVESTIGATION_WORKSPACE_VERSION,
  buildInvestigationWorkspace,
} from "./investigation_workspace.mjs";

const clampConfidence = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
};

const clean = (value, fallback = "") => String(value ?? fallback).replace(/\s+/g, " ").trim();

/**
 * Shape one candidate/scorer result for a human review surface.
 * No identity assertion is made: the returned decision is always `review`.
 */
export function toReviewItem(pair = {}, score = {}) {
  const left = pair.left || pair.a || pair.source || {};
  const right = pair.right || pair.b || pair.candidate || {};
  const leftName = clean(left.vendor_name ?? left.name ?? pair.left_name);
  const rightName = clean(right.vendor_name ?? right.name ?? pair.right_name);
  if (!leftName || !rightName) return null;

  const confidence = clampConfidence(score.confidence ?? pair.confidence ?? score.score ?? pair.score);
  return {
    id: clean(pair.id || pair.pair_id || `${leftName}::${rightName}`),
    entity_type: "vendor",
    label: "Possibly same vendor",
    decision: REVIEW_DECISION,
    confidence,
    method: clean(score.method || pair.method, "candidate_review"),
    matcher_version: clean(score.matcher_version || pair.matcher_version, REVIEW_VERSION),
    left: {
      id: clean(left.id ?? left.source_record_id),
      name: leftName,
      source: clean(left.source || left.source_system),
      source_record_key: clean(left.source_system_id),
      source_url: clean(left.source_url),
      observed_fields: left.observed_fields || {},
      observed_at: clean(left.ingested_at),
    },
    right: {
      id: clean(right.id ?? right.source_record_id),
      name: rightName,
      source: clean(right.source || right.source_system),
      source_record_key: clean(right.source_system_id),
      source_url: clean(right.source_url),
      observed_fields: right.observed_fields || {},
      observed_at: clean(right.ingested_at),
    },
    evidence: score.evidence || pair.evidence || {},
    review_status: "pending",
  };
}

export function toReviewItems(pairs = []) {
  return (Array.isArray(pairs) ? pairs : [])
    .map((entry) => toReviewItem(entry.pair || entry, entry.score || entry))
    .filter(Boolean);
}
