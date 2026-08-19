# RUM observatory maintainer and operator handoff

This is the single durable handoff for CityScroll field-performance observability
(rum-01 through rum-15). It tells a maintainer how to extend the registry, how
an operator reads honest states, and which governance work is still deferred.

The observatory measures how long real public pages take to become usable. It
does not enforce speed. There is no SLO, no paging, no PR-fail-on-percentile,
and no automatic rollback on a percentile.

Live collection switches, host allowlist, and the end-to-end production trace
live in [`docs/rum-production-pilot.md`](rum-production-pilot.md) when that
RUM-14 protocol is present. Query SQL and sampling semantics live in
[`docs/performance-query-adapter.md`](performance-query-adapter.md). This page
does not replace those contracts.

Reproduce every procedure against committed fixtures:

```bash
node tools/rum_observatory_handoff.mjs --check
node --test test/rum_observatory_handoff.test.mjs
```

## Metric semantics

The versioned catalog is the `metrics` array in
[`architecture/performance-observability.v1.json`](../architecture/performance-observability.v1.json).
Validate with `node --test test/performance_metric_catalog.test.mjs`.

Commissioned field vitals: `ttfb_ms`, `fcp_ms`, `lcp_ms`, `cls_score`, `inp_ms`.
Derived load phases: `response_to_first_render_ms`, `first_render_to_main_ms`,
`main_to_useful_ms`. Semantic readiness: `content_ready_ms`,
`component_ready_ms`. Interaction: `interaction_feedback_ms`,
`interaction_settled_ms`, `feedback_to_settled_ms`.

A numeric value, including `0`, exists only for `state=measured`. Unsupported,
backgrounded, missing, or no-interaction cases are omitted. Synthetic harness
zeros are absence, not a field measurement. Do not add a speed threshold or a
usage-analytics field to this catalog.

## Semantic milestones

Component owners report ordered readiness through
[`site/rum_semantic_milestones.mjs`](../site/rum_semantic_milestones.mjs).
Terminal result states are closed: `content`, `empty`, `unavailable`, `error`.
Feedback must precede settlement. DOM selectors, record IDs, URLs, and query
text stay out of the milestone record. Focused proof:
`test/rum_semantic_milestones.test.mjs`.

Owner slices:

| Slice | Owner | Proof |
| --- | --- | --- |
| Home and notice | `site/rum_static_record_instrumentation.mjs` | `test/rum_static_record_instrumentation.test.mjs` |
| Contracts browse | `site/contracts_rum.mjs` | `test/rum_browse_search_instrumentation.test.mjs` |
| Map, entity, async | `site/rum_maps_entities_async_instrumentation.mjs` | `test/rum_maps_entities_async_instrumentation.test.mjs` |
| Following | `site/rum_stateful_instrumentation.mjs` | `test/rum_stateful_instrumentation.test.mjs` |

## Register a new component

One canonical edit:
[`architecture/performance-observability.v1.json`](../architecture/performance-observability.v1.json).
Do not hand-edit generated projections.

1. Add one `components[]` row with a stable kebab-case `component_id`, a
   `semantic_marker` matcher, a real `owner_source_path`, and
   `projections: ["browser", "worker", "operator"]`.
2. Rebuild and check:

   ```bash
   node tools/build_performance_observability.mjs
   node tools/build_performance_observability.mjs --check
   ```

3. Confirm the three generated projections share one `registry_hash`:
   [`site/data/performance-classification-manifest.v1.json`](../site/data/performance-classification-manifest.v1.json),
   [`worker/src/data/performance-validation-allowlist.v1.json`](../worker/src/data/performance-validation-allowlist.v1.json),
   [`worker/src/data/performance-operator-labels.v1.json`](../worker/src/data/performance-operator-labels.v1.json).
4. Instrument the owner module through the semantic milestone API. Keep
   synthetic performance green. Do not map an unknown route to Home or Browse.

In-memory proof of that one-edit propagation (does not write the production
registry):

```bash
node tools/rum_observatory_handoff.mjs --procedure new-instrumentation
```

Compatibility: aliases and supersedes preserve renamed identity; unknown
pathnames stay unclassified; the browser projection must omit
`operator_label`, `owner_source_path`, `architecture_container_ref`,
`definition`, and `reason`.

## Privacy rejection boundary

Intake is strict `POST /performance-events` in
[`worker/src/performance_events.mjs`](../worker/src/performance_events.mjs).
Unknown keys reject the batch. Usage analytics still strips unknown keys; RUM
must not reuse that normalizer.

Forbidden fields (any of these, including nested or camelCase variants, is
`forbidden_key`): account, account_id, ad_id, advertising_id, attribution,
correlation_id, css_path, css_selector, device_id, dom_path, dom_text, entries,
entity_id, error, exception, geolocation, hash, href, id, interaction_target,
ip, latitude, longitude, navigation_url, notice_id, parcel_id, path, pathname,
project_id, query, record_id, referrer, resource_url, screen_height,
screen_width, search, search_term, selector, session_id, subscription_id,
target, text, token, url, user_agent, vendor_id, visitor, visitor_id.

Public versus private:

- Public HTML never receives Analytics Engine credentials, SQL, or operator labels.
- `GET /admin/performance` is `ADMIN_KEY` with `Cache-Control: private, no-store`.
- Public `/stats` and `/admin/stats` stay usage and corpus surfaces.
- Desk reads the Worker contract only.

```bash
node tools/rum_observatory_handoff.mjs --procedure privacy-audit
```

## Sampling, retention, and honest states

Cloudflare Analytics Engine applies weighted adaptive sampling. Sufficiency
uses retained `count()`, not `sum(_sample_interval)`. Percentiles use
`quantileExactWeighted`. Neither count is a unique-visitor figure. No
confidence interval is claimed. Details:
[`docs/performance-query-adapter.md`](performance-query-adapter.md).

Retention is a bounded 90-day adapter model on top of the provider's
approximately three-month store. A window that starts before availability is
`retention_partial` and omits percentiles.

| State | Percentiles | Meaning |
| --- | --- | --- |
| `available` | present | Retained-row floor met |
| `insufficient_sample` | omitted | Too few retained rows |
| `no_data` | omitted | Instrumented, no observations |
| `uninstrumented` | omitted | Registered, not yet instrumented |
| `unclassified` | omitted | Unknown surface or component |
| `partial` | omitted | Retention or health incomplete |
| `unavailable` | omitted | Credentials, SQL, or overflow |

Absence is state and omission, never a fabricated zero. A measured numeric
zero can be a percentile.

## Query troubleshooting

```bash
node tools/rum_observatory_handoff.mjs --procedure query-troubleshooting
```

Walk the committed weighted fixture and the Desk state matrix:

1. Confirm the SQL uses `count()`, `sum(_sample_interval)`, and
   `quantileExactWeighted` — never the usage formula
   `sum(_sample_interval * double1)`.
2. If percentiles are missing, read `status` before assuming a zero.
3. `insufficient_sample` with a large `estimated_count` still withholds
   percentiles. Wait for more retained rows.
4. `uninstrumented` is a registry/instrumentation gap; `no_data` is an empty
   window on an instrumented selection.
5. `unclassified` means intake rejected an unknown id. Register it.
6. `unavailable` is operator configuration, not a product empty state.

## Desk contract

The public-repo handoff is
[`data/rum-09-desk-contract-fixtures/desk-consumer-contract.v1.json`](../data/rum-09-desk-contract-fixtures/desk-consumer-contract.v1.json).
Desk discovers `performance.endpoint` from authenticated
`GET /admin/ops-contract`, then proxies bounded `/admin/performance` requests.
The dashboard belongs in `cityscroll-internal`, never under public `site/`.

```bash
node tools/rum_observatory_handoff.mjs --procedure desk-contract
```

## Independent switches and rollback

Two independent switches gate new writes:

| Switch | Off | Effect |
| --- | --- | --- |
| `collector.production_enabled` | `false`, then regenerate projections | Browser collection does not emit |
| Worker `RUM_INGEST_ENABLED` | `"false"`, then redeploy the Worker | Intake writes no Analytics Engine points |

Either switch alone stops **new** writes. Historical rows remain queryable.
Public navigation and `/stats` stay unchanged. This is not data deletion, not
a percentile-triggered revert, and not merge enforcement.

```bash
node tools/rum_observatory_handoff.mjs --procedure rollback
```

When the RUM-14 protocol is present, also follow
[`docs/rum-production-pilot.md`](rum-production-pilot.md) and
`test/rum_pilot_rollout.test.mjs`.

## Known limitations

- Adaptive sampling means percentiles describe the provider-weighted sample,
  not every page view.
- 90-day comparison against an older window is explicitly partial.
- Unclassified future routes are advisory architecture coverage, never hard
  `observer_coverage.unmapped_surfaces` drift.
- The synthetic p95 budget harness in `test/performance` is a CI fixture. It
  is not field RUM and must not be merged into the field distribution.
- Desk UI freshness depends on live retained rows after deploy; the dashboard
  does not populate instantly.

## Deferred governance candidates

These remain candidates only. Do not implement them in this observatory.

```bash
node tools/rum_observatory_handoff.mjs --procedure deferred-governance
```

| ID | Candidate | Why later |
| --- | --- | --- |
| field-percentile-baselines | Field percentile baselines | Samples are not yet a reviewed baseline |
| slos | SLOs | Observation is not yet a target |
| alerts-paging | Alerts and paging | Commissioning is not an on-call product |
| synthetic-rum-compare | Synthetic versus field comparison | Different questions; merging hides missingness |
| merge-enforcement | Merge-queue field-RUM enforcement | Filling samples must not block product work |
| automatic-rollback | Automatic rollback on percentiles | Rollback is a manual independent switch |

## Procedure commands

| Procedure | Command |
| --- | --- |
| new-instrumentation | `node tools/rum_observatory_handoff.mjs --procedure new-instrumentation` |
| query-troubleshooting | `node tools/rum_observatory_handoff.mjs --procedure query-troubleshooting` |
| desk-contract | `node tools/rum_observatory_handoff.mjs --procedure desk-contract` |
| privacy-audit | `node tools/rum_observatory_handoff.mjs --procedure privacy-audit` |
| rollback | `node tools/rum_observatory_handoff.mjs --procedure rollback` |
| deferred-governance | `node tools/rum_observatory_handoff.mjs --procedure deferred-governance` |
| all + links | `node tools/rum_observatory_handoff.mjs --check` |
