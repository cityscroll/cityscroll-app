# ADR: Cutoff-safe, project-family-grouped backtest of filing-evidence feature families

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-05 |
| Scope | `warehouse/lib/land_filing_evidence_backtest.mjs`, `warehouse/fixtures/land-filing-evidence-backtest/`, `tools/build_land_filing_evidence_backtest.mjs` |
| Supersedes | — |
| Related | `docs/adr/land-use-filing-ontology.md`, `warehouse/lib/land_filing_sequence.mjs` (LDP-26), `docs/land-use-prediction-predictor-v2.md`, `docs/evidence/land-use-prediction-v2/stance-backtest.md` (LUP2-C7) |

## Context

LDP-22 through LDP-26 registered a census, a typed filing-obligation and
filing-document ontology, an extraction pipeline, and a materialized
pre-certification filing sequence for RER filings. None of that work asked
whether any of it carries out-of-sample predictive value, and the release's
own out-of-scope list forbids shipping a certification-chance feature before
this card passes. Statutory applicability is a selection mechanism, not a
treatment: a plausible-looking association between an applicant's filing and
a later outcome is not evidence the filing caused it, and nothing before this
card stopped that association from being proposed as a feature on its face
value alone.

## Decision

1. **Three feature families, always ablated separately.** `report_filing_facts`
   (applicability assertion presence, report document observation, the
   not-timely-filed notice), `package_churn` (observed package-version count,
   revision interval, version conflicts), and `environmental_state` (CEQR
   identity and milestone presence) are three disjoint tiers. Every
   evaluation report names exactly one family; nothing in
   `evaluateFeatureFamilyForOutcome` can combine two families' features into
   one design matrix under one family's name.

2. **Five separate outcomes, never one.** `days_to_certification`,
   `days_from_noticing_to_certification`, `certified_within_horizon`,
   `post_certification_disposition` (approved/modified, scored only over
   certified rows), and `withdrawal_or_inactivity` (scored over every row
   with a determinate answer). Withdrawal/inactivity is its own target
   rather than a third class folded into `post_certification_disposition`:
   a withdrawn or inactive project by definition never reaches
   certification, so "approved or modified" and "withdrawn or inactive"
   describe two different populations, and scoring them as one target would
   silently conflate them.

3. **Absence is never a numeric zero.** `feature()` enforces the invariant
   structurally: a `not_checked`/`source_unavailable`/`unknown` state
   requires `value: null`, and an `observed_present`/`observed_absent` state
   requires a real finite number. A feature builder that tried to report "no
   event found" as a bare `0` without distinguishing "checked, absent" from
   "never checked" cannot construct a valid feature at all.

4. **Project families and rolling-origin folds.** `buildFilingProjectFamilies`
   unions projects sharing a BBL (a resubmission, phasing, or amendment of
   the same site); `buildRollingOriginFilingFolds` assigns train/test splits
   by cutoff and excludes any family that would appear on both sides of the
   same fold, re-verified independently by
   `assertFilingFoldFamilyDisjointness` rather than trusted from the
   assignment step alone.

5. **`buildAsOfFilingBacktestRow` re-checks leakage independently, twice.**
   First against the raw ZAP-row snapshot's own date fields (a caller's
   fixture or future live source could otherwise hand in a "live" row that
   already knows a later date), then against every event
   `land_filing_sequence.mjs` materializes from the as-of-projected
   obligations/documents (`projectLandUseFilingAsOf`, LDP-23). Either check
   throws rather than silently including the fact.

6. **A minimal, deterministic scoring stack.** Logistic regression (full-batch
   gradient descent, fixed iterations) for binary and one-vs-rest categorical
   targets; ridge linear regression (closed-form normal equations) plus
   concordance and a Kaplan-Meier median comparator for duration targets.
   This is deliberately lighter than SEQRA-09's platform-pinned
   transcendentals and IRLS fitter: this card's population is small by
   design (a committed synthetic fixture, not a production corpus), and the
   receipt is compared with rounding rather than demanded byte-exact, so the
   determinism bar is "the same inputs give the same fitted numbers on this
   machine and in CI," not "identical to the last ULP across every
   platform."

7. **A signed GO/stop verdict, never a bare boolean.**
   `evaluatePromotionGate` checks fold count, per-fold test-row floor, row
   coverage, incremental lift over a no-filing-evidence baseline,
   calibration error, and subgroup metric spread independently, and names
   every threshold that failed. A GO requires every condition to hold; there
   is no code path that reports GO from an unmeasured lift or calibration
   error, and a stop is accepted as a valid, non-error outcome throughout
   the test suite and the build tool's own checks.

8. **The displacement index stays out.** `assertNoDisplacementIndexFeature`
   refuses any feature name referencing displacement or the DRI; none of the
   three feature families reference it, so the assertion is a structural
   guarantee rather than a promise about today's feature list.

9. **No causal language, no combined score.**
   `assertNoForbiddenCausalLanguage` scans every emitted name (family,
   target, feature, class) for a whole-token causal or product-score term
   (`causes`, `due_to`, `certification_probability`, `risk_score`, …).
   `assertNoCombinedScore` refuses any report shape that folds families or
   outcomes into one `combined_score`/`overall_risk`-style field. Together
   with (1) and (2) above, no code path in this module can produce a single
   number a caller could read as this card's own product score.

10. **The corpus is entirely synthetic.** Every row in
    `warehouse/fixtures/land-filing-evidence-backtest/` is built through the
    real LDP-23 contracts (`buildLandUseFilingObligation`,
    `buildLandUseFilingDocument`) so the harness is contract-valid, but every
    project key, BBL, and disposition is invented for this fixture set --
    matching SEQRA-09's and LUP2-C7's own precedent of exercising a backtest
    harness against a committed synthetic corpus rather than a live source.
    This card's receipt and its GO/stop verdicts describe the harness, not a
    real project's odds.

## Non-goals

- No product score, no resident-facing feature, and no change to the
  existing prediction product (`land_prediction_predictor.v2` and its
  siblings) of any kind. This card is an evaluation and handoff gate only.
- No causal claim of any kind: report filing is never said to cause,
  delay, or predict certification, approval, rejection, displacement, or
  equity/inequity.
- No use of current document availability to backfill a historical
  prediction; every feature is built strictly from the as-of-cutoff
  obligations/documents/ZAP snapshot, and every outcome label is read only
  from ground truth strictly after that same cutoff.
- No live source, no network call, no host-time model call.
- No neighbourhood-risk or protected-class proxy feature in any family.

## Consequences

A later prediction card may cite this card's receipt as its GO/stop
evidence, per family and per outcome, but this card authorizes no change to
the prediction product by itself. A family that stops here may remain
available for explanation and search without ever entering prediction; that
is treated as a fully valid, non-error outcome of running
`npm run backtest:land:filing-evidence`, not as a defect in the harness.
