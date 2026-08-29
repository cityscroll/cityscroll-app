---
card_standard: kraken-v1
richness_profile: standard
group: follow-on
id: procurement-lifecycle-actions/pla-06
title: "PLA-06 · Vendor performance evaluations"
status: proposed
wave: procurement-lifecycle-actions-follow-on
spec: "../../README.md#card-map"
builds_on:
  - procurement-lifecycle-actions/pla-03
blocked_by: []
predecessors:
  - procurement-lifecycle-actions/pla-03
related: []
context:
  - ../../README.md#shared-data-contract
  - site/procurement_object_contract.mjs
  - site/analytical_performance_evidence.mjs
  - site/data/source_contracts.json
  - worker/src/lib/source_records.mjs
verify: "test -s docs/evidence/procurement-lifecycle-actions/README.md && test -s docs/evidence/procurement-lifecycle-actions/cards/proposed/pla-06-vendor-performance-evaluations.md"
needs_james: false
effort: L
risk: high
target: crol-list
autodispatch: false
goal: "Add a source-qualified public performance-evaluation read model with exact contract, vendor, and agency relationships."
---
## Story

Public performance evaluations can add useful evidence after award, but payment, contract term,
and registration facts are not evaluations. The new source family must retain publisher semantics
and make both positive and absent evidence safe to interpret.

### Goal

Expose public vendor performance evaluations as source-backed objects and connect them to contracts,
vendors, and agencies through exact identities.

### Data sources

* MOCS/PASSPort public Performance Evaluation Report.
* Exact contract identifiers, vendor identifiers, and agency identifiers where published.
* Retained source observations, receipts, and source passages.
* Existing source-qualified procurement/vendor identity contracts.

### Evaluation schema

```text
performance_evaluation
  evaluation_id
  contract_id
  vendor
  agency
  evaluation_period
  finalized_at
  overall_rating
  timeliness_rating?
  fiscal_administration_rating?
  quality_rating?
  source_observation_ref
  receipt
```

### Relationships

```text
evaluation → contract
evaluation → vendor
evaluation → agency
```

Exact identifiers are preferred. Ambiguous candidates stay unattached and inspectable.

### Implementation sketch

1. Acquire and retain the public evaluation observation with publisher fields and receipt.
2. Resolve exact contract/vendor/agency references through existing source-qualified identity
   contracts; do not use payment or contract-term heuristics as evaluation evidence.
3. Preserve rating value, scale, period, evaluator, and publisher semantics exactly.
4. Make evaluation queries structured and expose the source document/passages.
5. For vendor aggregates, retain links to every constituent evaluation and support reverse
   evaluation → contract navigation.

### User-visible result

A contract page can show `Overall Satisfactory · Period FY2026` with the publisher's evaluation
evidence. A vendor page can show an aggregate such as `9 evaluations`, with each constituent
evaluation and contract link available. An absent evaluation is not rendered as a negative score.

### Actions unlocked

* Query evaluations by vendor, contract, agency, period, or publisher rating where fields exist.
* Open the source document and receipt.
* Traverse vendor → evaluation → contract and reverse contract → evaluation links.
* Follow a contract or vendor for a newly observed evaluation.

## Change

**Before:** Public performance evidence has no dedicated, exact relationship read model.

**After (intended):** Public evaluations are typed, source-qualified objects with exact joins,
publisher-preserved rating semantics, structured queries, aggregates with constituent links, and
safe unknown/absence behavior.

**Theory / mechanism:** Evaluation is a distinct evidence fact. Keeping it separate from financial
and lifecycle facts prevents a missing document or a payment pattern from becoming a performance
judgment.

### Gap -> fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | A contract fact can be mistaken for an evaluation. | Add a dedicated evaluation source/read model. | A1 |
| G2 | Ambiguous identity could misattribute a rating. | Require exact identifiers or leave the relation unattached. | A2 |
| G3 | Publisher scales can be flattened into local judgment. | Preserve rating value, scale, period, and publisher wording. | A3 |
| G4 | An aggregate can hide its evidence. | Link every aggregate count/value to constituent evaluation rows. | A4 |

## Acceptance

- **Before:** CityScroll may show who received a contract and subsequent payments but has no structured post-award performance observation.

- **After:**

- [ ] A1 [provenance] Every published evaluation carries a source observation reference, receipt, publisher identifier where available, and source passage/document link.
- [ ] A2 [identity] At least 98% of accepted contract links are exact and correct against the retained validation set; ambiguous candidates remain unattached rather than being forced.
- [ ] A3 [semantics] Rating value, rating scale, evaluation period, evaluator, and publisher state are preserved; the renderer does not substitute an ungrounded local score.
- [ ] A4 [absence] An absent evaluation is never rendered as poor performance, a failed contract, or a missing required act.
- [ ] A5 [aggregate] A vendor aggregate exposes its constituent evaluations and their contract/source links; the aggregate is not a free-floating number.
- [ ] A6 [traversal] Structured queries and reverse links support vendor → evaluation → contract and contract → evaluation navigation.
- [ ] A7 [verification] Fixture F returns the FY2026 Overall Satisfactory evaluation with source evidence and exact contract/vendor relationships.

## Non-goals

Do not infer active performance from a contract term, infer poor performance from absent
evaluations, or broaden exact identity with lifecycle heuristics.
