// entity_resolution/review — human review queue helpers (stub).
//
// Soft "possibly same" UI and review_status on entity_link land in later cards
// (er-06+). This slot holds queue shaping only — no public HTTP review service.

/** Stub version until review UI / queue cards land. */
export const REVIEW_VERSION = "stub";

/**
 * Shape a scorer result into a review-queue item.
 * Stub: returns null (nothing queued).
 *
 * @param {unknown} _pair
 * @param {unknown} _score
 * @returns {null}
 */
export function toReviewItem(_pair, _score) {
  return null;
}
