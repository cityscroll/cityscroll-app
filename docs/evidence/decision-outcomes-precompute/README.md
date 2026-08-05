# Decision-outcome first-paint timing

The prior Land detail path waited for a cold `GET /zap-outcomes` response before it could replace
“Loading decision documents and outcomes…”. The route-level regression test records cold responses
of 12–17 seconds in `test/functional/20_demo_links.py`.

The replacement contract measures the interval from a dispatched Zoning-tab activation to the DOM
mutation that adds either a precomputed outcome or an explicit honest-absent state. It runs after the
current view is interaction-ready, with one warmup and 20 measured samples per viewport.

| Viewport | Before | After p95 | Budget | Result |
|---|---:|---:|---:|---|
| Mobile | 12–17 s cold path | 58.575 ms | 1,200 ms | Pass |
| Desktop | 12–17 s cold path | 61.970 ms | 1,200 ms | Pass |

Raw samples and invariant results are in `performance-results.json`. Reproduce with:

```bash
python3 test/performance/verify.py \
  --fixture land.outcomes-first-paint \
  --site-root site \
  --samples 20 \
  --output docs/evidence/decision-outcomes-precompute/performance-results.json
```
