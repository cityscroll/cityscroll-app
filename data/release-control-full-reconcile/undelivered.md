# Release-control full reconcile — genuinely undelivered

Reconciled proposed cards in cityscroll-snappiness (`rum-*`),
cityscroll-capability-spine (`cs-03`–`cs-06`), cityscroll-comparative-intelligence
(`ci-*`), cityscroll-land-data-freshness, cityscroll-data-health (`dh-02`–`dh-07`),
cityscroll-geography-spine (`gs-03`), cityscroll-procurement-observability (`p5`),
and cityscroll-search-quality (`sq-08`) against current cityscroll-app main.

Promoted **31** cards to `implemented` with delivering PR (or scout commit)
links, realized After text, and checked acceptance. Already-implemented cards
in those workstreams were left as they were.

## Genuinely undelivered

### rum-09-desk-dashboard

cityscroll-app PR 1144 published `data/rum-09-desk-contract-fixtures/desk-consumer-contract.v1.json`,
which is the public-repo handoff fixture, not the Desk UI. Acceptance A1/A3
require an Access-authenticated performance area in `cityscroll-internal` that
renders percentiles and honest states through the rum-08 proxy. That dashboard
is not on cityscroll-app main and was not present to verify here.

### rum-13-instrument-stateful

No `test/rum_stateful_instrumentation.test.mjs` and no Following/Near You shell
versus settled-state instrumentation. Usage classification for those routes
still exists; catalog-valid stateful readiness does not.

### rum-14-pilot-rollout

Worker `RUM_INGEST_ENABLED` remains `"false"` in wrangler, and the public
collector manifest stays `production_enabled: false`. There is no documented
production-pilot run that traces accepted observations through weighted queries,
`/admin/performance`, and Desk, then disables both switches.

### rum-15-docs-handoff

Blocked on rum-14. Agents.md and `docs/performance-query-adapter.md` describe
shipped seams, but there is no single maintainer/operator handoff covering
registry extension, independent switch rollback, and deferred-governance
candidates as a fixture-backed procedure.

### land-keyword-live-soda-missfill

Land keyword search still has no hybrid SODA miss-fill when the publish loop
misses live ULURP canaries, and no timestamped hybrid as-of state for that path.
Warehouse lookup plus the freshness publish loop remain the shipped canary path.

## Already implemented (not in the remaining backlog)

These were already `status: implemented` before this pass, including land
freshness/ontology cards with PRs 1061–1104, dh-02 (#1112), dh-05 (#1113),
and rum-00 (scout, still without a cityscroll-app `pr:` because it is
production-no-op).
