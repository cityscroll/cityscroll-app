# Procurement Intent Radar — Phase 1

Phase 1 is a deterministic, review-only extractor. It does not create
predictions, reconcile later solicitations, or add a public route.

## Input coverage

The current committed meeting read model is
`site/data/shared_meeting_read_model.json`. It contains 522 rows: 395
community-board events and 127 City Record meeting notices. Those rows retain
meeting metadata, descriptions, and search text, but no Council transcript,
agency testimony, or Finance Division briefing-paper passages. The materialized
artifact records this as `text_bearing_council_rows: 0`; no new source
acquisition is performed.

The bounded review corpus is the five versioned source spans in
`test/fixtures/procurement_intent_radar/gold_fixtures.v0.json`. It is used to
prove the extractor contract while retained Council text coverage is absent.

## Pipeline

`warehouse/lib/procurement_intent_extractor.mjs` performs two deterministic
stages:

1. Stage 1 requires at least one future-language trigger, procurement-action
   trigger, and procurement-object trigger in the supplied source span.
2. Stage 2 preserves the source span and extracts agency, speaker, object,
   program, procurement form, quantities, money, populations, places,
   timeframe, modality, conditions, and evidence offsets.

Past-tense and reported-speech controls are retained as rejected review rows.
The source span is never replaced by a prediction or a later procurement
record.

## Rebuild and review

```sh
node tools/build_procurement_intent_candidates.mjs
node tools/build_procurement_intent_candidates.mjs --check
node tools/review_procurement_intent_candidates.mjs
node --test test/procurement_intent_radar_extractor.test.mjs test/procurement_intent_radar_fixtures.test.mjs
```

The review dataset is
`warehouse/fixtures/procurement-intent-radar/candidate_review.v0.json`.
It contains the candidate sentence, source identifiers, citation, trigger
matches, rejection reasons, and structured assertion for every reviewed span.

## Historical realization bridge

`warehouse/lib/procurement_intent_realization_matcher.mjs` is the retrospective
reconciliation seam for PIR-2 processes. It searches only later publisher rows
within an 18-month, equivalent-agency horizon. Structured evidence is separated
into strong signals (program, project, quantity, and population) and medium
signals (agency, service, geography, money, and method). Chronology gates the
horizon but cannot establish a match by itself.

Only very strong, agency-consistent pairs produce `realized_by` edges. Other
same-agency candidates remain review leads, and an empty candidate set remains
unmatched. Accepted rows produce an exact
`procurement.notice_published` event for the PIR-2 provisional subject so the
existing prediction resolver can consume the bridge without becoming fuzzy.
The feature object deliberately excludes publisher identifiers and vendor
fields; those values are outputs of the later observation, not hindsight inputs
to the historical intent.

Focused proof:

```sh
node --test test/procurement_intent_realization_matcher.test.mjs
```

## Corpus backtest

`tools/backtest_procurement_intent_radar.mjs` reconstructs each labeled source
at its meeting-date cutoff, scores later realizations only after that cutoff,
and writes the JSON/report/coverage receipt. The five-case gold pack remains a
fixture control. The retained meeting read model currently contributes zero
PIR-eligible 2022–2025 Council text rows, so promotion stays withheld.

```sh
node tools/backtest_procurement_intent_radar.mjs
node tools/backtest_procurement_intent_radar.mjs --check
node --test test/procurement_intent_radar_backtest.test.mjs
```

## Prospective shadow mode

`tools/run_procurement_intent_shadow_mode.mjs` replays the retained arrival
stream `test/fixtures/procurement_intent_radar/shadow_arrivals.v0.json` through
two ordered phases. The assertion phase is handed the source projection of the
stream only: each arriving span is sealed at its own publication clock, run
through the extractor and the PIR-2 ontology, and recorded as an open internal
intent with a provisional identity and separate occurrence and timing claims.
The resolution phase is the only phase that reads later solicitations, and it
records a resolution or review outcome beside the earlier assertion. Every
assertion is fingerprinted before resolution and re-checked after it, so a later
realization can never become a feature of the earlier candidate.

Open, resolved, ambiguous, unmatched, superseded, insufficient-evidence, and
abstention states are all explicit. An intent that has simply not been observed
yet is reported separately from one whose stated window closed with nothing
observed. Identity is content-addressed from the sealed source, so a replayed
arrival is a recorded duplicate rather than a second intent, and a later arrival
for the same provisional subject supersedes the earlier one without editing it.

Shadow mode is a measurement mode. The artifact is internal-only: it creates no
route, search document, follow target, notification, or resident-facing claim,
publishes no realized edge, and authorizes no promotion. It performs no network
access and has no CityMeetings runtime dependency; citation URLs are retained
strings that are never fetched. The run is reproducible from the retained,
versioned stream alone.

```sh
node tools/run_procurement_intent_shadow_mode.mjs
node tools/run_procurement_intent_shadow_mode.mjs --check
node --test test/procurement_intent_radar_shadow_mode.test.mjs
```

The internal outputs are
`warehouse/fixtures/procurement-intent-radar/shadow_mode.v1.json` and
`docs/evidence/procurement-intent-radar/shadow-mode.md`.
