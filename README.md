# CROL-List

[The City Record](https://a856-cityrecord.nyc.gov/) is the official daily journal of the City of
New York — by City Charter §1066 every agency must publish its contracts, personnel changes,
hearings, and rezonings there.

**CROL-List** is an interface for searching this information by interest.

> Maintenance rule: this README is updated with every significant feature change — if a lens,
> route, or behavior ships, its description lands here in the same session.

## The front page

The masthead opens with **Today's Edition** — the latest edition's date, "N notices from M
agencies," per-section counts that deep-link into the matching lens, and three feature cards
(closing-soon RFP, largest award of the edition, next public hearing), each a permalink to its
notice.

## What it does — seven lenses

**Three deep lenses** re-stitch a single thread and decode it:

- **💵 Money** — follow a contract from **RFP → Intent to Award → Award ($)**, stitched by PIN, with how-to-respond (deadline, contact, PASSPort), filters, a **⏳ Closing this week** quick filter, and CSV export.
- **👤 People** — opens with **16 example role chips** (from committed seed data — instant, no network) plus a 250-title typeahead; decode any city job: official civil-service title, **competitive (exam) vs non-competitive**, salary band, and a career ladder. Or look up a person → appointment history + payroll.
- **🏗 Land** — rezonings in plain English, cross-referenced to **ZAP** (applicant, what's being built, affordable housing, status) and drawn as the real rezoned tax-lot polygons on a map.

**Three feed lenses** sweep the rest of the daily record — filter by agency or keyword, then add the date to your calendar (`.ics`):

- **🏛 Property** — an **asset-type explorer**: tabs with live counts (Real property · Forest/timber · Vehicles+equipment · Medallions · Seized/unclaimed) derived from the notice text, a lifecycle rail (Proposed → Closing soon → Upcoming → Past), and labeled dollar badges ("upset price $850,000", "$1 nominal") — never a price filter, because the data can't support one honestly. Each address keeps the one-tap **"Still standing?"** DOB-demolition check.
- **📋 Rules** — **rules that are changing**: proposed & adopted agency regulations, by agency, with the public-comment **hearing date**.
- **🗓 Meetings** — **public meetings**: Community Boards, City Council, Landmarks, Board of Standards & Appeals, and more.

**And alerts:**

- **🔔 Alerts** — every lens toolbar has **"🔔 Watch this search"**, which carries the current filters into a prefilled watch; a **60-second onboarding quiz** (topic chips → optional narrowing → frequency) builds one from scratch. Preview the digest live, then **subscribe by email** — double opt-in, one-click unsubscribe. The same watch is also available as **RSS/Atom, JSON Feed, and a subscribable `.ics` calendar** via the worker's `/feed.*` routes.

**Cross-cutting:**

- **Entity pages & pivots** — every agency and vendor mention on the site is a link. `#agency/<name>` profiles an agency (awarded totals, notices by section deep-linking into each lens, top vendors with share bars, open RFPs, upcoming hearings, prefilled watch buttons); `#vendor/<name>` profiles a vendor with **read-time name resolution** (case/punctuation/legal-suffix stems — "Sinergia Inc" and "Sinergia Incorporated" resolve to one profile, variants listed), totals, agencies-they-win-from, and notices naming them. Money also has a **selection-method facet** (live counts, Datasette-style; round-trips through the URL).
- **Permalinks everywhere** — every tab + filter state mirrors into the URL (`#rules?agency=Buildings&q=scaffold`), and every notice has a canonical address (`#notice/<request_id>`) rendering a single-notice view with a utility bar (copy link / email / print / add-to-calendar / City Record) and the PIN paper trail. Digest emails and feeds link here.
- **At-a-glance box** — notice details open with a deterministic **Who / What / When / Act** summary extracted from the record's own fields (agency acronyms spelled out, deadlines as countdown chips); the original legalese sits below a "Read the full notice" fold. Deadline chips run site-wide (oxblood ≤3 days, amber ≤14).
- **✨ Ask in plain English** on every lens — a small model fills the filters and runs the search, with an on-device fallback if the helper is unavailable.
- **Accessibility** — WAI-ARIA tabs with arrow-key navigation, keyboard-operable result rows, live-region result announcements, focus rings, skip link, `prefers-reduced-motion`; on phones, filters collapse behind a ☰ toggle.

## Architecture

CROL-List is one self-contained `index.html` — inline CSS and vanilla JS, no build step — served as a static file on GitHub Pages. Every query is a live API call from the browser, so there is no cached bulk data and nothing to keep in sync; results are as fresh as the City publishes. The open-data APIs are CORS-open and need no key.

The parts that need a secret or a server — plain-English search (a model key), **email-alert
subscriptions** (double opt-in; the address is only ever the subscriber's own), and the
**`/feed.xml` / `/feed.json` / `/feed.ics`** feed routes — run in a separate Cloudflare Worker,
**crol-worker** (sibling repo; see its README for routes and the daily digest cron). When it's
unavailable the search falls back to an on-device parser (covered by `test/fallback.test.mjs`),
so the page never hard-depends on the Worker. The only committed data is two small seed files,
`data/title_crosswalk.json` and `data/people_examples.json`, which power the People lens's
instant example chips and title typeahead.

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
