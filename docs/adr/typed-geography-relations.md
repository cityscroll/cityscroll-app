# ADR: Typed institutional relations projected from geometric containment

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-04 |
| Scope | `site/geography_relations.mjs`, `ontology/registry.v0.json` link types |
| Supersedes | — |
| Related | `docs/adr/ontology-registry-v0.md`, `site/civic_geography.mjs`, `site/civic_geography_registry.mjs` |

## Context

`resolveCivicGeographies` answers geometric containment only: which
published polygons a point falls inside, all reported through the same
generic `contains_point`/`located_in` relation. A point can be contained by a
council district, a community district, a police precinct, a sanitation
district, a neighbourhood tabulation area (NTA), and a business improvement
district (BID) at once, but those six classes reach a resident through
government in different ways -- one seats an elected office, two deliver a
department's own service, one is a statistical label, and two have no single
established institutional meaning. Presenting all six the same way overstates
what CityScroll actually knows.

## Decision

Keep `located_in` exactly as it is (untouched, still the only containment
evidence) and add a second, additive layer: a small per-geography-type
mapping table (`site/geography_relations.mjs`) that projects one typed
institutional relation onto a subset of already-registered geography
classes, only where the institutional meaning is a defensible, structural
fact rather than a guess from a polygon's label:

* `council_district` &rarr; **`represented_by`**. The City Charter seats one
  elected Council member per numbered district; the edge names the
  district/office, never a specific officeholder or term.
* `police_precinct` &rarr; **`served_by`**. An NYPD precinct boundary is the
  department's own patrol/command jurisdiction.
* `sanitation_district` &rarr; **`served_by`**. A DSNY district boundary is
  the department's own collection-routing jurisdiction.
* `nta2020` &rarr; **`statistically_classified_as`**. NTA2020 is a DCP
  statistical tabulation geography; it classifies rather than represents or
  serves.

`community_district`, `business_improvement_district`, and `borough` are
listed explicitly as deliberately untyped (`EXPLICITLY_UNTYPED_GEOGRAPHY`),
each with its own reason, so their absence reads as a reviewed decision
rather than an oversight:

* A community district's institutional relationship runs through an
  appointed advisory community board -- neither ordinary electoral
  representation nor ordinary service delivery -- so it gets no predicate
  until that relationship is named on its own terms.
* A BID's exact institutional service to any given contained point has not
  been established, and different BIDs provide non-uniform services, so no
  `served_by` edge is published for the class.
* A borough has no single elected office or service department attached to
  the geography itself.

Every emitted relation carries its source geography type and id, the
predicate, an `institutional_basis` sentence, `validity_assumptions`,
`provenance` (pointing back to the `located_in` evidence and boundary
vintage it was derived from), and `temporal_limitations`. The predicate is
derived only from the geography's validated canonical type/id -- never from
a free-text label -- and the mapping table is checked at module load against
the closed `CIVIC_GEOGRAPHY_LAYERS` registry, so it can only ever name a
geography kind that is already ingested.

Three link types are registered in `ontology/registry.v0.json`
(`represented_by`, `served_by`, `statistically_classified_as`) so the
predicates are catalogued the same way `located_in` already is, and are
importable by any future consumer (a place page, a Near You explanation, a
scope-evaluation path) without redefining the vocabulary.

## Consequences

* No new dataset, ingestion, or geometry work; this is a pure projection
  over containment matches that already exist.
* No representation edge ever names an officeholder, and no service edge is
  published for a class whose service meaning is unverified (BID).
* Ontology registry counts moved (`link_types` 66 &rarr; 71 for LDP-23, then
  71 &rarr; 74 here); the reviewed watermark shards
  (`architecture/watermark.d/ontology.json`,
  `architecture/watermark.d/canary--ontology-registry.json`) and the pinned
  hash in `test/architecture_watermark.test.mjs` were advanced to match.
