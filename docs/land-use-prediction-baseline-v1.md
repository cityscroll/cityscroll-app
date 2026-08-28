# Land-use prediction baseline v1

This is the frozen CARD 1 contract for the predictor that existed before Land-Use
Prediction v2. It is a characterization of current behavior, not a V2 design.
The machine-readable replay is in
[`warehouse/receipts/proof/land-prediction-baseline-v1.json`](../warehouse/receipts/proof/land-prediction-baseline-v1.json),
with retained application cases in
[`test/fixtures/land_prediction_baseline/v1.json`](../test/fixtures/land_prediction_baseline/v1.json).

## Current output contract

The current land surface has three different kinds of output that are easy to
mistake for one predictor:

1. **Observed status.** List cards print `public_status` or `project_status`
   (`site/app/land.mjs:777-778, 834`). Detail-page status is one resolved value
   from the ZAP public-status dimension. `zap-outcomes.public_status` wins by
   status rank, then list-row/open-data values provide fallbacks
   (`site/land_detail_coherence.mjs:40-112`). This is categorical process
   description, not a terminal-outcome forecast.
2. **Observed/current stage.** The stage facet maps terminal status to
   `completed`; otherwise it maps `current_milestone` through the shared phase
   classifier (`site/land_status_facets.mjs:167-194`). The full phase spine maps
   event `title`, `kind`, `representing`/`detail`, status, and actual/planned
   time into pre-application, environmental, certification, Community Board,
   Borough President, CPC, Council, and mayoral-appeal phases
   (`site/land_phase_spine.mjs:97-175, 253-367, 441-691`). This is also observed
   process position, not an approval forecast.
3. **Historical outcome context and timing.** The detail panel selects an
   action-type/borough cohort, with deterministic backoff to action-type
   citywide, all-actions borough, then citywide. It displays the cohort's
   approved/modified/disapproved rates and empirical p25-p75 duration range
   (`worker/src/lib/zoning_statistics.mjs:340-403`; `site/app/land.mjs:1241-1267`).
   The emitted `zap_disposition` prediction is a p10/p50/p90 timing window with
   `probability: 1`, not a probability of approval
   (`worker/src/lib/zoning_statistics.mjs:416-453`).

Applicant conditioning is a separate descriptive branch. A resolved applicant
entity needs at least 20 terminal outcomes; it is shown beside the unconditioned
base rate (`worker/src/lib/zoning_statistics.mjs:460-524, 530-547`;
`site/app/land.mjs:1207-1239`). The existing time-split Brier comparison only
emits a project-level approval occurrence prediction when conditioning beats the
unconditioned rate. The committed model currently says `render_mode:
descriptive_history`, so no project-level approval probability is emitted
(`worker/src/lib/zoning_statistics.mjs:623-730`; `site/data/zoning_statistics.json`).

## Inputs that affect the displayed result

The following are actual inputs, not proposed V2 features.

### Cohort timing and outcome context

The worker-side materialization reads retained ZAP project rows with
`project_id`, `actions`, `borough`, `primary_applicant`, `certified_referred`,
`approval_date`, `completed_date`, `current_milestone_date`,
`project_status`, and `public_status` (`tools/build_zoning_statistics.mjs:52-68`).
Action-detail status rows add `action_statuses`; the project outcome classifier
uses explicit `outcome` when present, otherwise action statuses, and excludes
pure withdrawal/termination rather than calling it disapproval
(`worker/src/lib/zoning_statistics.mjs:97-132`; `tools/build_zoning_statistics.mjs:121-157`).

For each normalized row, the effective inputs are:

- first action code from `actions`/`action_types`;
- borough, defaulting to `Citywide`;
- certification/referral date;
- outcome class (`approved`, `modified`, `disapproved`, or excluded/unknown);
- disposition date: explicit `disposition_date`, then `approval_date`, then
  `completed_date`/`current_milestone_date` for modified or disapproved rows;
- primary-applicant name, only for the separate applicant-conditioned branch.

The cohort output retains `n`, outcome counts/rates, duration p10/p25/p50/p75/p90,
training date range, cohort level, and model version. Duration observations are
limited to non-negative spans of at most 730 days
(`worker/src/lib/zoning_statistics.mjs:234-260, 270-323`). The current
materialization uses a minimum cohort size of 20 and model
`zap_disposition_duration@1.0.0` (`site/data/zoning_statistics.json`).

For a project-level timing replay, the selected cohort must have p10/p50/p90
duration values and the project must have a project ID and certification date.
Those cohort quantiles are added to the certification date. The resulting
prediction has claim `timing`, event kind `land.zap_disposition`, and
`probability: 1` (`worker/src/lib/zoning_statistics.mjs:416-453`).

### Public status and stage

The displayed resolved status reads, in priority order, outcome-record
`public_status`, list-row `public_status`, outcome-record open-data
`public_status`, list-row `project_status`, and outcome-record open-data
`project_status`; status rank and a public-status tie-break choose one value
(`site/land_detail_coherence.mjs:63-112`).

The stage classifier reads `public_status`, `project_status`,
`current_milestone`, and optional `phase_id`; terminal text maps to `completed`,
and the remaining milestone maps through `mapMilestoneToPhase`
(`site/land_status_facets.mjs:167-194`). The phase-spine classifier additionally
reads every retained event's title, kind, detail/representing, status, outcome,
time value, time certainty, synthetic marker, plus open-data current milestone,
public status, project ID, and noticed date
(`site/land_phase_spine.mjs:103-175, 177-220, 253-367, 441-501`).

### ULURP statutory clock and timing assertions

The statutory clock reads the procedure (`ulurp_non`, including nested
`open_data.ulurp_non`), certification/referral date, milestone and spine-event
titles/statuses/details/outcomes/dates/certainty, disposition rows, and terminal
public/project status (`site/ulurp_statutory_clock.mjs:117-229, 245-319,
545-699`). It is deliberately fail-closed for a resolved ELURP or Non-ULURP
procedure: only ULURP or unknown procedure is eligible for the §197-c table
(`site/ulurp_statutory_clock.mjs:1-16, 124-132, 545-557`). The current timing
cohort heuristic is separate and does not read this procedure gate; the ELURP
fixture freezes that limitation.

The UI uses the precomputed clock, current phase, public status, and today's
date to render a pipeline step and days-left text. It suppresses terminal
projects and only uses phase-window deadlines with a known start
(`site/app/land.mjs:1269-1308, 1310-1407`).

## Numeric baseline

The authoritative current materialization backtest is time-split at
2024-01-01. It trains through 2023-12-31 and evaluates 63 timing predictions:

- 63/63 resolved (`resolution_rate: 1.0`), with 49 interval hits and 14 misses;
- nominal interval coverage: 0.80;
- observed p10-p90 interval coverage: 49/63 = **0.7778**;
- median absolute p50 error: **35 days**;
- the existing timing ship bar is `pass` under its configured 50-prediction
  minimum and ±0.10 interval tolerance.

Approval accuracy, Brier score, log loss, and calibration are **not available**
for the current public approval output: the committed artifact contains zero
occurrence predictions, and the applicant branch is descriptive history because
its conditioned rate did not beat the unconditioned base rate. Status/stage
accuracy is likewise not applicable because those outputs describe observed
position rather than forecast terminal outcome. These nulls are part of the
baseline contract, not missing calculations.

The eight-case retained replay provides a small reproducibility set across
pre-certification, Community Board, CPC/public review, completed applications,
withdrawal, multiple action types, and ELURP. Its two scored historical timing
examples are an illustrative replay of the current materialized model, not a
second held-out training split; the machine report labels this explicitly.

## Freeze rule

`worker/src/lib/land_prediction_baseline.mjs` pins the contract to
`land_prediction_baseline_v1` and `zap_disposition_duration@1.0.0`. The regression
test `test/land_prediction_baseline.test.mjs` pins every representative cohort,
timing window, categorical status, stage, and ELURP clock outcome. Any future
predictor must run alongside this adapter and report separately; changing V2
code cannot silently change the baseline numbers.

Regenerate/check the report with:

```sh
node tools/build_land_prediction_baseline.mjs
node tools/build_land_prediction_baseline.mjs --check
node --test test/land_prediction_baseline.test.mjs
```
