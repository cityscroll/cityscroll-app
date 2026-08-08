import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { routeHashFromScope, scopeFromRouteHash } from "./scope_v0.mjs";

/**
 * Resolve the agency display value needed by the live feed controls from a
 * typed scope facet. The API feed uses the source agency name, while the
 * shareable route uses the canonical agency:id:<slug> edge.
 */
export function agencyNameFromEntityFacet(values = {}) {
  const refs = Array.isArray(values?.entity_refs_all) ? values.entity_refs_all : [];
  for (const rawRef of refs) {
    const match = String(rawRef || "").trim().match(/^agency:(?:id:)?([^:\s]+(?:-[^:\s]+)*)$/);
    if (!match) continue;
    const resolved = resolveAgencyIdentity(match[1]);
    if (resolved?.canonical_name) return resolved.canonical_name;
  }
  return "";
}

/** Preserve the current lens scope while replacing its agency axis. */
export function agencyScopeHref(surface, agency, currentHash = "") {
  const lens = String(surface || "meetings").trim() || "meetings";
  const raw = String(currentHash || `#${lens}`);
  const hash = raw.startsWith("#") ? raw : `#${raw}`;
  const scope = scopeFromRouteHash(hash, { language: "en" });
  scope.facets.agencies = agency ? [String(agency)] : [];
  return routeHashFromScope(scope, { surface: lens });
}
