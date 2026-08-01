# ADR: Civic-time event contract

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-01 |
| Scope | Library seam only — pure mapper, kind registry, fixture diff |
| Supersedes | — |
| Blocks | Optional later adapters that emit production events under this envelope |

## Context

CityScroll already materializes Rules, Land/ZAP, Meetings, procurement lifecycle, and
digest matching. Each path names dates differently (`start_date`, `comment_by_date`,
`valid_at`, ZAP `time.value`, Checkbook registration dates). Digests document three
clocks plus delivery identity in `docs/digest-time-ontology.md`, but there is no shared
**event envelope** or operator receipt for “what did this materializer run change?”

Without a named contract, adapters invent clocks (for example treating processing time as
publication) and idempotency keys, so late revisions and re-runs are hard to audit.

Authoritative system map: [`docs/architecture.md`](../architecture.md). This ADR is a
library seam under the existing Worker package — not a second architecture document, not a
deployable service, not a temporal database, and not a production writer.

## Decision

Adopt a **pure civic-time event envelope** plus a **bounded event-kind registry** and a
**deterministic semantic-diff CLI** over fixtures.

### Clocks (never invent)

| Clock | Meaning | Rules for mappers |
| --- | --- | --- |
| **Valid / event** | When the civic fact holds or occurs (`valid_at` or `valid_from`/`valid_to`) | Map only from an explicit source field (hearing date, comment close, milestone date, award date). |
| **Publication** | When the city published the assertion (`published_at`) | Map only from publisher timestamps (City Record `start_date`, RSS `pubDate`, Legistar last-modified when that is the published claim). |
| **Observation** | When CityScroll first fetched or stored the assertion (`observed_at`) | Map only from ingest/materializer observation metadata. |
| **Processing** | When a pipeline run processed the row (`processed_at`) | Map only from run metadata. Never copy into `published_at` or `valid_at`. |

Unknown clocks stay `null`. A mapper must not fill publication from processing or valid
time from observation.

### Envelope minimum

Every mapped event exposes:

- `event_id` — stable id for the subject + kind + source revision
- `subject_ref` — product subject (`notice:…`, `project:…`, `contract:…`, …)
- `event_kind` — registry id (bounded vocabulary)
- `valid_at` **or** (`valid_from` / `valid_to`)
- `published_at`, `observed_at`, `processed_at` (nullable independently)
- `source_record_ref`, `source_revision`, `payload_hash`
- `materializer_name`, `materializer_version`, `run_id`
- optional `confidence`, `status`, `supersedes_event_id`

### Idempotency and supersession

- The same source revision maps to the same `event_id` and byte-stable `payload_hash`.
- A **new** `source_revision` for the same subject + kind produces a new event that may
  set `supersedes_event_id` to the prior event id.
- Semantic diff never silently overwrites fixture history: it reports `add`, `change`,
  `supersede`, or `unchanged`.

### Event-kind registry

The registry is a closed list of kinds used by Money, Rules, Land, and Meetings fixtures
in this card. Adapters may propose new kinds in later PRs; unknown kinds fail closed in
the mapper rather than collapsing stages (for example award ≠ amendment).

### Non-goals

- No Worker route, KV/D1 writer, or production consumer in this card
- No graph store, event bus, or multi-hop ontology product
- No replacement of existing spine renderers (`deriveRuleEvents`, land spine, meeting
  outcomes, Checkbook lifecycle) — those remain source of truth until an adapter opts in

## Consequences

- Operators can run `node worker/scripts/civic-time-diff.mjs` on fixtures and see adds,
  changes, supersedes, and unchanged events for one materializer run.
- Characterization tests pin clock honesty and idempotency before any production writer.
- Digest time ontology remains the delivery contract for alerts; this envelope is the
  shared vocabulary for **events and projections**, not a second digest system.

## Verify

```bash
node --test worker/test/civic_time_contract.test.mjs
node worker/scripts/civic-time-diff.mjs --fixtures worker/test/fixtures/civic-time --check
```

## Rollback

Delete `worker/src/lib/civic_time.mjs`, fixtures under `worker/test/fixtures/civic-time/`,
the characterization test, the CLI, and this ADR. No migration or route exists.
