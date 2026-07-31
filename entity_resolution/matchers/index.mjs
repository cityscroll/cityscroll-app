// entity_resolution/matchers — scoring + decision methods (stub).
//
// Matchers consume features and emit same | different | unresolved (or review).
// LLM matching is out of scope as a primary matcher (taxonomy ADR).
// No production auto-links from this package boundary card.

/** Stub version until matcher cards land. */
export const MATCHERS_VERSION = "stub";

/**
 * Score a candidate pair. Stub: always unresolved with null confidence.
 *
 * @param {unknown} _left
 * @param {unknown} _right
 * @param {Record<string, unknown>} [_features]
 * @returns {{ decision: "unresolved", confidence: null, method: string, matcher_version: string }}
 */
export function scorePair(_left, _right, _features = {}) {
  return {
    decision: "unresolved",
    confidence: null,
    method: "stub",
    matcher_version: MATCHERS_VERSION,
  };
}
