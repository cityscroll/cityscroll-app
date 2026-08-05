# Land completion-order residual characterization

Characterized 2026-08-05 against the 11 `completion_order_violation` rows in
`land-stage-coherence-census.json` and the source-linked ZAP project payloads.
The census contains 11 rows across 10 projects because `2024K0286` contributes
two comparisons.

## Result

No reader-facing lifecycle defect was found. Ten rows are benign publisher
history: ZAP runs and re-runs filing and CEQR workflows in parallel, so their
placement beside each other in the display spine does not establish a strict
completion dependency. The remaining row is an audit defect: it treated a
borough-president hearing date as the completion date even though the source
publishes the actual borough-president milestone completion later.

The audit now excludes only those two proven cases. Strict ordering checks from
certification through public review remain active, and a regression test proves
that a borough-president milestone completed before a community-board milestone
still reports a violation. The reader timeline is unchanged and continues to
show every source event and date.

## Per-record evidence

All milestone dates below are the source `actual_end` selected by the existing
materializer. The disposition row states its distinct date basis explicitly.
Each ZAP API link exposes the cited source identifiers and fields; the portal
link is the corresponding public reader page.

| Project and evidence | Census comparison | Source identifiers | Classification | Finding |
|---|---|---|---|---|
| `2020M0385` · [API](https://zap-api-production.herokuapp.com/projects/2020M0385) · [portal](https://zap.planning.nyc.gov/projects/2020M0385) | Filing 2024-03-21; CEQR 2022-08-08 | Filing `5b0991a3-d74d-ea11-a9ac-001dd83080ab`; CEQR `d9a91e7d-d6af-ea11-a812-001dd8309c75` | Source history | The project contains repeated filing and CEQR cycles; the first CEQR completion predates a later filing completion. |
| `2020K0444` · [API](https://zap-api-production.herokuapp.com/projects/2020K0444) · [portal](https://zap.planning.nyc.gov/projects/2020K0444) | Filing 2024-02-08; CEQR 2023-08-29 | Filing `0928b087-4ba8-eb11-b1ac-001dd804ad8f`; CEQR `b91c05f9-58a8-eb11-b1ac-001dd804ad8f` | Source history | Multiple filing and CEQR cycles interleave through 2025; the earliest completions are not a single linear pass. |
| `2022K0419` · [API](https://zap-api-production.herokuapp.com/projects/2022K0419) · [portal](https://zap.planning.nyc.gov/projects/2022K0419) | Filing 2026-04-17; CEQR 2026-02-13 | Filing `63b70dc4-ca80-ef11-a670-001dd809b68c`; CEQR `16d2094e-fe14-ee11-8f6d-001dd809c825` | Source history | Filing began 2025-11-24 and CEQR began 2025-12-08, but CEQR closed first; completion order does not encode start order for overlapping workflows. |
| `2024R0332` · [API](https://zap-api-production.herokuapp.com/projects/2024R0332) · [portal](https://zap.planning.nyc.gov/projects/2024R0332) | Filing 2026-04-17; CEQR 2025-12-17 | Filing `da1892d3-74ab-ef11-b8e9-001dd809b68c`; CEQR `5fc161d2-39ee-ef11-be20-001dd8004b19` | Source history | Three completed CEQR prepare/review cycles precede the cited filing completion. |
| `2023X0347` · [API](https://zap-api-production.herokuapp.com/projects/2023X0347) · [portal](https://zap.planning.nyc.gov/projects/2023X0347) | Filing 2025-10-06; CEQR 2025-09-19 | Filing `e2e93d36-9252-f011-877a-001dd80a67c9`; CEQR `409a5f9c-110c-f011-bae3-001dd80a67c9` | Source history | Repeated filing rows continue into 2026 while the first CEQR cycle overlaps them. |
| `2022K0302` · [API](https://zap-api-production.herokuapp.com/projects/2022K0302) · [portal](https://zap.planning.nyc.gov/projects/2022K0302) | Filing 2024-04-30; CEQR 2023-08-09 | Filing `00108101-3c7a-ec11-8940-001dd804d9bc`; CEQR `9cf84678-b6aa-ec11-b3fe-001dd804d73e` | Source history | The payload contains several later filing and CEQR cycles; earliest completion is not a stage dependency. |
| `2023Q0315` · [API](https://zap-api-production.herokuapp.com/projects/2023Q0315) · [portal](https://zap.planning.nyc.gov/projects/2023Q0315) | Filing 2024-08-09; CEQR 2024-06-12 | Filing `f90a5f9f-3aae-ed11-aad1-001dd806a702`; CEQR `e8a331f4-9884-ee11-8179-001dd804e43e` | Source history | Numerous later filing and CEQR re-filings interleave through 2025. |
| `2024K0286` · [API](https://zap-api-production.herokuapp.com/projects/2024K0286) · [portal](https://zap.planning.nyc.gov/projects/2024K0286) | Filing 2025-10-17; CEQR 2025-10-16 | Filing `fb9fa42e-c831-f011-8c4e-001dd80a67c9`; CEQR `babd9e72-5f24-f011-998a-001dd806295a` | Source history | One-day completion overlap is followed by repeated filing and CEQR cycles through February 2026. |
| `2024K0286` · [API](https://zap-api-production.herokuapp.com/projects/2024K0286) · [portal](https://zap.planning.nyc.gov/projects/2024K0286) | Community board 2026-04-14; borough president 2026-04-13 | Community-board vote `987f36a1-43bb-f011-bbd2-001dd8089923` + `bc7f36a1-43bb-f011-bbd2-001dd8089923`; borough-president hearing `1f5d4dad-43bb-f011-bbd3-001dd80f20e8` + `405d4dad-43bb-f011-bbd3-001dd80f20e8`; borough-president completion `0d029778-5f24-f011-998a-001dd806295a` (2026-05-16) | Audit defect | The April 13 value is `hearing_date`, not a vote or completion. The audit incorrectly promoted it to a terminal completion; the source milestone completed May 16. |
| `2024Q0164` · [API](https://zap-api-production.herokuapp.com/projects/2024Q0164) · [portal](https://zap.planning.nyc.gov/projects/2024Q0164) | Filing 2025-05-05; CEQR 2025-01-15 | Filing `7cc620ec-8059-ee11-be6e-001dd804eec0`; CEQR `ad2482d4-c66e-ee11-8def-001dd804e43e` | Source history | Repeated filing and CEQR cycles interleave through January 2026. |
| `2025K0219` · [API](https://zap-api-production.herokuapp.com/projects/2025K0219) · [portal](https://zap.planning.nyc.gov/projects/2025K0219) | Filing 2025-07-22; CEQR 2025-05-06 | Filing `5137227e-e6cd-ef11-b8e9-001dd809b68c`; CEQR `b57636d8-10d8-ef11-8eea-001dd809d9d4` | Source history | Repeated filing and CEQR cycles interleave through November 2025. |

## Classification totals

| Class | Rows | Product action |
|---|---:|---|
| Publisher re-filing / parallel history | 10 | Exclude only the filing-to-CEQR pair from strict completion-order checks; preserve all events. |
| Equal-date ambiguity | 0 | None. |
| True source stage-order anomaly | 0 | None. |
| Audit/materializer defect | 1 | Do not treat a disposition `hearing_date` as terminal completion evidence. |
| Stale flag from an already-fixed path | 0 | None. |
