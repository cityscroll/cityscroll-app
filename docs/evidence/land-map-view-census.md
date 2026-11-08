# Land default-corpus mapability census

This receipt measures how much of the current 40-row Land default snapshot can be placed with sources already retained in the repository. It does not ship a browse Map, change Land filters or watches, or acquire a new publisher.

## Bottom line

**26 of 40 projects (65 percent)** have at least one exact WH-06 BBL with a finite retained MapPLUTO centroid. **14 projects remain unmapped** and stay in the List denominator. No runtime geocoder, live GIS request, borough or district guess, neighboring parcel, or outcome-only point is counted as deterministic placement.

`26 / 40 = 65%`

Unmapped project ids: 2023M0452, 2020Q0317, P2009K0185, 2020K0444, P2012X0048, 2024Q0135, 2026X0180, 2025M0399, 2024X0217, 2024M0148, 2026X0270, 2026Q0371, 2026K0322, 2025Q0494.

## Aggregation

| Quantity | Value |
| --- | ---: |
| Default Land projects (denominator) | 40 |
| Deterministically mapped | 26 |
| Unmapped | 14 |
| Exact-BBL projects | 32 |
| BBL occurrences | 220 |
| Unique BBL keys | 220 |
| Matched centroid occurrences | 170 |
| Unique centroid keys | 170 |
| single_bbl_centroid | 3 |
| multi_bbl_anchor | 23 |
| publisher_point | 0 |
| property_coordinate | 0 |
| geometry_representative_point | 0 |
| List snapshot bytes | 72409 |
| New publisher work | false |

Exact-BBL projects without a retained centroid: 2023M0452, 2020Q0317, P2009K0185, 2020K0444, P2012X0048, 2024Q0135.
Projects with no retained WH-06 BBL: 2026X0180, 2025M0399, 2024X0217, 2024M0148, 2026X0270, 2026Q0371, 2026K0322, 2025Q0494.

## Specimens

- `2025K0305` is a positive multi-BBL case: 25 retained BBLs and 25 centroid matches, method `multi_bbl_anchor`. The census records those exact keys; it does not claim the later nearest-mean anchor resolver.
- `2026K0123` and `2025R0222` have no retained WH-06 BBL. A MapPLUTO canary BBL for another lookup, a district label, or an outcome coordinate must not mint a marker.

## Artifacts

| Artifact | Vintage / identity | SHA-256 |
| --- | --- | --- |
| `site/data/land_default_ulurp.json` | 2026-11-08T14:14:11.560Z | `f8d8eb39d9455867b5877c385417f93966e8cc152f687fa97ce3d12e5228d7e7` |
| `site/data/zap_bbl_warehouse_lookup.json` | 2026-11-04T21:51:58.033Z (WH-06, 2iga-a6mk) | `715333f7271ac80079f2d3a4d0ac58b64c30256c7d4f84562855920441197410` |
| `site/data/bbl_mappluto_centroids_lookup.json` | 2026-10-09T18:54:04.150Z (mappluto_pluto_csv) | `d81945e19d2549be8ff619912c1c051238ee50ad6da4df677c93875dc35781c5` |

Join version: `exact_project_id_wh06_bbl_mappluto_centroid_v1`. Rebuild with `node tools/build_land_mapability_census.mjs` or check the committed bytes with `node tools/build_land_mapability_census.mjs --check`.

## Forty-row table

| Project | Mapped | Method | Exact BBLs | Centroid keys | Missingness |
| --- | --- | --- | ---: | ---: | --- |
| `2023M0452` | no | unmapped | 1 | 0 | exact_bbl_missing_centroid |
| `2020Q0317` | no | unmapped | 2 | 0 | exact_bbl_missing_centroid |
| `P2009K0185` | no | unmapped | 1 | 0 | exact_bbl_missing_centroid |
| `2020K0444` | no | unmapped | 8 | 0 | exact_bbl_missing_centroid |
| `2023Q0351` | yes | multi_bbl_anchor | 24 | 24 | — |
| `P2012X0048` | no | unmapped | 11 | 0 | exact_bbl_missing_centroid |
| `2024Q0135` | no | unmapped | 25 | 0 | exact_bbl_missing_centroid |
| `2026X0180` | no | unmapped | 0 | 0 | no_retained_bbl |
| `2025M0399` | no | unmapped | 0 | 0 | no_retained_bbl |
| `2024M0194` | yes | multi_bbl_anchor | 3 | 3 | — |
| `2023Q0177` | yes | multi_bbl_anchor | 5 | 5 | — |
| `2024X0217` | no | unmapped | 0 | 0 | no_retained_bbl |
| `2024M0148` | no | unmapped | 0 | 0 | no_retained_bbl |
| `2026X0270` | no | unmapped | 0 | 0 | no_retained_bbl |
| `2024M0193` | yes | multi_bbl_anchor | 3 | 3 | — |
| `2026Q0371` | no | unmapped | 0 | 0 | no_retained_bbl |
| `2022Q0214` | yes | multi_bbl_anchor | 14 | 14 | — |
| `2023K0400` | yes | multi_bbl_anchor | 4 | 4 | — |
| `2026Q0128` | yes | multi_bbl_anchor | 6 | 6 | — |
| `2022K0416` | yes | multi_bbl_anchor | 6 | 6 | — |
| `2026K0233` | yes | multi_bbl_anchor | 2 | 2 | — |
| `2023Q0125` | yes | single_bbl_centroid | 1 | 1 | — |
| `2022X0393` | yes | multi_bbl_anchor | 3 | 3 | — |
| `2024K0196` | yes | multi_bbl_anchor | 5 | 5 | — |
| `2025K0284` | yes | single_bbl_centroid | 1 | 1 | — |
| `2025Q0124` | yes | multi_bbl_anchor | 4 | 4 | — |
| `2025Q0247` | yes | multi_bbl_anchor | 2 | 2 | — |
| `2022K0430` | yes | multi_bbl_anchor | 25 | 23 | — |
| `2024K0240` | yes | multi_bbl_anchor | 7 | 7 | — |
| `2025K0306` | yes | multi_bbl_anchor | 3 | 3 | — |
| `2025K0470` | yes | single_bbl_centroid | 1 | 1 | — |
| `2026K0322` | no | unmapped | 0 | 0 | no_retained_bbl |
| `2023K0357` | yes | multi_bbl_anchor | 12 | 12 | — |
| `2025K0232` | yes | multi_bbl_anchor | 5 | 5 | — |
| `2025M0338` | yes | multi_bbl_anchor | 6 | 6 | — |
| `2025X0283` | yes | multi_bbl_anchor | 3 | 3 | — |
| `2024Q0325` | yes | multi_bbl_anchor | 12 | 12 | — |
| `2024Q0324` | yes | multi_bbl_anchor | 7 | 7 | — |
| `2022Q0160` | yes | multi_bbl_anchor | 8 | 8 | — |
| `2025Q0494` | no | unmapped | 0 | 0 | no_retained_bbl |

## Boundary

List continues to display all 40 current rows. A later Map may render only accepted points and must keep the unmapped count visible. This receipt does not decide whether Map becomes a default view.
