# Formula: rules adoption lag

**Status:** shipped (batch precompute)  
**Model:** `rules_adoption_lag` `1.0.0`  
**Assertion:** `cityscroll.prediction.v0`  
**Method:** `phase_duration_ecdf`  
**Predicted event:** `rules.adoption` (anchored on `rules.comment_close`)

## What it estimates

How long after a rule’s public comment period closes until a Notice of Adoption is published in the City Record, and how often an adoption appears within 365 days.

There is no statutory adoption deadline — only a general “minimum of about 60 days” for the rulemaking process overall — so this is a statistical estimate, not a legal due date.

## Data

- **Historical corpus:** City Record Online Agency Rules notices (warehouse bulk snapshot; ~3,061 Agency Rules rows spanning 2013–2026 in the committed fixture rebuild).
- **Live open matters:** the rules materialization (`/rules`, 540-day window, multi-notice stitch) remains the source of truth for current comment periods.
- **Sibling stitch:** the same `attachRulemakingSiblings` / `matchRulemakingSiblings` logic as the live pipeline groups proposal, hearing, and adoption notices. No parallel matcher.

## Comment-close anchor (priority)

1. Explicit comment-by date in the notice body (when parseable)
2. Hearing / public-process `event_date` on a non-adoption sibling (City Record “Opportunity to Comment” notices almost always set the hearing day as the deadline)
3. Proposal publication date only when no hearing clock exists

Adoption date is the publication day of a role-classified adoption notice.

## Right-censoring

Rules with a comment-close anchor and no observed adoption by the training cutoff are **right-censored** (Kaplan–Meier style). Silence does not count as a short gap.

For the timing ECDF, gaps longer than 365 days are winsorized to censored-at-365 so multi-year false stitches do not dominate the band.

## Cohort model

| Piece | Rule |
|---|---|
| Per-agency ECDF | when cohort n ≥ 20 (`EARLY_SAMPLE`, same bar as forecast scoring) |
| Back-off | citywide ECDF otherwise |
| Quantiles | p10 / p50 / p90 on the comment_close → adoption gap (outer anchors use empirical p05/p95 so the labeled window targets ~80% coverage on a heavy-tailed process) |
| Middle half | p25–p75 (digest “middle half” copy) |
| Occurrence | citywide P(adoption within 365d) from the KM curve |

## Delivery

- **Page:** dashed “Estimate” ghost segment after comment close on the rules phase timeline — never an event dot.
- **Digest:** one pattern-attribution line for watched closed comment periods, only on **band transitions** (`far` → `approaching` → `imminent` → `overdue`) via `predictionDeliveryTransition`. Re-estimation alone does not resend.
- **Copy (one line):**  
  `Comment period closed {date}. Predicted based on {N} similar rule adoptions since {YYYY} — median {D} days to adoption, middle half {D1}–{D2}.`  
  When the ship bar fails for a cohort, the same line uses “typically” without a per-matter date.

## Evaluation

| Protocol | Role |
|---|---|
| Expanding-window walk-forward over realized adoptions | Primary ship bar (no future leakage; train only on earlier comment closes) |
| Fixed split train pre-2025 / score 2025–26 | Headline slice reported under `headline_split` |

**Ship bar** (thresholds from `worker/src/lib/prediction_calibration.mjs`):

- ≥ 50 resolved backtest predictions (`MINIMUM_RESOLVED`)
- Interval coverage within 80% ± 10 points on the [p10, p90] window
- Occurrence quintiles non-decreasing where enough mass exists

Primary evaluation is expanding-window walk-forward (short phase durations make
a single open-at-T New Year split too thin). When open-at-T predictions exist
they are also scored with `evaluatePredictionBacktest`.

Evidence: `docs/evidence/rules-adoption-lag/backtest.json`  
Rebuild: `node tools/build_rules_adoption_predictions.mjs`  
Check: `node tools/build_rules_adoption_predictions.mjs --check`  
Scorecard fixtures: `node worker/scripts/prediction-calibration-scorecard.mjs --fixtures worker/test/fixtures/predictions --check`

## False-positive / honesty modes

- **False multi-notice stitch** can attach the wrong adoption; stitch stays high-confidence-only (false merge worse than split).
- **Hearing-date-as-deadline** is the dominant City Record pattern but not universal; explicit body dates win when present.
- **Low occurrence base rate** in the historical stitch (~13% within 365d) reflects incomplete adoption joins and rules that never publish an adoption notice — not a claim that 87% of proposals die.
- Below the ship bar, surfaces show the cohort statistic without a per-matter date.

## Related code

- `worker/src/lib/rules_adoption_lag.mjs` — model, backtest, digest delivery keys
- `worker/src/lib/prediction_contract.mjs` — assertion contract
- `worker/src/lib/rules.mjs` — sibling stitch
- `site/rules_adoption_lag_view.mjs` — client ghost segment
- `site/data/rules_adoption_lag_model.json` — precomputed cohorts
- `site/data/rules_adoption_predictions.json` — open-matter view
