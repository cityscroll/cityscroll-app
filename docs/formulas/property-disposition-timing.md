# Property disposition timing (phase-duration ECDF)

## What it estimates

When a Property Disposition matter has a **hearing** but City Record has not yet published an **auction / RFP / sale** notice with a date, the disposition timeline can show a citywide cohort line:

> Predicted based on {N} Property Disposition auction notices since {YYYY} — when a sale date is published, it typically falls {W1}–{W2} weeks after the auction notice.

This is a **cohort statistic**, not a calendar deadline. The existing “soon ≤30 days” list rail remains the urgency device for *scheduled* auction dates; this line only fills the gap **before** a sale date is published.

## Method

- **Assertion type:** `cityscroll.prediction.v0` with `basis.method = phase_duration_ecdf`
- **Registered kinds:** `property.disposition_hearing` → `property.auction_or_rfp` (open → terminal)
- **Intended multi-stage pairs:** parcel-joined disposition spines (agency + BBL / borough+block+lot) that carry both a hearing and a later auction stage
- **Corpus reality (2026-08-03):** the City Record Property Disposition section holds **243** notices (2013–2026). Parcel-linked **hearing → auction** pairs in that window: **0**. Auction notices almost never carry extractable BBLs (6/69), so multi-stage joins do not form.
- **Fallback cohort (what ships):** within-notice lag from auction-notice **publication** (`start_date`) to **scheduled event** (`event_date`) among auction/RFP/sale notices that publish both — **n = 34**, citywide only (no agency cohort clears n ≥ 20)

Nearest-rank empirical quantiles on lag days; middle-half weeks are p25–p75 rounded to whole weeks for reader copy.

## Ship bar

Shared prediction calibration scorecard (`prediction_calibration_v1`):

| Check | Result on this corpus |
|---|---|
| ≥50 resolved backtest predictions | **fail** (multi-stage scoring pairs = 0) |
| Interval coverage within ±10 of 80% | **fail** (no resolved timing set) |
| Occurrence quintiles monotone | n/a (timing-only; treated as pass) |

**Public projection:** `cohort_statistic_only` — **no per-matter predicted dates**. That is the designed degradation for a thin section, not a silent model failure.

Evidence: `docs/evidence/property-disposition-timing/backtest.json`  
Model artifact: `site/data/property_disposition_timing_model.json`  
History fixture: `site/data/property_sources/property_disposition_history.json`

## What this is not

- Not a tax-lien-sale / private-property “seizure” risk model (separate domain; not registered here)
- Not a statutory clock (no Charter day math for disposition stages)
- Not a claim that an auction *will* follow every hearing — only a historical schedule width among published auction notices when multi-stage joins are unavailable

## Rebuild

```bash
node tools/build_property_disposition_timing.mjs
node tools/build_property_disposition_timing.mjs --check
```
