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
