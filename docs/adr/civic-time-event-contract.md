# ADR: Civic-time event contract

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-01 |
| Scope | Pure mapper + kind registry + fixture diff; Money production adapter on contract lifecycle; optional flag-gated D1 writer |
| Supersedes | — |
| Blocks | Optional later writers for Rules/Land/Meetings under this envelope (adapters remain library-only until they opt in) |

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
deployable service, and not a temporal database. An optional production writer may append
envelopes to D1 when explicitly enabled (see **Flag-gated production writer** below).

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

### Product-spine adapters

Pure mappers convert already-shipped product spines into envelopes:

| Adapter | Source | Production attach |
| --- | --- | --- |
| `mapMoneyLifecycleToCivic` | `assembleLifecycle` timeline (Checkbook + PASSPort) | `attachMoneyCivicEvents` on `computeLifecycle` → `civic_events` on `/contract-lifecycle` |
| `mapRuleSpineToCivic` | `deriveRuleEvents` (Rules) | library only |
| `mapLandSpineToCivic` | `buildLandEventSpine` (Land/ZAP) | library only |
| `mapMeetingRecordToCivic` | meeting-outcomes matched record | library only |
| `clocksFromTemporalAction` | digest `temporal_action` (alerts) | library only |

Money is the first production path: matched solicitation/award/registration/payment stages
emit `procurement.*` envelopes cached with the lifecycle JSON. When PASSPort RFx detail is
matched (EPIN↔PIN), the same adapter also emits solicitation production events:

| Publisher field | Event kind | Clock |
| --- | --- | --- |
| `release_date` | `procurement.solicitation_opened` | valid + publication |
| addenda date (when present) | `procurement.solicitation_addenda` | valid |
| `due_date` | `procurement.solicitation_due` | valid |

`public_rfx_data` publishes no addenda date columns — the addenda kind is registered but
stays unemitted (class-(b) gap) until a publisher field exists. Award on the chain continues
to use City Record `procurement.notice_published` and Checkbook/PASSPort
`procurement.award_registered` rather than inventing a fourth RFx-only award kind.

Named metric: **`rfx_spine_adapter_coverage`** = matched-RFx lifecycles that emit ≥1 RFx
production event / all matched-RFx lifecycles (baseline 0 → 1.0 on field cases).

Rules/Land/Meetings remain read-only mappers until a later materializer opts in. Adapters
do not replace the product spines as source of truth.

### Flag-gated production writer

Envelopes may optionally be appended to D1 table `civic_time_events` (migration
`0019_civic_time_events.sql`) so history can accumulate across runs.

| Item | Value |
| --- | --- |
| Module | `worker/src/lib/civic_time_writer.mjs` |
| Env flag | `CIVIC_TIME_EVENT_WRITE` |
| Enable value | exactly `"true"` (case-insensitive) |
| Default | **off** (`"false"` in `worker/wrangler.toml`; unset also means off) |
| Behavior when off | Pure seam only — adapters attach `civic_events` to responses; no D1 writes |
| Behavior when on | Fail-soft `INSERT OR IGNORE` by `event_id` after Money lifecycle attach |
| Public reads | None yet — table is write-only accumulation |

Clock honesty is enforced at map time and again at write time: source-null
`published_at` / `valid_*` / `observed_at` stay SQL NULL; processing never fills
publication; observation never fills valid time.

### Non-goals

- No always-on event bus or graph store (the D1 table is an opt-in append log only)
- No public HTTP consumer of `civic_time_events` in this card
- No replacement of existing spine renderers (`deriveRuleEvents`, land spine, meeting
  outcomes, Checkbook lifecycle) — adapters project them into the shared envelope

## Consequences

- Operators can run `node worker/scripts/civic-time-diff.mjs` on fixtures and see adds,
  changes, supersedes, and unchanged events for one materializer run.
- Characterization tests pin clock honesty and idempotency before any production writer.
- Digest time ontology remains the delivery contract for alerts; this envelope is the
  shared vocabulary for **events and current views**, not a second digest system.

## Verify

```bash
node --test worker/test/civic_time_contract.test.mjs
node --test worker/test/civic_time_writer.test.mjs
node --test worker/test/temporal_completeness.test.mjs
node --test worker/test/checkbook_lifecycle.test.mjs
node worker/scripts/civic-time-diff.mjs --fixtures worker/test/fixtures/civic-time --check
node worker/scripts/temporal-completeness-scorecard.mjs --fixtures worker/test/fixtures/civic-time --check
```

Coverage metrics (Money adapter), pinned in `worker/test/civic_time_contract.test.mjs`:

- `money_spine_adapter_coverage` = notices with ≥1 Money civic event / procurement notices
  with a lifecycle (target >0 from 0).
- `rfx_spine_adapter_coverage` = matched PASSPort RFx lifecycles that emit ≥1 of
  `solicitation_opened` / `solicitation_addenda` / `solicitation_due` / matched RFx
  lifecycles (target 1.0 on field cases with release+due dates).

### Temporal completeness scorecard

Named metric: **`temporal_completeness_rate`** — mean over civic-time events of
(filled clock families / 4), where families are **event** (`valid_at` or range),
**publication** (`published_at`), **observed** (`observed_at`), and **processed**
(`processed_at`). The scorecard also reports per-spine and per-clock fill rates and
joins `site/data/source_contracts.json` status so missing clocks are classified as
`adapter_gap` (live source, incomplete map), `source_disabled`, `source_unhealthy`,
or `source_unknown`.

Pure builder: `temporalCompletenessScorecard` in `worker/src/lib/civic_time.mjs`.
CLI: `node worker/scripts/temporal-completeness-scorecard.mjs --fixtures worker/test/fixtures/civic-time --check`.
Characterization: `node --test worker/test/temporal_completeness.test.mjs`.

## Rollback

- Writer only: set `CIVIC_TIME_EVENT_WRITE` to `"false"` (or unset). No code change required;
  the pure seam continues to attach `civic_events` without D1 writes.
- Full seam: remove `mapMoneyLifecycleToCivic` / `attachMoneyCivicEvents` /
  `writeLifecycleCivicEvents` wiring from `worker/src/checkbook_lifecycle.mjs` and drop
  `civic_events` from the cache completeness check. Delete `worker/src/lib/civic_time.mjs`,
  `worker/src/lib/civic_time_writer.mjs`, migration `0019_civic_time_events.sql`, fixtures
  under `worker/test/fixtures/civic-time/`, the characterization tests, the CLI, and this
  ADR if rolling back the whole seam.
