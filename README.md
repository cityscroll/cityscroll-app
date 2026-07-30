# CityScroll

CityScroll brings New York City's scattered public-data systems into one place — so you can
follow a procurement from solicitation through award to payment, see one vendor across every
agency they work with, and get an email the morning something you care about appears. No
single city website connects these threads. CityScroll does.

*   **Use it:** [cityscroll.org](https://cityscroll.org/)
*   **Changelog:** [cityscroll.org/changelog.html](https://cityscroll.org/changelog.html)
*   **System Stats:** [cityscroll.org/stats.html](https://cityscroll.org/stats.html)

![CityScroll homepage — contracts, staffing, zoning, property, meetings, and rules, all in one place](docs/readme/homepage.png)

[**Open it →**](https://cityscroll.org/)

---

## What you can do here that the source sites can't do

**Follow a contract end to end — across systems that don't link to each other.**

A single notice page joins the City Record announcement, the Checkbook NYC registration and
payment record, the PASSPort solicitation detail, and the OCP award corroboration —
on one timeline, with every source named.

[![A procurement lifecycle timeline joining City Record, Checkbook NYC, and PASSPort on one notice page](docs/readme/procurement-lifecycle.png)](https://cityscroll.org/#notice/20260724018)

**See one vendor across every agency and every year.**

A vendor profile resolves name variants (punctuation, casing, legal suffixes), totals every
award on record, lists the agencies they win from, and links to every notice that names them.

[![Vendor profile resolving four name variants, $184M across 50 awards and six agencies](docs/readme/vendor-profile.png)](https://cityscroll.org/#vendor/Community%20Mediation%20Services%2C%20Inc.)

**Search procurement notices and get daily alerts.**

Browse open RFPs, recent awards, and closing-soon solicitations in one filterable view, or
describe what you want in plain English ("construction contracts over $500k"). Get a morning
email digest when new matches appear.

[![Procurement search showing open solicitations across multiple agencies](docs/readme/money-search.png)](https://cityscroll.org/#money)

**See the data honestly — with its quirks explained.**

The Data page computes live totals from NYC Open Data: how many notices by section, the
procurement mix, top agencies and vendors. It also explains the data-entry errors it corrects
for (phantom $96 trillion awards, fake 2099 deadlines, 312 raw agency-name strings for ~150
real agencies).

[![The Data page — live per-section counts, procurement mix, and data-quality notes](docs/readme/data-page.png)](https://cityscroll.org/data.html)

---

## What CityScroll covers

### Procurement
Follow contracts from RFP → Intent to Award → Award → Registration → Payments. Each stage
names its source and links back to it. Solicitation pages include bidding deadlines, PASSPort
detail, agency contacts, and document links. Export any view as CSV or Excel.

### Vendors and agencies
Every vendor and agency has a deep-linkable profile page. Vendor pages resolve name variants,
total awards across all agencies, and list every notice that names them. Agency pages show
their procurement history and award patterns.

### Renewal outlook
Historical Checkbook NYC contract terms are used to estimate expiration and renewal timing,
displayed as a timeline on profiles, with six-month early-warning alerts. These are labeled
estimates, not active solicitations.

### Staffing
A plain-language guide to how civil-service hiring works, with open and upcoming exams in one
filterable list. Fees, minimum salaries, and pay-schedule history are shown when DCAS has
published them, with a direct link to the official application step.

### Land use
Rezonings and land-use actions in plain English, linked to the official City Planning ZAP
registry and tax-lot (MapPLUTO) boundary polygons. Project detail pages show decision
documents, action approvals, and disposition votes beyond the status chips on the portal.

### Property
Municipal asset auctions (real estate, equipment, timber) and building demolition filing
statuses.

### Rules and meetings
This week's public hearings by affected borough or neighborhood, with the hearing venue kept
separate from the place a decision concerns. Regulatory changes and public comment windows,
enriched with official comment/adoption links and deadlines from the NYC Rules feed.

---

## Search, alerts, and data tools

*   **Plain-English search:** Type what you're looking for — "shelter services contracts,"
    " rezonings in Brooklyn," "education contracts over $200K" — and CityScroll translates it
    into the right filters.
*   **Email digests:** Describe a watch in plain English, confirm via double opt-in, and
    receive a morning email when new matches appear. Delivers in your chosen language.
*   **Subscribe by email:** Write to `subscribe@crol-list.org` in plain English; the message
    is parsed into a watch and a confirmation link is sent back.
*   **RSS, JSON, and iCal feeds:** Live feeds for any lens, so you can wire CityScroll into
    your own tools.
*   **MCP for AI assistants:** Point any MCP client at `api.cityscroll.org/mcp` to search
    notices and create watches programmatically ([docs](https://cityscroll.org/api.html)).
*   **Multilingual:** The interface switches to Spanish, Simplified Chinese, Russian, and
    other languages via the header selector. Notice text stays in English (it's the official
    record); an unofficial translation is available on demand for shipping languages.
*   **Workspace:** Pin records, write local notes, export CSV/JSON dossiers, and generate
    shareable snapshot links.
*   **Exports:** Download any lens as Excel-safe CSV or a typed Excel workbook, export notice
    details with a contract-trail sheet, or print a clean permalink-stamped view to PDF.

---

## Data Sources

<!-- BEGIN GENERATED SOURCE CONTRACTS -->

The executable registry is [`site/data/source_contracts.json`](site/data/source_contracts.json);
[the generated source ledger](docs/data-sources.md) records coverage, cadence, freshness,
required fields, and known gaps. Required pull-request checks validate recorded upstream
shapes; a separate daily workflow runs the live verifier and reports publisher drift.

| Live source | Used for | Product freshness |
|---|---|---|
| [City Record Online](https://data.cityofnewyork.us/d/dg92-zbpx) `dg92-zbpx` | Core notices, feeds, alerts, profiles, hearings, property records, prior-cycle matches, and aggregates. | Live browser queries use a five-minute cache; Worker mirrors and materialized views refresh daily. |
| [NYCIDA/Build NYC subsidy project records](https://edc.nyc/about-nycedc/financial-public-documents-recordings) | City Record ↔ Build NYC subsidy timeline joins for application, hearing, board, closing, and compliance stages. | Freshness depends on the Build NYC document publication page; the worker caches joined lifecycle records for read-path latency. |
| [Checkbook NYC registered contracts](https://www.checkbooknyc.com/data-feeds/api) `Contracts` | Pending and registered contract amounts, paid-to-date totals, contract terms, and the procurement lifecycle timeline. | Queried live for contract details and daily for watched renewal estimates. |
| [Checkbook NYC spending transactions](https://www.checkbooknyc.com/data-feeds/api) `Spending` | Individual payment records in the procurement lifecycle (solicitation to payment). | Queried by PIN for the contract lifecycle timeline. |
| [Recent Contract Awards (OCP)](https://data.cityofnewyork.us/d/qyyg-4tf5) `qyyg-4tf5` | OCP award side-car on the procurement lifecycle: award date and amount corroboration against City Record, with both sources named when they disagree. | Joined into the precomputed contract lifecycle on the Worker; edge-cached with the lifecycle read model. |
| [Checkbook NYC NYCHA contracts](https://www.checkbooknyc.com/data-feeds/api) `Contracts_NYCHA` | Exact NYCHA solicitation-to-award matches. | Queried by exact notice PIN on demand, with bounded daily prewarming. |
| [NYS Authorities Budget Office — local authorities](https://data.ny.gov/d/8w5p-k45m) `8w5p-k45m` | Possible award matches for mapped local-authority profiles. | Checked weekly; the last good cache is retained if the upstream request fails. |
| [NYS Authorities Budget Office — local development corporations](https://data.ny.gov/d/d84c-dk28) `d84c-dk28` | Possible award matches for mapped local-development-corporation profiles. | Checked weekly; the last good cache is retained if the upstream request fails. |
| [NYS Authorities Budget Office — state authorities](https://data.ny.gov/d/ehig-g5x3) `ehig-g5x3` | Possible award matches for mapped state-authority profiles, including the MTA. | Checked weekly; the last good cache is retained if the upstream request fails. |
| [Citywide Payroll Data](https://data.cityofnewyork.us/d/k397-673e) `k397-673e` | Title and pay history in the Staffing experience. | Queried live with a five-minute browser cache. |
| [Civil Service List (Active)](https://data.cityofnewyork.us/d/vx8i-nprf) `vx8i-nprf` | Competitive-list checks and active-list totals. | Queried live for list checks and captured in the Staffing build. |
| [Zoning Application Portal — projects](https://data.cityofnewyork.us/d/hgx4-8ukb) `hgx4-8ukb` | Rezoning search, status, milestones, applicants, and comments handoff. | Queried live with a five-minute browser cache and used by daily subscriptions. |
| [Zoning Application Portal — tax lots](https://data.cityofnewyork.us/d/2iga-a6mk) `2iga-a6mk` | Tax-lot joins from ZAP projects to MapPLUTO. | Queried live with a five-minute browser cache. |
| [Zoning Application Portal — project outcomes (Planning Labs API)](https://zap.planning.nyc.gov/) | Land detail decision documents, action approvals, disposition votes/recommendations, and DOB NOW tax-lot filing side-car beyond Open Data status chips. | Worker materializes per-project outcomes on GET /zap-outcomes with a one-day edge cache; the browser never calls the ZAP API for this panel. |
| [MapPLUTO](https://www.nyc.gov/content/planning/pages/resources/datasets/mappluto-pluto-change) | Tax-lot boundary geometry. | Queried live for matched ZAP tax lots. |
| [NYC GeoSearch](https://geosearch.planninglabs.nyc/) | Address, neighborhood, borough, and BBL resolution. | Queried live; the verifier checks availability and response shape, not underlying data age. |
| [DOB NOW job application filings](https://data.cityofnewyork.us/d/w9ak-ipjd) `w9ak-ipjd` | Current demolition-filing verification. | Queried live only when a demolition check is requested. |
| [Legacy DOB job application filings](https://data.cityofnewyork.us/d/ic3t-wcy2) `ic3t-wcy2` | Legacy demolition-filing verification. | Queried live as the fallback for demolition checks. |
| [Current Solicitations (OCP / Open Data)](https://data.cityofnewyork.us/d/3khw-qi8f) `3khw-qi8f` | Procurement lifecycle solicitation-stage package enrichment: document links, due dates, and contact fields joined to City Record notices by request_id or PIN. | Joined at lifecycle compute time and cached with the procurement timeline in D1; a stale or unreachable view leaves City Record stages intact and marks the package-documents sub-slot unknown. |
| [NYC Rules RSS feed](https://rules.cityofnewyork.us/) | Rule lifecycle enrichment: official comment/adoption page links, comment deadlines, hearing dates, adoption and effective dates joined to City Record Agency Rules notices. | Daily materialized join in the Worker; a stale or unreachable feed falls back to City Record notices only with an explicit enrichment-gap marker. |
| [NYC Council Legistar API](https://council.nyc.gov/legislation/api/) | Meeting outcomes surface: matching notices to Council agenda trees, voting results, and supporting documents. | Daily materialized read model in the worker; stale views keep user-facing tables usable while upstream is retried. |
| [PASSPort Public contracts](https://a0333-passportpublic.nyc.gov/contracts.html) | Pending and pre-registration contract stages on the procurement lifecycle when Checkbook is unmatched, plus registered-stage enrichment when EPIN joins a City Record PIN. | Worker rebuilds the D1 passport_contracts table on the daily scheduled run; lifecycle reads join from that edge materialization with no live browser fetch to PASSPort. |
| [PASSPort Public solicitations (RFx)](https://a0333-passportpublic.nyc.gov/rfx.html) | RFx detail on solicitation lifecycle stages (due date, method, status, commodity) joined by EPIN to City Record PINs. | Worker rebuilds the D1 passport_rfx table on the daily scheduled run; solicitation lifecycle stages read joined RFx detail from that materialization. |

The external-award registry currently maps 13 agency names to 12 distinct ABO authorities across
`8w5p-k45m`, `d84c-dk28`, `ehig-g5x3`, adds 1 exact NYCHA mapping, and records 16 verified
coverage gaps. ABO joins remain possible matches rather than exact contract identity.

MOCS Local Law 63 plan rows are disabled. The current official page publishes rotating
per-agency spreadsheets without a stable machine manifest; the former configured dataset is
non-tabular, and the former documented dataset does not exist. CityScroll does not show
official plan forecasts until a source passes the executable contract.

<!-- END GENERATED SOURCE CONTRACTS -->

---

## Under the hood

This repository holds the complete system: a static client (`site/`) and a serverless
Cloudflare Worker backend (`worker/`) that handles email alerts, feeds, public metrics, and
the plain-English search assistant. Civil-service exam sources are normalized at build time
into `site/data/staffing_exams.json`, so career exploration needs one small static file and no
runtime API fan-out. Source provenance and refresh rules live in
[`site/data/exam_sources/`](site/data/exam_sources/README.md). The project is designed to be forked and
pointed at any city's open-data portal.

For the code map and how the pieces fit together, see
[CONTRIBUTING.md](CONTRIBUTING.md#geography-of-indexhtml); for backend routes, storage, and
deploy steps, see [worker/README.md](worker/README.md).

---

## Testing & Development

[![CI](https://github.com/cityscroll/crol-list/actions/workflows/ci.yml/badge.svg)](https://github.com/cityscroll/crol-list/actions/workflows/ci.yml)

Both unit layers run automatically in CI on every pull request and push to `main`
(`.github/workflows/ci.yml`); the Playwright functional suite runs on manual dispatch.

Run tests from the repository root:

*   **Unit Tests:** Run `node --test` to verify entity stem compilers, name resolution, and date logic.
*   **Worker Tests:** Run `node --test` inside the `worker/` directory.
*   **Functional (Playwright) Tests:** Driven against a headless Chromium browser using:
    ```bash
    ./test/functional/run.sh
    ```
    *Requires Python 3 and Playwright (`pip install playwright && playwright install chromium`).*
*   **Production E2E Tests:** Run the public demo-link contract against the canonical deployment using:
    ```bash
    CROL_BASE=https://cityscroll.org/ python3 test/functional/20_demo_links.py
    ```
