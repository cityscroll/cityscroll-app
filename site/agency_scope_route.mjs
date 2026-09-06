import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { reviewedInstitutionName } from "./civic_institution_party_spellings.mjs";
import { routeHashFromScope, scopeFromRouteHash } from "./scope_v0.mjs";

/**
 * Relations that name an institution through a field other than the record's
 * publishing agency. A scope carrying one of these is asking about a different
 * party, so its institution ref must not also seed the agency-name control:
 * demanding `agency_name` match while the relation reads `vendor_name` is a
 * contradiction that can only ever answer nothing.
 */
const NON_AGENCY_PARTY_RELATIONS = Object.freeze(new Set(["named_vendor"]));

/**
 * Resolve the agency display value needed by the live feed controls from a
 * typed scope facet. The API feed uses the source agency name, while the
 * shareable route uses the canonical agency:id:<slug> edge.
 *
 * Only a name this repository actually resolved is returned. An unresolved id
 * previously fell through as its own route slug, which the feed then applied as
 * an exact `agency_name` filter and matched nothing — an institution with a
 * profile but no alias entry became an empty result rather than an unfiltered
 * one.
 */
export function agencyNameFromEntityFacet(values = {}) {
  if (NON_AGENCY_PARTY_RELATIONS.has(String(values?.connection_relation || "").trim())) return "";
  const refs = Array.isArray(values?.entity_refs_all) ? values.entity_refs_all : [];
  for (const rawRef of refs) {
    const match = String(rawRef || "").trim().match(/^agency:(?:id:)?([^:\s]+(?:-[^:\s]+)*)$/);
    if (!match) continue;
    const reviewed = reviewedInstitutionName(match[1]);
    if (reviewed) return reviewed;
    const resolved = resolveAgencyIdentity(match[1]);
    if (resolved?.matched && resolved.canonical_name) return resolved.canonical_name;
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
