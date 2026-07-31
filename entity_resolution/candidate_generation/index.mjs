// entity_resolution/candidate_generation — blocking / candidate pairs (stub).
//
// Token/stem blocking v0 lands in er-05. This module is the package slot so
// the metrics harness and later matchers can import a stable path without
// inventing a second home.

/** Stub version until er-05 ships a real blocker. */
export const CANDIDATE_GENERATION_VERSION = "stub";

/**
 * Produce candidate pairs from normalized records.
 * Stub: always empty. er-05 fills in token/stem blocking.
 *
 * @param {unknown[]} _records
 * @param {{ blocker?: string }} [_opts]
 * @returns {unknown[]}
 */
export function generateCandidates(_records = [], _opts = {}) {
  return [];
}
