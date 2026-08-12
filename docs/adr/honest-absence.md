# ADR: Build-time uncertainty and honest absence

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-12 |
| Scope | Materialized joins, optional read models, and reader-facing missing data |
| Supersedes | — |
| Related | `worker/src/data/abo_award_residual_lookup.json`, `site/data/gap_taxonomy.json`, `test/contract/procurement_lifecycle.test.mjs` |

## Context

CityScroll builds joined views from public sources that do not share one
complete identifier. A missing row can mean that a source has not published
the relevant record, that a join did not meet its evidence bar, that the view
is unavailable, or that the record is outside the current corpus. Collapsing
those cases into a positive claim or a reassuringly blank panel would make the
reader infer more than the evidence supports.

The residual ABO award bridge is a concrete example. Its fixed sample joined
1 of 50 notices (2%) and measured fuzzy precision at 50%, below the 30%
usefulness threshold and 95% precision floor. The materialization therefore
publishes no notice-level edges and retains unresolved rows as unmatched.

## Decision

Materialize only evidence that clears the applicable usefulness and precision
gates. When a gate fails, preserve the source records and the measured result,
but do not publish the speculative relationship.

Reader surfaces must distinguish at least these states where the product
contract needs them:

- a known empty result,
- an unknown or not-yet-ingested result,
- an unavailable read model, and
- a record outside the current corpus.

Missing or uncertain evidence must not be rendered as a publisher assertion,
an inferred positive relationship, or a generic success message. Optional
sections may be omitted when their read model is unavailable, while an
explicitly measured stopped bridge remains available in its receipt or
machine-facing payload.

## Alternatives

- Publish best-effort joins below the measured gate and label them as likely.
- Treat every missing join as evidence that no relationship exists.
- Render one generic “no data” state for all empty, unknown, and unavailable
  cases.

## Rationale

The gate is evidence-based rather than stylistic: the ABO receipt records both
the 2% join rate and the 50% fuzzy precision, and the payload explicitly says
that no speculative edge is published when either gate fails. The distinction
between absence classes is also implemented in gap-taxonomy and contract tests.
This preserves the boundary between what the sources contain and what
CityScroll could not establish.

## Consequences

- False positive links are reduced at the cost of leaving some useful-looking
  candidates unresolved.
- Builders and renderers must carry status and provenance, not only arrays of
  rows.
- Tests must cover empty, unavailable, and unmatched paths separately.
- A stopped bridge can resume only after a new measurement clears its gate; a
  copy edit cannot promote it.

## Evidence

- `worker/src/data/abo_award_residual_lookup.json` — records the 30% usefulness
  threshold, 95% precision floor, 1/50 join rate, and empty published match map.
- `tools/source_contracts.mjs` — explains that the residual bridge emits no
  notice-level edge below either gate.
- `site/data/gap_taxonomy.json` — defines delivery and absence states used by
  source contracts.
- `test/contract/procurement_lifecycle.test.mjs` — verifies explicit unmatched
  stages rather than blank output.
- `test/functional/05_entity_pages_pivots.py` — verifies that an unavailable
  optional read model leaves no misleading reader-visible placeholder.
