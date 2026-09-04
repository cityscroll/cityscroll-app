/**
 * Canonical place-scope fixtures (PS-06).
 *
 * One test geography (a Canarsie-equivalent Brooklyn community district, sitting inside
 * one council district) with the five record kinds the place-scope contract must
 * distinguish, plus the two scope fixtures the commission calls for: a council-district
 * scope combining keyword + domain + agency + place role + time window, and a
 * community-district scope built for Following watch serialization.
 *
 * These are deliberately administrative-geography fixtures only — no derived or
 * subjective geography (outer_borough, urban_core, transit_desert, walkable, ...).
 */

export const FIXTURE_BOROUGH = "Brooklyn";
export const FIXTURE_COMMUNITY_DISTRICT = "K18"; // Canarsie-equivalent test community district.
export const FIXTURE_COUNCIL_DISTRICT = "42"; // Same Canarsie-equivalent area, council level.
export const ELSEWHERE_COMMUNITY_DISTRICT = "Q04"; // A different, unrelated test district.

export const FIXTURE_COMMUNITY_DISTRICT_SUBJECT = `community-district:${FIXTURE_COMMUNITY_DISTRICT}`;
export const FIXTURE_COUNCIL_DISTRICT_SUBJECT = `council-district:${FIXTURE_COUNCIL_DISTRICT}`;
const ELSEWHERE_SUBJECT = `community-district:${ELSEWHERE_COMMUNITY_DISTRICT}`;

/** Registry-shaped geography nodes the fixture's located_in edges point at. */
export const FIXTURE_GEOGRAPHY_NODES = Object.freeze([
  { subject_ref: FIXTURE_COMMUNITY_DISTRICT_SUBJECT, kind: "community-district", label: "Canarsie (Community District 18, Brooklyn)" },
  { subject_ref: FIXTURE_COUNCIL_DISTRICT_SUBJECT, kind: "council-district", label: "Canarsie (Council District 42, Brooklyn)" },
  { subject_ref: ELSEWHERE_SUBJECT, kind: "community-district", label: "Elmhurst-Corona (Community District 4, Queens)" },
]);

/** One public, well-formed mandate backlink shared by every fixture record. */
export const FIXTURE_MANDATE_BACKLINKS = Object.freeze([{
  duty_text: "Publish the annual district capital and service plan.",
  citation: "NYC Charter § 203",
  relation: "requires_public_hearing",
  relation_label: "Requires a public hearing",
  agency_id: "transportation",
  agency_name: "Transportation",
  agency_href: "/agencies/transportation/",
  publication_tier: "deterministic",
}]);

function locatedEdge(recordId, toSubject, { placementMethod = "matter_title_place" } = {}) {
  return {
    type: "located_in",
    from: `notice:${recordId}`,
    to: toSubject,
    decision: "public",
    method: "district_activity_placement_v1",
    method_version: "1.0.0",
    confidence: "strong",
    evidence: { lens: "meetings", placement_method: placementMethod, boundary_vintage: "2026-05-26" },
  };
}

/**
 * The five record kinds the commission requires for one test geography. Each entry
 * carries the compact district-activity record plus the located_in edges the Near-you
 * explanation-path builder consumes — see site/near_you_explanation_path.mjs.
 */
export const FIXTURE_ONE_RECORDS = Object.freeze({
  // A. Meeting venue here, matter elsewhere: only known evidence for this geography is venue.
  venueHere: {
    record: { id: "psc-201", basis: "Venue / logistics" },
    locatedEdges: [locatedEdge("psc-201", FIXTURE_COMMUNITY_DISTRICT_SUBJECT, { placementMethod: "venue_line" })],
  },
  // B. Land-use matter here, hearing venue elsewhere: only known evidence for this
  // geography is the matter place.
  matterHere: {
    record: { id: "psc-202", basis: "Matter place" },
    locatedEdges: [locatedEdge("psc-202", FIXTURE_COMMUNITY_DISTRICT_SUBJECT, { placementMethod: "matter_title_place" })],
  },
  // C. Action affects here; venue and matter are both elsewhere.
  affectedAreaHere: {
    record: { id: "psc-203", basis: "Affected area" },
    locatedEdges: [locatedEdge("psc-203", FIXTURE_COMMUNITY_DISTRICT_SUBJECT, { placementMethod: "classic_affected_area" })],
  },
  // D. Weak geographic fallback only: never eligible for a confident exact-place path.
  weakFallbackOnly: {
    record: { id: "psc-204", basis: "Weak fallback" },
    locatedEdges: [locatedEdge("psc-204", FIXTURE_COMMUNITY_DISTRICT_SUBJECT, { placementMethod: "agency_hq" })],
  },
  // E. Unrelated: its only place evidence points at a different district entirely.
  unrelated: {
    record: { id: "psc-205", basis: "Venue / logistics" },
    locatedEdges: [locatedEdge("psc-205", ELSEWHERE_SUBJECT, { placementMethod: "venue_line" })],
  },
});
