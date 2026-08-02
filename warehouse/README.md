# CityScroll data warehouse (WH-01 scaffold)

DuckDB + parquet lake **inside this repo**, for offline ownership of NYC bulk
sources and batch joins. Public browser routes stay **precompute-first** — the
warehouse is the factory; the Worker is the shop window.

Design authority: estate vision report
`cityscroll-data-warehouse-vision` (cards WH-01…WH-04). Captain constraints for
this phase:

1. **Inside crol-list** — `warehouse/` (not a sibling repo).
2. **Incremental** — scaffold + skeleton only; full bulk is **WH-02**.
3. **CPU-disciplined** — never repeat the OpenL3 full-blast CPU hog. Ingest is
   single-job, headroom-gated, `taskpolicy -b` / `nice` wrapped, tiny limits by
   default.

## Layout

```
warehouse/
  datasets.v0.json     # parameterized dataset registry
  fixtures/            # tiny committed samples (offline proof)
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

## CPU discipline (baked into the runner)

| Guard | Behavior |
|---|---|
| **Single-job lock** | `warehouse/.ingest.lock` — second concurrent ingest exits |
| **Headroom gate** | Calls estate `headroom.py --json`; CONSTRAINED refuses (override only with `--force-headroom` for tiny proof) |
| **Row caps** | Default ≤50; soft ack above 1000 (`--ack-large`); hard cap 10k without deliberate WH-02 tooling |
| **taskpolicy / nice** | Live convert path runs under `headroom.py wrap` → `taskpolicy -b` |
| **DuckDB threads** | `PRAGMA threads=1` on convert + catalog |
| **One dataset per invocation** | No fan-out multi-source hoover in this CLI |

Heavy work should prefer the **Mac Mini** overnight, or a capped local batch when
headroom is OK. Never launch parallel full City Record + payroll downloads on
the MacBook.

## Incremental / resumable pattern

- Snapshots are **immutable**: `raw/<dataset>/snapshot_date=YYYY-MM-DD/…` and
  matching `parquet/…`.
- Receipts record sha256, row counts, source mode (`fixture` | `soda_limit`),
  and catalog registration.
- `--resume` skips stages whose outputs already exist for that snapshot.
- WH-02 will add full `rows.csv?accessType=DOWNLOAD` behind the same lock +
  caps, plus dated re-exports / `$where` cursors for deltas.

## Query seam (app later)

- **Python:** `warehouse/scripts/query.py`
- **Node:** `warehouse/lib/query.mjs` → `queryWarehouse(sql)` / `exampleOcpAwardCount()`
- **SQL examples:** `warehouse/sql/examples/`

This is **not** edge ad-hoc SQL. Worker routes keep serving precomputed read
models; warehouse SQL feeds batch jobs (ZAP prewarm WH-03, ER WH-04, lifecycle
export).

## entity_resolution/

Reuse the existing package for identity (`vendorStem`, `token_v0`, matchers).
**Do not** reimplement matchers in SQL. Batch ER over warehouse tables is
**WH-04**. WH-01 only leaves a clear landing zone (parquet tables + registry
ids aligned with `source_contracts.json`).

## Roadmap (do not pull forward)

| Card | Scope |
|---|---|
| **WH-01** (this) | Scaffold, CPU-capped skeleton, tiny OCP proof |
| **WH-02** | Full BULK pack (City Record, ZAP OD, OCP, Doing Business, PASSPort, ABO) — still capped, Mini-first |
| **WH-03** | ZAP outcomes prewarm → Worker read-model cache (kill 12s cold path) |
| **WH-04** | Batch ER over warehouse → `entity_link` parquet |

## Characterization

```bash
node --test test/warehouse_scaffold.test.mjs
```

Optional: re-run the fixture ingest before the query assertions if the local
catalog was wiped.
