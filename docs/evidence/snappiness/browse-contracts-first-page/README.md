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
