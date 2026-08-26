# Procurement analytical projection evidence

Population statement: **26,270 unique registered expense contracts, registration FY2025–FY2027; $104,947,948,439 current registered contract value.** Snapshot observed 2026-08-26T03:04:48Z. The population is the normalized Checkbook Contracts expense population, one row per exact `prime_contract_id`; the graph publication slice is not used for these rankings.

## Before / after captures

- Before, existing Contracts record list: `artifacts/procurement-analytical-projection/before-390.png` and `before-1440.png`.
- After, Contracts Compare / Overview with the population statement and ranked groups: `artifacts/procurement-analytical-projection/after-390.png` and `after-1440.png`.
- Agency-scope before/after: the DHS contract list is in `before-agency-390.png` and `before-agency-1440.png`; the ranked vendor projection is in `after-agency-390.png` and `after-agency-1440.png`.
- The after view is grouped by Agency and measured by Current registered contract value. Vendor grouping is available from the same control; an agency scope adds the vendor projection with top-5/top-10 shares and exact contract links.
- After, Registration timing view with the date-coverage headline and timing measures: `artifacts/procurement-analytical-projection/after-timing-390.png` and `after-timing-1440.png`.
- The after view is grouped by Agency and measured by Current registered contract value. Vendor grouping is available from the same control.

## Registration timing

The timing view defines `lag_days` as the published registration date minus the published contract start date. A positive lag is retroactive; zero or negative is early/on time. The rate denominator includes only contracts with both dates, while missing-date count and share remain visible beside it. In this committed snapshot, the source population publishes registration dates but no contract start dates, so the honest result is 0 eligible contracts and 26,270 missing-date contracts (100.0% missing coverage); no citywide rate is inferred from that gap.

The fixture proof covers before-start (−2 days), same-day (0), after-start (+11), and missing-start rows. Its independently computed SQL result matches the reader aggregation: 1 of 3 eligible contracts retroactive, with median lag 0 days, p75 11 days, and p90 11 days. Timing group links append `retroactive=true` to the ordinary Contracts route.

## AP-06 — City Record publication coverage

The coverage view uses the existing exact normalized Checkbook PIN ↔ City Record award-PIN join. It reports whether CityScroll found an exact matching award notice; it does not establish legal noncompliance. Contracts without a PIN remain a separately visible `cannot_evaluate_missing_pin` denominator failure.

- Before: `artifacts/procurement-city-record-coverage/before-390.png` and `before-1440.png`.
- After: `artifacts/procurement-city-record-coverage/after-390.png` and `after-1440.png`.
- Default threshold: registered value of $100,000 and over; the view can switch to all registered values and filter by registration FY and amount band.
- Coverage receipt: `artifacts/procurement-city-record-coverage/capture-receipt.json`.
- The current materialized population contains 12,382 eligible contracts over $100,000: 3,413 exact matches, 1,724 with no exact match, and 7,245 missing PINs. These are registered values, not actual spending.
- Every agency bucket links to the contributing Contracts rows; the no-match link carries the exact `ap_city_record_match=none` filter. The Department of Homeless Services path is covered by the functional browser test.

## Drill-through paths

These links open the ordinary Contracts route with exact analytical group filters; the list is filtered from the same precomputed population artifact.

- Department of Design and Construction — 904 contracts, $16,604,935,454 current registered contract value: `/browse/contracts/?mode=award&ap_agency=Department+of+Design+and+Construction`
- Department of Homeless Services — 373 contracts, $15,978,562,684 current registered contract value: `/browse/contracts/?mode=award&ap_agency=Department+of+Homeless+Services`
- Department of Environmental Protection — 575 contracts, $7,190,831,192 current registered contract value: `/browse/contracts/?mode=award&ap_agency=Department+of+Environmental+Protection`
- New York City Economic Development Corporation — 543 contracts, $4,679,887,526 current registered contract value: `/browse/contracts/?mode=award&ap_vendor=NEW+YORK+CITY+ECONOMIC+DEVELOPMENT+CORPORATION`

All amounts above are registered contract values, not actual spending or payment totals.

## AP-07 agency-scope proof

Department of Homeless Services: 373 contracts and **$15,978,562,684 current registered contract value** in the explicit selected-scope denominator. The top five named vendors account for **42.6%** ($6,807,021,842); the top ten account for **60.7%** ($9,700,344,493). Each named-vendor row exposes the vendor entity page and an exact agency+vendor Contracts link. Unclassified vendor value is shown as its own bucket when present; DHS has $0 unclassified value in this snapshot.

## Scope

This delivery extends AP-01 through AP-05 and AP-07: the versioned projection contract, Checkbook source-native dimension profile, population materialization, the Contracts Compare / Overview reader view, the Registration timing analytical view, and the versioned vendor-share calculation with agency-scoped vendor drill-through. AP-06 and AP-08 through AP-10 remain deferred future waves.
