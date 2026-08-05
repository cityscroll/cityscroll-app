# CityScroll data warehouse (WH-01…WH-06 + RC-1 + entity-intelligence index)

DuckDB + parquet lake **inside this repo**, for offline ownership of NYC bulk
sources and batch joins. Public browser routes stay **precompute-first** — the
warehouse is the factory; the Worker is the shop window.

Design authority: estate vision report
`cityscroll-data-warehouse-vision` (cards WH-01…WH-05). Captain constraints:

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

## RC-4 ABO residual measurement

The ABO collector is a measured join pipeline, separate from the existing
authority-wide recent-award cache. It refreshes a fixed City Record residual
sample and each mapped ABO authority with a named User-Agent, checkpoints every
page, waits at least 250 ms between live requests, and stops without retry on
HTTP 403. Fixture proof is offline:

```bash
warehouse/.venv/bin/python warehouse/scripts/abo_awards_run.py \
  --from-fixture --force-headroom
warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/abo_residual_verify.sql
```

Tables: `abo_residual_notice`, `abo_procurement_award`,
`abo_residual_candidate`, `abo_residual_match`, and
`abo_residual_measurement`. The committed proof records 1/50 joined (2%), 50%
fuzzy precision, and zero materialized matches. The site/Worker payload twins
therefore contain an explicit stopped bridge and an empty match map; they do not
authorize a reader surface.

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
previous pack. Loaded: OCP + `zap-projects` + `zap-bbl`. Next: `city-record`.

## DOF Tax Lien Sale Lists

Dataset `dof-tax-lien-sale-lists` (`9rz4-mjek`) uses the resumable 50,000-row
SODA paging path because the publisher exposes notice-stage rows rather than a
single downloadable snapshot. Materialize and verify it one dataset at a time:

```bash
python3 "$HEADROOM_BIN"
warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset dof-tax-lien-sale-lists --bulk --ack-large --resume
warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/tax_lien_sale_bulk_verify.sql
```

The raw CSV, parquet, and DuckDB table remain gitignored. The committed proof
receipt records the full row count and checksum. Prediction snapshots are built
from this table by `tools/build_tax_lien_sale_predictions.mjs`; the builder
requires at least three completed historical cycles before the held-out cycle.

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

## Procurement plans (RC-1)

`procurement_plans_run.py` is the host-side collector for the official FY2027
MOCS LL63 and LL1 XLSX indexes plus Capital Projects Dashboard `fb86-vt7u`.
It uses conditional checkpoints, a minimum 1.2-second source cadence, content
hashes, and the shared single-job/headroom guards. Each City Record/PASSPort
bridge is measured independently on a fixed sample; a path emits no edge below
30% or while an agency+title+time candidate lacks a review label.

```bash
warehouse/.venv/bin/python warehouse/scripts/procurement_plans_run.py \
  --from-fixture --force-headroom --output-dir warehouse/raw/procurement-plans-fixture

# Stage two only: live/publish with green headroom. Re-runs resume checkpoints.
warehouse/.venv/bin/python warehouse/scripts/procurement_plans_run.py --publish
```

Tables: `mocs_procurement_plan_files`, `mocs_procurement_plans`,
`capital_projects_dashboard`, and `procurement_plan_bridge_edges`. Stage one
commits the fixture receipt and `site/data/procurement_planning_payload.schema.json`;
it enables no production rows or edges. The dependent Money reader is a later
delivery unit after the production measurement lands.

The public materialization uses `site/data/procurement_planning_payload.json`
as a checksum manifest over deterministic 10,000-row JSON shards in
`site/data/procurement_planning_payload/`. The collector rejects any shard over
20 MiB, leaving deployment headroom below the static-host asset limit while the
raw warehouse payload remains a single resumable build artifact.

## ZAP milestone and disposition statistics

The ZAP bulk receipt profiles milestone/status-date coverage used by the land
prediction models. The full re-materialization must retain non-null min/max
milestone dates and certification-to-final-action pair counts:

```bash
warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset zap-projects --bulk --ack-large --write-sample 25
warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/zap_bulk_verify.sql
node warehouse/scripts/fetch_zap_action_outcomes.mjs
node tools/build_zoning_statistics.mjs
node tools/build_zoning_statistics.mjs --check
```

The bounded action-outcome pass is resumable under the gitignored
`warehouse/raw/zap-action-outcomes/` cache. Committed outputs are the site and
Worker cohort twins plus
`warehouse/receipts/proof/zap-zoning-statistics_latest.json`. The model uses an
unconditioned action-type/borough cohort with an n>=20 back-off; applicant
conditioning belongs in a separate model.

## Incremental / resumable pattern

- Snapshots are **immutable**: `raw/<dataset>/snapshot_date=YYYY-MM-DD/…` and
  matching `parquet/…`.
- Receipts record sha256, row counts, source mode (`fixture` | `soda_limit` |
  `soda_bulk`), headroom snapshots, and catalog registration.
- `--resume` skips stages whose outputs already exist for that snapshot.
- Full `rows.csv?accessType=DOWNLOAD` is the WH-02 path (`--bulk --ack-large`).
- The one-source delta proof is City Record only. It uses the source-specific
  exclusive `(start_date, request_id)` cursor and writes deterministic UTF-8 CSV
  under `raw/city-record/delta_date=YYYY-MM-DD/`, with a
  checkpoint and receipt beside `rows.csv`. A fixture proof, including an
  interrupted resume and an independent final-snapshot equivalence check, runs as:

  ```bash
  node --test test/warehouse_delta_export.test.mjs
  ```

  Live bounded runs use `warehouse/scripts/city_record_delta.py` with an immutable
  `--snapshot`, UTC `--export-date`, `--output-root warehouse/raw`,
  and a deliberate `--max-rows`; re-run incomplete or completed partitions with
  `--resume`. Other sources retain their existing snapshot/collector behavior until
  their cursor semantics are proved separately.
- City Record uses checkpointed 50,000-row SODA pages with a stable
  `start_date, request_id` order. An interrupted pull resumes at the first
  unfinished offset:

  ```bash
  warehouse/.venv/bin/python warehouse/scripts/ingest.py \
    --dataset city-record --bulk --ack-large --resume
  ```

## Query seam

- **Python:** `warehouse/scripts/query.py`
- **Node:** `warehouse/lib/query.mjs` → `queryWarehouse(sql)` / `exampleOcpAwardCount()`
- **OCP lookup:** `warehouse/lib/ocp_lookup.mjs` → `lookupOcpAwardRowsFromWarehouse`
- **ZAP lookup:** `warehouse/lib/zap_lookup.mjs` → `lookupZapProjectFromWarehouse`
- **ZAP BBL lookup:** `warehouse/lib/zap_bbl_lookup.mjs` → `lookupZapBblsFromWarehouse`
- **Entity intelligence index:** `warehouse/lib/entity_intelligence_index.mjs` →
  root + edge rows for cross-domain object links (PIN / contract / payment / BBL)
- **Doing Business lookup (WH-05):** `warehouse/lib/doing_business_lookup.mjs`
- **SQL examples:** `warehouse/sql/examples/`

This is **not** edge ad-hoc SQL. Worker routes keep serving precomputed read
models; warehouse SQL feeds materialization jobs and batch ER.

## Entity-intelligence edge index (join layer)

Cross-domain object links live in `entity_resolution/cross_domain/`. The warehouse
index flattens them for faster root lookup and a DuckDB-shaped query:

```bash
node warehouse/lib/entity_intelligence_index.mjs --from-fixture --limit 400
node warehouse/lib/entity_intelligence_index.mjs --check
# proof: warehouse/receipts/proof/wh_entity_intelligence_index_latest.json
# SQL shape: warehouse/sql/examples/entity_intelligence_index.sql
```

Join keys only when present: PIN, contract_id, payee/payment, BBL↔project.
Product materialization remains `tools/build_entity_intelligence.mjs` (site +
Worker lookup).

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

## WH-05: second bulk + serve ZAP Open Data (own-the-data momentum)

**Bulk pack:** `zap-projects` (`hgx4-8ukb`, ~33k rows) via the same capped
runner (`--bulk --ack-large`). Proof + checksums:
`warehouse/receipts/proof/zap-projects_bulk_latest.json` and
`warehouse/manifests/wh02_load_manifest.json`.

**Replaced live fetch:** `fetchOpenDataRow` in `worker/src/zap_outcomes.mjs` —
every cold `/zap-outcomes` build previously hit SODA `hgx4-8ukb` by
`project_id`.

**Path now:** same WH-03 shape:

1. **Build/ops** queries DuckDB sell-facing slice (+ demos) → materializes
   `site/data/zap_projects_warehouse_lookup.json` + Worker twin.
2. **Edge** looks up the materialization **first** (in-process, sub-ms).
3. **Live SODA** only on miss.

```bash
python3 "$HEADROOM_BIN"   # CONSTRAINED → defer
warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset zap-projects --bulk --ack-large --write-sample 25
warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/zap_bulk_verify.sql
warehouse/.venv/bin/python warehouse/scripts/write_load_manifest.py

# Materialize edge lookup (sell-facing + demos; not full 33k in git)
node tools/build_zap_warehouse_lookup.mjs --bench
node tools/build_zap_warehouse_lookup.mjs --fixture --check
```

Speed receipt: `warehouse/receipts/proof/wh05_zap_lookup_speed.json`.
Product seed: `warehouse/fixtures/zap-projects/product_seed.csv`.

## WH-06: third bulk + serve ZAP BBL (tax-lot join)

**Bulk pack:** `zap-bbl` (`2iga-a6mk`, ~132k rows) via the same capped runner
(`--bulk --ack-large`). Proof + checksums:
`warehouse/receipts/proof/zap-bbl_bulk_latest.json` and
`warehouse/manifests/wh02_load_manifest.json`.

**Replaced live fetch:** `fetchBbls` in `worker/src/zap_outcomes.mjs` — every
cold `/zap-outcomes` DOB tax-lot side-car previously hit SODA `2iga-a6mk` by
`project_id`.

**Path now:** same WH-03/WH-05 shape:

1. **Build/ops** queries DuckDB sell-facing projects' BBLs (+ demos) →
   materializes `site/data/zap_bbl_warehouse_lookup.json` + Worker twin.
2. **Edge** looks up the materialization **first** (in-process, sub-ms).
3. **Live SODA** only on miss.

**Entity links:** land objects in the cross-domain layer gain `sited_on_parcel`
edges (`project:` → `parcel:` + 10-digit BBL) when ZAP BBL join keys exist.
Rebuild entity intelligence after BBL materialization.

```bash
python3 "$HEADROOM_BIN"   # CONSTRAINED → defer
warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset zap-bbl --bulk --ack-large --write-sample 25
warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/zap_bbl_bulk_verify.sql
warehouse/.venv/bin/python warehouse/scripts/write_load_manifest.py

node tools/build_zap_bbl_warehouse_lookup.mjs --bench
node tools/build_zap_bbl_warehouse_lookup.mjs --fixture --check
node tools/build_entity_intelligence.mjs
```

When `zap_bbl` is bulk-loaded independently and the catalog does not also have
the full `zap_projects` table, pass `--all` to materialize the complete
project-to-BBL index instead of the bounded sell-facing/demo set:

```bash
node tools/build_zap_bbl_warehouse_lookup.mjs --all --bench
```

Speed receipt: `warehouse/receipts/proof/wh06_zap_bbl_lookup_speed.json`.
Product seed: `warehouse/fixtures/zap-bbl/product_seed.csv`.

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

# Incremental warehouse slice (after WH-01/02 OCP load; hard limit 200)
warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py --limit 200 \
  --review-receipt warehouse/receipts/proof/wh04_er_batch_live_review_2026-08-05.json

warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/er_entity_links_verify.sql
```

| Guard | Behavior |
|---|---|
| **Single-job lock** | Same `warehouse/.ingest.lock` as ingest |
| **Headroom gate** | Refuses when CONSTRAINED unless `--force-headroom` (fixture only) |
| **taskpolicy / nice** | Warehouse slices go through `headroom.py wrap`; tiny fixture may skip wrap |
| **Live OCP hard limit** | 200 rows; neither headroom override nor another flag widens it |
| **DuckDB threads** | 1 on materialize |

### Materialized views

| View | Grain |
|---|---|
| `er_entity_link` | source_record → canonical_entity (auto_link) |
| `er_canonical_entity` | vendor:stem:… / agency:id:… |
| `er_resolution_run` | batch run + metrics_json |
| `er_pair_receipt` | token_v0 candidate pair scores |
| `er_ocp_vendor_resolved` | OCP awards LEFT JOIN vendor links (when OCP view present) |

Parquet under `warehouse/parquet/er_*/` (gitignored). The proof receipt at
`warehouse/receipts/proof/wh04_er_batch_latest.json` copies the bounded source
fetch metadata, runtime, candidate/accept/ambiguity counts, and an optional
source-hash-gated quality review. The 200-row evidence is not a full-corpus
precision or resource-safety claim.

Pure lib: `warehouse/lib/er_batch.mjs` (imports `entity_resolution/` +
`worker/src/lib/entity_link.mjs` exact-stem builder). Identity is never
reimplemented in SQL.

## NYCEDC project documents (RC-2)

The host-side collector reads the annual NYCEDC project workbook plus NYCIDA and
Build NYC board minutes. It checkpoints downloads, records content hashes and
source locators, and writes `nycedc_documents`, `nycedc_projects`,
`nycedc_project_notice_edges`, plus the `nycedc_project_feed` view. Publisher
index pages receive one polite request; an HTTP 403 is recorded without retry.

```bash
# Deterministic parser, join, and DuckDB proof
warehouse/.venv/bin/python warehouse/scripts/nycedc_project_documents_run.py \
  --from-fixture --limit 25 --force-headroom

# Capped live refresh; requires a green headroom gate
warehouse/.venv/bin/python warehouse/scripts/nycedc_project_documents_run.py \
  --limit 25

# Materialize accepted receipt-backed joins for the Worker notice panel
node tools/build_subsidy_project_lookup.mjs --bench

node tools/build_subsidy_project_lookup.mjs --check
node --test test/nycedc_project_documents.test.mjs \
  test/subsidy_project_panel.test.mjs worker/test/subsidy_project_lookup.test.mjs
```

The versioned payload is
`warehouse/schemas/nycedc_project_feed.v1.schema.json`. City Record edges are
materialized only when the committed fixed-sample receipt clears the 30% join
threshold with every candidate reviewed and no false positives. Missing facts
and unmatched projects remain null/unmatched. A public hearing is never treated
as a board approval without explicit motion and vote language in the minutes.
`site/data/subsidy_project_lookup.json` and its Worker twin contain only accepted
edges; unmatched notice IDs are absent, so the notice page stays unchanged.

## Roadmap

| Card | Scope |
|---|---|
| **WH-01** | Scaffold, CPU-capped skeleton, tiny OCP proof |
| **WH-02** | First bulk export(s) via capped runner — OCP first; ZAP / City Record sequential next |
| **WH-03** | Materialize warehouse OCP → replace live SODA in `fetchOcpAwardRows` (+ live miss fallback) |
| **WH-04** | Batch ER over warehouse → `er_entity_link` parquet + SQL views |
| **WH-05** | ZAP sell-facing materialization (`fetchOpenDataRow`) + Doing Business stem index (`attachDoingBusiness`) |
| **WH-06** | ZAP BBL materialization (`fetchBbls`) + parcel cross-domain edges |
| **Next** | City Record bulk; full Doing Business catalog pack for zero-SODA vendor attach |

## WH-05: Doing Business + ZAP live fetches → warehouse materialization

| Live fetch replaced | Path now |
|---|---|
| `attachDoingBusiness` multi-page SODA `72mk-a8z7` | Warehouse stem index first; full-catalog or all-matched skips SODA; partial fixture keeps SODA gap-fill |
| `fetchOpenDataRow` SODA `hgx4-8ukb` | Materialization by `project_id` first; live SODA on miss |
| Land default Active ULURP rebuild | `fetchLandDefaultProjects` prefers DuckDB when `zap_projects` is packed |

```bash
# Offline / CI
node tools/build_doing_business_warehouse_lookup.mjs --fixture --bench
node tools/build_zap_warehouse_lookup.mjs --fixture --bench

# After capped WH-02 pack of each dataset
warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset doing-business-entities --bulk --ack-large
node tools/build_doing_business_warehouse_lookup.mjs --bench

warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset zap-projects --bulk --ack-large
node tools/build_zap_warehouse_lookup.mjs --bench
```

Speed receipts: `warehouse/receipts/proof/wh05_*_lookup_speed.json`.

## Characterization

```bash
node --test test/warehouse_scaffold.test.mjs test/warehouse_bulk.test.mjs \
  test/warehouse_ocp_lookup.test.mjs test/warehouse_zap_lookup.test.mjs \
  worker/test/ocp_warehouse_lookup.test.mjs worker/test/zap_warehouse_lookup.test.mjs \
  test/warehouse_er_batch.test.mjs test/warehouse_wh05_lookups.test.mjs \
  worker/test/wh05_warehouse_lookups.test.mjs
```

Optional: re-run the fixture ingest before the query assertions if the local
catalog was wiped. Bulk verification needs a prior `--bulk` run (local/Mini only;
CI does not download multi-MB packs).
