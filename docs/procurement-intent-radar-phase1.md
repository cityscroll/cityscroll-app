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
