# Bounded identifier arrays — corpus recording

Schema: `cityscroll.research_response_bounds.recording.v1`  
Machine-readable twin: [`bounded-identifier-arrays.json`](./bounded-identifier-arrays.json)

This recording re-runs the research Contracts analysis read against the committed
registered-contract projection and retains the sizes that close the remaining
fixture gaps after the response-bound delivery.

## Corpus

| Field | Value |
| --- | --- |
| Projection | `site/data/analytics_registered_contracts.json` |
| Vintage | snapshot `2026-09-09`, generated `2026-09-09T06:33:01.880Z` |
| Rows | 26,846 |
| Research budget | 65,536 bytes (64 KiB) |

## Largest group in the corpus

The largest agency group by registration count is **Department of Education**
(7,717 identifiers). At the maximum sample of 50, the MCP tool result is
**10,412 bytes**, under the budget, with no full identifier arrays and with the
response `identifier_note` naming the sample field so the bound is visible in
the payload.

## Demonstrated Health Department cases

These are the cases that failed the first evaluation attempt.

| Case | Identifiers | After (bounded) | Before (diagnosed turn) | Turn completes |
| --- | ---: | ---: | ---: | --- |
| Health Department, all years | 1,821 | 8,116 bytes | 644,929 bytes | yes |
| Health Department, fiscal year 2026 | 806 | 8,227 bytes | 644,929 bytes | yes |

The diagnosed before size is the tool output from the failing turn. Rebuilding
the same unbounded shape against the committed projection — unfiltered agency
analysis with `identifiers=full` and limit 100 — measures **642,928 bytes**
across 69 groups and 26,846 identifiers, confirming the failure class rather
than a one-off measurement.

## Proof

- `worker/test/research_response_corpus_bounds.test.mjs` re-runs both letters
  against the committed projection and checks this recording stays honest.
- Shared research limits live in `capabilities/research_response_limits.mjs`.
- Owner contract notes live in [`docs/research-response-bounds.md`](../../research-response-bounds.md).
