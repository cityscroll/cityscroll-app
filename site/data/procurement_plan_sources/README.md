# Procurement-plan sources

RC-1 collects the official FY2027 MOCS [Local Law 63 agency
plans](https://www.nyc.gov/site/mocs/resources/standard-prof-services-ll63.page),
[Local Law 1 M/WBE plans](https://www.nyc.gov/site/mocs/resources/m-wbe-ll1.page),
and NYC Open Data [Capital Projects Dashboard
`fb86-vt7u`](https://data.cityofnewyork.us/d/fb86-vt7u).

The host-side collector treats the MOCS pages as manifests for changing XLSX
files. It uses conditional checkpoints, content hashes, an honest User-Agent,
and at least 1.2 seconds between publisher requests. A 403 stops the source
without retrying. Raw workbooks remain gitignored. The production checksum
manifest points to deterministic, receipt-backed JSON shards containing 11,566
normalized MOCS rows and 50,000 Capital Projects rows; the
DuckDB catalog and raw publisher files remain local warehouse materializations.

## Bridge doctrine

Each LL63, LL1, or capital-project path to City Record and PASSPort has a
separate fixed modern sample. Publisher identifiers may match deterministically.
Agency+title+time candidates require an explicit precision-review label. A path
below 30%, or with an incomplete review, emits no edges. Unmatched plans and
notices stay separate, and an agency total is never treated as a row budget.

The framework proof is
`warehouse/receipts/proof/rc1_procurement_plans_framework_latest.json`. The
production receipt is
`verification_receipts/procurement_plans_2026-08-04.json`. Each of its six
100-row bridge samples measured 0%, so no production edge materialized and the
dependent Money planning reader remains inert.
