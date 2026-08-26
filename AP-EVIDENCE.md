# Procurement analytical projection evidence

Population statement: **26,270 unique registered expense contracts, registration FY2025–FY2027; $104,947,948,439 current registered contract value.** Snapshot observed 2026-08-26T03:04:48Z. The population is the normalized Checkbook Contracts expense population, one row per exact `prime_contract_id`; the graph publication slice is not used for these rankings.

## Before / after captures

- Before, existing Contracts record list: `artifacts/procurement-analytical-projection/before-390.png` and `before-1440.png`.
- After, Contracts Compare / Overview with the population statement and ranked groups: `artifacts/procurement-analytical-projection/after-390.png` and `after-1440.png`.
- The after view is grouped by Agency and measured by Current registered contract value. Vendor grouping is available from the same control.

## Drill-through paths

These links open the ordinary Contracts route with exact analytical group filters; the list is filtered from the same precomputed population artifact.

- Department of Design and Construction — 904 contracts, $16,604,935,454 current registered contract value: `/browse/contracts/?mode=award&ap_agency=Department+of+Design+and+Construction`
- Department of Homeless Services — 373 contracts, $15,978,562,684 current registered contract value: `/browse/contracts/?mode=award&ap_agency=Department+of+Homeless+Services`
- Department of Environmental Protection — 575 contracts, $7,190,831,192 current registered contract value: `/browse/contracts/?mode=award&ap_agency=Department+of+Environmental+Protection`
- New York City Economic Development Corporation — 543 contracts, $4,679,887,526 current registered contract value: `/browse/contracts/?mode=award&ap_vendor=NEW+YORK+CITY+ECONOMIC+DEVELOPMENT+CORPORATION`

All amounts above are registered contract values, not actual spending or payment totals.

## Scope

This delivery covers AP-01 through AP-04: the versioned projection contract, Checkbook source-native dimension profile, population materialization, and the Contracts Compare / Overview reader view. AP-05 through AP-10 remain deferred future waves.
