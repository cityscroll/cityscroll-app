# SEQRA/CEQR source inventory and population profiler (SEQRA-01)

This is the first card of the New York SEQRA/CEQR predictive-foundation
workstream. It measures source feasibility and denominators only. It does
not build the process ontology, extract documents, create labels, train a
model, or enable resident ingestion -- that is SEQRA-02 onward.

## Jurisdiction scope (hard boundary)

This workstream covers only New York State SEQRA, records labeled SEQR/SEQRA
by New York State agencies, New York City CEQR, and New York Article 78 /
related judicial review. California CEQA is completely out of scope.

`warehouse/lib/seqra_scope_classifier.mjs` implements the required rejection
test and the required scope envelope
(`jurisdiction_level`, `environmental_regime`, `review_label_as_published`,
`judicial_review_regime`). NYS `SEQR`/`SEQRA` labels normalize to `SEQRA`
while the original published terminology is preserved verbatim; NYC `CEQR`
stays separately identifiable; any California/CEQA record, or a record whose
jurisdiction cannot be resolved to NYS/NYC, is rejected -- never coerced into
an admitted population. No live source in this inventory ever returns a
California/CEQA record; the classifier's rejection path is exercised end to
end against the bounded fixture batch in
`warehouse/fixtures/seqra-inventory/jurisdiction_fixture_batch.mjs`, which is
what produces the `out_of_scope_record_count` and
`scope_classification.california_or_ceqa_admitted_count` fields in the
receipt (always `0` admitted).

## Source registry

`warehouse/lib/seqra_source_registry.mjs` registers every source named in the
commission's Tier 1-4 priority list, with the required SOURCE RECEIPTS fields
(`source_id`, `publisher`, `jurisdiction_level`, `environmental_regime`,
`access_type`, `base_url`, `dataset_identifier`, `coverage_start/end`,
`update_frequency`, `known_gaps`, plus the runtime fields
`observed_latency`/`last_success_at`/`last_row_count`/`last_content_hash`,
which the static module leaves `null` and a `--refresh` run overlays into the
receipt's `source_registry` -- see `buildRuntimeSourceRegistrySnapshot` in
`warehouse/lib/seqra_source_inventory.mjs`).

Three `access_type`s:

- `soda_api` -- Tier 1 structured source, profiled live over Socrata SODA
  with bounded aggregate queries (never a full-table download): exact
  `count(*)`, grouped breakdowns, `min`/`max` date range, missingness via
  `WHERE field IS NULL`, and duplicate measurement via
  `count(distinct key)` (exact, no pagination cap) plus a bounded
  `$group ... $having count(*) > 1` sample of the largest offending groups.
- `discovery_probe` -- one bounded, polite HTTP GET records reachability
  (HTTP status, content type, byte count, content hash) only; it is never
  parsed into a population count.
- `discovery_only` -- registered from the commission text; not probed in
  this card. A later card (named in `known_gaps`) owns the adapter.

Seven sources are measured live: CEQR Projects, CEQR Project Milestones, ZAP
Projects, ZAP BBL, NYS DEC DART, NYC eLobbyist, and NYC City Record Online
(the publisher dataset behind the existing City Record corpus/search; the
SEQRA/CEQR-scoped subset of it is not yet query-defined, so this inventory
reports the whole-corpus count as a feasibility measurement, not an
environmental-review population).

## Command

```sh
npm run warehouse:seqra:inventory              # deterministic build from the retained observation
npm run warehouse:seqra:inventory -- --check    # rebuild and diff against the committed receipt
node tools/build_seqra_source_inventory.mjs --refresh  # live measurement pass (network required)
```

`--refresh` performs the actual bounded live fetches and writes a retained
observation fixture (`warehouse/fixtures/seqra-inventory/observation.v1.json`)
plus per-query raw artifacts under the gitignored `warehouse/raw/seqra-inventory/`
(same convention as every other warehouse collector: raw stays out of git,
code/fixtures/receipts stay in). The no-flag default rebuilds the receipt
deterministically from that retained observation -- run twice from the same
committed inputs, the receipt is byte-identical apart from nothing at all
(`generated_at` is itself sourced from the retained observation's
`materialized_at`, so it does not change either). This is what makes
`npm run warehouse:seqra:inventory` reproducible in CI without live network
access, while a fresh `--refresh` is how the retained baseline gets updated
with newly measured counts.

## What this card found

As of the last `--refresh` (see the committed receipt for the exact
`generated_at` and per-source counts):

- CEQR Projects: 15,383 rows. CEQR Project Milestones: 34,811 rows. ZAP
  Projects: 32,964 rows. ZAP BBL: 132,090 rows. NYS DEC DART: 495,140 rows.
  NYC eLobbyist: 79,726 rows. NYC City Record Online (whole corpus):
  1,104,171 rows.
- NYS DEC DART has a large measured exact-duplicate rate on `application_id`
  (roughly 29% of rows share an `application_id` with byte-identical row
  content) -- a publisher data-quality characteristic, not a CityScroll
  dedupe defect. The exact count comes from `count(distinct application_id)`,
  which is immune to the bounded `$having` group-listing's pagination cap.
- Several Tier 2 discovery probes returned HTTP 404 against the URLs named in
  the commission text (the NYC Council Legistar API root, the DEC ENB page,
  and the OEC CEQR resources page have moved or require a more specific
  path). These are recorded honestly as unresolved reachability, not
  silently retried or guessed into a different URL; resolving the correct
  current URLs is discovery work for whichever later card needs that source.

## Target-specific usable-population estimates

`buildTargetPopulationEstimates` in `warehouse/lib/seqra_source_inventory.mjs`
reports, for each of the commission's nine prediction targets, whether the
population is `measured`, `derived_from_measured_fields`, or `unknown` with a
reason naming the later card that would make it label-ready. Only Target A
(review path) and Target E (supplemental review) have any measured-field
denominator today; both are explicit that this is a raw denominator, not a
validated label, and both keep the CEQR (NYC) and statewide SEQRA (NYS)
denominators separate rather than summed. Targets B through D and F through I
are `unknown`, correctly, because they require the process ontology
(SEQRA-02), the document pipeline (SEQRA-04/05), the label builder
(SEQRA-08), or the litigation ontology and court-coverage grading (A78-01,
A78-03) -- none of which exist yet.

## Existing reconciliation baseline

The receipt cites `warehouse/receipts/proof/ceqr_project_milestone_reconciliation_latest.json`
under `existing_reconciliation_baseline` for context only. It is explicitly
labeled as not a current source count produced by this inventory; verifying
it against the named receipt is how a reviewer confirms it was not silently
promoted into a fresh measurement.

## Command-surface note

The commission's required command is `npm run warehouse:seqra:inventory`.
This repository has never had a root `package.json` before this card --
every existing warehouse tool is invoked as `node warehouse/scripts/*.mjs`
or `node tools/*.mjs` directly, including in CI
(`.github/workflows/*.yml`) and `make prepush`. The root `package.json`
added by this card is a minimal, dependency-free `scripts` wrapper solely
for the one command this card's acceptance criteria require; it does not
change how CI or any existing tool runs. Later SEQRA-0x/A78-0x cards should
decide deliberately whether to keep extending this wrapper for their own
required commands or standardize on direct `node` invocation.
