# ADR: Exact Council-matter watch updates

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-06 |
| Scope | Semantic change reduction and durable outbox identity for exact Council-matter watches |
| Supersedes | — |
| Related | `docs/adr/exact-council-matter-watch.md`, `site/council_matter_watch_change.mjs`, `worker/src/lib/digest_outbox.mjs` |

## Context

Saved exact Council-matter watches already persist a confirmed observation
baseline. Non-rules freshness still treated an unseen row identity as the
delivery event, and notice-lens outbox identity normally required a City Record
request id. A later official action on a watched matter could be suppressed by
a seen notice, duplicated by overlapping follows, or misstated by monotonic
agenda/action/vote ranking.

The existing digest outbox, temporal reconciler, and provider send path already
carry land, rules, and procurement identities. A second mail pipeline would
diverge acknowledgement and crash recovery.

Pinned locators from the original design (`worker/src/lib/alert_temporal.mjs`,
`worker/src/lib/digest_outbox.mjs`, `worker/src/lib/digest.mjs`,
`worker/src/alerts.mjs`, `site/civic_outcome_transition.mjs`) remain the owning
delivery, identity, and outcome-projection modules. This change reuses those
owners and does not replace them.

## Decision

Add a matter-specific reducer inside the existing meetings digest path.

- Compare normalized official action state, not notice identity. Title,
  formatting, duplicated notices, and acquisition timestamps are quiet.
- Key a native change by source-qualified action identity plus semantic
  revision. Coalesce additions in one published matter revision into one
  logical watch update.
- Classify scheduled activity, occurred action, and correction separately. A
  future hearing is scheduled, never held. A later event repeating Laid Over is
  a new event. A later committee action after an earlier vote remains eligible.
- Enqueue through `digest_outbox` with `matter_update_key`. Overlapping follows
  for one recipient share that item; distinct recipients each receive their own.
- Reuse provider send, occasion reservation, and acknowledgement. Pass the
  reserved delivery id as the provider idempotency key. A crash after provider
  acceptance and before receipt persistence leaves the logical item owed and is
  reported as remaining physical-send ambiguity.
- Delivery remains gated on `MATTER_WATCH_DELIVERY`.

## Consequences

Matter watches can describe a later official action even when CityScroll has
already seen the notice. Replay and retries stay quiet. Notice and rules
identities are unchanged. End-to-end publication of those updates onto public
pages remains a later, separately gated change.
