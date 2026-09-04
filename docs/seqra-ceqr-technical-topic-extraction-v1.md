# Technical-topic extraction (SEQRA-05)

This is the fifth card of the New York SEQRA/CEQR predictive-foundation
workstream. It builds on SEQRA-02's process ontology and SEQRA-04's document
pipeline. It gives the workstream its first typed, page-cited technical-topic
findings: a manual-vintage resolver and crosswalk, impact/mitigation/
alternative/threshold extraction, comment and agency-response extraction over
the dispute record, a topic-assessment projector, a low-confidence quarantine
gate, and a human-reviewed benchmark scorer. It does not join spatial or
implementation data (SEQRA-06), extract public-position signals (SEQRA-07),
or build a labeled backtest corpus (SEQRA-08).

## What a finding is, and what it is not

`warehouse/lib/seqra_topic_finding.mjs#buildTopicFinding` is the single choke
point every extractor in this card passes through. It requires a page number,
an evidence excerpt, and the same `fetch_id`/`content_hash`/`raw_object_path`
triple SEQRA-04's document processing record already requires per page, and
throws rather than emitting a finding missing any of them -- "a finding
without a span is an assertion; a finding with one is a citation" is
enforced structurally here, not by convention (card acceptance A1).

A finding sits alongside SEQRA-02's `technical_topic_assessment` ontology
entity rather than replacing it, the same way SEQRA-04's document processing
record sits alongside `review_document`: `technical_topic_assessment` is the
one-row-per-topic *state* a review carries; a finding is the individual typed
fact that state is projected from. No ontology registry entry was added or
changed by this card -- `technical_topic_assessment`'s shape and vocabulary
were already registered by SEQRA-02, and this card only populates it.

## Manual vintage and the crosswalk

`warehouse/lib/seqra_manual_vintage.mjs` names the two recorded CEQR
Technical Manual editions and one NYS SEQR Handbook vintage, each with an
effective date window. `resolveManualVintageForReview` picks the single
vintage whose window covers the review's own governing date and never
guesses the nearest one when no window covers it -- it returns
`status: "unknown_vintage"` instead.

`compareThresholdFact` is the structural half of the negative rule ("do not
apply current technical thresholds retrospectively without a documented
vintage crosswalk"): it requires an explicit `manualVintageId`, has no
"current" or "latest" fallback anywhere in the module, and returns
`no_threshold_definition_for_vintage` -- never another vintage's number --
when the named vintage has no definition for a topic/fact type.
`MANUAL_VINTAGE_CROSSWALK` documents every case this pipeline models where a
threshold changed between the two recorded editions (shadows,
transportation), so a reviewer can see *why* the same fact compares
differently depending on which review it came from. The threshold values
themselves are illustrative placeholders that exercise this mechanism, like
every other synthetic value in this workstream's fixtures -- not asserted,
verified regulatory figures.

## Impact, mitigation, alternative, and threshold extraction

`warehouse/lib/seqra_topic_finding_extraction.mjs` scans each already
-extracted page (SEQRA-04 owns turning bytes into page text; this module only
ever reads what that pipeline already produced) for a technical-topic keyword
co-occurring with an impact/mitigation/alternative/threshold cue phrase,
records the section heading a page's own first lines carry, and captures a
`Table N`/`Figure N` reference inline with the sentence it appears in. A
numeric threshold cue additionally tries to capture a normalized value and
compare it against the review's own resolved manual vintage
(`evaluateThresholdFinding`) -- never a different one.

A page whose own SEQRA-04 extraction-quality assessment is `low` is still
scanned (silently skipping it would make a garbled page invisible rather than
identifiable, the same principle SEQRA-04's own A3 already established), but
every finding from it has its confidence capped below the quarantine
threshold, so a garbled read is never accepted as if it were a clean one.

## The not_located / screened_out boundary

`warehouse/lib/seqra_topic_assessment_projection.mjs#projectTopicAssessments`
is where card acceptance A2 is enforced structurally. `screened_out` is
reachable *only* through an explicit `screened_out_statement` finding, which
is itself only ever built from explicit screening language ("screened out",
"no further analysis is required", "not applicable to this action") --
never inferred from a topic's absence. Every topic in the full
`SEQRA_TECHNICAL_TOPICS` vocabulary that has zero surviving findings of any
kind gets `not_located`; there is no code path from "no findings" to
`screened_out`. Every projected record is validated against SEQRA-02's own
`technical_topic_assessment` entity spec before it is returned, so a
projection bug that produced a malformed observation fails loudly here
rather than downstream.

The pipeline check tool projects assessments from *accepted* (post
-quarantine) findings only: a topic whose only signal was quarantined for low
confidence is honestly reported `not_located` rather than a falsely confident
state built on evidence this pipeline does not trust yet -- the quarantined
count is reported separately (below) so the two are never conflated with
each other.

## Comment and agency-response extraction

`warehouse/lib/seqra_comment_response_extraction.mjs` extracts the dispute
record from `comment_letter` and `agency_response` documents -- both
document types SEQRA-02's ontology and SEQRA-04's classifier already
recognize -- through the same `buildTopicFinding` choke point, so a comment
or response finding carries the same A1 evidence guarantee as an
impact/mitigation finding. An agency-response finding additionally carries a
categorical `response_disposition` (`addressed`/`deferred`/
`disputed_unresolved`/`unknown`), read from the response's own wording, never
inferred from silence.

## Low-confidence quarantine

`warehouse/lib/seqra_topic_finding_quarantine.mjs#quarantineFindings`
partitions findings at a documented confidence threshold
(`LOW_CONFIDENCE_THRESHOLD`, 0.6) into `accepted` and `quarantined`, and
reports `quarantined_count` explicitly (card acceptance A5). It first throws
on any finding missing page/span evidence outright -- that is a defect in
the extractor that produced it, never a confidence question, so it is never
silently routed into quarantine as if it were merely low-confidence rather
than broken. `buildTrainingCorpusRows` is the only function that may emit
training-corpus rows, and it refuses any finding still tagged
`quarantined_low_confidence`, so a caller cannot bypass quarantine by
reaching past this module into the raw finding list.

## Human-reviewed benchmark

`warehouse/lib/seqra_topic_extraction_benchmark.mjs#computeExtractionBenchmarkReport`
scores extractor output against a benchmark set of reviewed pages -- each
page names the (technical_topic, finding_type) pairs a human reviewer
confirmed are genuinely present, possibly empty -- and reports precision,
recall, and F1 per topic and per document type, plus an overall roll-up
(card acceptance A4). Scoring only ever compares against *reviewed* pages: an
extractor finding on a page nobody has reviewed is out of the benchmark's
scope, reported separately as `unscored_finding_count`, never folded into
precision. The fixture benchmark set this card ships with
(`warehouse/fixtures/seqra-ceqr-access/sample_topic_extraction_fixtures.mjs`)
is deliberately not a trivial 100% match -- it carries one finding the
extractor produces that the reviewer did not expect and one the reviewer
expected that the extractor misses, so the gate's precision/recall assertions
are a real computation over real data, not a stand-in constant.

## Negative rule

"Do not apply current technical thresholds retrospectively without a
documented vintage crosswalk, and do not let an unexplained score replace a
cited finding." The first half is enforced by `compareThresholdFact`'s
explicit-vintage requirement above; the card gate additionally statically
scans every SEQRA-05 module for a fallback-to-"current"/"latest"-vintage
pattern. The second half is enforced by `buildTopicFinding` itself: a
`threshold_comparison` finding requires `normalizedValue`/`unit`/
`manualVintageId`/`factType` together, and every finding of any type requires
`page_number` and `evidence_excerpt` -- there is no path to constructing a
bare confidence score standing in for a citation.

## Command

```sh
npm run warehouse:seqra:documents                              # this card's gate (deterministic, no network), shared with SEQRA-04
node tools/check_seqra_document_pipeline.mjs --check            # rebuild and diff against the committed receipt
```

`npm run warehouse:seqra:documents` is this card's gate, reusing the exact
command SEQRA-04's `verify` field already named -- the same convention
`warehouse:seqra:labels` already established for SEQRA-02 (a later card's own
acceptance folded into an existing command surface entry, not a new one per
card). It performs no network access; it fetches and stores this card's own
synthetic fixture documents through the real hash-preserving fetcher (so the
A1 evidence chain is exercised end to end, not stubbed), extracts findings
from them, quarantines the low-confidence ones, projects topic assessments,
and scores the result against the committed benchmark set.

## Reuse and non-regression

This card adds no new ontology registry entry: `technical_topic_assessment`
and the full `SEQRA_TECHNICAL_TOPICS`/`SEQRA_TOPIC_ASSESSMENT_STATES`
vocabulary were already registered by SEQRA-02
(`warehouse/lib/seqra_ontology_spec.mjs`) and are reused verbatim. Document
identity, fetch receipts, and page text all come from SEQRA-04's existing
document pipeline (`seqra_document_fetcher.mjs`, `seqra_document_classifier.mjs`,
`seqra_document_extraction.mjs`) rather than a second implementation of any
of them.
