# CROL-List

[The City Record](https://a856-cityrecord.nyc.gov/) is the official daily journal of the City of
New York — by City Charter §1066 every agency must publish its contracts, personnel changes,
hearings, and rezonings there.

**CROL-List** is an interface for searching this information by interest.

## What it does — seven lenses

**Three deep lenses** re-stitch a single thread and decode it:

- **💵 Money** — follow a contract from **RFP → Intent to Award → Award ($)**, stitched by PIN, with how-to-respond (deadline, contact, PASSPort), filters, and CSV export.
- **👤 People** — decode any city job: official civil-service title, **competitive (exam) vs non-competitive**, salary band, and a career ladder. Or look up a person → appointment history + payroll.
- **🏗 Land** — rezonings in plain English, cross-referenced to **ZAP** (applicant, what's being built, affordable housing, status) and drawn as the real rezoned tax-lot polygons on a map.

**Three feed lenses** sweep the rest of the daily record — filter by agency or keyword, then add the date to your calendar (`.ics`):

- **🏛 Property** — city property being **sold, auctioned, or disposed** (NYPD auctions, HPD sales, DEP land): what's on the block, the sale date, and where. Each address gets a one-tap **"Still standing?"** check against DOB demolition filings.
- **📋 Rules** — **rules that are changing**: proposed & adopted agency regulations, by agency, with the public-comment **hearing date**.
- **🗓 Meetings** — **public meetings**: Community Boards, City Council, Landmarks, Board of Standards & Appeals, and more.

**And alerts:**

- **🔔 Alerts** — compose a watch (e.g. "rezonings near 79 Rivington," "awards over $1M"), preview the digest, and **subscribe by email** — a confirmation link starts it. Each notice carries one-tap **✍ Respond** / **✉** / **☎** built from its own data.

Every lens has an **✨ Ask in plain English** box — type what you want (or tap a sample) and a small model fills the filters and runs the search, with an on-device fallback if the helper is unavailable.

## Architecture

CROL-List is one self-contained `index.html` — inline CSS and vanilla JS, no build step — served as a static file on GitHub Pages. Every query is a live API call from the browser, so there is no cached bulk data and nothing to keep in sync; results are as fresh as the City publishes. The open-data APIs are CORS-open and need no key.

The parts that need a secret — plain-English search (a model key) and **email-alert subscriptions** — run in a separate Cloudflare Worker, **crol-worker** (double opt-in; the address is only ever the subscriber's own). When it's unavailable the search falls back to an on-device parser (covered by `test/fallback.test.mjs`), so the page never hard-depends on the Worker. The only committed data is two small seed files, `data/title_crosswalk.json` and `data/people_examples.json`.

## Data sources

| Source | ID / endpoint | Used by |
|---|---|---|
| [City Record Online](https://data.cityofnewyork.us/d/dg92-zbpx) | `dg92-zbpx` (Socrata) | Money · People · Property · Rules · Meetings · Alerts |
| [Citywide Payroll](https://data.cityofnewyork.us/d/k397-673e) | `k397-673e` | People |
| [Civil Service List](https://data.cityofnewyork.us/d/vx8i-nprf) | `vx8i-nprf` | People (exam status) |
| [ZAP Projects](https://data.cityofnewyork.us/d/hgx4-8ukb) | `hgx4-8ukb` | Land, Alerts |
| [Planning Labs GeoSearch](https://geosearch.planninglabs.nyc/) | `geosearch.planninglabs.nyc` | Land, Property (geocoding) |
| [MapPLUTO (ArcGIS)](https://www.nyc.gov/site/planning/data-maps/open-data/dwn-pluto-mappluto.page) | `services5.arcgis.com/…/MAPPLUTO` | Land (tax-lot polygons) |
| [DOB job filings](https://data.cityofnewyork.us/d/w9ak-ipjd) | `w9ak-ipjd`, `ic3t-wcy2` | Property ("Still standing?") |
