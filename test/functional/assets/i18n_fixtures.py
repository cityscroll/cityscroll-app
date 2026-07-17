"""Hermetic fixture dataset + Playwright network stubs for the stray-English guard.

Every upstream the client touches is intercepted here, so the guard (and any spec that
imports this) runs with NO live network: deterministic rows, deterministic counts, runs
in CI on every PR. The fixture numbers for the Today strip reproduce the 2026-07-13
status report exactly (36 notices / 16 agencies; Procurement 26, Public Comment on
Contract Awards 8, Public Hearings and Meetings 1, Agency Rules 1).

DATA vs CHROME is the load-bearing distinction: values that come from these rows
(agency names, titles, vendors, methods, statuses…) legitimately stay English —
they are official-source data. `data_values()` exports exactly those strings so the
guard can allow them. section_name is deliberately NOT exported: section names are
rendered as navigation chrome (the Today strip, agency profiles) and MUST translate.
"""
import json
import re
from datetime import datetime, timedelta
from urllib.parse import urlparse, parse_qs

_now = datetime.now()


def _iso(days_from_now, hour=12):
    d = _now + timedelta(days=days_from_now)
    return d.strftime(f"%Y-%m-%dT{hour:02d}:00:00.000")


TODAY_EDITION = _iso(0)[:10]

SECTION_COUNTS = [
    {"section_name": "Procurement", "n": "26"},
    {"section_name": "Public Comment on Contract Awards", "n": "8"},
    {"section_name": "Public Hearings and Meetings", "n": "1"},
    {"section_name": "Agency Rules", "n": "1"},
]

AGENCIES_TODAY = [{"agency_name": n} for n in [
    "Housing Preservation and Development", "Design and Construction", "Environmental Protection",
    "Police Department", "Transportation", "Parks and Recreation", "Health and Mental Hygiene",
    "Education", "Fire Department", "Sanitation", "Buildings", "Homeless Services",
    "Citywide Administrative Services", "City Planning", "Small Business Services", "Law Department",
]]

RFP_OPEN = {
    "request_id": "20260701001", "start_date": _iso(-9), "agency_name": "Housing Preservation and Development",
    "type_of_notice_description": "Solicitation", "category_description": "Construction Services",
    "short_title": "CONSTRUCTION OF AFFORDABLE HOUSING UNITS AT 123 EXAMPLE STREET, BROOKLYN",
    "pin": "8502026HP0001", "due_date": _iso(5), "address_to_request": "100 Gold Street, New York, NY 10038",
    "contact_name": "Jane Roe", "contact_phone": "(212) 555-0100", "email": "rfp@hpd.nyc.gov",
    "selection_method_description": "Competitive Sealed Proposals",
    "additional_description_1": "The Department of Housing Preservation and Development requests proposals for the construction of affordable housing units at 123 Example Street. Interested vendors should obtain the solicitation package via PASSPort.",
}
RFP_OPEN_2 = {
    "request_id": "20260701002", "start_date": _iso(-4), "agency_name": "Design and Construction",
    "type_of_notice_description": "Solicitation", "category_description": "Services (other than human services)",
    "short_title": "RESIDENT ENGINEERING INSPECTION SERVICES, CITYWIDE",
    "pin": "TBD", "due_date": _iso(12),
    "selection_method_description": "Sole Source",
    "additional_description_1": "Resident engineering inspection services for citywide infrastructure projects.",
}
AWARD_ROW = {
    "request_id": "20260701003", "start_date": _iso(0), "agency_name": "Environmental Protection",
    "type_of_notice_description": "Award", "category_description": "Construction/Construction Services",
    "short_title": "CITY WATER TUNNEL SHAFT REHABILITATION, STAGE TWO",
    "pin": "8262026EP0007", "contract_amount": "12500000", "vendor_name": "EXAMPLE BUILDERS INC",
    "selection_method_description": "Competitive Sealed Bids",
    "additional_description_1": "Award of contract for rehabilitation of water tunnel shafts.",
}
# Dedicated #notice/ permalink fixture (crol-hotfix3-m8): a Solicitation with every
# how-to-respond field populated (contact/address/email, like RFP_OPEN) so the guard's
# deep-link walk exercises the full glance + action-button + how-to-respond chrome. due_date
# is deliberately >14 days out -- deadlineTag()'s dl<=14 branch spells single digits as
# hardcoded English words via _spellNum() (a separate, pre-existing i18n gap, out of this
# hotfix's class-focused scope) which would make this fixture fail the guard for an
# unrelated reason if due_date landed inside that window.
NOTICE_PERMALINK_ROW = {
    "request_id": "20260701099", "start_date": _iso(-1), "agency_name": "Housing Preservation and Development",
    "type_of_notice_description": "Solicitation", "category_description": "Construction Services",
    "short_title": "REHABILITATION OF PUBLIC RESTROOMS, CITYWIDE",
    "pin": "8502026HP0099", "due_date": _iso(25), "address_to_request": "100 Gold Street, New York, NY 10038",
    "contact_name": "Jane Roe", "contact_phone": "(212) 555-0100", "email": "rfp@hpd.nyc.gov",
    "selection_method_description": "Competitive Sealed Proposals",
    "additional_description_1": "The Department of Housing Preservation and Development requests proposals for the rehabilitation of public restrooms citywide.",
}
CHAIN_ROWS = [
    dict(RFP_OPEN),
    {**AWARD_ROW, "pin": "8502026HP0001", "agency_name": "Housing Preservation and Development",
     "request_id": "20260701004", "start_date": _iso(-2)},
]
CLOSING_ROW = dict(RFP_OPEN)
HEARING_ROW = {
    "request_id": "20260701005", "start_date": _iso(0), "agency_name": "City Planning Commission",
    "type_of_notice_description": "Public Hearings", "event_date": _iso(3),
    "short_title": "NOTICE OF PUBLIC HEARING ON PROPOSED ZONING MAP AMENDMENT",
    "street_address_1": "120 Broadway, New York, NY",
    "additional_description_1": "A public hearing will be held by the City Planning Commission in the matter of a proposed zoning map amendment.",
}
METHOD_FACET = [
    {"selection_method_description": "Competitive Sealed Proposals", "n": "20"},
    {"selection_method_description": "Sole Source", "n": "6"},
]
AGENCY_STATS = [{"n": "12", "total": "340000000"}]

PAY_ROLES = [
    {"title_description": "AGENCY ATTORNEY", "n": "120", "mn": "60000", "mx": "120000", "avg": "90000"},
    {"title_description": "ASSOCIATE ATTORNEY", "n": "45", "mn": "80000", "mx": "150000", "avg": "110000"},
]
CSL_ROLES = [{"list_title_desc": "AGENCY ATTORNEY"}]

ZAP_ROWS = [
    {"project_id": "P2026K0001", "project_name": "Example Street Rezoning",
     "project_brief": "A zoning map amendment to facilitate a nine-story mixed-use building with approximately 120 dwelling units.",
     "primary_applicant": "Example Development LLC", "public_status": "In Public Review",
     "project_status": "Active", "borough": "Brooklyn", "community_district": "3",
     "actions": "ZM;ZR", "mih_flag": "true", "current_milestone": "City Planning Commission Review",
     "current_milestone_date": _iso(-10), "ulurp_numbers": "C260001ZMK"},
    {"project_id": "P2026Q0002", "project_name": "Sample Avenue Rezoning",
     "project_brief": "A rezoning of Sample Avenue.", "primary_applicant": "Sample Partners LP",
     "public_status": "Completed", "project_status": "Completed", "borough": "Queens",
     "community_district": "7", "actions": "ZM", "mih_flag": "false",
     "current_milestone": "Approved", "current_milestone_date": _iso(-60), "ulurp_numbers": "C260002ZMQ"},
]

PROPERTY_ROWS = [
    {"request_id": "20260701006", "start_date": _iso(-3), "agency_name": "Citywide Administrative Services",
     "type_of_notice_description": "Sale by Auction", "event_date": _iso(10),
     "short_title": "PUBLIC AUCTION OF CITY-OWNED PROPERTY, DISPOSITION AREA, BOROUGH OF BROOKLYN",
     "street_address_1": "123 Example Street, Brooklyn, NY",
     "additional_description_1": "Public auction of City-owned property. The minimum upset price for the parcel will be $850,000 per the appraisal."},
    {"request_id": "20260701007", "start_date": _iso(-6), "agency_name": "Parks and Recreation",
     "type_of_notice_description": "Sale", "short_title": "SALE OF FOREST MANAGEMENT PRODUCTS, PROJECT #5205",
     "additional_description_1": "Sale of an estimated 134,164 board feet of sawtimber."},
    {"request_id": "20260701008", "start_date": _iso(-8), "agency_name": "Police Department",
     "type_of_notice_description": "Notice", "short_title": "OWNERS ARE WANTED FOR PROPERTY IN THE CUSTODY OF THE PROPERTY CLERK",
     "additional_description_1": "Property in the custody of the property clerk division."},
]
RULES_ROWS = [
    {"request_id": "20260701009", "start_date": _iso(-1), "agency_name": "Buildings",
     "type_of_notice_description": "Notice of Adoption",
     "short_title": "NOTICE OF ADOPTION OF RULE RELATING TO ELEVATOR INSPECTIONS",
     "additional_description_1": "Notice of adoption of amendments to rules relating to elevator inspections."},
]
MEETINGS_ROWS = [dict(HEARING_ROW)]

EDITION_RANGE = [{"a": "2003-09-17T00:00:00.000", "b": _iso(0)}]

# w9-05 (leak L4): agency/vendor forecast cards render a "Subscribe to Alert" button that was
# untranslated in the live site but invisible to the guard, because /inv/<name> was aborted —
# hasForecasts stayed false and the button never rendered. A minimal real response lets the
# guard actually walk this surface instead of silently skipping it.
FORECAST_ROWS = {"forecasts": [
    {"source": "checkbook", "vendor_name": "EXAMPLE BUILDERS INC",
     "agency_name": "Housing Preservation and Development", "amount": "500000",
     "expiration_date": _iso(60)[:10]},
    {"source": "mocs", "description": "PLANNED ELEVATOR MAINTENANCE RFP",
     "agency": "Housing Preservation and Development", "value_band": "$1M-$5M",
     "release_quarter": "Q3 2026"},
]}

# Phase 1b (prior-cycle client swap): index.html's priorCycleAwards() now reads the precomputed
# GET /priorcycle/<request_id> endpoint instead of firing its own SODA queries. With the worker
# API otherwise dead in fixtures, that fetch would abort and the panel would render nothing —
# silently dropping the prior_cycle_*/near_match_* strings out of the guard's coverage. A minimal
# real response (empty strict + a positive eligibleCount + one near match) makes the notice-detail
# panel render the low-confidence none-note (a prior_cycle_* string) and the "look for looser
# matches" reveal summary (a near_match_* string), so both string families stay guard-walked. The
# near candidate's own text sits inside the collapsed <details> body (never visible → never walked)
# and needs no data_values() registration.
PRIOR_CYCLE_MATCHES = {
    "id": "20260701099",
    "strict": [],
    "eligibleCount": 1,
    "near": [{
        "c": {"request_id": "20260701003", "start_date": _iso(-400),
              "short_title": "CITY WATER TUNNEL SHAFT REHABILITATION, STAGE TWO",
              "contract_amount": "12500000", "vendor_name": "EXAMPLE BUILDERS INC",
              "pin": "8262026EP0007"},
        "reasons": [{"kind": "title", "words": ["rehabilitation"]},
                    {"kind": "amount", "a": "12000000", "b": "12500000"}],
        "score": 0.43,
    }],
    "ok": True,
}

AUTHORITY_AWARDS = [{
    "authority_name": "New York City School Construction Authority",
    "vendor_name": "ROUX ENVIRONMENTAL ENGINEERING AND GEOLOGY DPC",
    "procurement_description": "HAZARDOUS MATERIAL ENGINEERING SERVICES",
    "award_process": "Authority Contract - Competitive Bid",
    "award_date": "2024-05-06T00:00:00.000",
    "contract_amount": "$5,000,000.00",
}]

# GET /externalaward now serves the precomputed award set (external_award.mjs). The agency-profile
# walk opens a covered ABO agency (School Construction Authority) and expects its fuzzy award panel,
# so the worker endpoint is stubbed with a fuzzy response carrying one normalized award + provenance
# (mirrors AUTHORITY_AWARDS above, in the endpoint's normalized shape). Same reason /priorcycle and
# /inv are stubbed after the catch-all abort: keep the new surface guard-covered.
EXTERNAL_AWARD = {
    "agency": "New York City School Construction Authority",
    "coverage": "fuzzy",
    "agencyAwards": [{
        "authority": "New York City School Construction Authority",
        "vendor": "ROUX ENVIRONMENTAL ENGINEERING AND GEOLOGY DPC",
        "description": "HAZARDOUS MATERIAL ENGINEERING SERVICES",
        "process": "Authority Contract - Competitive Bid",
        "date": "2024-05-06T00:00:00.000", "amount": 5000000, "source": "nys-abo",
    }],
    "source": {"kind": "abo", "dataset": "8w5p-k45m", "refreshed": "2025-12-01"},
    "ok": True,
}

# Every fixture string value that may surface in the UI as DATA (legitimately English).
# section_name is intentionally omitted — sections render as chrome and must translate.
_DATA_ROWS = ([RFP_OPEN, RFP_OPEN_2, AWARD_ROW, HEARING_ROW, NOTICE_PERMALINK_ROW] + CHAIN_ROWS + PROPERTY_ROWS
              + RULES_ROWS + MEETINGS_ROWS + ZAP_ROWS + PAY_ROLES + CSL_ROLES
              + AGENCIES_TODAY + METHOD_FACET + FORECAST_ROWS["forecasts"] + AUTHORITY_AWARDS)
_DATA_FIELDS_EXCLUDED = {"section_name"}


def data_values():
    vals = set()
    for row in _DATA_ROWS:
        for k, v in row.items():
            if k in _DATA_FIELDS_EXCLUDED or not isinstance(v, str):
                continue
            if any(c.isalpha() for c in v):
                vals.add(v)
    return vals


def _soda_response(url):
    q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
    sel, where, group = q.get("$select", ""), q.get("$where", ""), q.get("$group", "")
    order = q.get("$order", "")
    if "max(start_date) as m" in sel:
        return [{"m": _iso(0)}]
    if "min(start_date) as a" in sel:
        return EDITION_RANGE
    if group == "section_name":
        return SECTION_COUNTS
    if group == "agency_name" and "start_date='" in where:
        return AGENCIES_TODAY
    if group == "agency_name":
        return AGENCIES_TODAY[:6]
    if group == "selection_method_description":
        return METHOD_FACET
    if group == "vendor_name":
        return []
    if "count(1) as n, sum(contract_amount) as total" in sel:
        return AGENCY_STATS
    if "count(1) as n" in sel:
        return [{"n": "5"}]
    if "sum(contract_amount) as t" in sel:
        return [{"t": "1200000"}]
    if sel == "start_date,due_date":
        return []  # agencyNorms ad-window sample: too small → no flag
    if "request_id='" in where:
        m = re.search(r"request_id='([^']*)'", where)
        rid = m.group(1) if m else None
        for row in (RFP_OPEN, RFP_OPEN_2, AWARD_ROW, NOTICE_PERMALINK_ROW):
            if row.get("request_id") == rid:
                return [row]
        return []
    if "pin='" in where:
        return CHAIN_ROWS
    if "section_name='Public Hearings and Meetings'" in where:
        return MEETINGS_ROWS
    if "section_name='Property Disposition'" in where:
        return PROPERTY_ROWS
    if "section_name='Agency Rules'" in where:
        return RULES_ROWS
    if "section_name='Changes in Personnel'" in where:
        return []
    if "type_of_notice_description='Award'" in where:
        return [AWARD_ROW]
    if "type_of_notice_description='Solicitation'" in where:
        return [RFP_OPEN, RFP_OPEN_2]
    return []


def install_routes(page):
    """Intercept every upstream. Local files (index.html, i18n.js, data/*.json) still load
    from the CROL_BASE http server; everything remote is deterministic or dead."""
    def soda(route):
        route.fulfill(status=200, content_type="application/json",
                      body=json.dumps(_soda_response(route.request.url)))

    def fixed(body):
        return lambda route: route.fulfill(status=200, content_type="application/json",
                                           body=json.dumps(body))

    # NOTE: Playwright matches routes newest-first — register catch-alls BEFORE specifics.
    page.route("https://data.cityofnewyork.us/**", fixed([]))
    page.route("https://data.cityofnewyork.us/resource/dg92-zbpx.json*", soda)
    page.route("https://data.cityofnewyork.us/resource/k397-673e.json*",
               lambda r: r.fulfill(status=200, content_type="application/json",
                                   body=json.dumps(PAY_ROLES if "group" in r.request.url else [])))
    page.route("https://data.cityofnewyork.us/resource/vx8i-nprf.json*", fixed(CSL_ROLES))
    page.route("https://data.cityofnewyork.us/resource/hgx4-8ukb.json*", fixed(ZAP_ROWS))
    page.route("https://data.cityofnewyork.us/resource/2iga-a6mk.json*", fixed([]))
    page.route("https://data.ny.gov/**", fixed([]))
    page.route("https://data.ny.gov/resource/8w5p-k45m.json*", fixed(AUTHORITY_AWARDS))
    page.route("https://data.ny.gov/resource/d84c-dk28.json*", fixed(AUTHORITY_AWARDS))
    page.route("https://geosearch.planninglabs.nyc/**", fixed({"features": []}))
    page.route("https://services5.arcgis.com/**", fixed({}))
    # Worker API and third-party scripts: dead. Every feature must degrade gracefully.
    page.route("https://api.crol-list.org/**", lambda r: r.abort())
    # ...except /inv/<name> forecast lookups (see FORECAST_ROWS above) — registered after the
    # catch-all abort so it wins (Playwright matches newest-registered route first).
    page.route("https://api.crol-list.org/inv/**", fixed(FORECAST_ROWS))
    # ...and /priorcycle/<request_id> (see PRIOR_CYCLE_MATCHES above) — same reason: registered
    # after the catch-all abort so the prior-cycle panel renders and stays guard-covered.
    page.route("https://api.crol-list.org/priorcycle/**", fixed(PRIOR_CYCLE_MATCHES))
    # ...and /externalaward (awards published elsewhere) — a fuzzy ABO response so the agency
    # profile's external-awards panel renders and stays guard-covered.
    page.route("https://api.crol-list.org/externalaward*", fixed(EXTERNAL_AWARD))
    page.route("https://crol-worker.crol-worker.workers.dev/**", lambda r: r.abort())
    page.route("https://crol-worker.crol-worker.workers.dev/priorcycle/**", fixed(PRIOR_CYCLE_MATCHES))
    page.route("https://crol-worker.crol-worker.workers.dev/externalaward*", fixed(EXTERNAL_AWARD))
    page.route("https://challenges.cloudflare.com/**", lambda r: r.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda r: r.abort())
    page.route("https://unpkg.com/**", lambda r: r.abort())
    # Committed seed data: empty in fixtures — the guard exercises the live-search path.
    page.route("**/data/people_examples.json", fixed([]))
    page.route("**/data/title_crosswalk.json", fixed([]))
