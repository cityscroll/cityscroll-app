# Field-performance query semantics

`worker/src/lib/performance_query.mjs` is the bounded read adapter for the separate
`crol_rum_observations_v1` Analytics Engine dataset. It is a Worker-only library. A later
authenticated `/admin/performance` read model may call it; Desk must never query Analytics Engine,
receive its credentials, or construct SQL.

Maintainer and operator procedures — registry extension, privacy, troubleshooting, Desk, rollback,
and deferred governance — live in [`docs/rum-observatory.md`](rum-observatory.md).

## Stored columns

The adapter reads the normalized point written by `worker/src/performance_events.mjs`:

| Column | Meaning |
| --- | --- |
| `blob1` | `cityscroll.performance_observation.v1` schema |
| `blob2`–`blob4` | metric, surface, component |
| `blob5` | unit |
| `blob6`–`blob9` | device, navigation, delivery, result state |
| `blob10` | traffic class; queries require `production` |
| `blob11`–`blob13` | collector, manifest, bounded release |
| `double1` | the numeric metric observation |
| `index1` | metric + surface + component sampling index |

The query grammar accepts only the `24h`, `7d`, `30d`, and `90d` windows and the registered filter
values for metric, surface, component, device, navigation, delivery, result state, and release. A
query must filter one metric or group by metric, because combining latency and score metrics into a
single distribution would be meaningless. At most one reviewed grouping dimension is allowed.
Release is filter-only, so a long deployment history cannot create an unbounded grouping. Summary
results are capped at 64 groups, and daily rows at 64 × 91 plus one overflow canary. An overflow is
an unavailable result, never a silently truncated distribution.

## Adaptive sampling

Cloudflare Analytics Engine applies weighted adaptive sampling at write time and may choose another
resolution at query time. `_sample_interval` belongs to each retained row and can vary within one
result. It is the inverse sampling rate: a retained row with interval 100 represents an estimated
100 underlying observations. Consequently:

- `sampled_count = count()` is the number of retained rows that support the distribution.
- `estimated_count = sum(_sample_interval)` estimates the underlying observation population.
- p50, p75, and p95 use
  `quantileExactWeighted(q)(double1, _sample_interval)`.

The configurable `RUM_MIN_SAMPLED_ROWS` floor (default 30, accepted range 1–10,000) is applied to
`sampled_count`, not `estimated_count`. A large estimated population represented by only a few
retained rows does not provide a sufficiently supported distribution. This deliberately does not
reuse usage analytics' `sum(_sample_interval * double1)` count-total formula: `double1` is a latency
or score here, not a count of events. Cloudflare likewise documents per-row weighting for
[adaptive sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/) and the
[`quantileExactWeighted` aggregate](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/aggregate-functions/#quantileexactweighted).

`sampled_count` and `estimated_count` are estimates with different meanings; neither is a unique
visitor count. No confidence interval is claimed. Percentiles describe the provider-weighted sample
and must be interpreted alongside the sample floor, metric scope, selected dimensions, and window.

## Windows, trends, and honest states

Current and previous intervals are equal-duration, half-open UTC windows fixed from one query clock:
`[now-window, now)` and `[now-2×window, now-window)`. Trends use UTC calendar-day buckets overlapping
the exact current interval, so a rolling 7-day interval can touch eight dates. A missing day is
`no_data`; it is not emitted with zero percentiles.

Analytics Engine retains data for three months; this adapter uses a bounded 90-day retention model
and also honors `RUM_MEASURED_SINCE`. Each requested interval declares its requested bounds,
queryable bounds, availability start, and `complete` or `partial` status. Low-sample, no-data,
invalid-provider, and unavailable results omit percentiles. A partial window still emits an
`available` current distribution when its retained sample floor is met; the partial coverage remains
explicit in `retention.current.status`:

| State | Counts | Percentiles |
| --- | --- | --- |
| `available` | sampled + estimated | p50, p75, p95 |
| `insufficient_sample` | sampled + estimated + floor | omitted |
| `no_data` | omitted | omitted |
| `retention_partial` | retained counts when present | omitted when below sample floor |
| `unavailable` | omitted | omitted |

A measured numeric zero remains a valid observation and can therefore be a percentile. Absence is
represented by state and omission, never by a fabricated zero. Comparison deltas are returned only
when both equal windows have available distributions. The 90-day current window can be complete,
but its preceding 90-day comparison is outside retention and is explicitly partial.

## Availability, freshness, and health

Missing account/token configuration, SQL failures, malformed provider rows, and cardinality overflow
produce a versioned `unavailable` result without counts or percentiles. Successful reads record a
best-effort `rum:health:latest-query` timestamp. Freshness reports the latest retained observation and
its age only when one exists.

The read configuration is deliberately diagnosed without exposing credentials: `missing-account-id`,
`invalid-account-id`, and `missing-read-token` are returned in the private `read_path` receipt. The
worker deploy workflow reuses the existing account deployment token for the
`ANALYTICS_READ_TOKEN` binding explicitly. A missing binding remains `unavailable`, never an empty
dataset.

The admin response keeps the existing `series` contract and adds `coarse_summary`, whose rows contain
only metric, dimensions, p50/p75/p95 when a retained distribution is available, retained
`sampled_count`, latest observation time, and one operational status. A query whose requested window
starts before `RUM_MEASURED_SINCE` keeps `retention.current.status=partial`, while the response remains
`status=available` when retained distributions are readable. Those rows report
`operational_status=flowing` and their percentiles are calculated over the available interval. This
keeps a healthy live path distinct from an unavailable read path while preserving the coverage caveat.
`implementation_status=code_complete` describes the registered code path; `operational_status=flowing`
is reserved for retained observations. The other operational states are `no_data`,
`insufficient_sample`, `uninstrumented`, and `unavailable`.

The opt-in live chain proof is `test/functional/rum_performance_e2e.py`. It uses Playwright to load
real public pages, waits for their normal collector lifecycle, reads fresh retained rows through the
authenticated API with `CROL_PERF_ADMIN_URL`/`CROL_PERF_ADMIN_KEY`, and opens the Access-authenticated
Desk view with `CROL_ACCESS_SERVICE_TOKEN_FILE`. Intercepted beacon requests are diagnostic only;
read-back is the acceptance signal. It writes only ignored local evidence and never posts synthetic
observations.

The Analytics Engine SQL uses ClickHouse's `%i` minute formatter (rather than `%M`, which emits a
month name in this dialect) so the returned observation timestamps remain parseable ISO-8601 values.

The adapter also projects a bounded seven-day health view from the intake counters: accepted rows,
rejections by the closed reason vocabulary, unsupported schemas, developer/disabled/preview
exclusions, storage configured versus unavailable checks, latest accepted, latest query, and the
latest-accepted delay. Missing `ALERT_STATE` makes health explicitly unavailable; it does not turn
missing telemetry into zero performance.

Cloudflare documents a three-month retention period in the
[Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/#data-retention)
and recommends keeping the SQL API account ID and token in Worker configuration in its
[Worker querying guide](https://developers.cloudflare.com/analytics/analytics-engine/worker-querying/).
