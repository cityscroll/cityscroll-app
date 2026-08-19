# How a new civic source joins data health

A civic source participates in data health by adding **one** row to
[`site/data/source_contracts.json`](../site/data/source_contracts.json).
That `id` is the only join key. Generated docs, the observation read model, the
strict public artifact, and the authenticated desk graph all consume that
contract. Do not add a second registry, a hand-drawn diagram, or a transient
`last_checked` stamp on the contract.

The generated ledger is [`docs/data-sources.md`](data-sources.md). Rebuild it
with `node tools/generate_source_docs.mjs`. This page is the onboarding
contract; it does not replace that generated list.

## Contract fields

`tools/source_contracts.mjs` validates every row. Identity, cadence, and
delivery must be present:

| Field | Role |
| --- | --- |
| `id` | Canonical source id. Warehouse datasets, receipts, coverage rows, observations, and public rows must use this exact string. |
| `name`, `owner`, `landing_page` | Publisher identity and official URL. |
| `status` | `live`, `build-time`, `manual`, or `disabled`. Disabled rows need a specific `gap`. |
| `scope`, `kind`, `delivery_tier` | Acquisition class and how the product serves the source. |
| `publisher_cadence` | Human-readable publisher rhythm. Display copy, not the executable window. |
| `product_freshness` | How CityScroll checks, materializes, or falls back. |
| `used_for` | Product surfaces, or an explicit reason the source stays backstage-only. |
| `code_references` | At least one in-repo path that still contains the cited token. |

Socrata rows still carry a top-level `max_stale_days` for the live probe in
`tools/verify_source_contracts.mjs`. That probe window should match
`freshness_contract.max_stale_days` when both apply. Optional
`freshness_policy` records how a measured limit was derived; `limit_days` must
equal the top-level Socrata window.

### `freshness_contract`

This is the executable freshness policy. Transient clocks never belong here.

| Field | Role |
| --- | --- |
| `mode` | `continuous`, `periodic`, `historical`, `manual-conditional`, or `pointer`. |
| `max_stale_days` | Required and positive for `continuous` and `periodic`. Must be `null` for `historical`, `manual-conditional`, and `pointer` so wall-clock age cannot mark those sources Delayed. |
| `clock_basis` | Which clock the Delayed check reads: `publisher_updated`, `checked_acquired`, or `manual_condition`. |
| `serving_max_age_days` | Independent serving-clock window, or `null`. |
| `serve_contract_id` | Optional key into `warehouse/lib/serve_publish_contract.mjs`. `null` when there is no named serve contract. |
| `manual_refresh_condition` | Required prose when `mode` is `manual-conditional`. |

Mode is how change is expected, not a failure. Historical and pointer sources
can still be Healthy, Degraded, or Source-unavailable on acquisition or serving
evidence; they are not Delayed merely because the publisher last wrote years
ago. Manual sources are Healthy only when the condition is not due and
acquisition succeeded.

### `health_policy`

| Field | Allowed value | Role |
| --- | --- | --- |
| `public_visibility` | `public` or `backstage-only` | Whether the source is eligible for `GET /source-health`. |
| `backstage_detail` | `receipts-and-errors` | Desk may keep adapters, runs, and exact errors. |
| `relationship_coverage` | `separate` | Coverage never overwrites freshness. |

Use `public` when the source feeds a public route, or when omitting it would
make a public surface look more current or complete than it is. Use
`backstage-only` for ingestion or QA layers that residents do not browse, and
say why in `used_for`. The NTA, police-precinct, DSNY, and BID geography
contracts are the landed examples.

## Observations are keyed on the contract id

`node tools/build_source_health_observations.mjs` writes
`site/data/source_health_observations.json`
(`cityscroll.source_health_observations.v1`). The builder emits **one
observation per contract**, `source_id === contract.id`, sorted by that id.
Orphan receipts, coverage rows, or observations fail the build. Duplicate ids
fail the build. A contract with no receipt still gets a row; missing clocks
stay `null` / `UNKNOWN`.

Receipts must already name the canonical id. The current producers are:

| Producer | Join field | What it can establish |
| --- | --- | --- |
| `warehouse/receipts/proof/*.json` | `source_contract_id`, `source_contracts[]`, or a named receipt schema such as `cityscroll.checkbook_contracts_population_receipt.v1` | Acquisition attempt and optional publisher clock. Dated fields include `pulled_at` / `source.pulled_at`. |
| `data/geography/receipts/**` | `source.contract_id` | Geography acquisition and publisher vintage. |
| Serving artifacts | `freshness_contract.serve_contract_id` or `warehouse_snapshot.artifact`, plus named lookups that already cite the contract (`site/data/abo_award_residual_lookup.json`, Checkbook rows in `site/data/procurement_spine_sources.json`) | Serving clock, age, and canary findings. |
| External `source-contracts-live` outbox | healthy / failure `id` | Live probe attempt. |
| `entity_resolution/source_coverage.json` | coverage `id`, plus `COVERAGE_ALIASES` in `tools/source_health_observations.mjs` | Relationship coverage, never freshness. |

If a coverage stream id is not the contract id, add an explicit alias. Do not
rely on filename or date matching. Warehouse datasets that feed this system
carry the same id as `source_contract_id` in `warehouse/datasets.v0.json`.
A missing `source_contract_id` is not proof the source was never acquired when
the receipt names the contract another honest way.

The observation file is the private current-state read model. It is excluded
from Pages in `site/_config.yml`. Rebuild it after contract or receipt changes;
`--check` fails when it is stale.

## Three freshness clocks and separate coverage

`ontology/source_health.mjs` evaluates freshness only.
`evaluateSourceHealth(contract, observation, { now })` never reads
relationship coverage.

The three clocks stay separate. A missing or invalid timestamp, including
Unix-epoch values, serializes as `{ at: null, state: "UNKNOWN", basis: null }`.

| Clock | Source on the observation | Meaning |
| --- | --- | --- |
| `publisher_updated` | `publisher_updated_at` | When the publisher last changed the underlying record. |
| `cityscroll_checked_acquired` | `acquired_at` when known, otherwise `checked_at` | When CityScroll last attempted or succeeded at acquisition. |
| `cityscroll_serving` | `serving.at` | When the materialized artifact the product serves was built. |

Status is computed against **that source's** `freshness_contract`, not a
universal age:

- Failed or held acquisition with a still-valid serving fallback is
  **Degraded**. The same failure with no valid fallback is
  **Source-unavailable**.
- Partial acquisition is **Limited-coverage**.
- `historical` mode is **Historical**. Age does not become Delayed.
- `disabled` (when not historical) is **Source-unavailable**.
- `manual-conditional` is **Healthy** only when `manual_refresh.due === false`
  and acquisition succeeded; otherwise **Manual-refresh**.
- `continuous` / `periodic` become **Delayed** only when the declared
  `clock_basis` clock is older than that source's `max_stale_days`.
- A known serving clock older than `serving_max_age_days` is **Degraded**.
- Successful acquisition with clocks inside contract is **Healthy**.
- A missing observation is **Source-unavailable** with
  `observation-missing` on the private row. The public serializer then
  renders health status **UNKNOWN**.

Relationship coverage is attached beside health, never inside it.
`normalizeRelationshipCoverage` refuses `complete` when the join is `held` or
`failed`, and refuses `complete` with zero retained rows
(`empty-declared-live`). Public labels are
`complete_for_declared_scope`, `limited_coverage`, `held_or_failed_join`, or
`UNKNOWN`. A source can be fresh and still have limited or held coverage.

## Frontstage and backstage

Both views are generated from the same contract plus the same observation
row.

**Frontstage** is `site/data/source_health_public.json`
(`cityscroll.public_source_health.v1`), built by
`node tools/build_source_health_public_projection.mjs` and served at
`GET /source-health` (`worker/src/source_health.mjs`). Only contracts with
`health_policy.public_visibility === "public"` appear. Each public row is
constructed from a closed allowlist in
`site/source_health_public_projection.mjs`:

- identity: `source_id`, `name`, `publisher`, `official_url`
- `expected_cadence` from `publisher_cadence`
- `mode` from `freshness_contract.mode`
- `health.status`, allowlisted `reason_codes`, and the three clocks
- `relationship_coverage.status`, `measured_at`, and allowlisted reasons

Public clock bases are rewritten to `publisher_record`,
`cityscroll_check` / `cityscroll_acquisition`, or
`cityscroll_materialization`. Operator fields, env names, receipts, hashes,
row counts, usefulness or precision gates, adapters, and exact errors are
denied. An invalid or unavailable artifact is served as `available: false`
with null sources, never as a fabricated empty-healthy payload.

**Backstage** is the authenticated data-source graph from
`node tools/data_source_graph.mjs`. Every contract auto-appears from the
registry; do not edit diagram markup. The graph joins the private
observation: contract fingerprint, three clocks, operator runs, redacted
exact errors, receipts, serving fallback, and the separate join gate.
Uncontracted research candidates stay dashed and are not live-source claims.
This repository does not deploy the desk.

Translate backstage evidence into plain public copy without dropping the
condition, the causal class, the affected scope, the clock basis, or the
fallback. If the precise fact is unknown, the public statement stays
UNKNOWN.

`/stats` remains the corpus-size surface. Data health answers which public
inputs are current, degraded, or coverage-limited. Do not collapse either
into an "all operational" roll-up.

The resident `/data-health/` page further selects from the public artifact:
it renders only sources with acquisition or serve evidence. Declared-only
contracts that have never been acquired stay in
`site/data/source_contracts.json` and in the public artifact; they do not
appear on the page. A served source that is currently Degraded still
renders with that honest state.

## Checklist for a new source

1. Add one contract to `site/data/source_contracts.json` with a unique `id`,
   the identity fields above, `freshness_contract`, and `health_policy`.
2. Record a source-shape fixture in
   `test/fixtures/source_contracts/source-shapes.json`.
3. If the source has a warehouse dataset, set `source_contract_id` to the
   same id. If it has a named serve lookup, set `serve_contract_id`.
4. Point at least one receipt producer at that id, **or** accept that clocks
   and coverage stay UNKNOWN until a producer exists. Do not invent
   timestamps to look complete.
5. If relationship coverage applies, add or alias a row in
   `entity_resolution/source_coverage.json`. If it does not apply, leave the
   census absent; the observation will carry `not-declared` / public
   `UNKNOWN` coverage rather than a fake complete.
6. Rebuild and check:

   ```sh
   node tools/verify_source_contracts.mjs
   node tools/generate_source_docs.mjs
   node tools/build_source_health_observations.mjs
   node tools/build_source_health_public_projection.mjs
   node tools/data_source_graph.mjs --check
   ```

   After landing-URL edits, also run `node tools/depot_rederive.mjs`.
7. Prove the mechanical join with the existing suites:

   ```sh
   node --test test/source_contracts.test.mjs \
     test/source_health_projection.test.mjs \
     test/source_health_public_projection.test.mjs \
     test/data_source_graph.test.mjs
   ```

A new contract appears in generated docs, the observation file, public
eligibility (when `public`), and the desk graph without a parallel inventory.
Intentionally backstage-only sources still take this path; they declare
`public_visibility: "backstage-only"` and explain why in `used_for`.
