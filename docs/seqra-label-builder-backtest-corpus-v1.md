# Label builder and backtest corpus (SEQRA-08)

This is the eighth card of the New York SEQRA/CEQR predictive-foundation
workstream. It builds on SEQRA-05's technical-topic extraction, SEQRA-06's
spatial and implementation joins, and SEQRA-07's public-position and
institutional-signal adapters, and on SEQRA-02's as-of review-state
projector (`warehouse/lib/seqra_review_event_log.mjs`). It turns those
upstream outputs into a labelled corpus: as-of feature snapshots, process-
path and supplemental-review labels with right-censoring, project-family-
grouped rolling-origin folds, and the leakage and denominator receipts a
reported backtest metric depends on. It does not train a model, add new
core ontology entities, or extend `SEQRA_REVIEW_EVENT_TYPES` -- target E is
built from the two supplemental-review event types SEQRA-02's ontology
already defines.

## A backtest is only as honest as its denominator

A predictive claim about review path or supplemental-review likelihood is
unfalsifiable unless three things are true about how it was measured: every
feature that fed the prediction was actually public before the prediction
was made, the reviews used to measure the metric are not near-duplicates of
each other split across train and test, and a review that has not yet
resolved is never scored as if it resolved negatively. `warehouse/lib/
seqra_label_builder.mjs` makes each of these a property of the corpus
construction, not a convention a caller has to remember.

## As-of features and an independent leakage audit

`buildAsOfFeatureSnapshot` does not re-derive the review/spatial/
institutional joins earlier cards already own: it calls SEQRA-02's
`projectReviewStateAsOf` (which itself filters every event by
`available_to_public_at`) and SEQRA-06's `joinProjectLayersAtCutoff` (cutoff-
safe by construction via layer-vintage resolution), then filters SEQRA-07
public positions by their own `available_to_public_at`. A snapshot for a
review whose event log is contradictory as of the cutoff is refused
(`{ ok: false, reason: "contradiction_at_cutoff" }`), never guessed.

Trusting those upstream builders' own cutoff discipline is not the same as
proving it: `auditFeatureLeakage` independently re-walks every record a
snapshot actually included and re-checks its public-availability timestamp
against the cutoff, reporting a `checked_count` and `violation_count`. This
is deliberately redundant -- a receipt that only asserts "the builder we
trust says so" is not a receipt (A1).

## Two labels, and where censoring actually applies

Target A (review path) is a five-category label --
`type_ii`/`negative_declaration`/`conditioned_negative_declaration`/
`positive_declaration_eis`/`unknown_or_incomplete` -- and needs no separate
censoring mechanism: spec.md defines the fifth category precisely so a
review that has not yet reached a classifying milestone has an honest label
of its own, never a guess at which of the other four it will become.

Target E (supplemental review) is framed as "did a technical memorandum or
supplemental EIS land within this horizon," which is where an open review
actually would read as a false negative if left unhandled: `classify
SupplementalReviewLabel` compares each horizon's window end (cutoff+90/180
days, the review's final-determination date, or its implementation-
completion date) against the corpus's own `observationHorizon`. A window
that closes after the horizon returns `{ label: null, censored: true }`
instead of `0` -- the same review can be a fully observed negative at one
horizon and censored at another, since each horizon's window closes at a
different time (A2, negative rule).

## Project families and rolling-origin folds

`buildProjectFamilies` groups projects that share at least one BBL into one
family via deterministic union-find -- a resubmission, phasing, or amendment
of the same site is the near-duplicate this exists to catch, reusing the
`project` entity's own `bbl_list` rather than inventing a new join.
`buildRollingOriginFolds` then assigns each (review, cutoff) row to a fold's
train or test side by cutoff alone, strictly time-ordered, never a random
row split. When a family's members would land on both sides of one fold's
boundary, that family is excluded from **both** sides of that fold, with an
audited `family_train_test_conflict` reason -- never resolved by silently
keeping one side, which would hide which rows moved (A3).

## Denominator receipts and reproducibility

`summarizeTargetFoldPopulation` reports, per target/fold/split: the raw
population before any exclusion, counts broken down by exclusion reason, the
eligible population, how many of those are censored, and prevalence per
label -- so `population === eligible_population + sum(excluded_by_reason)`
and `eligible_population === censored_count + labeled_population` always
hold (A4). Fold construction takes no randomness and no wall-clock input:
re-deriving folds from the exact rows/folds recipe a receipt recorded
reproduces byte-identical membership regardless of input array order (A5).

## Command surface

`node tools/build_seqra_label_backtest_corpus.mjs [--check]` runs this
card's own A1-A5 and negative-rule checks against the committed synthetic
fixture (`warehouse/fixtures/seqra-labels/label_builder_fixtures.mjs`, which
itself reuses SEQRA-02's contradiction fixture, SEQRA-06's multi-lot spatial/
implementation fixture, and SEQRA-07's actor-resolution/public-position
builder rather than re-authoring parallel data) and writes/verifies
`warehouse/receipts/proof/seqra_label_backtest_corpus_latest.json`. The
card's `verify` field, `npm run warehouse:seqra:labels`, is shared with
SEQRA-02; `tools/check_seqra_ontology.mjs` execs this tool's `--check` mode
as one of its own checks, the same delegation pattern it already uses for
its own ontology-schema sub-check.
