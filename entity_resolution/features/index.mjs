// entity_resolution/features — pair feature extractors (stub).
//
// Future cards score candidate pairs with deterministic features
// (string similarity, shared tokens, PIN/EPIN equality, etc.).
// No feature extractors in this boundary card.

/** Stub version until a feature card lands. */
export const FEATURES_VERSION = "stub";

/**
 * Extract a feature map for a candidate pair.
 * Stub: empty object.
 *
 * @param {unknown} _left
 * @param {unknown} _right
 * @param {{ entityType?: string }} [_opts]
 * @returns {Record<string, unknown>}
 */
export function extractFeatures(_left, _right, _opts = {}) {
  return {};
}
