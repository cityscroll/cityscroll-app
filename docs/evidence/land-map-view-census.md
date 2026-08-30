# Land default-corpus mapability census

This receipt measures how much of the current 40-row Land default snapshot can be placed with sources already retained in the repository. It does not ship a browse Map, change Land filters or watches, or acquire a new publisher.

## Bottom line

**29 of 40 projects (72.5 percent)** have at least one exact WH-06 BBL with a finite retained MapPLUTO centroid. **11 projects remain unmapped** and stay in the List denominator. No runtime geocoder, live GIS request, borough or district guess, neighboring parcel, or outcome-only point is counted as deterministic placement.

`29 / 40 = 72.5%`

Unmapped project ids: 2020M0385, 2020K0444, 2024Q0135, P2012X0048, 2020Q0317, 2023M0452, 2026K0123, 2024K0214, 2025M0252, 2025R0222, 2026K0233.

## Aggregation

| Quantity | Value |
| --- | ---: |
| Default Land projects (denominator) | 40 |
| Deterministically mapped | 29 |
| Unmapped | 11 |
| Exact-BBL projects | 35 |
| BBL occurrences | 278 |
| Unique BBL keys | 271 |
| Matched centroid occurrences | 227 |
| Unique centroid keys | 220 |
| single_bbl_centroid | 9 |
| multi_bbl_anchor | 20 |
| publisher_point | 0 |
| property_coordinate | 0 |
| geometry_representative_point | 0 |
| List snapshot bytes | 249323 |
| New publisher work | false |

Exact-BBL projects without a retained centroid: 2020M0385, 2020K0444, 2024Q0135, P2012X0048, 2020Q0317, 2023M0452.
Projects with no retained WH-06 BBL: 2026K0123, 2024K0214, 2025M0252, 2025R0222, 2026K0233.

## Specimens

- `2025K0305` is a positive multi-BBL case: 25 retained BBLs and 25 centroid matches, method `multi_bbl_anchor`. The census records those exact keys; it does not claim the later nearest-mean anchor resolver.
- `2026K0123` and `2025R0222` have no retained WH-06 BBL. A MapPLUTO canary BBL for another lookup, a district label, or an outcome coordinate must not mint a marker.

## Artifacts

| Artifact | Vintage / identity | SHA-256 |
| --- | --- | --- |
| `site/data/land_default_ulurp.json` | 2026-08-23T07:59:14.162Z | `3f60a1ac51f8e80ebec80d0895be41541174da5cadc80c1021bf8d7bcbdb9443` |
| `site/data/zap_bbl_warehouse_lookup.json` | 2026-08-05T10:41:38.120Z (WH-06, 2iga-a6mk) | `310a681d014bd31a5e18b5c567664615e204502c0f15dea1582dfd6f38955edf` |
| `site/data/bbl_mappluto_centroids_lookup.json` | 2026-08-18T03:13:42.683Z (mappluto_pluto_csv) | `236d627b8f34767d433f80ba3c60a381bc4189c04b77d64aa75a92becce3c426` |

Join version: `exact_project_id_wh06_bbl_mappluto_centroid_v1`. Rebuild with `node tools/build_land_mapability_census.mjs` or check the committed bytes with `node tools/build_land_mapability_census.mjs --check`.

## Forty-row table

| Project | Mapped | Method | Exact BBLs | Centroid keys | Missingness |
| --- | --- | --- | ---: | ---: | --- |
| `2020M0385` | no | unmapped | 2 | 0 | exact_bbl_missing_centroid |
| `2020K0444` | no | unmapped | 8 | 0 | exact_bbl_missing_centroid |
| `2024Q0135` | no | unmapped | 25 | 0 | exact_bbl_missing_centroid |
| `P2012X0048` | no | unmapped | 11 | 0 | exact_bbl_missing_centroid |
| `2020Q0317` | no | unmapped | 2 | 0 | exact_bbl_missing_centroid |
| `2023M0452` | no | unmapped | 1 | 0 | exact_bbl_missing_centroid |
| `2026R0127` | yes | single_bbl_centroid | 1 | 1 | — |
| `2025K0305` | yes | multi_bbl_anchor | 25 | 25 | — |
| `2026K0123` | no | unmapped | 0 | 0 | no_retained_bbl |
| `2024Q0325` | yes | multi_bbl_anchor | 12 | 12 | — |
| `2024K0214` | no | unmapped | 0 | 0 | no_retained_bbl |
| `2024M0244` | yes | multi_bbl_anchor | 8 | 8 | — |
| `2025M0338` | yes | multi_bbl_anchor | 6 | 6 | — |
| `2024K0358` | yes | multi_bbl_anchor | 2 | 2 | — |
| `2023M0213` | yes | multi_bbl_anchor | 7 | 7 | — |
| `2019K0383` | yes | multi_bbl_anchor | 6 | 6 | — |
| `2025K0287` | yes | single_bbl_centroid | 1 | 1 | — |
| `2025M0252` | no | unmapped | 0 | 0 | no_retained_bbl |
| `2024K0286` | yes | single_bbl_centroid | 1 | 1 | — |
| `2023M0116` | yes | single_bbl_centroid | 1 | 1 | — |
| `2024Q0219` | yes | multi_bbl_anchor | 12 | 12 | — |
| `2026R0186` | yes | single_bbl_centroid | 1 | 1 | — |
| `2025K0284` | yes | single_bbl_centroid | 1 | 1 | — |
| `2023X0149` | yes | multi_bbl_anchor | 12 | 12 | — |
| `2022K0416` | yes | multi_bbl_anchor | 6 | 6 | — |
| `2025Q0142` | yes | single_bbl_centroid | 1 | 1 | — |
| `2025Q0247` | yes | multi_bbl_anchor | 2 | 2 | — |
| `2025R0222` | no | unmapped | 0 | 0 | no_retained_bbl |
| `2025R0137` | yes | multi_bbl_anchor | 3 | 3 | — |
| `2025Q0316` | yes | multi_bbl_anchor | 25 | 25 | — |
| `2026Q0210` | yes | multi_bbl_anchor | 25 | 25 | — |
| `2025M0395` | yes | single_bbl_centroid | 1 | 1 | — |
| `2022K0430` | yes | multi_bbl_anchor | 25 | 23 | — |
| `2026K0233` | no | unmapped | 0 | 0 | no_retained_bbl |
| `2024K0196` | yes | multi_bbl_anchor | 5 | 5 | — |
| `2023Q0303` | yes | multi_bbl_anchor | 11 | 11 | — |
| `2025K0154` | yes | multi_bbl_anchor | 3 | 3 | — |
| `2024K0421` | yes | multi_bbl_anchor | 11 | 11 | — |
| `2022Q0449` | yes | multi_bbl_anchor | 14 | 14 | — |
| `2023K0183` | yes | single_bbl_centroid | 1 | 1 | — |

## Boundary

List continues to display all 40 current rows. A later Map may render only accepted points and must keep the unmapped count visible. This receipt does not decide whether Map becomes a default view.
