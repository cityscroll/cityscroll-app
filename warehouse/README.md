# CityScroll data warehouse (WH-01…WH-05)

DuckDB + parquet lake **inside this repo**, for offline ownership of NYC bulk
sources and batch joins. Public browser routes stay **precompute-first** — the
warehouse is the factory; the Worker is the shop window.

Design authority: estate vision report
`cityscroll-data-warehouse-vision` (cards WH-01…WH-04). Captain constraints:

1. **Inside crol-list** — `warehouse/` (not a sibling repo).
2. **Incremental** — WH-01 scaffold; WH-02 packs **one** full Socrata export at
   a time (never parallel City Record + payroll + ZAP).
3. **CPU-disciplined** — never repeat the OpenL3 full-blast CPU hog. Ingest is
   single-job, headroom-gated, `taskpolicy -b` / `nice` wrapped. Tiny `$limit`
   by default; full `rows.csv` only via `--bulk --ack-large`.

## Layout

```
warehouse/
  datasets.v0.json     # parameterized dataset registry + wh02_pack plan
  manifests/           # committed load manifests (checksums, queue status)
  fixtures/            # tiny samples (fixture + bulk_sample slices)
  raw/                 # downloaded source files   (gitignored bulk)
  parquet/             # columnar tables           (gitignored)
  duckdb/              # cityscroll.duckdb catalog (gitignored)
  receipts/            # run receipts; proof/ is committed
  sql/examples/        # example queries for the seam
  scripts/             # CPU-capped ingest + query CLI (Python + DuckDB)
  lib/                 # Node query seam (spawns Python DuckDB)
  requirements.txt     # duckdb for warehouse/.venv only
```

Override the data root (Mini volume / external disk):

```bash
export CITYSCROLL_WAREHOUSE_ROOT=/path/to/cityscroll-warehouse
```

Code and fixtures stay in-repo; large raw/parquet always gitignored (or live
only under `CITYSCROLL_WAREHOUSE_ROOT`).

## Setup (once)

```bash
python3 -m venv warehouse/.venv
warehouse/.venv/bin/pip install -r warehouse/requirements.txt
```

## WH-01 proof (tiny, offline)

```bash
warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset ocp-recent-contract-awards \
  --from-fixture \
  --limit 5
```

Then query:

```bash
warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql "SELECT COUNT(*) AS n FROM ocp_recent_contract_awards"

warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/ocp_awards_by_agency.sql

node warehouse/lib/query.mjs \
  --sql "SELECT agency_name, COUNT(*) AS n FROM ocp_recent_contract_awards GROUP BY 1"
```

Optional tiny **live** SODA slice (still capped; not full bulk):

```bash
# headroom first (estate headroom.py — set HEADROOM_BIN if not on the default path)
python3 "$HEADROOM_BIN"   # or: python3 path/to/headroom.py

warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset ocp-recent-contract-awards \
  --limit 50
```

## WH-02 first bulk pack (full export, still capped)

**One dataset at a time.** Primary queue (smallest/most-valuable first among the
card sources): OCP awards `qyyg-4tf5` → ZAP projects `hgx4-8ukb` → ZAP BBL
`2iga-a6mk` → City Record `dg92-zbpx` (largest last). Committed plan + checksums:
`warehouse/manifests/wh02_load_manifest.json`.

```bash
python3 "$HEADROOM_BIN"   # CONSTRAINED → defer

warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset ocp-recent-contract-awards \
  --bulk --ack-large \
  --write-sample 25

warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/ocp_bulk_verify.sql

warehouse/.venv/bin/python warehouse/scripts/write_load_manifest.py \
  --headroom-line "$(python3 \"$HEADROOM_BIN\" 2>&1 | tail -1)"
```

Raw CSV / parquet / DuckDB stay **gitignored**. Git gets: registry, runner,
proof receipt (`receipts/proof/*_bulk_latest.json`), small `bulk_sample.csv`,
and the load manifest (sha256 + row counts + remaining queue). Re-run the
commands above on Mini or a green MacBook to materialize bulk data.

**Do not** start the next dataset until headroom is still green after the
previous pack. Next after OCP: `zap-projects` (WH-03 prewarm input).

## CPU discipline (baked into the runner)

| Guard | Behavior |
|---|---|
| **Single-job lock** | `warehouse/.ingest.lock` — second concurrent ingest exits |
| **Headroom gate** | Calls estate `headroom.py --json`; CONSTRAINED refuses (override only with `--force-headroom` for tiny proof) |
| **Row caps** | Default ≤50; soft ack above 1000 (`--ack-large`); hard cap 10k on SODA `$limit` without ack |
| **Bulk export** | `--bulk --ack-large` → full `rows.csv?accessType=DOWNLOAD` (still one job + headroom + wrap) |
| **taskpolicy / nice** | Live/bulk convert path runs under `headroom.py wrap` → `taskpolicy -b` |
| **DuckDB threads** | `PRAGMA threads=1` on convert + catalog |
| **One dataset per invocation** | No fan-out multi-source bulk download in this CLI |

Heavy work should prefer the **Mac Mini** overnight, or a capped local batch when
headroom is OK. Never launch parallel full City Record + payroll downloads on
the MacBook.

## Incremental / resumable pattern

- Snapshots are **immutable**: `raw/<dataset>/snapshot_date=YYYY-MM-DD/…` and
  matching `parquet/…`.
- Receipts record sha256, row counts, source mode (`fixture` | `soda_limit` |
  `soda_bulk`), headroom snapshots, and catalog registration.
- `--resume` skips stages whose outputs already exist for that snapshot.
- Full `rows.csv?accessType=DOWNLOAD` is the WH-02 path (`--bulk --ack-large`).
  Dated re-exports / `$where` cursors for deltas remain follow-up work.

## Query seam

- **Python:** `warehouse/scripts/query.py`
- **Node:** `warehouse/lib/query.mjs` → `queryWarehouse(sql)` / `exampleOcpAwardCount()`
- **OCP lookup:** `warehouse/lib/ocp_lookup.mjs` → `lookupOcpAwardRowsFromWarehouse`
- **Doing Business lookup (WH-05):** `warehouse/lib/doing_business_lookup.mjs`
- **ZAP projects lookup (WH-05):** `warehouse/lib/zap_projects_lookup.mjs`
- **SQL examples:** `warehouse/sql/examples/`

This is **not** edge ad-hoc SQL. Worker routes keep serving precomputed read
models; warehouse SQL feeds materialization jobs and batch ER.

## WH-03: serve OCP awards from the warehouse (own-the-data payoff)

**Replaced live fetch:** `fetchOcpAwardRows` in
`worker/src/checkbook_lifecycle.mjs` — previously every cold
`/contract-lifecycle` compute hit SODA `qyyg-4tf5` by `request_id` / `pin`.

**Path now:**

1. **Build/ops** queries DuckDB (or fixture seed) → materializes
   `site/data/ocp_awards_warehouse_lookup.json` + twin under
   `worker/src/data/` (imported by the Worker).
2. **Edge** looks up the materialization **first** (in-process, sub-ms).
3. **Live SODA** only when the materialization lacks that row.

```bash
# Offline / CI (fixture catalog + product_seed demos)
node tools/build_ocp_warehouse_lookup.mjs --fixture --bench

# After WH-02 bulk is local (full corpus snapshot; still no download here)
node tools/build_ocp_warehouse_lookup.mjs --bench

# Drift gate
node tools/build_ocp_warehouse_lookup.mjs --fixture --check
```

Speed receipt (measured locally): `warehouse/receipts/proof/wh03_ocp_lookup_speed.json`.
Product seed demos (public field cases):
`warehouse/fixtures/ocp-recent-contract-awards/product_seed.csv`.

**Not in this card:** ZAP outcomes prewarm (needs `zap-projects` bulk next in
the WH-02 queue). That remains a follow-on once ZAP lands in the lake.

## entity_resolution/ (WH-04 batch)

Reuse the existing package for identity (`vendorStem`, `token_v0`,
`scorePair` / conventional matcher, `canonicalAgency`). **Do not** reimplement
matchers in SQL. DuckDB owns set joins once keys exist.

### Capped batch run

```bash
python3 "$HEADROOM_BIN"   # CONSTRAINED → defer

# Offline proof (fixture OCP sample + stem variants + tiny Doing Business sample)
warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py \
  --from-fixture --limit 25 --force-headroom

# Incremental warehouse slice (after WH-01/02 OCP load; default limit 200)
warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py --limit 200

warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/er_entity_links_verify.sql
```

| Guard | Behavior |
|---|---|
| **Single-job lock** | Same `warehouse/.ingest.lock` as ingest |
| **Headroom gate** | Refuses when CONSTRAINED unless `--force-headroom` (fixture only) |
| **taskpolicy / nice** | Warehouse slices go through `headroom.py wrap`; tiny fixture may skip wrap |
| **Default limit** | 200 OCP rows (not full bulk) |
| **DuckDB threads** | 1 on materialize |

### Materialized views

| View | Grain |
|---|---|
| `er_entity_link` | source_record → canonical_entity (auto_link) |
| `er_canonical_entity` | vendor:stem:… / agency:id:… |
| `er_resolution_run` | batch run + metrics_json |
| `er_pair_receipt` | token_v0 candidate pair scores |
| `er_ocp_vendor_resolved` | OCP awards LEFT JOIN vendor links (when OCP view present) |

Parquet under `warehouse/parquet/er_*/` (gitignored). Proof receipt:
`warehouse/receipts/proof/wh04_er_batch_latest.json`.

Pure lib: `warehouse/lib/er_batch.mjs` (imports `entity_resolution/` +
`worker/src/lib/entity_link.mjs` exact-stem builder). Identity is never
reimplemented in SQL.

## Roadmap

| Card | Scope |
|---|---|
| **WH-01** | Scaffold, CPU-capped skeleton, tiny OCP proof |
| **WH-02** | First bulk export(s) via capped runner — OCP first; ZAP / City Record sequential next |
| **WH-03** | Materialize warehouse OCP → replace live SODA in `fetchOcpAwardRows` (+ live miss fallback) |
| **WH-03b** (follow-on) | ZAP outcomes prewarm once `zap-projects` bulk is loaded |
| **WH-04** | Batch ER over warehouse → `er_entity_link` parquet + SQL views |
| **WH-05** (this pack) | Materialize Doing Business + ZAP projects → replace more live SODA (+ miss fallback) |

## WH-05: more live fetches → warehouse materialization

Extends the WH-03 pattern to the next BATCHABLE shortlist surfaces that map to
warehouse-registered datasets (`doing-business-entities`, `zap-projects`):

| Live fetch replaced | Path now |
|---|---|
| `attachDoingBusiness` multi-page SODA `72mk-a8z7` | Warehouse stem index first; full-catalog or all-matched skips SODA; partial fixture keeps SODA gap-fill |
| `fetchOpenDataRow` SODA `hgx4-8ukb` | Materialization by `project_id` first; live SODA on miss |
| Land default Active ULURP rebuild | `fetchLandDefaultProjects` prefers DuckDB when `zap_projects` is packed |

```bash
# Offline / CI
node tools/build_doing_business_warehouse_lookup.mjs --fixture --bench
node tools/build_zap_projects_warehouse_lookup.mjs --fixture --bench

# After capped WH-02 pack of each dataset
warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset doing-business-entities --bulk --ack-large
node tools/build_doing_business_warehouse_lookup.mjs --bench

warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset zap-projects --bulk --ack-large
node tools/build_zap_projects_warehouse_lookup.mjs --bench
```

Speed receipts: `warehouse/receipts/proof/wh05_*_lookup_speed.json`.

## Characterization

```bash
node --test test/warehouse_scaffold.test.mjs test/warehouse_bulk.test.mjs \
  test/warehouse_ocp_lookup.test.mjs worker/test/ocp_warehouse_lookup.test.mjs \
  test/warehouse_er_batch.test.mjs test/warehouse_wh05_lookups.test.mjs \
  worker/test/wh05_warehouse_lookups.test.mjs
```

Optional: re-run the fixture ingest before the query assertions if the local
catalog was wiped. Bulk verification needs a prior `--bulk` run (local/Mini only;
CI does not download multi-MB packs).
