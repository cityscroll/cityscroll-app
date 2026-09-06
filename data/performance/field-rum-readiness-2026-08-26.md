# Field RUM readiness

Grouped production read-back procedure and results for field readiness
metrics. Each surface keeps its own section below.

## Shared procedure

The read-back queries production RUM through the same bounded grammar the
private `/admin/performance` read model uses (`worker/src/lib/performance_query.mjs`,
`worker/src/admin_performance.mjs`): filter on `metric_id`, `surface_id`, and
`component_id`, request one of the fixed windows (`24h`/`7d`/`30d`/`90d`), and
read `sampled_count`, window completeness, and the weighted `p50`/`p75`/`p95`
percentiles Cloudflare Analytics Engine computes server-side. Analytics Engine
never returns raw per-request rows for this dataset — only the aggregate — so a
read-back can only ever report the aggregate, never reconstructed individual
observations.

The repository entry point used for these measurements is:

```bash
ANALYTICS_ACCOUNT_ID=<from worker/wrangler.toml> \
ANALYTICS_READ_TOKEN=<from the logged-in wrangler OAuth session> \
RUM_ANALYTICS_DATASET=crol_rum_observations_v1 \
RUM_MEASURED_SINCE=2026-08-19 \
RUM_MIN_SAMPLED_ROWS=30 \
node tools/read_rum_drift.mjs --out <output-dir>
```

A read-back is retained as evidence only when the window is complete and at
least 30 observations are retained; otherwise it is recorded as
`insufficient_sample`, never rounded up to a pass. Measured values are labeled
measured; estimates stay estimates.

## Notice-context

Primary metric: `component_ready_ms`, surface `notice`, component
`notice-context`. Cited by `docs/evidence/notice-context-readiness/README.md`
and `docs/evidence/notice-context-readiness/read-back.json`.

### 2026-08-19 – 2026-08-26 baseline

- Window: `2026-08-20T01:50:43Z` – `2026-08-26T13:10:50Z`
- Retained observations: 49
- p50 / p75 / p95: 5469.2 ms / 12601.6 ms / 21722.2 ms
- Predates the owner-readiness boundary change delivered in the pull request that
  made primary Notice-context readiness independent of optional enrichment work.
  Recorded as historical context only — not a pass for the p75 ≤ 2500 ms /
  p95 ≤ 5000 ms budget.

### 2026-09-06 production read-back (post-delivery)

- Window: `2026-08-31T03:51:05Z` (delivery merge) – `2026-09-06T12:46:28Z` (latest
  retained observation), a complete window per the same coverage check the private
  read model uses.
- Retained observations: 79 (≥ the 30-observation floor)
- p50 / p75 / p95: 2754.8 ms / 3620.0 ms / 8484.3 ms
- Result: `needs-work`. The delivered change materially shortened the tail relative
  to the August baseline (p75 −71%, p95 −61%), but production has not yet reached the
  p75 ≤ 2500 ms / p95 ≤ 5000 ms budget.
- This is the first production window with a sufficient, complete sample since
  delivery; prior windows checked immediately after delivery were below the
  30-observation floor.

Evidence: `docs/evidence/notice-context-readiness/read-back.json`, built from
`test/fixtures/notice-context-readiness/read-back-input.json` via
`node tools/build_notice_context_readiness_evidence.mjs`.

### Open read-back: Notice cold module path (pending)

Opened by the change that moved the five lens module groups off the Notice
route's cold module chain. That change claims no latency improvement; this
read-back is where the effect on the budget is measured.

- Status: **pending**. Not yet evaluated, and not a pass or a failure.
- Delivered for review: `2026-09-06`. The measurement window opens at the
  delivery merge commit, not at this date.
- Metrics to read, exactly as identified in production:
  - `component_ready_ms`, surface `notice`, component `notice-context` — the
    primary Notice-context readiness group.
  - `content_ready_ms`, surface `notice`, component `none` — the Notice
    primary content-ready group.
- Window length: one complete `7d` window measured from the delivery merge,
  using the shared procedure above.
- Sufficiency: the 30-observation floor applies. A window below the floor is
  recorded as `insufficient_sample` and the percentiles are withheld.
- Budget to evaluate against: p75 ≤ 2500 ms and p95 ≤ 5000 ms, unchanged.
- Comparison point: the `2026-09-06` post-delivery read-back above
  (`component_ready_ms`: p50 2754.8 ms / p75 3620.0 ms / p95 8484.3 ms over 79
  retained observations).
- Delivery-time module measurements for the same change are in
  `docs/evidence/notice-cold-path/README.md`. They are a static measurement of
  the module graph, not a latency claim.

Due once the change has been live in production for one complete window. The
evaluation belongs to this read-back rather than to the change that opened it.

## Browse Contracts

Page-level content readiness: `content_ready_ms`, surface `browse-contracts`,
component `none`. Cited by
`docs/evidence/browse-contracts-first-page-read-back/README.md` and
`docs/evidence/browse-contracts-first-page-read-back/read-back.json`.

### Pre-intervention field snapshot

- Retained observations: 68
- p50 / p75 / p95: 1809.5 ms / 3264.1 ms / 9622.0 ms
- Cited as the Browse Contracts field distribution before the bounded
  first-page delivery. Historical context only — not a pass for the
  p75 ≤ 2500 ms / p95 ≤ 5000 ms budget.

### 2026-09-06 production read-back (post-delivery)

- Queried at: `2026-09-06T14:10:07.421Z`
- Window: `2026-08-30T14:10:07.000Z` – `2026-09-06T14:10:07.000Z` (complete
  seven-day window)
- Retained observations: 48 (≥ the 30-observation floor)
- p50 / p75 / p95: 2241.4 ms / 3039.3 ms / 7615.4 ms
- Result: `needs-work`. The sample floor is met, but production has not yet
  reached the p75 ≤ 2500 ms / p95 ≤ 5000 ms budget.
- Post-delivery-only window since the delivery merge
  (`2026-09-05T21:09:25Z` – `2026-09-06T14:10:07Z`): 4 retained observations —
  `insufficient_sample`; percentiles withheld.

Evidence: `docs/evidence/browse-contracts-first-page-read-back/read-back.json`.
