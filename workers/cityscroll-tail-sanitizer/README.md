# cityscroll-tail-sanitizer

Dedicated Cloudflare Tail consumer for bounded, privacy-preserving Worker
invocation aggregates. It is separate from `cityscroll-worker`.

## Behavior

- Positive allowlist only: persist cohort labels plus native CPU class, outcome,
  event type, and aggregate counts.
- Drop URLs, query strings, headers, bodies, and identifiers before any
  persistence.
- Reject empty `{}` and non-invocation events.
- Observability / logs / traces stay disabled (no `[observability]` block).
- Aggregate sink is a Durable Object with authenticated readback
  (`x-cityscroll-tail-readback-token`).
- Event cap (default 10_000, 30 min deadline) bounds **all seen** events:
  `events_seen = events_accepted + events_rejected`. When the counting event
  hits the cap the sink sets `cap_reached` and returns `trigger_owned_detach`
  so the collector can start owned detach; further events refuse with
  `SINK_CAP`. Concurrent applies may briefly overshoot by at most
  concurrency−1; independent window expiry remains the detach fallback.

## Layout

- `src/projection.mjs` — pure allowlist projection (unit-tested)
- `src/aggregate_sink_logic.mjs` — in-memory sink contract for tests
- `src/worker.mjs` — Worker + Durable Object entrypoint
- `wrangler.toml` — Worker config (observability absent)

## Deploy

Deploy is intentionally out of band from the main Worker path filter
(`worker/**`). Do not deploy from this tree until an authorized production
window names this Worker and sets `READBACK_TOKEN` via
`wrangler secret put`.

## Tests

```bash
node --test test/tail_sanitizer.test.mjs
```
