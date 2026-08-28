---
card_standard: kraken-v1
richness_profile: standard
group: research
id: procurement-lifecycle-actions/research-contract-actions-award-milestones
title: "Research · Contract actions and Award-Milestones source audit"
status: proposed
wave: procurement-lifecycle-actions-research
spec: "../../README.md#dispatch-order-and-dependencies"
builds_on:
  - procurement-lifecycle-actions/pla-02
blocked_by: []
predecessors: []
related:
  - procurement-lifecycle-actions/pla-03
context:
  - ../../README.md#dispatch-order-and-dependencies
  - ../../README.md#design-validation
  - site/procurement_object_contract.mjs
  - worker/src/lib/checkbook_lifecycle.mjs
  - worker/src/lib/passport_join.mjs
verify: "test -s docs/evidence/procurement-lifecycle-actions/README.md && test -s docs/evidence/procurement-lifecycle-actions/cards/proposed/research-contract-actions-award-milestones.md"
needs_james: false
effort: S
risk: medium
target: crol-list
autodispatch: false
goal: "Audit whether lawful reproducible public sources can add contract actions and award milestones without making authenticated scraping a timeline dependency."
---
## Story

The existing journey can show selected public stages, award, registration, and payment. A separate
research spike should test whether additional public milestones are lawful, reproducible, and
historically usable before any product commitment.

### Goal

Research two possible source families:

* **Contract actions:** amendment, renewal, extension, value modification, and parent/child
  relationships.
* **Award-Milestones:** award creation, responsibility determination, law review, vendor signature,
  hearing, MOCS approval, OMB approval, registration-package compilation, and Comptroller registration.

This research spike may run in parallel after PLA-02 and is explicitly **not a delivery dependency
of PLA-01, PLA-02, PLA-03, PLA-04, PLA-05, or PLA-06**.

### Data sources

Public procurement pages, downloadable public records, public APIs, and existing retained source
receipts. Authenticated or vendor-private PASSPort views are out of scope.

### Implementation sketch

For each candidate source, record:

* public source and access method;
* publisher identifier;
* fields and literal publisher labels;
* refresh behavior;
* historical coverage;
* identity key and join precision;
* representative sample;
* status: `accept`, `defer`, or `reject`;
* lawful reproducibility and receipt requirements.

Accept a source only when a reviewer can reproduce the observation from a public source and the
identity/event clock can be retained. Defer or reject sources that require authenticated scraping,
cannot retain a stable receipt, or expose only a non-reproducible visual state.

### User-visible result

This card produces an audit decision and source receipts, not a new timeline. Any accepted source
can be proposed as a later card; no product surface depends on this spike to ship PLA-01 through
PLA-06.

### Actions unlocked

No resident action is unlocked by the research result alone. An accepted source may inform a later
separately reviewed work item.

## Change

**Before:** The unified journey ends at the currently retained public observations and does not
claim additional internal milestones.

**After (intended):** Each candidate contract action and Award-Milestone source has a reproducible
accept/defer/reject record with identity, freshness, and historical-coverage evidence.

**Theory / mechanism:** Source admissibility is a prerequisite for a public fact; a visually rich
timeline is not evidence when its underlying source cannot be reproduced or retained.

### Gap -> fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | Contract amendments and milestones may exist outside current read models. | Inventory public sources and field semantics. | A1 |
| G2 | A visual milestone can invite unsupported scraping. | Require lawful public reproducibility and retained receipts. | A2 |
| G3 | New stages can silently become delivery dependencies. | Mark this spike parallel and non-blocking for PLA-01..06. | A3 |
| G4 | Accepted sources can lack durable identity/history. | Record identity key, refresh, coverage, sample, and decision. | A4 |

## Acceptance

- [ ] A1 [research] The audit covers amendment, renewal, extension, value modification, parent/child actions, and each listed Award-Milestone candidate.
- [ ] A2 [boundary] A candidate is accepted only when its public source, publisher identifier, fields, event clock, identity key, receipt, and reproducibility are documented; authenticated/vendor-private views are deferred or rejected.
- [ ] A3 [dependency] The research card is explicitly parallel after PLA-02 and not a delivery dependency of PLA-01 through PLA-06.
- [ ] A4 [provenance] Each candidate record includes public source, publisher id, fields, refresh behavior, historical coverage, identity key, representative sample, and `accept`/`defer`/`reject` status.
- [ ] A5 [negative] No authenticated scraping is introduced merely to create a visually complete timeline, and no unaccepted candidate becomes a public lifecycle event.

## Non-goals

Do not implement contract-action or Award-Milestone ingestion in this spike, add resident-facing
timeline states without accepted public evidence, or block the existing-data tranche on the result.
