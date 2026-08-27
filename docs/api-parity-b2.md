# API parity B2: Contracts Compare / Overview

This is the second Milestone B dogfood slice. It migrates the registered-contract
grouping in the static-first Contracts Recent Awards view at
`/browse/contracts/?mode=award` to the same `contracts.analysis@1` capability
used by the public HTTP and MCP adapters. B1 covered the People directory; this
slice is in the procurement domain.

## Before and after

Before, the Contracts page loaded the committed
`data/analytics_registered_contracts.json` projection and `site/analytical_projection.mjs`
performed filtering, grouping, measure selection, ranking, null-dimension labels,
and drill-through URL construction for the Overview list. The Worker’s public
`GET /contracts/analysis` and `analyze_contracts` MCP operation separately
implemented the same civic semantics. That was the duplicate meaning: external
consumers could request the analysis, but the first-party Overview did not use
the capability boundary that defined it.

After, `capabilities/contracts_analysis_provider.mjs` is the transport-neutral
provider for the bounded projection. The UI calls
`executeContractsAnalysis(createContractsAnalysisProvider(projection), input)`
and renders its ranked groups and capability-issued drill-through links. The
HTTP and MCP adapters use the same provider. The existing site analytical
helpers delegate their shared filtering, grouping, coverage, and drill-through
logic to that provider, preserving the rest of the analytical panels as
separate slices.

The public gap closed is first-party consumption of the documented grouped
Contracts analysis: an external caller and the Overview now invoke the same
capability semantics, including the explicit registered-contract measure,
population denominator, coverage envelope, exact contributing contract IDs,
and ordinary Contracts drill-through scope.

Direct browser HTTP is intentionally not used for this slice. The Overview
already has the complete published static projection and must remain usable
when the Worker or upstream publishers are unavailable. Calling the public
endpoint for every control change would add network availability and latency
dependencies without improving semantic parity. The browser uses the same
provider locally over the static snapshot; the public API retains its existing
cache policy (`public, max-age=60, s-maxage=300,
stale-while-revalidate=3600`).

## Observable equivalence and delivery measurements

The before and after artifacts were built from the parent revision and this
change, respectively, then loaded in headless Chromium at 390×844 and
1440×1000. The baseline and after screenshots are committed:

| Viewport | Baseline | After |
| --- | --- | --- |
| 390×844 | [before](screenshots/api-parity-b2-contracts/before-390.png) | [after](screenshots/api-parity-b2-contracts/after-390.png) |
| 1440×1000 | [before](screenshots/api-parity-b2-contracts/before-1440.png) | [after](screenshots/api-parity-b2-contracts/after-1440.png) |

The capture receipt is [here](screenshots/api-parity-b2-contracts/capture-receipt.json).

| Measure | 390×844 before | 390×844 after | 1440×1000 before | 1440×1000 after |
| --- | ---: | ---: | ---: | ---: |
| FCP | 2,044 ms | 2,084 ms | 2,092 ms | 2,092 ms |
| LCP | 2,984 ms | 2,624 ms | 2,092 ms | 2,092 ms |
| first three group labels/links | equal | equal | equal | equal |
| visible groups | 10 | 10 | 10 | 10 |
| static analytical snapshot fetch count | 1 | 1 | 1 | 1 |
| `/contracts/analysis` browser request count | 0 | 0 | 0 | 0 |

The capture aborts remote HTTPS requests, so the zero endpoint count also
proves graceful degradation: the Overview still renders from the static
projection and shared provider without public API or publisher access. The
population sentence remains `$104,947,948,439 current registered contract
value across 26,270 contracts · registration FY2025–FY2027`, and the first
three agency labels and exact drill-through URLs are byte-for-byte equivalent
in the receipt.

## Regression coverage

- `test/contracts_analysis_ui_capability.test.mjs` proves that the UI-facing
  projection and public capability return equivalent groups, values, counts,
  IDs, and drill-through semantics, and checks the static binding.
- `worker/test/contracts_analysis_capability.test.mjs` continues to prove
  HTTP/MCP byte-equivalent structured output and now asserts the public cache
  policy.
- `test/analytical_projection.test.mjs` retains the existing filtering,
  aggregation, coverage, timing, and provenance cases.
- `test/functional/29_procurement_analytical_projection_drillthrough.py` passes
  unchanged, covering cold URLs, group changes, drill-throughs, fact switching,
  and graceful incompatible-filter reporting.

Architecture reconciliation and the frozen canary backtest remain healthy;
the site module graph and built client-module asset checks also pass.
