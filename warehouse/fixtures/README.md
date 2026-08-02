# Warehouse fixtures

- `ocp-recent-contract-awards/sample.csv` — synthetic rows for offline WH-01
  proof only. Not measured city data. Shape mirrors OCP Recent Contract Awards
  (`qyyg-4tf5`) so ingest → parquet → DuckDB works without network.
- `ocp-recent-contract-awards/product_seed.csv` — public OCP field-case rows
  (request_ids used in lifecycle characterization) so WH-03 materialization
  ships demos offline without bulk download. Not a full corpus export.
- `bulk_sample.csv` (local only, gitignored) — optional slice from `--write-sample`
  after a bulk run; not committed. Full bulk stays under `warehouse/raw/` /
  `CITYSCROLL_WAREHOUSE_ROOT`; checksums live in
  `warehouse/manifests/wh02_load_manifest.json`.
