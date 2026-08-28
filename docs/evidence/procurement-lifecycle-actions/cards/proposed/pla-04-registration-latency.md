---
card_standard: kraken-v1
richness_profile: standard
group: must-have
id: procurement-lifecycle-actions/pla-04
title: "PLA-04 · Registration latency"
status: proposed
wave: procurement-lifecycle-actions-existing-data
spec: "../../README.md#card-map"
builds_on:
  - procurement-lifecycle-actions/pla-03
blocked_by:
  - procurement-lifecycle-actions/pla-03
predecessors:
  - procurement-lifecycle-actions/pla-01
  - procurement-lifecycle-actions/pla-02
  - procurement-lifecycle-actions/pla-03
related: []
context:
  - ../../README.md#shared-data-contract
  - docs/formulas/award-registration-dwell.md
  - worker/src/lib/award_registration_dwell.mjs
  - tools/build_award_registration_dwell.mjs
  - site/data/award_registration_dwell_observations.json
verify: "test -s docs/evidence/procurement-lifecycle-actions/README.md && test -s docs/evidence/procurement-lifecycle-actions/cards/proposed/pla-04-registration-latency.md"
needs_james: false
effort: M
risk: medium
target: crol-list
autodispatch: false
goal: "Provide a useful comparative registration duration without turning peer duration into a normative delay verdict."
---
## Story

The existing lifecycle observations can establish some boundaries, but a duration is useful only
when both endpoints are explicit and the cohort is inspectable. The product should describe
observed time, not pronounce an agency late.

### Goal

Provide a useful comparative metric for procurement timing without turning peer duration into a
normative delay or compliance verdict.

### Data sources

Existing lifecycle observations and receipts, including:

* City Record release/award publication dates.
* PASSPort or Checkbook selection, award, and registration observations.
* The versioned `award_registration_dwell` model and its existing materialization/receipt path.
* Cohort dimensions: agency, method, and time period.

No new ingestion required.

### Initial measures

* `selection_made → registered`.
* `award → registered`.
* `released → responses_closed`.

### Implementation sketch

1. Reuse the existing versioned dwell observation/receipt discipline.
2. Include a row only when both boundary events are explicit or deterministic projections with
   retained receipts; exclude missing boundaries rather than imputing them.
3. Publish cohort definition, sample count, source coverage, and each boundary reference.
4. Require a minimum cohort size of 20 for comparative statistics.
5. Render durations and percentiles as descriptive facts. Do not use `late`, `slow`, `overdue`, or
   `compliance` based only on a comparison.

### User-visible result

For an eligible procurement: `Award → registration: 87 days`. For a comparable DOT CSP cohort:
`61-day median; 84 days is the 79th percentile`, with the cohort and boundary evidence available
for inspection.

### Actions unlocked

* Compare an observed procurement duration with a named, sufficiently sized cohort.
* Open the boundary source receipts.
* Keep timing evidence available to the procurement state watch without scheduling a verdict.

## Change

**Before:** A narrow award-registration dwell model exists, but there is no unified, inspectable
comparison across process boundaries.

**After (intended):** Eligible observed boundaries produce reproducible duration measures and
cohort comparisons, with no normative label based only on percentile.

**Theory / mechanism:** Explicit boundary evidence plus an inspectable cohort turns elapsed time
into a reproducible measurement rather than a judgment.

### Gap -> fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | Missing endpoints can be mistaken for zero or estimated time. | Exclude rows without both source-backed boundaries. | A2 |
| G2 | Peer comparison can become a delay verdict. | Use descriptive language and retain cohort evidence. | A3 |
| G3 | Small cohorts produce unstable comparisons. | Require n ≥ 20 and expose the denominator. | A1, A4 |
| G4 | Multiple timing formulas can diverge. | Reuse and version the existing receipt path. | A5 |

## Acceptance

- **Before:** Dates are individually available but a user has to calculate and contextualize the interval manually.

- **After:**

- [ ] A1 [outcome] A duration is published only for a cohort with at least 20 eligible observations and an inspectable agency/method/time definition.
- [ ] A2 [provenance] Both duration boundaries are explicit source observations or deterministic projections with receipts; missing boundaries are excluded and never imputed.
- [ ] A3 [language] The UI may show `Award → registration, 87 days` and a descriptive percentile/median comparison, but may not say `late`, `slow`, `overdue`, `compliance`, or `delayed by 26` solely from the comparison.
- [ ] A4 [transparency] The cohort denominator, included rows, boundary source references, and formula/model version are inspectable.
- [ ] A5 [reproducibility] Re-running the builder against the same retained observations produces the same duration and cohort result without wall-clock dependence.
- [ ] A6 [negative] Contract end date, term length, deadline expiry, or missing publication cannot be used as an inferred selection, award, registration, or closeout boundary.
- [ ] A7 [verification] Fixture D passes with 87 days and the stated 79th-percentile comparison while preserving the non-normative language gate.

## Non-goals

Do not infer compliance violations, label a procurement late based only on peer duration, or infer
closeout from a contract end date.
