# Field coverage honesty — production read-back

## What this is

A seven-day production coverage lattice for the six target surfaces, both
readiness metrics, device subgroups, and the four attribution phases. The
lattice keeps missing and below-floor groups visible as explicit states instead
of letting an absent sample look like a healthy result.

## Window

| Field | Value |
| --- | --- |
| Queried at (UTC) | 2026-09-06T13:38:21.834Z |
| Window | 2026-08-30T13:38:21.000Z → 2026-09-06T13:38:21.000Z |
| Window status | complete |
| Traffic class | production |
| Sample floor | 30 retained rows |
| Retained readiness rows | 555 |

## Result

Every target surface has an explicit readiness state for both
`content_ready_ms` and `component_ready_ms`. Near You and Agency remain
`no_data` (zero retained readiness rows). Percentiles are present only on
`measured` cells; every `insufficient_sample` and `no_data` cell withholds
them.

Attribution phases stay distinguishable in this window:

| Phase | Observed states |
| --- | --- |
| route-import | all `no_data` |
| response | mix of `measured`, `insufficient_sample`, and `no_data` |
| owner-settlement | all `no_data` |
| semantic-readiness | mix of `measured` and `no_data` |

Page-level readiness cells that clear the floor (measured values):

| Surface | Metric | sampled_count | p75 ms | p95 ms |
| --- | --- | ---: | ---: | ---: |
| Home | `content_ready_ms` | 89 | 1325.2 | 2426.5 |
| Following | `content_ready_ms` | 54 | 1680.4 | 3274.2 |
| Browse Contracts | `content_ready_ms` | 48 | 3039.3 | 7615.4 |
| Notice | `content_ready_ms` | 93 | 3411.0 | 7109.1 |
| Near You | `content_ready_ms` | 0 | — | — (`no_data`) |
| Agency | `content_ready_ms` | 0 | — | — (`no_data`) |

Mobile and other below-floor device subgroups remain `insufficient_sample` with
percentiles withheld; they are not treated as passes.

## Method

```bash
ANALYTICS_ACCOUNT_ID=<from worker/wrangler.toml> \
ANALYTICS_READ_TOKEN=<from the logged-in wrangler OAuth session> \
RUM_ANALYTICS_DATASET=crol_rum_observations_v1 \
RUM_MEASURED_SINCE=2026-08-19 \
RUM_MIN_SAMPLED_ROWS=30 \
node tools/read_rum_drift.mjs --out <output-dir>
```

`tools/read_rum_drift.mjs` requests the production coverage lattice through
`worker/src/lib/performance_query.mjs` and classifies each cell with
`worker/src/lib/performance_coverage.mjs`. The machine-readable lattice and
acceptance checks are in `read-back.json`. Credentials are not stored in this
directory.
