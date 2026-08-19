# Field-performance query semantics

`worker/src/lib/performance_query.mjs` is the bounded read adapter for the separate
`crol_rum_observations_v1` Analytics Engine dataset. It is a Worker-only library. A later
authenticated `/admin/performance` read model may call it; Desk must never query Analytics Engine,
receive its credentials, or construct SQL.

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
queryable bounds, availability start, and `complete` or `partial` status. Partial-retention,
low-sample, no-data, invalid-provider, and unavailable results omit percentiles:

| State | Counts | Percentiles |
| --- | --- | --- |
| `available` | sampled + estimated | p50, p75, p95 |
| `insufficient_sample` | sampled + estimated + floor | omitted |
| `no_data` | omitted | omitted |
| `retention_partial` | retained counts when present | omitted |
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

The adapter also projects a bounded seven-day health view from the intake counters: accepted rows,
rejections by the closed reason vocabulary, unsupported schemas, developer/disabled/preview
exclusions, storage configured versus unavailable checks, latest accepted, latest query, and the
latest-accepted delay. Missing `ALERT_STATE` makes health explicitly unavailable; it does not turn
missing telemetry into zero performance.

Cloudflare documents a three-month retention period in the
[Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/#data-retention)
and recommends keeping the SQL API account ID and token in Worker configuration in its
[Worker querying guide](https://developers.cloudflare.com/analytics/analytics-engine/worker-querying/).
