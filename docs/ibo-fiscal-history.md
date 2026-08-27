# IBO fiscal-history source contract

This warehouse source retains the two Excel files linked from IBO's [New York City Fiscal History](https://ns2.ibo.nyc.ny.us/fiscalhistory.html) page. The page describes the files as Excel data tables for spending and staffing. The direct files are checkpointed under `warehouse/sources/ibo-fiscal-history/`; their hashes, retrieval timestamp, and source metadata are in `source_manifest.json`.

## Publisher artifacts

| Workbook | Canonical download | Vintage and coverage | Selected sheet | Publisher unit / definition |
| --- | --- | --- | --- | --- |
| Agency Expenditures | `https://ns2.ibo.nyc.ny.us/RevenueSpending/AgencyExpenditures.xlsx` | FY1980–FY2022; the IBO FY2022 update was announced June 4, 2023 | `In $000's` (the workbook also contains `DETAIL`) | Thousands of US dollars; Personal Services, Other Than Personal Services, intra-city deduction, prior-year adjustments, and total department expenditures |
| Actual Full-Time Positions | `https://ns2.ibo.nyc.ny.us/RevenueSpending/FullTimePositions.xlsx` | FY1980–FY2022; the IBO FY2022 update was announced June 4, 2023 | `ALL FUNDS` | Actual full-time positions reported as of June 30 for each year |

The legacy `www.ibo.nyc.ny.us` hyperlinks are retained in the manifest as `published_link_url`. As retrieved on 2026-08-27, those hyperlinks redirected to the IBO content shell while the `ns2` URLs served the XLSX bytes. The `ns2` URL is therefore the checkpoint's canonical download URL.

New York City's fiscal year begins July 1 and ends June 30; the year label is the calendar year in which it ends. The current workbook files stop at FY2022. No FY2023 or later number is inferred.

## Expenditure semantics

The selected expenditure sheet is explicitly named `In $000's`, so `value` in the materialization is in `USD_thousands`. `value_in_usd` is a derived convenience value and carries an explicit factor of 1,000 plus a `derived_explicit_conversion` status. The raw cell spelling is retained for auditability.

Each ordinary agency block has five publisher rows: `Personal Services`, `Other Than Personal Services`, `less: intra-city`, `prior year adjustments`, and `TOTAL DEPT.`. IBO's [fiscal-history methodology note](https://www.ibo.nyc.ny.us/iboreports/CityRevenueandSpending.pdf) describes Personal Services as wages and salaries of agency employees and OTPS as other expenses, including contractual labor. It also explains that agency totals net intra-city funds and prior-year adjustments. The materialization retains all five rows; it does not recompute the publisher's total from PS and OTPS.

The final `Citywide` block is retained as `citywide_reconciliation` records, including `Total Citywide Expenditures`, `Interfund Agreements`, and `Total Citywide Expenditures, less Interfund Agreements`. The receipt compares the sum of ordinary `TOTAL DEPT.` rows with the publisher citywide total. Citywide records are not assigned a canonical agency.

## Staffing semantics

The staffing workbook's title is `Actual Full-Time Positions`, its cell A2 says `(reported as of June 30th for each year)`, and its source note names the Office of Management and Budget. This is a point-in-time fiscal-year-end positions measure, not an annual average. It is not relabeled as active employees or authorized positions: the workbook does not establish either of those meanings. IBO's [fiscal-history methodology note](https://www.ibo.nyc.ny.us/iboreports/CityRevenueandSpending.pdf) says part-time and seasonal workers are not shown, and warns that Personal Services expenditures can include them, so staffing and PS are not treated as interchangeable denominators.

The staffing rows include components such as DOE pedagogical/non-pedagogical, Police uniform/civilian/transit/housing, Fire uniform/civilian/EMS, Correction uniform/civilian, and Sanitation uniform/civilian. Those source rows remain separate. The ingestion does not silently merge them into a parent agency or sum overlapping components. The publisher's `Total` row is retained as the staffing reconciliation measure.

Blank cells are null observations, while numeric zero is preserved as zero. For example, the Veterans' Services row has values only for its published later-year span. The parser recognizes publisher missing/suppressed markers and numeric cells with currency, comma, parentheses, or footnote formatting without discarding the original spelling; any other non-empty non-numeric cell fails the run.

## Identity and execution

Source labels are resolved by `site/agency_identity.mjs`, the same shared agency identity surface used by the product. A label is classified as `exact`, `alias`, or `unresolved`; unmatched labels preserve the source spelling and do not receive a guessed ID. Existing alias/successor surfaces remain explicit in that shared module. Historical component, defunct, and aggregate labels remain unresolved or aggregate unless the shared identity contract explicitly establishes continuity.

Run the ingestion from the repository root with the checkpointed manifest:

```sh
warehouse/.venv/bin/python warehouse/scripts/ibo_fiscal_history.py \
  --manifest warehouse/sources/ibo-fiscal-history/source_manifest.json \
  --output-dir warehouse/sources/ibo-fiscal-history/materialized \
  --duckdb warehouse/duckdb/cityscroll.duckdb
```

The run writes deterministic `observations.jsonl`, `observations.csv`, and `receipt.json`. It validates workbook hashes, selected sheets, label anchors, and the exact expected year headers before writing. The DuckDB table is `ibo_fiscal_history`; the committed CSV/JSONL remain the inspectable materialization, while the catalog is local warehouse state.
