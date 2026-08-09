/**
 * Choose the Property view for a place-scoped route.
 *
 * A place scope can have no current records while still having useful closed
 * records. Keep an explicit archive request authoritative; otherwise fall
 * back only when the scoped current set is empty and the scoped archive set is
 * non-empty.
 */

export const PROPERTY_SCOPE_FALLBACK_SCHEMA = "cityscroll.property_scope_fallback.v1";

export function propertyScopeView({
  requestedView = "default",
  placeScoped = false,
  currentCount = 0,
  archiveCount = 0,
} = {}) {
  const requested = requestedView === "archive" ? "archive" : "default";
  if (requested === "archive") return "archive";
  if (placeScoped && Number(currentCount) === 0 && Number(archiveCount) > 0) return "archive";
  return requested;
}
