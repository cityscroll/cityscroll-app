# Spatial and implementation joins (SEQRA-06)

This is the sixth card of the New York SEQRA/CEQR predictive-foundation
workstream. It builds on SEQRA-03's structured-source adapters and SEQRA-04's
document pipeline, and on SEQRA-02's `project` and `land_use_determination`
ontology entities (`warehouse/lib/seqra_ontology_spec.mjs`). It gives the
workstream historical spatial and implementation context: project geometry
and BBL reconciliation that survives lot merges and subdivisions, per-layer
vintage-versioned PLUTO/zoning/receptor/environmental-site/disadvantaged-
community/flood joins, and a DOB/ACRIS implementation-event join to the
authorizing determination that feeds a remedy-exposure projection. It does
not add new core ontology entities, extract technical-topic facts (SEQRA-05),
or enable resident ingestion.

## Why a layer vintage is a window, not a label

A spatial layer publisher (PLUTO, the zoning map, a state remediation-site
registry, a flood-risk layer) releases updated data on its own cadence. A
naive join against "the current layer" describes conditions the reviewers
deciding a historical action never saw. `warehouse/lib/seqra_layer_vintage.mjs`
models each layer as a series of releases, each carrying a half-open window
`[effective_start, effective_end)` of wall-clock time during which it was the
release in force. Resolving a cutoff means finding the window that contains
it -- never "the newest release available when the join happened to run."

That framing is what makes card acceptance A2 ("current conditions cannot
leak backward: a feature computed for a historical cutoff is identical
whether it is computed today or at that cutoff") a property of the function,
not a promise about caller discipline: which window contains a fixed cutoff
cannot change when a later release is appended to the series, because that
release's window starts after the cutoff. `resolveLayerVintage` never falls
back to the nearest or current release when no window covers the cutoff --
it throws `SeqraLayerVintageError`, and every catcher converts that into an
explicit coverage-gap record (`cityscroll.seqra_spatial_coverage_gap.v1`,
mirroring `warehouse/lib/seqra_document_coverage_gaps.mjs`'s convention)
instead of completing the join (A5). The negative rule -- "do not replace
historical data with current project or spatial conditions to make a join
succeed" -- is enforced structurally: there is no code path in this module
that can return a vintage whose window does not contain the cutoff.

`warehouse/lib/seqra_spatial_layer_joins.mjs` applies that primitive across
the six layer families the card names -- PLUTO, zoning, and receptor share no
special casing with environmental-site, disadvantaged-community, and flood;
each keeps its own independent vintage series. `joinProjectLayersAtCutoff`
never throws for a missing vintage: a refused join lands in `gaps`, not
`features`, so one layer's coverage gap never aborts the whole join.

## BBL reconciliation across lot changes

`warehouse/lib/seqra_bbl_lot_history.mjs` turns a project's initial footprint
plus a dated sequence of `merge`/`subdivision` events into an ordered,
non-overlapping timeline of BBL-set snapshots. `bblFootprintAsOf` answers
"what BBLs constituted this project on date X" by walking that timeline, not
by resolving to the project's present-day `bbl_list` -- a BBL retired by a
later merge or subdivision stays in the project's history (`every_bbl_ever_
held`) and is still returned for any cutoff before its retirement (A3). A
cutoff before the project's earliest known snapshot is refused rather than
silently answered with the earliest-known footprint.

## Implementation events and remedy exposure

`warehouse/lib/seqra_implementation_remedy_projection.mjs` attributes DOB and
ACRIS events to the `land_use_determination` that authorized the action they
implement: an event is attributed only when its BBL is in the determination's
footprint and its date is on or after the determination's date; an earlier
event is reported separately as `unattributed`, never silently joined or
dropped. `projectRemedyExposureAsOf` then reduces attributed events dated on
or before a cutoff to a monotonic construction/conveyance stage (`not_started`
through `complete`) -- a future event can never raise the projected stage for
an earlier cutoff, the same no-backward-leakage property as the layer joins
(A4, A2). This module states progress, never a legal outcome: it exists
because how far a project has physically progressed affects the remedy a
court would weigh, not because this workstream predicts that remedy here.

## Command surface

`node tools/build_seqra_spatial_implementation_joins.mjs [--check]` runs this
card's own A1-A5 acceptance checks and negative-rule check against the
committed synthetic fixture (`warehouse/fixtures/seqra-spatial/
sample_multi_lot_project.mjs`) and writes/verifies
`warehouse/receipts/proof/seqra_spatial_implementation_joins_latest.json`.
The card's `verify` field, `npm run warehouse:seqra:ingest`, is shared with
SEQRA-03 and (per the commission) SEQRA-07; `tools/build_seqra_structured_
adapters.mjs` execs this tool's `--check` mode and this card's test suites
as one of its own checks, the same way it already delegates SEQRA-03's own
regression check to `tools/build_ceqr_project_milestone_reconciliation.mjs`.
