---
card_standard: kraken-v1
richness_profile: standard
id: cityscroll-community-board-ontology/cbo-c14-keyed-person-source-adapters
title: "CBO-14 · Add keyed agency-staff and vendor-contact person adapters"
status: proposed
wave: community-board-ontology-person
spec: "spec.md#cards"
builds_on:
  - cityscroll-community-board-ontology/person-root-slice
related:
  - cityscroll-community-board-ontology/cbo-c13-person-identity-review
context:
  - site/people_organizations_read_model.mjs
  - entity_resolution/leaders/index.mjs
  - ontology/person.mjs
  - test/people_organizations_community_boards.test.mjs
verify: "node --test test/people_organizations_community_boards.test.mjs test/person_source_adapters.test.mjs"
needs_james: staff-and-vendor-contact-publicness
---
## Story

Agency staff and vendor contacts should enter the generic Person projection only when their source
publishes a stable native key and the public-field policy permits the role to be shown.

## Change

Onboard one source at a time with source receipts, temporal `works_for` or contact roles, and an
explicit public-field allowlist. Keep notice-only staffing names and award-derived vendor
organizations unchanged when no native person/contact key exists.

## Acceptance

- [ ] A1 [outcome] Each adapter emits a source-qualified identity and temporal role with provenance.
- [ ] A2 [boundary] Free-text names and vendor display names cannot mint Person identities.
- [ ] A3 [verification] Source-key, publicness, privacy, and no-name-match fixtures pass.

## Non-goals

Do not convert current notice-only hires or award-derived vendor organizations into people.
