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
