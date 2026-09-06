# ADR: Prove continuing coverage and recoverability for exact matter follow-through

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-06 |
| Scope | Frozen-population replay, operational coverage receipts, and labelled durability recovery |
| Supersedes | — |
| Related | `docs/adr/retained-matter-publication-generation.md`, `docs/adr/matter-exact-refresh.md`, `docs/adr/exact-council-matter-watch-updates.md`, `site/matter_coverage_recovery.mjs` |

## Context

Retained fixtures and a successful demo can still hide missed matters, shrinking
histories, or updates that cannot be recovered. Pages, watches, and
notifications now share one published generation, but that contract does not
by itself prove the frozen population stays complete across withheld later
packets, long-running clocks, restarts, partial upstream failure, or
operational lag.

Pinned locators from the original design remain context, not replacement
owners: `docs/civic-action-paths.md`, `worker/test/continuation_replay.test.mjs`,
and `worker/src/worker.mjs`. Current owners for the follow-through path are
the exact-matter collector, the publication generation, the watch reducer, and
the digest outbox. This change reuses those owners.

Already delivered overlap, disclosed rather than reimplemented: population
matter histories, observation retention, exact-matter refresh independent of
notices, exact watch scope, one logical update per semantic revision, and one
retained publication generation for pages and watches.

## Decision

Treat the committed meeting-outcomes snapshot as an independent expected-result
oracle. Withhold the ten later packets until each watch baseline exists, then
release them only through the collector adapter. Do not preload a later event
into the state that claims to discover it.

- The frozen replay must derive 66 materialized matters, 76 distinct
  appearances, ten later-event discoveries, ten logical later-action updates,
  and zero replay duplicates.
- Repeat that journey at simulated days 181 and 365, across restart and partial
  upstream failure. Earlier events stay. Recovery emits each missing logical
  update once.
- Operational receipts expose active watches, due matters, last-complete
  refresh age, deferred work, failure class, retained counts, publication lag,
  and pending or failed outbox items, without resident email addresses.
- Alert when an eligible active watch lacks a complete refresh for 48 hours,
  when publication trails retained eligible changes for two scheduled cycles,
  or when pending delivery exceeds two scheduled cycles. Fault replay is a
  labelled durability test, not a second coverage denominator.
- Request budgets stay bounded. Completing the roster may take more than one
  cadence cycle; budget exhaustion is partial, never current.
- A bounded deployed canary records population floors and operational health.
  Fixed specimen IDs are not permanent live-coverage gates.
- Token recovery, budget backlog, cursor recovery, failed publication,
  replay-safe delivery, and feature rollback each name a site-owner action.
  Implementation status stays proposed until merged delivery and a strict-clean
  realization receipt exist.

## Consequences

Operators can see coverage health and recover from the three initial lag
classes without reading subscriber addresses. Frozen record-specific
assertions stay in offline fixtures. Refreshed build and deployment gates
evaluate population membership and operational health.

## Evidence

- `site/matter_coverage_recovery.mjs` — frozen oracle, alert thresholds, and recovery playbook.
- `worker/src/lib/matter_coverage_recovery.mjs` — receipts and recovery actions.
- `worker/test/council_matter_coverage_recovery.test.mjs` — end-to-end replay and durability faults.
- `docs/evidence/matter-coverage-recovery/manifest.json` — operator-view capture proof.
