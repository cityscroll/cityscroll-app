---
card_standard: kraken-v1
richness_profile: standard
group: follow-on
id: procurement-lifecycle-actions/pla-05
title: "PLA-05 · Procurement plans and future opportunities"
status: proposed
wave: procurement-lifecycle-actions-follow-on
spec: "../../README.md#card-map"
builds_on:
  - procurement-lifecycle-actions/pla-02
blocked_by: []
predecessors:
  - procurement-lifecycle-actions/pla-02
related:
  - procurement-lifecycle-actions/pla-03
context:
  - ../../README.md#shared-data-contract
  - site/data/procurement_plan_sources/README.md
  - site/data/procurement_planning_manifest.schema.json
  - site/procurement_planning_surface.mjs
  - site/procurement_planning_gate.mjs
  - warehouse/scripts/procurement_plans_run.py
verify: "test -s docs/evidence/procurement-lifecycle-actions/README.md && test -s docs/evidence/procurement-lifecycle-actions/cards/proposed/pla-05-procurement-plans-future-opportunities.md"
needs_james: false
effort: L
risk: high
target: crol-list
autodispatch: false
goal: "Expose future procurement opportunities as source-backed planned objects without pretending a plan is an open RFx."
---
## Story

Official plans and forecasts can help residents discover future opportunities before a solicitation
exists. They are not solicitations, and they must remain separate until an explicit identity gate
proves a later link.

### Goal

Expose procurement plans and future opportunities as a separate `planned_procurement` object that
can later attach to an RFx through a strong, reviewed identity relation.

### Data sources

* Official procurement plans and forecasts.
* LL1/M/WBE plans.
* LL63 renewal/amendment plans.
* Human Services plans.
* Existing MOCS/Capital Projects plan collectors, manifests, and receipts.

Normalize public MOCS procurement-plan/forecast sources into a new source family, beginning with
the relevant public plans and forecasts above. This is a new `planned_procurement` object, not an
RFx.

### Useful fields

```text
planned_procurement
  planned_procurement_id
  agency
  description_or_scope
  expected_fiscal_year_or_quarter
  anticipated_procurement_method
  estimated_amount_or_range
  category
  publisher_identifier
  intended_renewal_or_amendment_relationship?
  source_observation_ref
```

### Implementation sketch

1. Extend the existing bounded planning collector/read-model boundary; do not duplicate ingestion.
2. Preserve source fields, publisher identifiers, fiscal year/quarter, and unmatched rows.
3. Show `Planned` as a planned object, never as `Open` or an RFx.
4. Offer Follow for a future solicitation.
5. Link a later RFx only on an explicit publisher identifier or reviewed high-confidence identity
   gate. Text resemblance alone is not a merge.
6. Keep the original plan object and observation after a later RFx link.

### User-visible result

`Planned opportunity · DOT bridge inspection · Expected FY27 Q2 · CSP` can be discovered and
followed. When a later RFx passes the identity gate, the page shows a related link while retaining
the original plan evidence.

### Actions unlocked

* Follow a planned opportunity for a future solicitation.
* Remind or notify when the later source-backed RFx is observed.
* Inspect the plan and later RFx as separate source records.

## Change

**Before:** Planning artifacts are retained through a bounded bridge, but the resident planning
surface is inert where no reviewed link has been established.

**After (intended):** A standalone planned opportunity is queryable and followable, retains its
source row, and may later link to an RFx only through an exact or reviewed high-confidence gate.

**Theory / mechanism:** Treating plans as their own typed object preserves the semantic boundary
between intention and solicitation while still enabling discovery.

### Gap -> fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | A plan can be mistaken for an open RFx. | Use a separate `planned_procurement` object and state. | A1 |
| G2 | Fiscal quarter can disappear in normalization. | Preserve publisher fiscal year/quarter fields. | A2 |
| G3 | Text similarity can silently merge records. | Require explicit identifier or reviewed high-confidence identity. | A4 |
| G4 | Linking can erase the plan's original evidence. | Retain both objects and their receipts. | A5 |

## Acceptance

- **Before:** An agency procurement plan published six months before its RFx cannot be discovered as an upcoming CityScroll procurement.

- **After:**

- [ ] A1 [boundary] A plan with publisher state `Planned` remains `planned`; it is never rendered or queried as `open` merely because a future quarter is present.
- [ ] A2 [outcome] The DOT bridge-inspection fixture preserves `Expected FY27 Q2` and `CSP` as publisher-backed fields.
- [ ] A3 [action] A resident can Follow a planned opportunity for a later solicitation.
- [ ] A4 [identity] A later RFx attaches only after an explicit publisher identifier or reviewed high-confidence identity gate passes; title/agency/method resemblance alone cannot merge it.
- [ ] A5 [provenance] Unmatched plan rows remain separately retained and visible as unmatched; after a valid link, the original plan observation and receipt remain inspectable.
- [ ] A6 [negative] No agency-total budget or inferred opportunity count is presented as a plan row.
- [ ] A7 [verification] Fixture E shows a planned DOT bridge opportunity, a Follow action, and a later strong-identifier RFx link without changing the original planned state.

## Non-goals

Do not fuzzy-merge plans, RFx, awards, and contracts, and do not turn a plan into a solicitation
before a source observation establishes one.
