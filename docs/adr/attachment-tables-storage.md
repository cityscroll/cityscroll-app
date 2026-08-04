# ADR: Attachment T2 table storage (JSON vs parquet / DuckDB)

**Status:** accepted (2026-08-03)  
**Tier:** `att-t2-structured`  
**Related:** T0 `attachment_metadata`, T1 `attachment_text`, later `att-t3-embeddings` (parallel lane; embeddings do not own table shape)

## Context

T2 extracts structured tables from high-value City Record attachments (docx
native tables; PDF text-layer row recovery only — no OCR). The open product
question was whether extracted tables should land as **parquet** consumed via
**DuckDB** for build-time aggregation, or as **plain JSON** payloads already used
by the notice lookup and Worker materialization path.

## Decision drivers (measured / measurable)

| Criterion | Current scale (fixture + daily cap) | Implication |
|---|---|---|
| Table count | Fixture golden case: **2 tables / 1 doc**; live run cap **≤25 docs/run** after T0 inventory | Tiny; no warehouse-scale scan needed for the public surface |
| Payload size | Cannonsville species + stand tables ≪ 10 KB structured JSON | JSON fits committed lookup + D1 text column |
| Query needs | Product serves **per-notice** tables on `#notice/{id}` and cell text into haystack search | Point lookup, not cross-doc SQL aggregates |
| Toolchain weight in CI | Warehouse already installs `duckdb` + `pypdf` for ingest jobs; **required merge checks** should not grow a parquet write path for a micro-corpus | Extra convert/register steps buy nothing until aggregation exists |
| Build-time aggregation | No current map/chart/dimension reads attachment tables across notices | Parquet advantage is latent |

## Decision

**Store and serve extracted tables as JSON now.**

Concrete surfaces:

1. **Committed offline lookup** — `site/data/attachment_metadata_lookup.json` (+ Worker twin) carries `extracted_tables[]` beside T1 text fields.
2. **Edge materialization** — D1 `notice_attachments.extracted_tables` (TEXT JSON) written by the same admin batch as T0/T1.
3. **Warehouse proof** — optional JSONL under `warehouse/raw/attachment-tables/` + receipt; DuckDB may *read* that JSONL for operator inspection (parity with T1's `read_json_auto`), but **parquet is not the product of record**.

## Parquet threshold (revisit when any trip)

Switch the warehouse materialization path to parquet + DuckDB views when **any** of:

- `docs_with_tables ≥ 500`, or
- `total_tables ≥ 2_000`, or
- serialized table payload ≥ **5 MB** for a single rebuild, or
- a build job needs **cross-document SQL** over table cells (aggregates, joins to other warehouse tables).

Helper: `recommendTableStorage()` in `warehouse/lib/attachment_tables.mjs` encodes these numbers for characterization tests.

Until then, inventing a parquet pipeline would add CI/runtime weight without a consumer.

## Non-goals

- OCR / scanned PDF table recovery (T2 text-layer only; miss is stamped honestly).
- Embedding vectors (T3 parallel lane — do not share write ownership of embedding stores).
- Canonicalizing units, currencies, or species names inside cells (display + search only).

## Consequences

- Notice UI can render real HTML tables from the same progressive-disclosure pattern as T1 text without a warehouse round-trip.
- Search haystack gains an `[attachment-tables]` provenance slice (cell text), independent of T1 `[attachment-text]`.
- When the threshold trips, migrate warehouse JSONL → parquet with a versioned schema; the public API can keep serving browser-facing JSON rows.
