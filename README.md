# CityScroll

CityScroll makes **The City Record** — the official daily journal where every NYC agency
must publish its contracts, hearings, rule changes, rezonings, and staff moves (NYC Charter
§1066) — actually searchable, and emails you the moment something you care about shows up
in it.

*   **Use it:** [cityscroll.org](https://cityscroll.org/)
*   **Changelog:** [cityscroll.org/changelog.html](https://cityscroll.org/changelog.html)
*   **System Stats:** [cityscroll.org/stats.html](https://cityscroll.org/stats.html)

---

## See it in action

**Track a rezoning in your neighborhood.**
*Before:* dig through City Planning's ZAP case portal by project number, or wait for a
neighborhood listserv to notice.
*With CityScroll:* search "Bushwick rezoning" in plain English, follow the project, and get
an email the moment its status changes — mapped against the actual tax lots.

**Catch a contract award before it's old news.**
*Before:* comb the City Record by hand, or wait for a reporter to flag it.
*With CityScroll:* watch any agency or vendor — "construction contract awards over
$500k" — and get notified the day it posts, with the award amount (reconciled against what
Checkbook NYC shows was actually paid), the vendor, and a link to the real notice.

**Get alerts in your own language.**
*Before:* English-only civic data, full stop.
*With CityScroll:* switch the whole interface — search, filters, digests — to Spanish,
Simplified Chinese, or Russian. Notices themselves stay in English (it's the official
record's language), but everything CityScroll adds around them speaks yours.

**Find a path into a City career.**
*Before:* learn civil-service vocabulary, compare a monthly schedule with annual data,
open each Notice of Examination, and then find the separate application system.
*With CityScroll:* the Staffing guide explains the process in plain language, puts open and
upcoming exams in one filterable list, shows fees and minimum salaries when DCAS has
published them, and links each applicant to the official next step.

## Key Features

### 1. Procurement Lenses
*   **💵 Money:** Follow contracts from RFP → Intent to Award → Award, complete with bidding deadlines, PASSPort links, agency contacts, and CSV exports. Profiles for nine public authorities also show their latest official state-filed awards, clearly labeled as annual filings that may lag by a year.
*   **🔮 Predictive Forecasting:** Track upcoming solicitation opportunities 6 months before they are formally published. Fuses historical Checkbook NYC award durations to calculate expiration/renewal cycles, scrapes annual MOCS agency plans, displays a chronological vertical timeline widget on profiles, and triggers early-warning alert notifications.
*   **👤 Staffing:** Learn how civil-service hiring works, browse open and upcoming exams by interest, share a specific exam, and compare City titles, pay scales, and appointment histories.
*   **🏗 Land:** Map rezonings in plain English, linked to the official City Planning ZAP registry and tax-lot (MapPLUTO) boundary polygons.
*   **🏛 Property:** Track municipal asset auctions (real estate, equipment, timber) and check building demolition statuses.
*   **📋 Rules & 🗓 Meetings:** Find this week's public hearings by affected borough or neighborhood, with the hearing venue kept separate from the place a decision concerns; monitor regulatory changes and public comment windows.

### 2. Search & Alerts
*   **Subscription Quiz:** Build tailored watches via an onboarding wizard.
*   **Subscribe by Email:** Write to `subscribe@crol-list.org` in plain English; an LLM parses it into a watch and replies with a double-opt-in confirmation link.
*   **MCP for AI Assistants:** Point any MCP client at `api.cityscroll.org/mcp` to search notices and create/preview watches programmatically ([docs](https://cityscroll.org/api.html)).
*   **Proactive Alerts:** Receive morning email digests (queued per-subscriber delivery with independent retries) or subscribe to live RSS/Atom, JSON, and iCal feeds. Alerts deliver in your chosen language.
*   **Multilingual UI:** Switch the interface to Spanish, Simplified Chinese, or Russian via the header language selector; your preference is remembered. City Record notices remain in English (the official source language).
*   **[The Data](https://cityscroll.org/data.html):** the City Record at a glance — sections, volume, procurement mix, top agencies/vendors by cleaned dollars — computed live in the browser.
*   **Unified Workspace:** Pin records, write local notes, export CSV/JSON dossiers, and generate shareable snapshot links.
*   **Workflow exports:** Download any lens as Excel-safe CSV or a typed Excel workbook, export notice details with a separate contract-trail sheet, or print a clean permalink-and-date-stamped view to PDF.

---

## Data Sources

| Source / Portal | Endpoint / ID | Used For |
|---|---|---|
| **City Record Online** (Socrata) | `dg92-zbpx` | core notices: solicitations, awards, rules, meetings |
| **Checkbook NYC API** | `POST /api` (`Contracts`, `Contracts_NYCHA`) | registered amounts, paid-to-date, renewal expiration forecasting, and date-guarded NYCHA solicitation matches |
| **NYS Authorities Budget Office** (Socrata) | `8w5p-k45m`, `d84c-dk28` | recent official awards on nine mapped public-authority profiles; annual filings may lag by a year |
| **MOCS Procurement Plans** (Socrata) | `whpb-ebtd` | Charter §112 agency solicitation plans (forecasting) |
| **Citywide Payroll** (Socrata) | `k397-673e` | People lens (individual pay histories) |
| **Civil Service List** (Socrata) | `vx8i-nprf` | People lens (exam details) |
| **Annual Examination Schedule** (Socrata) | `4ptz-hmtc` | upcoming DCAS exams and application windows |
| **DCAS Exam Schedules and NOEs** | [nyc.gov/examsforjobs](https://www.nyc.gov/examsforjobs) | current open exams, official job details, fees, waivers, and application action |
| **ZAP Projects** (Socrata) | `hgx4-8ukb` | Land lens (rezonings status) |
| **MapPLUTO** (ArcGIS Online) | `/MAPPLUTO` | Land lens (geographic lot boundary layers) |
| **DOB Job Filings** (Socrata) | `w9ak-ipjd`, `ic3t-wcy2` | Property lens (building demolition verification) |

---

## Under the hood

This repository holds the complete system: a static client (`index.html`) and a serverless
Cloudflare Worker backend (`worker/`) that handles email alerts, feeds, public metrics, and
the plain-English search assistant. Civil-service exam sources are normalized at build time
into `data/staffing_exams.json`, so career exploration needs one small static file and no
runtime API fan-out. Source provenance and refresh rules live in
[`data/exam_sources/`](data/exam_sources/README.md). The project is designed to be forked and
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
