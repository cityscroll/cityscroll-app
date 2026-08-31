# Land-use prediction stance backtest

`worker/src/lib/land_prediction_backtest.mjs` is the C7 time-held-out evaluator.
It reuses the C5 feature vector and C6 regularized logistic predictor, plus
`forecast_calibration.mjs` leakage checks. It does not replace
`land_prediction_baseline_v1` and does not emit resident-facing probabilities.

The frozen gold pack is `test/fixtures/land_prediction_backtest/gold.v1.json`.
Each eligible application is reconstructed at its `prediction_as_of` cutoff.
Training uses only that cutoff-available evidence; `outcome_at` must be strictly
later. Four models share one scoring contract:

1. Existing process baseline — `application_type` and `procedural_stage` only.
   The production baseline still emits cohort rates rather than a project-level
   approval probability; this process-only logistic exists so Brier and log loss
   can be compared.
2. Baseline plus formal-process signals — Community Board, Borough President,
   CPC, committee, and modification features.
3. Baseline plus local-member stance.
4. Full V2 feature set.

The receipt reports held-out Brier score, log loss, calibration bins,
stage-specific error, stance coverage, evidence timing, missingness, and
ablation deltas. Unknown stance stays unknown. H1 (institutional deference)
and H2 (member as sensor) remain rival predictive hypotheses; lift is not a
causal explanation and is not a literature-assigned weight.

The kill criterion withholds major-feature status when stance adds no meaningful
held-out Brier lift after formal signals, or when stance arrives too late to
forecast. A met kill criterion is recorded as success. Product promotion stays
withheld in either case until a later gate.

Rebuild:

```sh
node tools/build_land_prediction_backtest.mjs
node tools/build_land_prediction_backtest.mjs --check
node --test worker/test/land_prediction_backtest.test.mjs \
  worker/test/land_prediction_predictor.test.mjs \
  test/land_prediction_backtest.test.mjs
```
