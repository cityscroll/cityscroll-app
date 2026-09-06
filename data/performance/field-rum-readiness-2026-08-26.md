# Notice-context field RUM readiness

Grouped production read-back procedure and results for the `notice-context` primary
metric (`component_ready_ms`, surface `notice`, component `notice-context`). This is
the baseline and follow-up record cited by `docs/evidence/notice-context-readiness/README.md`
and `docs/evidence/notice-context-readiness/read-back.json`.

## Procedure

The read-back queries production RUM through the same bounded grammar the private
`/admin/performance` read model uses (`worker/src/lib/performance_query.mjs`,
`worker/src/admin_performance.mjs`): filter on `metric_id`, `surface_id`, and
`component_id`, request one of the fixed windows (`24h`/`7d`/`30d`/`90d`), and read
`sampled_count`, `window_complete`, and the weighted `p50`/`p75`/`p95` percentiles
Cloudflare Analytics Engine computes server-side. Analytics Engine never returns raw
per-request rows for this dataset — only the aggregate — so a read-back can only ever
report the aggregate, never reconstructed individual observations. A read-back is
retained as evidence only when the window is complete and at least 30 observations
are retained; otherwise it is recorded as `insufficient_sample`, never rounded up.

## 2026-08-19 – 2026-08-26 baseline

- Window: `2026-08-20T01:50:43Z` – `2026-08-26T13:10:50Z`
- Retained observations: 49
- p50 / p75 / p95: 5469.2 ms / 12601.6 ms / 21722.2 ms
- Predates the owner-readiness boundary change delivered in the pull request that
  made primary Notice-context readiness independent of optional enrichment work.
  Recorded as historical context only — not a pass for the p75 ≤ 2500 ms /
  p95 ≤ 5000 ms budget.

## 2026-09-06 production read-back (post-delivery)

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
