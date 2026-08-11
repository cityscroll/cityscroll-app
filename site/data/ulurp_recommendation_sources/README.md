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

Usefulness is gated on the **recommendation-row** denominator (joinable catalog
rows), not ZAP-universe catalog coverage. Re-gated 2026-08-11:

| Universe | Joined | Total | Rate | Role |
|---|---:|---:|---:|---|
| Recommendation rows that hit a ZAP project | 80 | 91 | **87.91%** | **Gate** |
| PDF rows that hit a ZAP project | 73 | 88 | **82.95%** | Gate sibling |
| ZAP projects with non-null `ulurp_numbers` → either source | 152 | 27,971 | **0.54%** | Contrast only |
| Same → recommendations only | 81 | 27,971 | **0.29%** | Contrast only |
| Same → PDFs only | 71 | 27,971 | **0.25%** | Contrast only |

The catalogs are real but tiny absolute N (borough-scoped history). A sparse Land
panel mounts only on strict ULURP-token hits; misses omit the panel.

Receipts: `verification_receipts/ulurp_recommendations_2026-08-11.json` (ship),
`verification_receipts/ulurp_recommendations_2026-07-30.json` (historical contrast),
lookup `site/data/ulurp_recommendations_lookup.json`, panel
`site/ulurp_recommendation_panel.mjs`, gate policy `ontology/join_gate_policy.mjs`.

## Join strategies

**Accepted:** `exact_ulurp_token` — optional type letter + 6-digit body + letter
suffix, spaces optional (`C 210033 ZMK` ↔ `C210033ZMK` ↔ `210033ZMK`).

**Rejected:** bare 6-digit body without suffix (cross-action collisions),
title/project-name only, and Property Disposition notice sampling as a coverage
metric.
