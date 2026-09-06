# ADR: Exact Council matters refresh without a notice cutoff

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-06 |
| Scope | Scheduled exact-matter acquisition, fair refresh state, and Histories source gate |
| Supersedes | — |
| Related | `docs/adr/matter-observation-retention.md`, `worker/src/lib/legistar_client.mjs`, `worker/src/lib/matter_observation_journal.mjs` |

## Context

The notice-matched meeting collector looks back 180 days from recent City Record
hearings. A matter that already has a retained identity can move again after
that window, or without another matched notice. Residents waiting on that exact
matter would otherwise see a frozen history.

The documented Legistar matter Histories route can name later actions by matter
id. NYC authenticated behavior of that route is an activation proof, not an
assumption. Nested EventItems and Votes clients already exist.

A second history store or a second scheduler would compete with the journal and
the daily Worker schedule that already refresh Council meetings.

## Decision

Refresh active watches and explicitly retained matters on the existing daily
Worker schedule, independently of notice discovery and independently of the
180-day event lookback.

- **History** stays in `source_records` and `matter_observation_journal`.
  Migration `0028_matter_exact_refresh.sql` stores only roster, cursor, retry,
  and operator receipts.
- **Adapter.** Use the documented Histories route only after a retained,
  sanitized, authenticated NYC response proves the route and identity joins.
  Until that proof exists, use paginated `EventItems` filtered by matter id and
  hydrate events and votes through the existing nested clients. Do not claim
  the Histories source gate from reconstructed snapshot fixtures.
- **Progress** is per matter: last attempt, last complete refresh, acquisition
  status, restart-safe cursor, and retry time. Exhausting a page or request
  budget is `partial` and is never `current`.
- **Fairness.** Eligible matters are visited in visit-sequence then least-recent
  attempt order. Duplicate overlapping triggers share one run lock and must not
  exceed the configured request budget.
- **Activation** checks deployed retention configuration, including the
  source-record write flag. It does not assume shadow writes are on.
- **Resident reads and required tests** make zero publisher requests.

## Consequences

- Later official actions can enter the journal without a new City Record notice.
- Operators can see attempted, retained, deferred, and failed work.
- Live Histories activation remains gated until a sanitized NYC response is
  retained.
