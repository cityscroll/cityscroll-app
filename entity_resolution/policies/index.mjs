// entity_resolution/policies — auto-link thresholds and decision routing (stub).
//
// Policy decides when a scorer result becomes an entity_link vs review queue
// vs explicit separate. Family-specific thresholds live here later.

/** Stub version until policy cards land. */
export const POLICIES_VERSION = "stub";

/**
 * Route a matcher result to a durable decision.
 * Stub: pass through unresolved; never auto-links.
 *
 * @param {{ decision?: string, confidence?: number|null }} result
 * @param {{ entityType?: string }} [_opts]
 * @returns {{ decision: string, auto_link: false }}
 */
export function routeDecision(result = {}, _opts = {}) {
  const decision = result.decision || "unresolved";
  return { decision, auto_link: false };
}
