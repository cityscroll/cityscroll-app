# CROL-List

**NYC's official record (The City Record), made browsable.** The classifieds of city government.

[The City Record](https://a856-cityrecord.nyc.gov/) is the official daily journal of the City of
New York — by City Charter §1066 every agency must publish its contracts, personnel changes,
hearings, and rezonings there. It's the city's daily newspaper of government, and almost nobody can
read it: a dense stream of disconnected legal notices. **CROL-List** re-links them into something a
person can actually follow.

## What it does — seven lenses

**Three deep lenses** re-stitch a single thread and decode it:

- **💵 Money** — follow a contract from **RFP → Intent to Award → Award ($)**, stitched by PIN, with how-to-respond (deadline, contact, PASSPort), filters, and CSV export.
- **👤 People** — decode any city job: official civil-service title, **competitive (exam) vs non-competitive**, salary band, and a career ladder. Or look up a person → appointment history + payroll.
- **🏗 Land** — rezonings in plain English, cross-referenced to **ZAP** (applicant, what's being built, affordable housing, status) and drawn as the real rezoned tax-lot polygons on a map.

**Three feed lenses** sweep the rest of the daily record — filter by agency or keyword, then add the date to your calendar (`.ics`):

- **🏛 Property** — city property being **sold, auctioned, or disposed** (NYPD auctions, HPD sales, DEP land): what's on the block, the sale date, and where. Each address gets a one-tap **"Still standing?"** check against DOB demolition filings.
- **📋 Rules** — **rules that are changing**: proposed & adopted agency regulations, by agency, with the public-comment **hearing date**.
- **🗓 Meetings** — **public meetings**: Community Boards, City Council, Landmarks, Board of Standards & Appeals, and more.

**And alerts to keep it coming:**

- **🔔 Alerts** — subscribe to a slice (e.g. "rezonings near 79 Rivington," "awards over $1M") and preview the digest, with one-tap **✍ Respond** / **✉** / **☎** built from the notice's own data.

Every lens has an **✨ Ask in plain English** box — type what you want (or tap a sample) and a small model fills the filters and runs the search, with an on-device fallback if the helper is unavailable.

## Architecture

CROL-List is **one self-contained `index.html`** — inline CSS + vanilla JS, no build step — served as a static file on GitHub Pages. **Every query is a live API call from the browser at runtime:** no cached bulk data, no scheduled download, no copy of the datasets in this repo, so it's as fresh as the City publishes (each business day).

```
 ┌────────── index.html (static, GitHub Pages) ──────────┐
 │  vanilla JS ─fetch()→  NYC Open Data / Socrata SODA    │
 │                        • City Record   dg92-zbpx       │
 │                        • Citywide Payroll  k397-673e   │
 │                        • Civil Service List  vx8i-nprf │
 │                        • ZAP projects  hgx4-8ukb       │
 │                        • DOB filings  w9ak-ipjd/ic3t…  │
 │             ─fetch()→  Planning Labs GeoSearch         │
 │             ─query──→  MapPLUTO (ArcGIS) lot polygons  │
 │             ─tiles──→  Leaflet + CARTO basemap         │
 │             ─fetch()→  crol-worker  (optional)         │
 └───────────────────────────────────────────────────────┘
```

The open-data APIs are **CORS-open and need no key**. The one held secret — the model key behind the
plain-English search — lives in **crol-worker**, a tiny separate Cloudflare Worker; the site falls back
to an on-device parser whenever it's absent, so the static page never hard-depends on it.

The only data committed here is two small precomputed snapshots used as seed/reference:
`data/title_crosswalk.json` (~250 roles) and `data/people_examples.json` (~16 seed roles).

## Data sources

| Source | ID / endpoint | Used by |
|---|---|---|
| City Record Online | `dg92-zbpx` (Socrata) | Money · People · Property · Rules · Meetings · Alerts |
| Citywide Payroll | `k397-673e` | People |
| Civil Service List | `vx8i-nprf` | People (exam status) |
| ZAP Projects | `hgx4-8ukb` | Land, Alerts |
| Planning Labs GeoSearch | `geosearch.planninglabs.nyc` | Land, Property (geocoding) |
| MapPLUTO (ArcGIS) | `services5.arcgis.com/…/MAPPLUTO` | Land (tax-lot polygons) |
| DOB job filings | `w9ak-ipjd`, `ic3t-wcy2` | Property ("Still standing?") |
