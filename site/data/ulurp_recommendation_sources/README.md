# ULURP Recommendations (Borough President positions + PDF companion)

NYC Open Data publishes two small Borough President ULURP recommendation tables.
Neither is citywide or current enough to cover ZAP projects with ULURP numbers.

| Surface | Dataset | Rows | Catalog |
|---|---|---:|---|
| Borough President recommendations (Brooklyn-scoped) | `4j6i-9rmr` | 91 | https://data.cityofnewyork.us/d/4j6i-9rmr |
| ULURP recommendation PDFs | `gt5i-dmde` | 88 | https://data.cityofnewyork.us/d/gt5i-dmde |

Resource APIs:

- https://data.cityofnewyork.us/resource/4j6i-9rmr.json
- https://data.cityofnewyork.us/resource/gt5i-dmde.json

## Scope

- **Join key:** ULURP application number tokens shared with ZAP Open Data
  `hgx4-8ukb` field `ulurp_numbers` (already ingested for land outcomes).
- **4j6i-9rmr fields:** `ulurp_number_s`, `borough_president`, `recommendation_date`,
  `community_board_s`, `council_district_s`, `ulurp_application_name`.
- **gt5i-dmde fields:** `ulurp_application_number`, `pdf_download`, `date`, `project`.
- **Publisher freeze:** recommendation table Last-Modified 2021-06-29; PDF table
  Last-Modified 2018-01-25.
- **Not the Property Disposition notice universe.** Property Disposition samples
  do not join ZAP and must not be used as a success metric for this source.

## Product decision (measured)

Strict ULURP-token joins (see `worker/src/lib/ulurp_recommendations_join.mjs`) fall
**below the ~30% usefulness threshold** for edge materialization on the land-use
product universe:

| Universe | Joined | Total | Rate |
|---|---:|---:|---:|
| ZAP projects with non-null `ulurp_numbers` → recommendations **or** PDFs | 152 | 27,971 | **0.54%** |
| Same → recommendations only (`4j6i-9rmr`) | 81 | 27,971 | **0.29%** |
| Same → PDFs only (`gt5i-dmde`) | 71 | 27,971 | **0.25%** |

Reverse coverage (recommendation/PDF rows that hit some ZAP project) is high
(~88% / ~83%): the catalogs are real but tiny absolute N, mostly completed
Brooklyn/Manhattan history.

Receipts: `verification_receipts/ulurp_recommendations_2026-07-30.json` and the
`join_measurement` blocks on source contracts `ulurp-recommendations` and
`ulurp-recommendation-pdfs`.

**Stop rule applied:** ship the measured reconnaissance and disabled source
contracts; do **not** edge-materialize Borough President recommendation panels onto
land/ZAP outcomes until a higher-coverage citywide source exists (or usefulness is
re-measured above threshold). Keep the existing class-(a) land-outcome pointer
(ZAP decision documents).

## Join strategies

**Accepted:** `exact_ulurp_token` — optional type letter + 6-digit body + letter
suffix, spaces optional (`C 210033 ZMK` ↔ `C210033ZMK` ↔ `210033ZMK`).

**Rejected:** bare 6-digit body without suffix (cross-action collisions),
title/project-name only, and Property Disposition notice sampling as a coverage
metric.
