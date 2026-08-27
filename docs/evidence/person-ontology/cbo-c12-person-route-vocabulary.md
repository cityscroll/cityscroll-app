---
card_standard: kraken-v1
richness_profile: standard
id: cityscroll-community-board-ontology/cbo-c12-person-route-vocabulary
title: "CBO-12 · Resolve the public noun and route for generic Person"
status: proposed
wave: community-board-ontology-person
spec: "spec.md#cards"
builds_on:
  - cityscroll-community-board-ontology/person-root-slice
related:
  - cityscroll-community-board-ontology/cbo-c9-search-navigation
context:
  - ontology/person.mjs
  - site/person_constellation.mjs
  - site/browse_surface_contracts.mjs
  - site/route_migration.mjs
verify: "node --test test/person_ontology.test.mjs test/primary_document_routes.test.mjs test/route_migration.test.mjs"
needs_james: generic-person-public-route
---
## Story

Residents need a stable reader noun and URL before a generic Person can become a public detail document.

## Change

Choose the public noun and route for source-qualified generic Person objects, taking the existing
`/browse/people/` list surface into account. If a detail route is approved, add its Pages-edge,
asset, SPA, and route-migration contracts while retaining `/officials/{id}/` for Council officials.
The route must resolve only exact `person_ref` values and must not turn a display name into an ID.

## Acceptance

- [ ] A1 [decision] The public noun and route are recorded in the surface registry.
- [ ] A2 [boundary] Generic Person documents cannot load Council-only capabilities unless an exact
  Council compatibility identity selects the existing official route.
- [ ] A3 [verification] Route, deep-link, and unknown-ID tests prove every offered link resolves.

## Non-goals

Do not replace `/officials/{id}/`, broaden `official`, or create a universal `/records/` route.
