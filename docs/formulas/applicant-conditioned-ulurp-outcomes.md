# Applicant-conditioned ULURP outcome rates

Method: **entity-resolved applicant base rate** (`cityscroll.prediction.v0` claim
`occurrence`, basis method `base_rate`), always shown with the unconditioned
action-type/borough rate from the same zoning cohort engine.

## Inputs

- NYC Open Data ZAP Project Data (`hgx4-8ukb`)
- ZAP project action statuses (when cached) for approved / modified / disapproved
- Entity resolution: agency preferred alias (including common ZAP acronyms) or
  vendor stem on `primary_applicant`

## Cohort rule

- Group terminal projects by resolved applicant entity
- Require **n ≥ 20** approved + modified + disapproved outcomes
- Below the floor, no conditioned rate is rendered

## Rate

\[
P(\mathrm{approved} \mid \mathrm{applicant}) =
\frac{n_{\mathrm{approved}}}{n_{\mathrm{approved}}+n_{\mathrm{modified}}+n_{\mathrm{disapproved}}}
\]

Withdrawals and administrative terminations are excluded from the denominator.

## Presentation

- Unconditioned base rate is always shown alongside the conditioned rate
- One-line attribution:

  > Based on {N} applications by this applicant since {YYYY}: {P}% approved, vs {P0}% overall.

- Public link confidence bands: strong / tentative

## Backtest

Time-split Brier comparison of conditioned P(approved) versus the unconditioned
base rate on holdout dispositions. If conditioning does not beat the base rate
out of sample, `public_projection` is `descriptive_history` (history only; no
predictive occurrence emission).

## False-positive modes

1. **Entity-resolution mislinks** — distinct applicants collapsed onto one stem,
   or one firm split across stems
2. **Small-cohort noise** at the n=20 floor
3. **Era effects** — practice or policy shifts between the training window and a
   live application

## Artifacts

- `site/data/zoning_statistics.json` → `applicant_conditioning`
- Formula surface: `about.html#applicant-conditioned-ulurp`
