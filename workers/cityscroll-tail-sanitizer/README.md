# cityscroll-tail-sanitizer

Dedicated Cloudflare Tail consumer for bounded, privacy-preserving Worker
invocation aggregates. It is separate from `cityscroll-worker`.

## Behavior

- Positive allowlist only: persist cohort labels plus native CPU class, outcome,
  event type, and aggregate counts.
- Drop URLs, query strings, headers, bodies, and identifiers before any
  persistence. Fetch cohorts use pathname-only prefixes (`/search`,
  `/near-you`, `/performance-events` → `rum_batch_16`, `/events` → `http_events`,
  `/health` → `http_health`; unmatched fetch → `http_unknown`).
- Optional top-level numeric `coldStart` 0|1 dual-records into
  `cold_start_flag_raw_*` without inventing warm/cold labels; absent stays
  unpartitioned.
- Collector self-Tail (`scriptName` = this Worker) records native `cpuTime`
  into `collector_cpu_ms` / `collector` cohort without producer event caps.
  Wall time is never used as CPU.
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
- `wrangler.toml` — Worker config (observability absent; no KV namespaces)

## Deploy

Deploy is intentionally out of band from the main Worker path filter
(`worker/**`). Do not deploy from this tree until an authorized production
window names this Worker and sets `READBACK_TOKEN` via
`wrangler secret put READBACK_TOKEN`. Do not put `READBACK_TOKEN` under
`[vars]` in `wrangler.toml` — a plaintext placeholder collides with the
secret binding name. The runtime refuses readback while the secret is unset
or equal to the literal `"unset"`.

At arm time the guardian must set a non-empty `EXPECTED_DEPLOYED_REVISIONS`
(producer serving version id(s)). An empty allowlist forces every revision
key to `unknown` and must refuse READY/ARM
(`assertNonEmptyExpectedRevisionAllowlist`).

## Tests

```bash
node --test test/tail_sanitizer.test.mjs
```
