# Notice edge response

The Notice document is produced at the edge, one record per response. This
directory records how that response is produced, what the retained production
measurements can say about how long it takes, and — as carefully — what they
cannot say.

This change claims no latency improvement. The production read-back that will
measure one is open and pending in
[`data/performance/field-rum-readiness-2026-08-26.md`](../../../data/performance/field-rum-readiness-2026-08-26.md).

Measure it at any commit:

```bash
node tools/measure_notice_edge_response.mjs           # every terminal
node tools/measure_notice_edge_response.mjs --json    # the same report, machine-readable
node tools/measure_notice_edge_response.mjs --check   # committed ceilings
node tools/build_notice_edge_response_evidence.mjs    # refresh read-back.json
```

The tool runs the real handler from `site/pages_edge.mjs` against an
instrumented environment, so the handler stays the single owner of what a Notice
response fetches. `read-back.json` reads its field figures out of the committed
production read-backs rather than restating them.

## What the document's cache actually is

The leading explanation for the Notice surface's slower first byte was the
document's edge cache hit rate. That rate does not exist.

`site/_routes.json` lists `/notices/*`, so every request for a Notice document
invokes the Pages function rather than returning a stored object, and nothing in
the serving path reads or writes the Cache API. The document therefore has no
edge cache entry to hit or miss: its outcome is `dynamic` on every request by
construction, not a rate that varies. The `Cache-Control` directive the response
carries is honored by the browser and by any cache downstream of the edge; it is
not an instruction the serving path caches against.

The cache that does exist on this path belongs to the **record subrequest** —
the read of one record, held for a day — and the platform reports its outcome
back to the function. That outcome is now carried on the response, so the
question "did this response wait on a cache that did not answer?" has an answer
per response instead of an inference.

For the record: the directive on a produced Notice document is
`public, max-age=60, s-maxage=86400, stale-while-revalidate=604800,
stale-if-error=604800`, and a document that could not be produced carries the
60-second variant. Both come from the handler and are asserted in
`test/notice_edge_response.test.mjs`.

## How the response reports itself

`site/notice_edge_response.mjs` owns the vocabulary. The response carries a
`Server-Timing` header with three metrics:

| Metric | What it is |
| --- | --- |
| `cs-doc` | the function's own wall time producing the document, with the document's cache outcome |
| `cs-record` | the record read, with the outcome the platform reported for its cache |
| `cs-assets` | the resident reads that run alongside it |

Cache outcomes are drawn from a closed set — `hit`, `miss`, `stale`, `dynamic`,
`unknown` — and an absent or unrecognized platform status stays `unknown` rather
than being read as any of the four. The header carries durations and tokens
only: no record id, no reader, nothing derived from one. No new identity is
introduced anywhere, and the observation contract is unchanged.

## The response path, measured

Measured with `node tools/measure_notice_edge_response.mjs` on this change and
on the default branch it was cut from (`8a2fba61b`). A "dependent stage" is a
subrequest that could not begin until an earlier one had settled; subrequests
issued together share a stage.

| Terminal | Status | Subrequests | Dependent stages before | Dependent stages after |
| --- | ---: | ---: | ---: | ---: |
| Record available | 200 | 4 | 2 | 1 |
| Record absent | 404 | 4 | 2 | 1 |
| Record unavailable | 503 | 5 | 3 | 2 |

The record read depends on nothing the three resident reads produce — only on
the requested id — but it was queued behind them, so every Notice response
walked one round trip it did not need. It is now issued alongside them. The
subrequest count, the status, and the cache directive are unchanged on every
terminal; only the depth of the chain is one shorter.

The remaining second stage on the unavailable terminal is real: the public-source
degradation path runs only when the record read has already failed, so it cannot
be started earlier without fetching it on responses that never need it.

`architecture/notice-edge-response-budget.json` holds the ceilings. Reintroducing
a serial stage, or adding a subrequest to a terminal, fails
`node tools/measure_notice_edge_response.mjs --check` and
`test/notice_edge_response.test.mjs`.

## What this cannot settle

Named here rather than estimated into a total:

- **Time spent rendering inside the isolate.** The edge clock advances on
  subrequest boundaries, so the header's durations measure time spent waiting on
  subrequests. Isolate work is not separable from them.
- **A document edge cache hit rate.** There is no document-level cache entry on
  this path, so there is no rate. This is a property of the serving path, not a
  gap in the measurement.
- **Which devices the field percentiles came from.** See below.
- **The record cache's hit rate.** Its outcome is now carried on the response,
  but no production window has been read back since. Pending, not zero.

## The first-byte figures, and the sample behind them

From the seven-day production read-back in
[`../field-coverage-lattice-read-back/read-back.json`](../field-coverage-lattice-read-back/read-back.json)
(window `2026-08-30T13:38:21Z` – `2026-09-06T13:38:21Z`, production traffic):

| Surface | p50 | p75 | p95 | Retained rows | Rows in the p95 tail |
| --- | ---: | ---: | ---: | ---: | ---: |
| Notice | 250.7 ms | 683.0 ms | 2,012.1 ms | 100 | ~5 |
| Home | 61.5 ms | 184.3 ms | 544.5 ms | 150 | ~8 |

Both windows clear the 30-observation floor, but the floor applies to the
distribution, not to the tail: each 95th percentile above rests on a handful of
observations and moves materially when any one of them moves.

**The first byte's share of the readiness tail is not derivable.** Over the same
window the Notice surface's content-ready 95th percentile is 7,109.1 ms and its
first-byte 95th percentile is 2,012.1 ms, but those two numbers cannot be
subtracted. A percentile of one phase and a percentile of the whole are computed
over different rows, and the retained aggregate never exposes the rows, so how
much of the readiness tail the first byte owns is not something production
currently retains an answer to.

**How many devices contributed is not retained.** Two limits stack. The
observation contract carries a coarse device class and no device, session, or
reader identifier, so the number of distinct devices behind any percentile is
not a retained quantity for any metric. And the read-back builds its device
dimension for the readiness metrics only, so the first-byte figures have no
breakdown even by coarse class. Neither is estimated here.

## Two artifacts, one tail, a six-percent difference

Two committed artifacts measure `component_ready_ms` on surface `notice`,
component `notice-context`, over overlapping windows on the same day, and report
different 95th percentiles:

| Artifact | Window selection | Retained rows | p95 | Carries a budget |
| --- | --- | ---: | ---: | --- |
| [`../notice-context-readiness/read-back.json`](../notice-context-readiness/read-back.json) | delivery-anchored | 79 | 8,484.3 ms | yes |
| [`../field-coverage-lattice-read-back/read-back.json`](../field-coverage-lattice-read-back/read-back.json) | fixed rolling `7d` | 85 | 8,001.9 ms | no |

**The selection rule that differs is the window anchor.** The readiness artifact
opens its window at the delivery merge and closes it at the latest retained
observation, so it admits only post-delivery observations. The lattice read-back
uses the fixed seven-day bucket ending at query time, which starts about
fourteen hours earlier and ends about an hour later. That window strictly
contains the delivery-anchored one, so it also admits observations from before
the delivery — six more retained rows in total.

A second source of difference cannot be removed: Cloudflare assigns a sampling
weight per retained row, so two queries over overlapping windows retain their own
rows and differ even where the windows agree. Analytics Engine returns the
aggregate and never the retained rows, so the two sources cannot be apportioned
from what is retained. The window anchor is the identifiable difference; the
sampling is the irreducible one.

**The gate reads the delivery-anchored artifact.**
`site/notice_context_readiness.mjs` is what classifies a window against the
p75 ≤ 2,500 ms and p95 ≤ 5,000 ms budget, and
`node tools/build_notice_context_readiness_evidence.mjs --check` is what enforces
it. The lattice read-back carries no budget and states no SLO: it answers a
coverage question — which cells of the lattice have a sufficient sample — not a
budget one. Neither figure is wrong, and neither supersedes the other.
