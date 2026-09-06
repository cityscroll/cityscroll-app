# ADR: Matter observations survive snapshot replacement

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-06 |
| Scope | Immutable source-record reuse, indexed matter observation journal, and last-good refresh |
| Supersedes | — |
| Related | `docs/adr/legislative-matter-history-population.md`, `worker/src/lib/legistar_source_records.mjs`, `worker/migrations/0008_source_records.sql` |

## Context

The compact Council meeting materialization is replaced on refresh. That rolling
view is a publication snapshot, not a journal: when a later refresh is empty,
partial, or fails, the apparent history can shrink, lose native event-item
identity, or treat a correction as a new hearing. The published matter pages
read that snapshot. They do not themselves retain every native identity needed
for revision-aware tracking.

An immutable `source_records` contract already exists. A second raw evidence
store would compete with it. Compact bootstrap appearances also lack native
event-item identifiers, so they cannot be rewritten as evidence-rich native
history.

## Decision

Retain matter observations independently of the rolling snapshot.

- **Raw evidence** stays in `source_records`. Bootstrap appearances and native
  event, event-item, and vote rows are additional source systems in that table,
  not a parallel payload store.
- **Indexed projection** lives in migration `0027_matter_observation_journal.sql`.
  It stores publisher system, tenant, matter id, event id, native event-item id
  when supplied, publisher action id when supplied, event time, observed time,
  acquisition time, raw receipt reference, payload hash, and semantic revision
  as separate fields.
- **Matter identity** is publisher system + tenant + immutable matter id
  (`legistar:nyc:matter:79200`). Title similarity never merges two ids.
- **Hearing identity** is that matter at one native event. Notice references
  remain provenance. Two event items on the same day stay distinct observations.
- **Coarse bootstrap** is labelled `coarse` and kept after a native match. The
  native row supersedes it on the same hearing key; it does not open a second
  hearing. Missing native identifiers are reported unresolved, never invented.
- **Votes** bind only to their event item. Unavailable native binding is
  `incomplete` and is not inferred from matter-level aggregation.
- **Refresh failure** is transactional. An empty, partial, failed, or interrupted
  replacement keeps last-good rows and records one deduplicated repair
  observation. Identical replay does not change observation identity. History is
  not a 180-day TTL.

No request-time publisher access is introduced. The public meeting-outcomes KV
view remains a replaceable snapshot; journal telemetry is stripped before that
view is stored.

## Consequences

- Operators can inspect retained last-good history when a refresh returns less
  than the previous generation.
- Published resident matter pages continue to read the committed snapshot until
  a later decision projects this journal into those pages.
- Watch delivery and notice-independent refresh remain separate decisions.
