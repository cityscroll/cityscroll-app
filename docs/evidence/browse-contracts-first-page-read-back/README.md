# Browse Contracts bounded first page

For a cold, non-default Contracts view backed by the Award/Archive query
projection, `site/app/money-list.mjs`'s `search()` renders the first 40 rows
from the bounded manifest and compact query rows in
`site/procurement_browse_query.mjs`. The full resident snapshot is only a
reconciliation input for post-paint lineage, so its fetch is deferred until
after the bounded page has already painted rather than started ahead of it.

A query the bounded projection cannot answer — free text, a scoped
vendor/contract reference, or an analytics drill-through, none of which the
compact rows carry — keeps the existing full read, and the fallback reason is
recorded on `globalThis.CROL_BROWSE_READ_PATH_RECEIPT` for inspection rather
than happening silently. Open and All RFPs are not eligible for the bounded
path at all: that projection is built from the same registered/award corpus
as Recent Awards and Archive, not the City Record solicitation feed those two
modes read.

`manifest.json` is a functional network-order trace (no browser, no image
capture) against the tracked `site/data/procurement_browse_rows.json`
fixture: it records the fetch call order and event order for a cold Recent
Awards view filtered by agency, and confirms the first 40 rows match a full,
unbounded read of the same fixture exactly.

Rebuild or verify with:

```bash
node tools/capture_browse_contracts_first_page.mjs
node tools/capture_browse_contracts_first_page.mjs --check
```

Covering tests: `test/procurement_browse_first_page.test.mjs`,
`test/procurement_browse_query.test.mjs`.

## Production content-ready read-back

`read-back.json` records the grouped production RUM read-back for Browse
Contracts page-level `content_ready_ms` (surface `browse-contracts`, component
`none`). Procedure, baseline, and result notes also live in
`data/performance/field-rum-readiness-2026-08-26.md`.

| Field | Value |
| --- | --- |
| Queried at (UTC) | 2026-09-06T14:10:07.421Z |
| Window (UTC) | 2026-08-30T14:10:07.000Z → 2026-09-06T14:10:07.000Z |
| Window status | complete |
| Traffic class | production |
| Sample floor | 30 retained rows |
| Retained observations | 48 |
| p50 / p75 / p95 | 2241.4 ms / 3039.3 ms / 7615.4 ms |
| Result | `needs-work` — sample floor met; p75 and p95 still above 2500 ms / 5000 ms |

The post-delivery window since the bounded-first-page merge
(2026-09-05T21:09:25Z → 2026-09-06T14:10:07Z) retains only 4 observations, so
it is recorded as `insufficient_sample` with percentiles withheld.

```bash
ANALYTICS_ACCOUNT_ID=<from worker/wrangler.toml> \
ANALYTICS_READ_TOKEN=<from the logged-in wrangler OAuth session> \
RUM_ANALYTICS_DATASET=crol_rum_observations_v1 \
RUM_MEASURED_SINCE=2026-08-19 \
RUM_MIN_SAMPLED_ROWS=30 \
node tools/read_rum_drift.mjs --out <output-dir>
```
