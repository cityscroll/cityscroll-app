# MCP usage observation

CityScroll records one content-free observation per supported MCP dispatch or request outcome
and folds those observations into the authenticated private statistics read model. Browser
usage events stay on their own taxonomy; machine use never becomes a unique-person count and
never enters public `/stats`.

## Schema

- Observation schema: `cityscroll.mcp_usage_observation.v1`
- Taxonomy version: `mcp.1.0.0` (keeps rows out of the browser usage SQL allowlist)
- Surface: `mcp`
- Owner modules:
  - `capabilities/mcp_usage_observation.mjs` — closed builder, fingerprint, six-field adapter
  - `worker/src/lib/mcp_usage.mjs` — `USAGE_ANALYTICS` write/read and statistics fold
  - `worker/src/mcp.mjs` — emits one observation per actual handler outcome
  - `worker/src/stats.mjs` — `mcp_usage` on authenticated private stats

Each observation carries surface, method, registered tool or `unknown`, bounded outcome,
observation class, latency, deployment identity (`GIT_COMMIT_SHA` when present), and on
`tools/list` a deterministic catalog fingerprint plus returned tool count. Client family,
client version, and protocol version are bounded and self-reported when present on
`initialize`; otherwise they remain `unknown`. Stateless HTTP invents no cross-request
session and no unique-user count. A catalog-served observation does not prove a remote
client cached that catalog.

## Observation classes

| Class | How it is reached | Product totals |
| --- | --- | --- |
| `production` | Default for ordinary requests | Included |
| `developer` | Valid `X-CROL-Analytics-Dev` HMAC, or non-production `ANALYTICS_ENVIRONMENT` | Excluded |
| `canary` / `probe` | Explicit operator marking via header or query | Excluded |

Anonymous or unknown provenance never becomes verified external adoption. Spoofed developer
tokens without the shared secret stay `production`.

## What is never stored

Credentials, IP addresses, raw user agents, prompts, argument or query strings, response
content, entity identifiers, subscriber identities, exception text, and arbitrary unknown
tool or client names. High-cardinality inputs collapse into closed buckets (`unknown`,
`other`).

## Collection controls

- Binding: existing `USAGE_ANALYTICS` Analytics Engine dataset
- Kill switch: `MCP_USAGE_INGEST_ENABLED=false`
- Measured-since: `MCP_USAGE_MEASURED_SINCE` (default `2026-09-16`)
- A missing binding is `unconfigured` / unavailable on the private read model, never reported
  as zero traffic
- Measurement failure never changes MCP results and never leaves a floating rejected promise

## Private statistics

Authenticated `GET /admin/stats` includes `mcp_usage` with 7/30-day counts by day, tool, and
outcome, latency summaries, observation window, measured-since, last observation, sample and
retention semantics, coverage gaps, collection status, and per-class slices. Desk consumers
reuse this read model; there is no parallel metrics store.

## Coverage gaps

Declared in `MCP_USAGE_COVERAGE_GAPS` inside the observation module. Notable limits:

- Client disconnect after the Worker begins writing a response is not observable as cancellation
- Notifications acknowledge only; they do not prove retained remote state
- Client identity fields are self-reported on initialize only
- Catalog fingerprints describe what was served, not what a client cached

## Verification

Offline: `node --test worker/test/mcp_usage.test.mjs worker/test/mcp.test.mjs worker/test/stats.test.mjs`

Post-deployment measurement (outside required offline globs): 
`node tools/verify_mcp_usage_stats_canary.mjs` — authenticated read-only canary that marks
itself as probe traffic and retrieves the observation through the statistics reader.
