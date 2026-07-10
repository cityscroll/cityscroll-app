# CROL-List

CROL-List is a fast, dependency-free interface for searching and tracking **The City Record**—the official daily journal of the City of New York. Under NYC Charter §1066, municipal agencies must publish solicitations, awards, public hearings, regulations, and personnel changes here daily. 

This repository contains the complete system: a single-file static client (`index.html`) and a serverless Cloudflare Worker backend (`worker/`). It is designed to be easily forked and pointed at any city's open-data portal.

*   **Production App:** [crol-list.org](https://crol-list.org/)
*   **Changelog:** [crol-list.org/changelog.html](https://crol-list.org/changelog.html)
*   **System Stats:** [crol-list.org/stats.html](https://crol-list.org/stats.html)

---

## Key Features

### 1. Procurement Lenses
*   **💵 Money:** Follow contracts from RFP → Intent to Award → Award, complete with bidding deadlines, PASSPort links, agency contacts, and CSV exports.
*   **🔮 Predictive Forecasting:** Track upcoming solicitation opportunities 6 months before they are formally published. Fuses historical Checkbook NYC award durations to calculate expiration/renewal cycles, scrapes annual MOCS agency plans, displays a chronological vertical timeline widget on profiles, and triggers early-warning alert notifications.
*   **👤 People:** Explore city job listings, civil service exam statuses, pay scales, and appointment/payroll histories.
*   **🏗 Land:** Map rezonings in plain English, linked to the official City Planning ZAP registry and tax-lot (MapPLUTO) boundary polygons.
*   **🏛 Property:** Track municipal asset auctions (real estate, equipment, timber) and check building demolition statuses.
*   **📋 Rules & 🗓 Meetings:** Monitor regulatory changes, public comment windows, and public hearings.

### 2. Search & Alerts
*   **Subscription Quiz:** Build tailored watches via an onboarding wizard.
*   **Proactive Alerts:** Receive morning email digests or subscribe to live RSS/Atom, JSON, and iCal feeds.
*   **Unified Workspace:** Pin records, write local notes, export CSV/JSON dossiers, and generate shareable snapshot links.

---

## Data Sources

| Source / Portal | Endpoint / ID | Used For |
|---|---|---|
| **City Record Online** (Socrata) | `dg92-zbpx` | core notices: solicitations, awards, rules, meetings |
| **Checkbook NYC API** | `POST /api` (Contracts) | registered amounts, paid-to-date, renewal expiration forecasting |
| **MOCS Procurement Plans** (Socrata) | `whpb-ebtd` | Charter §112 agency solicitation plans (forecasting) |
| **Citywide Payroll** (Socrata) | `k397-673e` | People lens (individual pay histories) |
| **Civil Service List** (Socrata) | `vx8i-nprf` | People lens (exam details) |
| **ZAP Projects** (Socrata) | `hgx4-8ukb` | Land lens (rezonings status) |
| **MapPLUTO** (ArcGIS Online) | `/MAPPLUTO` | Land lens (geographic lot boundary layers) |
| **DOB Job Filings** (Socrata) | `w9ak-ipjd`, `ic3t-wcy2` | Property lens (building demolition verification) |

---

## Architecture

*   **Frontend:** A single [index.html](index.html) built with vanilla JavaScript and CSS. Requests are executed directly from the browser to the open-data APIs.
*   **Backend:** A Cloudflare Worker ([worker/src/](worker/src/)) that manages email alert subscriptions (double opt-in), feed generation, public metrics, and daily digest cron dispatches.
*   **Performance:** Uses an in-memory query cache with request coalescing, skeleton placeholders, and lazy-loaded dependencies (e.g., Leaflet maps) to maximize load speed and visual stability.

---

## Testing & Development

Run tests from the repository root:

*   **Unit Tests:** Run `node --test` to verify entity stem compilers, name resolution, and date logic.
*   **Worker Tests:** Run `node --test` inside the `worker/` directory.
*   **Functional (Playwright) Tests:** Driven against a headless Chromium browser using:
    ```bash
    ./test/functional/run.sh
    ```
    *Requires Python 3 and Playwright (`pip install playwright && playwright install chromium`).*
*   **Production E2E Tests:** Run against the live production deployment using:
    ```bash
    CROL_BASE=https://crol-list.org/ ./test/functional/run.sh
    ```
