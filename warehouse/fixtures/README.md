# Warehouse fixtures

- `ocp-recent-contract-awards/sample.csv` — synthetic rows for offline WH-01
  proof only. Not measured city data. Shape mirrors OCP Recent Contract Awards
  (`qyyg-4tf5`) so ingest → parquet → DuckDB works without network.
- `ocp-recent-contract-awards/product_seed.csv` — public OCP field-case rows
  (request_ids used in lifecycle characterization) so WH-03 materialization
  ships demos offline without bulk download. Not a full corpus export.
- `er-batch/ocp_vendor_variants.csv` — intentional Inc/Incorporated stem
  collisions for WH-04 offline ER proof (not measured city data; synthetic).
- `er-batch/doing_business_sample.csv` — tiny Doing Business-shaped sample so
  the ER batch can show cross-table vendor_stem hits without packing
  `72mk-a8z7`. Synthetic only; phone column is unformatted `55501xx` placeholders
  (not real contacts; not measured from Socrata `72mk-a8z7`).
- `doing-business-entities/sample.csv` + `product_seed.csv` — WH-05 fixture pack
  and product demos (includes public CAMBA field-case shape used by vendor-profile
  characterization). Full `72mk-a8z7` bulk stays local via capped WH-02 runner.
- `zap-projects/sample.csv` — synthetic + demo rows for offline WH-05 fixture
  ingest (`hgx4-8ukb` shape).
- `zap-projects/product_seed.csv` — public ZAP field-case rows (includes demo
  `2022M0258` + sell-facing samples) so WH-05 materialization ships demos
  offline without bulk download. Not a full corpus export.
- `zap-bbl/sample.csv` — synthetic + demo BBL rows for offline WH-06 fixture
  ingest (`2iga-a6mk` shape).
- `zap-bbl/product_seed.csv` — public ZAP BBL rows for product seed project_ids
  (includes demo `2022M0258`) so WH-06 materialization ships demos offline
  without bulk download. Not a full corpus export.
- `bulk_sample.csv` (local only, gitignored) — optional slice from `--write-sample`
  after a bulk run; not committed. Full bulk stays under `warehouse/raw/` /
  `CITYSCROLL_WAREHOUSE_ROOT`; checksums live in
  `warehouse/manifests/wh02_load_manifest.json`.
