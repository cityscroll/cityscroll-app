# ADR: KV projections versus D1 search

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-12 |
| Scope | Worker read models, scheduled projections, and open-ended notice search |
| Supersedes | — |
| Related | `docs/architecture.md`, `worker/src/lib/notices.mjs`, `worker/migrations/0016_notice_fts.sql`, `worker/src/hearings.mjs`, `worker/src/vendor_profile.mjs` |

## Context

CityScroll serves two different classes of data. Some endpoints answer a
bounded product question whose shape is known ahead of time: a location-aware
hearing view, a Property view, a vendor profile, a contract-lifecycle result,
or a prior-cycle match set. Other requests are open-ended notice searches with
arbitrary terms and structured filters.

The architecture assigns versioned, answer-shaped projections to KV and keeps
the recent notice mirror and its rebuildable FTS5/BM25 index in D1. The daily
cron refreshes the source mirror and materialized views; the search path applies
structured filters before ranking and has a `LIKE` fallback when FTS5 is not
available.

## Decision

Use KV for precomputed, answer-shaped read models and D1 for durable notice
records and open-ended search.

- Store bounded projections in named, versioned KV keys or buckets so an
  ordinary read can fetch a ready-to-render result.
- Store the recent City Record mirror, ingest state, search haystack, and
  rebuildable `notices_fts` index in D1.
- Keep source data and search semantics in D1 even when a derived answer is
  also cached in KV.
- Treat KV misses and stale views as explicit fallback conditions, not as
  evidence that no source record exists.
- Keep the D1 FTS index rebuildable because virtual tables are not included in
  D1 exports.

## Alternatives

- Put all read models and searches in D1 and query them on every request.
- Put the full notice corpus and arbitrary search index in KV.
- Use only live Socrata queries and no durable mirror or projection layer.

## Rationale

The code documents the shape distinction: KV keys such as
`hearings:location:v1`, `property:location:v1`, and versioned vendor-profile
buckets are whole answers, while D1 `notices_fts` supports arbitrary lexical
terms, structured predicates, and ranked results. This preserves a cheap,
bounded path for known product views without forcing open-ended search into a
key-value lookup. The historical cost and latency measurements behind this
exact store boundary are not recorded: rationale required.

## Consequences

- Known views can render from one bounded KV read and be refreshed on schedule.
- Search requires D1 schema and index maintenance, including FTS rebuilds on
  restore or export.
- The system has two freshness paths and must report stale, missing, or
  unavailable projections honestly.
- A new endpoint must first identify whether it is a bounded answer-shaped
  projection or an open-ended query before choosing its store.

## Evidence

- `docs/architecture.md` — defines KV read models, the D1 notice mirror, and
  the division between precomputed matches and notice search.
- `worker/src/hearings.mjs` and `worker/src/vendor_profile.mjs` — implement
  versioned KV projections for bounded product answers.
- `worker/src/lib/notices.mjs` — builds structured-filtered FTS5/BM25 queries
  and a legacy `LIKE` fallback.
- `worker/migrations/0016_notice_fts.sql` — makes the D1 virtual index
  rebuildable after export and restore.
