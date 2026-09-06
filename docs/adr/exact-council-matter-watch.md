# ADR: Exact Council matter Following scope

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-06 |
| Scope | Versioned exact Council-matter watches under the existing meetings Following contract |
| Supersedes | — |
| Related | `docs/adr/matter-observation-retention.md`, `site/council_matter_watch_scope.mjs`, `worker/src/lib/compile.mjs` |

## Context

Saved Following scopes can name a meetings query, a notice membership, or a
community board. They cannot name one New York City Council matter. A five-matter
hearing then has no honest "follow this" action: choosing the first matter, the
notice, or the committee would silently broaden what the resident asked to
watch.

City Record SODA has no matter field. A compiler that dropped an exact-matter
constraint would replay all meetings.

## Decision

Extend the existing meetings Following filter with a versioned, source-qualified
identity `legistar:nyc:matter:<id>`.

- Validate before sanitization. Malformed IDs, unknown tenants, unsupported
  versions, conflicting filters, and unresolved identities fail visibly.
- Both compiler paths either read retained native observations or return an
  explicit unsupported result. They never send a fabricated matter field to
  City Record SODA or the D1 notices mirror.
- Confirmation writes an observed-revision baseline in the same activation as
  the saved watch. Preexisting history produces zero catch-up updates.
- Repeated confirmation is idempotent and owner-isolated. Removal cancels
  unsent items exclusive to that watch. A later refollow writes a fresh
  baseline.
- Delivery enqueueing stays off until `MATTER_WATCH_DELIVERY` is enabled.

## Consequences

Residents can save one exact matter without creating a parallel subscription
product. End-to-end mail delivery remains a later, explicitly gated change.
