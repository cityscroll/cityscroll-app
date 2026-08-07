// Baseline scorer. This is the existing conservative statistical judgment,
// moved behind the scorer contract without changing its policy-facing output.

import { extractFeatures, FEATURES_VERSION } from "../features/index.mjs";
import { createScorer, hashJson } from "./contract.mjs";

export const MATCHERS_VERSION = "conventional_v2";

function result(decision, confidence, method) {
  return {
    decision,
    confidence,
    method,
    matcher_version: MATCHERS_VERSION,
  };
}

/** Score one pair using the unchanged conventional_v2 rules. */
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

  if (f.family === "vendor" && !f.legal_form_conflict &&
      f.typo_proximity?.close && f.token_jaccard >= 0.5 &&
      f.shared_tokens.length >= 1) {
    return result("same", 0.93, "vendor_typo_proximity_v1");
  }

  if (f.family === "vendor" && !f.legal_form_conflict && f.stem_truncation &&
      (f.shared_tokens.length >= 1 || f.hard_id_equal)) {
    return result("same", 0.92, "vendor_truncation_v1");
  }

  if (f.family === "vendor" && !f.legal_form_conflict &&
      f.abbreviation_matches > 0) {
    const unmatchedLeft = f.left_token_count - f.shared_tokens.length;
    const unmatchedRight = f.right_token_count - f.shared_tokens.length;
    if (f.abbreviation_matches >= unmatchedLeft &&
        f.abbreviation_matches >= unmatchedRight) {
      return result("same", 0.91, "vendor_abbreviation_v1");
    }
  }

  const confidence = Math.min(0.84, 0.45 + (f.token_jaccard * 0.35) + (f.length_ratio * 0.04));
  return result("unresolved", Number(confidence.toFixed(3)), `${f.family}_similarity_v0`);
}

const RULESET = {
  matcher_version: MATCHERS_VERSION,
  features_version: FEATURES_VERSION,
  confidence_is_calibrated_probability: false,
  policy_compatible: true,
};

export const conventionalV2Scorer = createScorer({
  name: MATCHERS_VERSION,
  version: MATCHERS_VERSION,
  artifactHash: hashJson({ scorer: MATCHERS_VERSION, ruleset: RULESET }),
  configHash: hashJson(RULESET),
  scoreBatch({ candidate_pairs: pairs }) {
    return pairs.map((pair) => {
      const score = scorePair(pair.left, pair.right, pair.features, {
        entityType: pair.entity_type || pair.features.family,
      });
      return {
        pair_id: pair.pair_id,
        probability: score.confidence,
        evidence: {
          ...score,
          evidence_type: "deterministic_rules",
          features_version: pair.features.features_version,
          probability_semantics: "fixed_confidence_not_calibrated_probability",
        },
      };
    });
  },
});
