// entity_resolution/matchers — conventional deterministic matcher v0.
// Middle-band pairs remain unresolved; no LLM participates in scoring.

import { extractFeatures } from "../features/index.mjs";

export const MATCHERS_VERSION = "conventional_v1";

function result(decision, confidence, method) {
  return {
    decision,
    confidence,
    method,
    matcher_version: MATCHERS_VERSION,
  };
}

/**
 * Score one pair as same | different | unresolved.
 * Hard identifiers and exact family identity are the only broad auto-same
 * paths. Similarity alone must clear a narrow high-confidence threshold.
 */
export function scorePair(left = {}, right = {}, features = null, opts = {}) {
  const f = features?.features_version
    ? features
    : extractFeatures(left, right, opts);

  if (f.authority_key_equal) {
    return result("same", 0.995, "scoped_authority_key_equal_v1");
  }

  if (f.contract_id_equal) {
    return result("same", 0.995, "contract_id_equal_v0");
  }

  if (f.family === "procurement" && f.hard_id_conflict) {
    return result("different", 0.995, "hard_id_conflict_v0");
  }

  if (f.family === "agency" && f.agency_place_conflict) {
    return result("different", 0.98, "agency_place_conflict_v0");
  }

  if (f.family === "vendor" && f.legal_form_conflict && f.token_jaccard === 1) {
    return result("different", 0.97, "vendor_legal_form_conflict_v0");
  }

  if (f.stem_equal && f.family !== "procurement") {
    return result("same", 0.985, `${f.family}_stem_equal_v0`);
  }

  if (f.family !== "procurement" && !f.legal_form_conflict && f.token_jaccard >= 0.9) {
    return result("same", 0.95, `${f.family}_token_similarity_v0`);
  }

  const confidence = Math.min(0.84, 0.45 + (f.token_jaccard * 0.35) + (f.length_ratio * 0.04));
  return result("unresolved", Number(confidence.toFixed(3)), `${f.family}_similarity_v0`);
}
