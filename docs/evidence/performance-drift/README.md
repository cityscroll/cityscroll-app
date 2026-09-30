# Notice post-delivery read-back aggregate

## What this is

A retained production aggregate for the three Notice measurement groups that the
post-delivery letters require:

| Measurement group | Population | Metrics |
| --- | --- | --- |
| `cold_module_path` | resident (`traffic_class=production`) | `component_ready_ms` / `content_ready_ms` on surface `notice` |
| `first_byte` | resident | `ttfb_ms` on `notice`, plus same-window `home` comparison |
| `synthetic` | synthetic probe | `content_ready_ms` / `component_ready_ms` on surface `notice` |

Each group carries its own delivery (or first probe slot) anchor, observation
window, sample count per percentile, and sufficiency. Groups are never combined
into one distribution.

The machine-readable file is
[`notice-readback-aggregate.json`](./notice-readback-aggregate.json)
(`schema`: `cityscroll.notice_readback_aggregate.v1`).

## Regenerate

```bash
ANALYTICS_ACCOUNT_ID=<from worker/wrangler.toml> \
ANALYTICS_READ_TOKEN=<Cloudflare API token with Analytics Engine read> \
RUM_ANALYTICS_DATASET=crol_rum_observations_v1 \
RUM_MEASURED_SINCE=2026-08-19 \
RUM_MIN_SAMPLED_ROWS=30 \
node tools/build_notice_readback_aggregate.mjs
```

Validate the committed file without contacting production:

```bash
node tools/build_notice_readback_aggregate.mjs --check
```

The builder reads each group through the same bounded RUM grammar
`tools/read_rum_drift.mjs` uses (`tools/read_rum_measurement_group.mjs` →
`worker/src/lib/performance_query.mjs`). Credentials are not stored in this
directory.

## Sample floor

A group clears the floor only when every metric it names retains at least 30
observations inside a complete window that begins at or after that group's own
delivery anchor. Below-floor groups withhold percentiles.
