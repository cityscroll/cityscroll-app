# Bid Tabulations Historical (`9k82-ys7w`)

NYC Open Data Socrata dataset of competitive sealed bid openings: bidder names,
line-item prices, and bid numbers for historical CSB solicitations.

| Surface | URL |
|---|---|
| Catalog | https://data.cityofnewyork.us/d/9k82-ys7w |
| Resource API | https://data.cityofnewyork.us/resource/9k82-ys7w.json |

## Scope

- **Rows:** 57,704 line items across **945** distinct `bid_number` values.
- **Bid openings:** 2016-01-05 through 2021-03-24 (historical freeze).
- **Publisher last-modified:** 2023-09-16 (rows and resource headers).
- **No PIN/EPIN column.** Join keys are `bid_number`, `bid_title`, `bid_opening_date`.

## Product decision (measured)

Strict PIN↔`bid_number` joins (see `worker/src/lib/bid_tabulations_join.mjs`) fall
**below the ~30% usefulness threshold** for edge materialization on the product's
primary notice universe:

| Universe | Joined | Total | Rate |
|---|---:|---:|---:|
| City Record Procurement + PIN, `start_date` ≥ 2025-01-01 | 0 | 7,254 | **0%** |
| Same, `start_date` in [2016-01-01, 2022-01-01) | 2,158 | 23,804 | **9.07%** |
| Historical subset with PIN prefix `857*` (DCAS commodity) | 2,127 | 3,180 | 66.9% |

Receipts: `verification_receipts/bid_tabulations_historical_2026-07-30.json` and
the `join_measurement` block on source contract `bid-tabulations-historical`.

**Stop rule applied:** ship the measured reconnaissance and source contract; do
**not** materialize bid counts onto notice detail until a higher-coverage modern
source exists (or usefulness is re-measured above threshold).

## Join strategies

**Accepted:** `exact`, `agency_prefix_bid_suffix` (2–4 digit agency code + 7-digit
`bid_number`, including DCAS `857` + bid number).

**Rejected:** title-only uniqueness, loose digit containment, and other weak
matches that produced cross-year false positives in recon.
