---
card_standard: kraken-v1
richness_profile: standard
id: cityscroll-community-board-ontology/cbo-c13-person-identity-review
title: "CBO-13 · Materialize reviewed same-person assertions"
status: proposed
wave: community-board-ontology-person
spec: "spec.md#cards"
builds_on:
  - cityscroll-community-board-ontology/person-root-slice
related:
  - cityscroll-community-board-ontology/cbo-c12-person-route-vocabulary
context:
  - ontology/person.mjs
  - ontology/registry.v0.json
  - entity_resolution/review/assertion_evidence.mjs
  - test/person_ontology.test.mjs
verify: "node --test test/person_ontology.test.mjs test/evidence_bearing_provenance_graph.test.mjs"
needs_james: generic-person-unification-policy
---
## Story

Identity links should be reviewable evidence rather than an implicit merge of source records.

## Change

Add a bounded review/materialization path for `person_identity_link.v1`. Preserve source-qualified
identities and their historical role edges, retain candidate and rejected assertions as non-linking
evidence, and expose `canonical_person_ref` only for accepted assertions with inspectable evidence,
review metadata, and observation clocks.

## Acceptance

- [ ] A1 [outcome] Accepted links can be replayed into a canonical reference without rewriting either source identity.
- [ ] A2 [boundary] Candidate, rejected, name-only, and incomplete-evidence links never create a public edge or route.
- [ ] A3 [verification] Replay is deterministic and preserves provenance for every accepted link.

## Non-goals

Do not auto-link by display name, title, agency, board, address, email, or shared numeric-looking keys.
