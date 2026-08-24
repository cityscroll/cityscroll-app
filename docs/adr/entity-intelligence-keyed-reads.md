# ADR: Keyed D1 entity-intelligence reads

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-23 |
| Scope | Worker entity-intelligence read model |
| Supersedes | — |
| Related | `docs/architecture.md`, `worker/src/lib/entity_intelligence_read_model.mjs`, `worker/migrations/0026_entity_intelligence_read_model.sql`, `architecture/generated/watermark.json` |

## Context

The committed entity-intelligence lookup is a ~13 MiB whole-corpus map. The Worker
imported that file and resolved `/entity-intelligence`, project connections,
vendor footprints, and ontology-delta inventory from the in-memory object. That
import was one of the remaining uncompressed Worker inputs over Cloudflare's
64 MiB limit. Request paths only need the matching entity, not the full map.

## Decision

Serve entity intelligence from keyed D1 lookups published from the same
committed lookup during Worker deploy. Keep `entity_intelligence_lookup.json`
as the build input. Do not import it into the Worker bundle.

- Store one gzip-compressed dossier per `entity_ref`, plus subject-ref and
  graph-link indexes and a compact meta row, in D1 (`DB` / `crol-notices`).
- Look up only the bounded matching entity (or subject/graph slice) at request
  time.
- On a missing ref or D1 failure, return the existing empty/unavailable state.
  Never fall back to loading the whole corpus.

## Rationale

A keyed D1 table matches the access shape: exact entity and subject lookups
on a binding the Worker already has. Gzipped dossiers stay under D1's SQL
statement limit, so the deploy path can refresh the table from the committed
JSON without a new object store. Removing the whole-corpus import from the
Worker graph is the reviewed way to drop that ~13 MiB input while keeping
route outputs and provenance unchanged.

The observer now sees the keyed read-model adapter as an entity-resolution
importer, which changes the coverage hash. Canary fingerprints are unchanged
and unmapped surfaces stay empty. The committed architecture watermark records
that reviewed coverage change.

## Consequences

- Worker entity-intelligence, project-connection, vendor-profile, and
  ontology-delta paths depend on the D1 read model being published at deploy.
- A D1 miss is an honest empty or unavailable response, not a silent whole-map
  restore.
- The coverage-hash baseline must be re-accepted when this adapter lands.

## Evidence

- `worker/src/lib/entity_intelligence_read_model.mjs` — keyed D1 adapter.
- `worker/migrations/0026_entity_intelligence_read_model.sql` — table schema.
- `tools/build_worker_d1_read_models.mjs` — deploy SQL published from the
  committed lookup.
- `worker/test/d1_read_models_canary.test.mjs` — Parks keyed-lookup canary.
- `worker/test/worker_bundle_safety.test.mjs` — Worker graph must not import
  `entity_intelligence_lookup.json`.
