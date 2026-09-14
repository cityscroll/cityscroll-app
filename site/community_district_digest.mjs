/** Public contract for the bounded community-district overview projection. */

export const COMMUNITY_DISTRICT_DIGEST_SCHEMA = "cityscroll.community_district_digest.v1";
export const COMMUNITY_DISTRICT_DIGEST_SECTIONS = Object.freeze([
  Object.freeze({ id: "meetings", label: "Upcoming meetings" }),
  Object.freeze({ id: "land", label: "Land use" }),
  Object.freeze({ id: "property", label: "Property" }),
  Object.freeze({ id: "rules", label: "Rules" }),
  Object.freeze({ id: "money", label: "Money" }),
]);
export const COMMUNITY_DISTRICT_COVERAGE_STATES = Object.freeze([
  "supported", "known_zero", "unsupported", "unavailable", "stale", "failed",
]);

export function communityDistrictDigestRows(digest, district) {
  const row = digest?.by_community_district?.[String(district || "").toUpperCase()];
  return row?.sections && typeof row.sections === "object" ? row.sections : {};
}

export function communityDistrictDigestSection(digest, district, section) {
  return communityDistrictDigestRows(digest, district)?.[section] || null;
}
