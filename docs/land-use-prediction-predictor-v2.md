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
out-of-sample backtest in `worker/src/lib/land_prediction_backtest.mjs`
(`docs/land-use-prediction-backtest-v2.md`) and Card 9 owns any promotion
decision.

Card 11 splits Council disposition from terminal project outcome and adds
review-regime features (`worker/src/lib/land_prediction_regime_targets.mjs`);
both stay experimental and shadow-only. Card 12 backtests that split with
explicit factual, counterfactual, and negative-control cohorts held separate
by the loader (`worker/src/lib/land_prediction_regime_backtest.mjs`). A
counterfactual case is restricted to eligibility and branching semantics and
is never assigned an outcome nobody observed; a null or unestimable finding
-- the expected result while the factual post-reform sample stays small --
is recorded as a successful evaluation rather than forced into a conclusion.

```sh
node --test test/lup2_regime_targets.test.mjs
node --test test/lup2_regime_backtest.test.mjs
```

V2 is explicitly `shadow_only_until_backtest_gate`. `predictLandUse` preserves
the incumbent `land_prediction_baseline_v1` path: a supplied
`fallback_predictor` is invoked on failure, or the result carries an honest
fallback descriptor with no invented baseline approval probability.

## Explanation and evidence contract

`worker/src/lib/land_prediction_explanation.mjs` defines
`cityscroll.land_prediction_explanation.v1`. It separates material
`known_reasons` from `unknown_signals`; each stable reason retains the feature
state, modeled direction, non-causal explanation, and evidence references.
Evidence references are `resolvable` only when they carry an exact stable route
or URL. A source reference without a retained observation remains
`source_statement_status: unavailable`, and an unresolved route is explicitly
`unavailable`; neither state is treated as proof that evidence does not exist.

`compareLandPredictionExplanations` emits the deterministic
`cityscroll.land_prediction_explanation_comparison.v1` shape. It reports model
and probability changes as measurements and classifies reason IDs as added,
removed, changed, unchanged, or still unknown. Temporal ordering is not exposed
as a causal explanation for a probability movement. Institutional features are
described only as predictive associations; control remains unavailable unless a
separate source-backed contract establishes it.

The land-detail coherence seam preserves a valid shadow explanation or exposes
an honest unavailable state. It does not make V2 resident-authoritative, remove
the incumbent heuristic, or alter C7's withheld promotion decision.

Focused verification:

```sh
node --test worker/test/land_prediction_predictor.test.mjs
node --test worker/test/land_prediction_explanation.test.mjs
```
