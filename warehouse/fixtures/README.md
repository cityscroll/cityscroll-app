# Warehouse fixtures

- `ocp-recent-contract-awards/sample.csv` — synthetic rows for offline WH-01
  proof only. Not measured city data. Shape mirrors OCP Recent Contract Awards
  (`qyyg-4tf5`) so ingest → parquet → DuckDB works without network.
- `ocp-recent-contract-awards/bulk_sample.csv` — first N rows from a real WH-02
  bulk export of Socrata `qyyg-4tf5`, **contact columns stripped** (no email /
  phone / contact name). Full bulk stays gitignored under `warehouse/raw/` (or
  `CITYSCROLL_WAREHOUSE_ROOT`); checksums live in
  `warehouse/manifests/wh02_load_manifest.json`.
