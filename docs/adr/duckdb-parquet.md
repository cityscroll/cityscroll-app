# ADR: DuckDB and Parquet as the batch warehouse

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-12 |
| Scope | Offline bulk-source ownership, batch joins, and warehouse query seams |
| Supersedes | — |
| Related | `warehouse/README.md`, `warehouse/scripts/ingest.py`, `warehouse/scripts/convert_parquet.py`, `warehouse/lib/query.mjs`, `test/warehouse_scaffold.test.mjs` |

## Context

CityScroll needs repeatable joins over public bulk data without turning every
browser request into a multi-source query. The source material can be large,
while the MacBook has finite CPU and memory headroom. The warehouse therefore
needs a columnar on-disk representation for source snapshots, a local query
catalog, and a controlled path from raw data to product materializations.

## Decision

Use an in-repository DuckDB plus Parquet warehouse for offline ownership and
batch joins.

- Keep code and small fixtures in `warehouse/`; keep large raw, Parquet, and
  DuckDB artifacts gitignored or under `CITYSCROLL_WAREHOUSE_ROOT`.
- Convert source snapshots to Parquet and register them in a DuckDB catalog.
- Expose a small Python query CLI and a Node query seam for batch jobs; do not
  expose ad-hoc warehouse SQL as an edge API.
- Run one dataset per ingest, use a single-job lock, require a headroom gate,
  cap rows by default, wrap heavy conversion with `taskpolicy`/`nice`, and set
  DuckDB to one thread.
- Use warehouse output to build bounded Worker or site read models; the Worker
  remains the serving layer.

## Alternatives

- Query large raw CSV files directly in the Worker or browser.
- Store all bulk data in D1 and perform batch joins there.
- Use a hosted analytical database or a sibling warehouse repository.
- Run unconstrained, parallel full-source downloads locally.

## Rationale

The repository records the constraints that drove this choice: offline source
ownership, columnar tables for bulk data, a local SQL seam for joins, a
precompute-first serving model, and explicit CPU discipline after a prior
full-blast workload. The exact historical comparison with other analytical
engines or hosted services is not recorded: rationale required.

## Consequences

- Batch joins and rebuilds can be rerun from receipts, fixtures, and source
  snapshots without adding live fan-out to reader requests.
- Bulk data handling requires manifests, checksums, checkpoints, and storage
  outside the committed tree.
- Ingest throughput is intentionally bounded; one dataset must finish before
  another begins.
- Warehouse schemas and product payloads need explicit seams so SQL does not
  become an accidental public API.

## Evidence

- `warehouse/README.md` — defines DuckDB plus Parquet as the in-repository lake,
  the warehouse/factory versus Worker/shop-window boundary, and CPU limits.
- `warehouse/scripts/ingest.py` and `warehouse/scripts/convert_parquet.py` —
  implement the staged ingest and Parquet conversion path.
- `warehouse/lib/query.mjs` — provides the Node-to-Python query seam used by
  batch code.
- `test/warehouse_scaffold.test.mjs` — verifies the small offline warehouse
  proof and runner contracts.
- `warehouse/receipts/proof/` — stores committed proof receipts for materialized
  warehouse operations.
