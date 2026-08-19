# Production RUM pilot

Bounded, reversible field-performance collection. This is observation only:
no thresholds, no paging, no SLO, and no PR-fail-on-percentile.

## Independent switches

| Switch | Production | Beta / preview | Rollback |
| --- | --- | --- | --- |
| Public collector contract `collector.production_enabled` | `true` | same generated file; browser host allowlist still excludes preview | set to `false` and regenerate projections |
| Worker `RUM_INGEST_ENABLED` | `"true"` in default `[vars]` | `"false"` in `[env.beta.vars]` | set production var to `"false"` and redeploy the Worker |

Either switch alone stops **new** writes. Historical Analytics Engine rows remain
queryable. Public navigation and `/stats` are unchanged.

Sampling is Cloudflare Analytics Engine weighted adaptive sampling
(`_sample_interval`). The pilot is 100 percent of **registered instrumented
pages**, not an unsampled 100 percent of every visitor row. The query adapter
uses `count()` for sufficiency and `sum(_sample_interval)` for estimated
population. Do not disable that weighting.

## Host and traffic exclusion

Browser collection and Worker intake both require a canonical production host:

- `cityscroll.org`
- `www.cityscroll.org`
- `cityscroll.pages.dev` (production Pages hostname)

Localhost, numbered preview `*.pages.dev` hosts, and `beta.cityscroll.org` are
excluded. Developer tokens (`X-CROL-Analytics-Dev`) still write no points.
Forbidden dimensions (visitor/session/device IDs, full URLs, raw search terms,
selectors, record IDs) remain intake rejections.

## End-to-end protocol

1. A registered production page loads `analytics.js`, which after `load` + idle
   imports `site/rum_bootstrap.mjs` only on a canonical host.
2. The bootstrap reads the generated manifest and `/data/performance-release.json`
   (stamped at Pages build from the deploy SHA). Missing release identity is a
   silent no-op.
3. Field vitals and buffered semantic readiness project into
   `cityscroll.performance_observation.v1` and POST `/performance-events`.
4. Intake writes one Analytics Engine point per observation into
   `crol_rum_observations_v1` when both switches are on.
5. `GET /admin/performance` (ADMIN_KEY) reads weighted percentiles through
   `worker/src/lib/performance_query.mjs`.
6. Desk at `desk.cityscroll.org/performance` consumes that private read model
   from `cityscroll-internal`. This repository proves the cityscroll-app side
   and pins the consumer contract at
   `data/rum-09-desk-contract-fixtures/desk-consumer-contract.v1.json`.

After merge and deploy, percentiles accumulate as live visitors generate
observations. The dashboard does not populate instantly.

## Prove rollback

```bash
node --test test/rum_pilot_rollout.test.mjs worker/test/rum_pilot_rollout.test.mjs \
  worker/test/performance_events.test.mjs worker/test/admin_performance.test.mjs
```

The pilot tests flip each switch independently and assert no residual writes.

Operator rollback: set `RUM_INGEST_ENABLED = "false"` in `worker/wrangler.toml`
and/or `collector_contract.production_enabled` to `false`, regenerate with
`node tools/build_performance_observability.mjs`, then deploy. Historical reads
stay available.

## Desk handoff

The public Worker contract is live. The authenticated Desk UI lives in
`cityscroll-internal` and is not exercised from this repository. After deploy,
operators should confirm `desk.cityscroll.org/performance` leaves the
"Performance telemetry is unavailable" empty state once retained sample counts
clear the floor.
