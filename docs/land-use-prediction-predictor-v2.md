# Land-use prediction V2

`worker/src/lib/land_prediction_predictor.mjs` is the C6 shadow predictor. Its
boundary is:

`raw evidence → land_prediction_snapshot.v1 → land_prediction_feature_vector.v1 → regularized logistic model → explanation`

The C2 and C5 builders are the source of truth for temporal validity and
provenance. `fitLandPredictionModel` accepts rows containing a normalized
feature vector (or a C2 snapshot/raw feature input), an outcome, and
`outcome_at`. A row is training-valid only when `outcome_at` is strictly after
the vector's `prediction_as_of`; the vector validators reject evidence that was
not available at that cutoff. Rows with unsupported or missing outcomes are
rejected instead of being silently treated as negatives.

The first model is `land_use_approval_logistic` version `2.0.0`. It uses a
deterministic, regularized logistic additive model over categorical feature
values and explicit feature states (`known`, `unknown`, `no_known_position`,
and `neutral_mixed`), including the C5 local-member-by-stage interaction. There
is no random initialization or shuffling. A prediction contains the probability,
prediction timestamp/as-of cutoff, model identity, complete feature-state
summary, evidence-linked major contributors, and a statement that contributors
are predictive associations rather than causal claims.

Calibration is measured with Brier score, log loss, and fixed probability bins.
The training report is labeled as in-sample; callers can use
`measureLandPredictionCalibration` on a held-out set. Card 7 owns the
out-of-sample backtest and Card 9 owns any promotion decision.

V2 is explicitly `shadow_only_until_backtest_gate`. `predictLandUse` preserves
the incumbent `land_prediction_baseline_v1` path: a supplied
`fallback_predictor` is invoked on failure, or the result carries an honest
fallback descriptor with no invented baseline approval probability.

Focused verification:

```sh
node --test worker/test/land_prediction_predictor.test.mjs
```
