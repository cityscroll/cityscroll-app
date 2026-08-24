# ADR: Bounded ranked D1 keyword candidates

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-23 |
| Scope | Worker keyword-family retrieval from the D1 read model |
| Related | `worker/src/lib/search_read_model.mjs`, `worker/src/search.mjs`, `worker/migrations/0025_search_and_ocp_read_models.sql`, `worker/src/lib/notices.mjs` |

## Context

The Worker keyword-family read model stores searchable documents in a D1
FTS5 table and keeps the public exact-token and offset evidence contract in
`site/keyword_matcher.mjs`. The previous family query used FTS `MATCH` but
materialized up to 20,000 `document_json` values in ordinal order. High-
frequency terms such as `award` therefore transferred tens of megabytes before
the canonical matcher discarded non-matches and the public route truncated
the result set.

## Decision

Keep D1 FTS as the keyword backend and retrieve at most 100 candidates per
family using FTS5 BM25 ranking:

```sql
... WHERE family_id = ? AND keyword_search_fts MATCH ?
ORDER BY bm25(keyword_search_fts) ASC, ordinal ASC, document_id ASC
LIMIT ?
```

The canonical exact-token matcher still runs over the returned documents, so
published evidence retains its existing field, token-offset, character-offset,
and snippet semantics. Callers may request a larger family limit for downstream
processing, but the read-model boundary remains hard-capped at 100.

## Consequences

- High-frequency searches transfer only a bounded ranked candidate set and stay
  within the Worker search result budget.
- Ranking is relevance-based and deterministic for BM25 ties; insertion order
  is only a tie-breaker.
- A family lane's candidate set is intentionally bounded. The public route
  already returns no more than 100 universal-search results and eight cards;
  reconstructing every hit for a high-frequency token would require a separate
  pagination or count contract.
- D1/read failures continue to surface as the existing unknown state. There is
  no whole-corpus fallback.

## Evidence

- `worker/src/lib/notices.mjs` establishes the existing `MATCH` + BM25 + limit
  query shape.
- `worker/test/d1_read_models_canary.test.mjs` verifies the hard bound, ranked
  ordering, and exact-token evidence on the bounded result.
- The keyword-backend benchmark measured 100% exact-token/offset parity on the
  prior candidate set and showed that BM25 `LIMIT 100` keeps the high-frequency
  `award` payload bounded while retaining the public top-result budget.
