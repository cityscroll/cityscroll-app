# Land filing-evidence backtest

As of 2026-09-05. Measured over a committed, entirely synthetic evaluation
corpus (`warehouse/fixtures/land-filing-evidence-backtest/`, 39 fixture rows,
37 project families, 3 rolling-origin folds spanning 2021-2024), not a
recurrent population estimate and not a claim about any real project. Every
row is built through the real LDP-23 contracts
(`ontology/land_use_filing.mjs`), so the harness this corpus exercises --
cutoff safety, project-family grouping, per-family ablation, calibration, and
the promotion gate -- is the same code that would run against a real corpus,
but the numbers below describe the fixture, not a filing history.

Regenerate with `npm run backtest:land:filing-evidence`; the full receipt is
`warehouse/receipts/proof/land_filing_evidence_backtest_latest.json`.

## Promotion gate

A feature family may be proposed to the prediction workstream only when it
is time-valid, source-stable, sufficiently covered, incrementally useful
over a no-filing-evidence baseline, calibrated (where a probability is
fitted at all), robust across subgroups, and explainable without a
protected-class or neighbourhood-risk proxy. Every threshold below is
checked independently and named when it fails; a GO requires all of them to
hold, and a stop is a valid, accepted result, not an error.

| Threshold | Value |
| --- | ---: |
| Minimum out-of-time folds | 2 |
| Minimum test rows per fold | 3 |
| Minimum row coverage | 0.50 |
| Minimum incremental lift over baseline | 0.01 |
| Maximum expected calibration error (where applicable) | 0.25 |
| Maximum subgroup metric spread | 0.40 |

Calibration error is not applicable to a duration target in this module's
minimal scoring stack (no survival-quantile calibration is fitted here); the
gate skips that one threshold for those targets rather than reporting it as
permanently unmeasured and stopping every duration target by construction.

## Results by feature family and outcome

`report_filing_facts`, `package_churn`, and `environmental_state` are always
ablated separately (G5/A5); nothing below combines two families under one
name. `days_to_certification` and `days_from_noticing_to_certification` are
duration targets (primary metric: concordance); `certified_within_horizon`
and `withdrawal_or_inactivity` are binary (primary metric: log loss);
`post_certification_disposition` is scored one-vs-rest per class
(`approved`, `modified`) and reported here as the mean of the two classes'
log loss, never combined into one label prediction.

### `report_filing_facts`

| Outcome | Decision | Row coverage | Lift over baseline | Calibration error | Subgroup spread | Reasons |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| days_to_certification | stop | 0.667 | 0.0278 | n/a | 0.583 | subgroup metric spread 0.5833 exceeds 0.4 |
| days_from_noticing_to_certification | stop | 0.667 | 0.0000 | n/a | 0.000 | incremental lift over the baseline tier 0.0000 is below 0.01 |
| certified_within_horizon | stop | 0.667 | 0.2384 | 0.0590 | 0.783 | subgroup metric spread 0.7832 exceeds 0.4 |
| post_certification_disposition | **go** | 0.667 | 0.4737 | 0.1986 | n/a | — |
| withdrawal_or_inactivity | stop | 0.667 | -0.0000 | 0.0085 | 0.000 | incremental lift over the baseline tier -0.0000 is below 0.01 |

### `package_churn`

| Outcome | Decision | Row coverage | Lift over baseline | Calibration error | Subgroup spread | Reasons |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| days_to_certification | **go** | 0.974 | 0.4132 | n/a | 0.000 | — |
| days_from_noticing_to_certification | **go** | 0.974 | 0.4427 | n/a | 0.000 | — |
| certified_within_horizon | stop | 0.974 | 0.2221 | 0.1948 | 0.570 | subgroup metric spread 0.5695 exceeds 0.4 |
| post_certification_disposition | **go** | 0.974 | 0.3944 | 0.1807 | n/a | — |
| withdrawal_or_inactivity | stop | 0.974 | 0.0000 | 0.0085 | 0.000 | incremental lift over the baseline tier 0.0000 is below 0.01 |

### `environmental_state`

| Outcome | Decision | Row coverage | Lift over baseline | Calibration error | Subgroup spread | Reasons |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| days_to_certification | **go** | 0.923 | 0.3571 | n/a | 0.333 | — |
| days_from_noticing_to_certification | **go** | 0.923 | 0.3333 | n/a | 0.333 | — |
| certified_within_horizon | **go** | 0.923 | 0.4559 | 0.1494 | 0.213 | — |
| post_certification_disposition | stop | 0.923 | 0.0025 | 0.0092 | n/a | incremental lift over the baseline tier 0.0025 is below 0.01 |
| withdrawal_or_inactivity | stop | 0.923 | 0.0000 | 0.0085 | 0.000 | incremental lift over the baseline tier 0.0000 is below 0.01 |

Seven of fifteen (family, outcome) pairs measure GO on this fixture corpus;
eight measure stop. Both outcomes are accepted results of running the gate,
not evidence of a harness defect -- `withdrawal_or_inactivity` in particular
was deliberately fixtured so that ground truth depends only on whether a
project was ever certified, not on any of the three feature families, and
every family's near-zero lift on that target reflects that construction
honestly rather than a modelling failure.

## Theory / mechanism

Statutory applicability is a selection mechanism, not a treatment. This
backtest never asks whether a filing *caused* an outcome, only whether a
fact that was public at a cutoff separates an outcome observed strictly
after that cutoff, out of time, better than a baseline carrying no such
fact. A family that measures a real lift here is evidence the fact carries
information available at decision time; it says nothing about why, and
nothing here licenses a causal reading of report filing, package churn, or
environmental identity.

## Leakage and exclusions

- Every row's own ZAP-row snapshot and every materialized filing-sequence
  event is independently re-checked against that row's own cutoff by
  `buildAsOfFilingBacktestRow`; a fixture that leaked a future date was
  refused during authoring and is now covered by a regression test.
- Two project families (a resubmission/amendment pair sharing a BBL) are
  deliberately placed across a fold boundary; both are excluded from that
  fold rather than appearing on both sides of the split.
- The displacement index is not a feature in any family
  (`assertNoDisplacementIndexFeature`); it was never proposed for this card
  and this receipt is not a sensitivity analysis of it.
- No product score, causal claim, or certification-probability language
  appears anywhere in the emitted reports (`assertNoForbiddenCausalLanguage`,
  `assertNoCombinedScore`), checked structurally against the actual receipt
  contents, not only against a hand-maintained word list.

## Handoff

This receipt is the evidence a later, owner-reviewed prediction card would
cite per family and per outcome. It authorizes no change to the existing
prediction product (`land_prediction_predictor.v2` and its siblings) by
itself. A family measuring stop here may remain available for explanation
and search without entering prediction.
