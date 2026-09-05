# Warehouse-backed first-class refresh

Most first-class resident datasets are refreshed daily by the
`First-class dataset refresh` workflow, which runs the acquisition and owning
builder that `site/data/source_contracts.json#first_class_artifacts` declares
for each one.

A hosted runner cannot refresh every dataset. `site/data/ocp_awards_warehouse_lookup.json`
and its dependants are materialised from the retained analytical warehouse — a
DuckDB catalog plus the ingest receipts that record each source snapshot's
checksum and row count. The catalog is deliberately not in the repository, and
the builder refuses to fall back to fixture or seed rows, so on a runner without
a catalog the acquisition fails and the last verified artifact is kept. The
scheduled workflow records that failure in its run summary rather than hiding it.

These datasets refresh on the machine that holds the warehouse:

| dataset | owning builder |
| --- | --- |
| `site/data/ocp_awards_warehouse_lookup.json` | `tools/build_ocp_warehouse_lookup.mjs` |
| `site/data/money_resident_snapshot.json` | `tools/build_ocp_warehouse_lookup.mjs` |
| `site/data/procurement_browse_rows.json` | `tools/build_ocp_warehouse_lookup.mjs` |
| `site/data/procurement_browse_query.json` | `tools/build_ocp_warehouse_lookup.mjs` |
| `site/data/analytics_registered_contracts.json` | `tools/build_analytical_registered_contracts.mjs` |
| `site/data/analytics_payments.json` | `tools/build_analytical_payments.mjs` |
| `site/data/analytics_performance_evidence.json` | `tools/build_analytical_performance_evidence.mjs` |
| `site/data/zap_projects_warehouse_lookup.json` | `tools/build_zap_warehouse_lookup.mjs` |

## Installing the scheduled job

`com.cityscroll.first-class-refresh.plist` and `run-warehouse-refresh.sh` are a
job definition, not an installed job. Nothing in this repository installs them.

On the machine that holds the warehouse:

1. Confirm the catalog is present. `warehouse/lib/catalog.mjs` resolves it from
   `CITYSCROLL_WAREHOUSE_ROOT`, falling back to the repository's `warehouse/`
   directory, and expects `duckdb/cityscroll.duckdb` plus a `receipts/`
   directory under that root.
2. Copy `run-warehouse-refresh.sh` somewhere stable and make it executable.
3. Edit the plist: set `CITYSCROLL_REPO` to the checkout, `CITYSCROLL_WAREHOUSE_ROOT`
   to the warehouse root, and `GH_TOKEN` to a token that can open a pull request.
4. Install it: `cp com.cityscroll.first-class-refresh.plist ~/Library/LaunchAgents/`
   then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cityscroll.first-class-refresh.plist`.
5. Rehearse once by hand before relying on the schedule:
   `CITYSCROLL_REPO=… CITYSCROLL_WAREHOUSE_ROOT=… ./run-warehouse-refresh.sh --dry-run`.

The script refreshes only the datasets that are due, writes the freshness
report, and opens a pull request when something changed. It never pushes to the
default branch and never merges.
