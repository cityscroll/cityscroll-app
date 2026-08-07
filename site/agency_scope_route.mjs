import { resolveAgencyIdentity } from "./agency_identity.mjs";

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
