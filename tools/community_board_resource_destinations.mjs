export const RESOURCE_DESTINATION_DISPOSITIONS = Object.freeze([
  "not-published",
  "unreachable",
  "not-yet-reviewed",
  "observed",
]);

const PLACEHOLDER_HASH = /^#?$/;

/**
 * Classify a discovered destination without treating an unvisited link as a
 * publisher negative. Generic landings are rejected even when they return 200.
 */
export function rejectCommunityBoardResourceDestination(input = {}) {
  const href = String(input.url ?? input.href ?? "").trim();
  if (!href) return { accepted: false, reason: "not-yet-reviewed" };
  if (/^javascript:/i.test(href)) return { accepted: false, reason: "placeholder" };
  if (PLACEHOLDER_HASH.test(href)) return { accepted: false, reason: "placeholder" };
  if (input.soft_404 === true || input.http_status === 404 || input.http_status === 410) {
    return { accepted: false, reason: "soft-404" };
  }
  if (input.redirects_to_wrong_board === true) return { accepted: false, reason: "wrong-board-redirect" };
  if (input.generic_landing === true) return { accepted: false, reason: "generic-landing" };
  if (input.reachable === false) return { accepted: false, reason: "unreachable" };
  return { accepted: true, reason: null };
}
