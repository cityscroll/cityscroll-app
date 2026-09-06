# RUM-09 cross-repository Desk integration

This repository owns only the CityScroll Worker contract. The dashboard remains a separate deliverable in the local-only `cityscroll-internal` repository; no Desk UI belongs in the public CityScroll site.

## Exact Desk deliverable

Build a distinct private performance area in Desk against `cityscroll.admin.performance.v1` and this fixture bundle:

- Pin the CityScroll commit containing `desk-consumer-contract.v1.json`, its advertised reference response, edge-state matrix, and consumer acceptance test. Validate the pinned files in Desk CI; do not copy or recreate the CityScroll metric, surface, or component registry.
- From the Access-authenticated Desk Worker, fetch the upstream authenticated `/admin/ops-contract`, require a compatible ops-contract version, discover `performance.endpoint`, then proxy bounded requests to `/admin/performance` with the existing server-held upstream admin credential. Return `Cache-Control: private, no-store`. The browser must receive neither that credential nor Analytics Engine credentials, account identifiers, SQL, or arbitrary query controls.
- Add a distinct Desk navigation destination for performance. Render the overview, surface detail, phase decomposition, architecture coverage, and telemetry health projections declared by the consumer manifest. Drive labels, applicable metrics, lifecycle state, and architecture ownership from the response catalog.
- Render `insufficient_sample` as low sample, and keep `no_data`, `uninstrumented`, `unclassified`, `unavailable`, and partial retention/health visibly distinct. Missing percentiles or phases stay absent; never display a synthetic numeric zero.
- Cover the authenticated same-origin proxy, ops-contract discovery, schema validation, all five projections, every honest state, navigation, and the no-credential/no-copied-registry boundary with focused tests against the pinned CityScroll fixtures.
- Isolate any unrelated pre-existing Desk baseline failure when reporting validation; do not repair it in the public repository or count it as RUM-09 evidence.

Done means the private Desk implementation and its tests are committed in `cityscroll-internal`, while this public repository remains limited to the versioned contract, fixtures, discovery metadata, and acceptance tests.
