/**
 * Typed institutional relations projected from geometric containment.
 *
 * `resolveCivicGeographies` (site/civic_geography.mjs) answers only geometric
 * containment: which published polygons a point falls inside, all reported
 * with the same generic `contains_point` relation. That is useful
 * computational evidence, but a council district, a police precinct, a
 * neighbourhood tabulation area, and a business improvement district do not
 * reach a resident's address the same way -- one seats an elected office,
 * two deliver a department's own service, one is a statistical label, and
 * one has no established institutional meaning at all yet.
 *
 * This module keeps `located_in` containment exactly as-is (it is never
 * read, mutated, or filtered here) and separately projects a typed
 * institutional edge -- `represented_by`, `served_by`, or
 * `statistically_classified_as` -- only for the geography classes whose
 * institutional meaning is already established as a per-type structural
 * fact. The target of a typed edge is the same district/precinct/NTA
 * feature the containment edge already names; a typed edge is never
 * inferred from a polygon's free-text label, only from its validated
 * canonical id and type.
 */

import { civicGeographyLayer } from "./civic_geography_registry.mjs";

export const GEOGRAPHY_RELATION_SCHEMA = "cityscroll.geography_relation.v1";

export const INSTITUTIONAL_RELATION_PREDICATES = Object.freeze([
  "represented_by",
  "served_by",
  "statistically_classified_as",
]);

const RELATION_MAPPINGS = Object.freeze({
  council_district: Object.freeze({
    predicate: "represented_by",
    institutional_basis:
      "The NYC City Charter's council-district geography is the seat for exactly one elected City Council member per numbered district. The edge names the district/office, never a specific officeholder or term.",
    validity_assumptions: Object.freeze([
      "The published council_district boundary vintage used for containment is current.",
      "Representation is asserted at the district/office level; it does not assert who currently holds the seat or when their term runs.",
    ]),
    temporal_limitations:
      "Council district lines are redrawn at redistricting and the officeholder changes at each election/term boundary; this edge carries neither a term nor an officeholder identity.",
  }),
  police_precinct: Object.freeze({
    predicate: "served_by",
    institutional_basis:
      "An NYPD police precinct boundary is the department's own geographic patrol/command jurisdiction, not a generic administrative overlay drawn for some other purpose.",
    validity_assumptions: Object.freeze([
      "The published police_precinct boundary vintage used for containment is current.",
    ]),
    temporal_limitations:
      "Precinct boundaries and command assignments can be revised by the NYPD; a boundary-vintage change can move which precinct serves a point.",
  }),
  sanitation_district: Object.freeze({
    predicate: "served_by",
    institutional_basis:
      "A DSNY sanitation district boundary is the department's own geographic collection-routing jurisdiction, not a generic administrative overlay drawn for some other purpose.",
    validity_assumptions: Object.freeze([
      "The published sanitation_district boundary vintage used for containment is current.",
    ]),
    temporal_limitations:
      "Sanitation district boundaries and garage assignments can be redrawn by DSNY.",
  }),
  nta2020: Object.freeze({
    predicate: "statistically_classified_as",
    institutional_basis:
      "A neighbourhood tabulation area (NTA2020) is a DCP statistical tabulation geography built from Census-tract geography. It classifies; it neither represents nor serves.",
    validity_assumptions: Object.freeze([
      "The published nta2020 boundary vintage used for containment is current.",
    ]),
    temporal_limitations:
      "NTA boundaries are revised roughly once per decade alongside Census geography.",
  }),
});

// Geography classes considered and deliberately left untyped. Listed
// explicitly (rather than left silent) so the absence of a predicate reads
// as a reviewed decision, not an oversight.
export const EXPLICITLY_UNTYPED_GEOGRAPHY = Object.freeze({
  community_district: "A community district's institutional relationship runs through an appointed advisory community board -- neither ordinary electoral representation nor ordinary service delivery -- so no represented_by, served_by, or statistically_classified_as edge is published for this class until that relationship is named deliberately.",
  business_improvement_district: "A business improvement district's exact institutional service to any given contained point has not been established, and different BIDs provide non-uniform services, so no typed relation -- served_by included -- is published for this class.",
  borough: "A borough is an administrative partition with no single elected office or service department attached to the geography itself.",
});

for (const type of Object.keys(RELATION_MAPPINGS)) {
  // Start only from geography kinds already ingested and registered.
  if (!civicGeographyLayer(type)) {
    throw new TypeError(`geography_relations: unknown geography layer "${type}"`);
  }
}
for (const type of Object.keys(EXPLICITLY_UNTYPED_GEOGRAPHY)) {
  if (!civicGeographyLayer(type)) {
    throw new TypeError(`geography_relations: unknown geography layer "${type}"`);
  }
}
for (const [type, mapping] of Object.entries(RELATION_MAPPINGS)) {
  if (!INSTITUTIONAL_RELATION_PREDICATES.includes(mapping.predicate)) {
    throw new TypeError(`geography_relations: ${type} declares an unrecognized predicate`);
  }
  if (!mapping.institutional_basis || !mapping.validity_assumptions?.length || !mapping.temporal_limitations) {
    throw new TypeError(`geography_relations: ${type} is missing required documentation`);
  }
}

/** Registry lookup: the typed-relation mapping for one geography type, or null. */
export function geographyRelationMapping(type) {
  return RELATION_MAPPINGS[String(type || "")] || null;
}

/**
 * Project typed institutional relations from already-resolved geometric
 * containment matches (see resolveCivicGeographies in civic_geography.mjs).
 * The input matches are read only, never mutated or filtered in place --
 * existing `located_in`/`contains_point` evidence survives untouched. The
 * result is a separate, parallel array of typed relations.
 */
export function projectInstitutionalRelations(containmentMatches = []) {
  const matches = Array.isArray(containmentMatches) ? containmentMatches : [];
  const institutional = [];
  for (const match of matches) {
    if (!match || match.relation !== "contains_point") continue;
    const mapping = RELATION_MAPPINGS[match.type];
    if (!mapping) continue;
    institutional.push(Object.freeze({
      schema: GEOGRAPHY_RELATION_SCHEMA,
      predicate: mapping.predicate,
      source_geography_type: match.type,
      source_geography_id: match.id,
      source_geography_key: match.key,
      label: match.label ?? null,
      institutional_basis: mapping.institutional_basis,
      validity_assumptions: mapping.validity_assumptions,
      provenance: Object.freeze({
        derived_from: "located_in",
        source_id: match.source_id ?? null,
        boundary_vintage: match.boundary_vintage ?? null,
      }),
      temporal_limitations: mapping.temporal_limitations,
    }));
  }
  return Object.freeze(institutional);
}
