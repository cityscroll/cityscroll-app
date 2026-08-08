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
# M/WBE goal-chip solicitation demo (#notice/20260720022) — §6-129 + 30% goal body.
# Hand-checked live City Record sample from solicitation_procurement_method fixtures.
MWBE_SOLICITATION_ROW = {
    "request_id": "20260720022",
    "start_date": _iso(-5),
    "agency_name": "Transportation",
    "type_of_notice_description": "Solicitation",
    "section_name": "Procurement",
    "category_description": "Construction/Construction Services",
    "short_title": "RESIDENT ENGINEERING INSPECTION SERVICES — DOT",
    "pin": "84126MBTR746",
    "due_date": _iso(20),
    "selection_method_description": "Competitive Sealed Proposals",
    "additional_description_1": (
        "This procurement is subject to participation goals for Minority-Owned Business "
        "Enterprises (MBEs) as required by Section 6-129 of the New York Administrative Code. "
        "The MWBE goal for this project is 30%."
    ),
}
# Award sub-outreach demo (#notice/20231222103) — prime vendor for award_prime_goal card.
MWBE_AWARD_ROW = {
    "request_id": "20231222103",
    "start_date": _iso(-30),
    "agency_name": "Design and Construction",
    "type_of_notice_description": "Award",
    "section_name": "Procurement",
    "category_description": "Construction/Construction Services",
    "short_title": "CONSTRUCTION MANAGEMENT SERVICES",
    "pin": "07123E0076001",
    "contract_amount": "4020000",
    "vendor_name": "HNTB CORPORATION",
    "selection_method_description": "Competitive Sealed Proposals",
    "additional_description_1": "Award of construction management services contract.",
}
MWBE_AWARD_LIFECYCLE = {
    "ok": True,
    "request_id": "20231222103",
    "pin": "07123E0076001",
    "pin_strategy": "exact",
    "timeline": [
        {
            "stage": "award",
            "status": "matched",
            "source": "city-record",
            "detail": {
                "vendor": "HNTB CORPORATION",
                "amount": 4020000,
                "request_id": "20231222103",
            },
        },
        {
            "stage": "registered",
            "status": "matched",
            "source": "checkbook-contracts",
            "detail": {
                "vendor": "HNTB Corp",
                "mwbe": "Non-M/WBE",
                "contract_id": "CT107120248803393",
                "current_amount": 4020000,
                "original_amount": 4020000,
                "registration_date": "2024-02-01",
                "start_date": "2024-01-15",
                "end_date": "2026-01-14",
            },
        },
        {"stage": "payment", "status": "unmatched", "source": "checkbook-spending"},
    ],
    "award_prime_goal": {
        "schema": "cityscroll.award_prime_goal.v1",
        "eligible": True,
        "prime": {
            "display_name": "HNTB CORPORATION",
            "stem": "HNTB",
            "subject_ref": "vendor:name:hntb%20corporation",
            "mwbe_category": "Non-M/WBE",
            "sources": ["city-record", "checkbook-contracts"],
        },
        "agency": {
            "display_name": "Design and Construction",
            "canonical_id": "design-and-construction",
            "canonical_name": "Design and Construction",
            "subject_ref": "agency:design-and-construction",
        },
        "dollars": {"amount": 4020000, "source": "city-record", "basis": "contract_amount"},
        "industry_chips": [
            {
                "key": "construction_construction_services",
                "label": "Construction/Construction Services",
                "source": "city-record",
                "field": "category_description",
            }
        ],
        "subcontract_goal": {
            "status": "not_published",
            "class": "not_published",
            "goals": None,
            "goal_percent": None,
            "remaining_percent": None,
            "would_appear_in": "agency or Comptroller subcontract-utilization reports",
            "public_pointer": "https://comptroller.nyc.gov/reports/nyc-contracts/",
        },
        "possible_subcontract_window": {
            "status": "open_candidate",
            "basis": "award_or_registration_with_prime",
            "has_prime": True,
            "has_dollars": True,
            "goal_data": "honest_absent",
        },
        "pin": "07123E0076001",
        "contract_id": "CT107120248803393",
    },
}
NOTICE_PERMALINK_ROW = {
    "request_id": "20260701099", "start_date": _iso(-1), "agency_name": "Housing Preservation and Development",
    "type_of_notice_description": "Solicitation", "category_description": "Construction Services",
    "short_title": "REHABILITATION OF PUBLIC RESTROOMS, CITYWIDE",
    "pin": "8502026HP0099", "due_date": _iso(25), "address_to_request": "100 Gold Street, New York, NY 10038",
    "contact_name": "Jane Roe", "contact_phone": "(212) 555-0100", "email": "rfp@hpd.nyc.gov",
    "selection_method_description": "Competitive Sealed Proposals",
    "additional_description_1": "The Department of Housing Preservation and Development requests proposals for the rehabilitation of public restrooms citywide. Responses are submitted in PASSPort.",
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
# Owner-report exemplar for context-carrying alert entry (Dining Out NYC public hearing).
# Used by demo id alerts-context-carry-notice on hermetic + production deep links.
DINING_OUT_HEARING = {
    "request_id": "20260716009", "start_date": "2026-07-22T00:00:00.000",
    "agency_name": "Transportation",
    "type_of_notice_description": "Public Hearings",
    "section_name": "Public Hearings and Meetings",
    "event_date": "2026-08-06T00:00:00.000",
    "short_title": "Dining Out NYC Public Hearing",
    "additional_description_1": (
        "NOTICE IS HEREBY GIVEN that a public hearing will be held remotely via Zoom "
        "on August 6th, 2026, at 11:00 am, in the matter of proposed revocable consents "
        "authorizing roadway cafes under Dining Out NYC."
    ),
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

PERSONNEL_ROWS = [
    {
        "request_id": "20260729004", "start_date": _iso(-1),
        "agency_name": "Fire Department",
        "short_title": "APPOINTED",
        "additional_description_1": (
            "Effective Date: 07/20/2026; Provisional Status: No; Title Code: 53053; "
            "Reason For Change: APPOINTED; Salary: 49047.00; Employee Name: RIVERA,ANA M."
        ),
    },
    {
        "request_id": "20260729003", "start_date": _iso(-2),
        "agency_name": "Citywide Administrative Services",
        "short_title": "APPOINTED",
        "additional_description_1": (
            "Effective Date: 07/19/2026; Provisional Status: Yes; Title Code: 10026; "
            "Reason For Change: APPOINTED; Salary: 77744.00; Employee Name: RODRIGUEZ,LUIS A."
        ),
    },
    {
        "request_id": "20260729002", "start_date": _iso(-3),
        "agency_name": "Health and Mental Hygiene",
        "short_title": "APPOINTED",
        "additional_description_1": (
            "Effective Date: 07/18/2026; Provisional Status: No; Title Code: 53053; "
            "Reason For Change: APPOINTED; Salary: 52000.00; Employee Name: CHEN,MEI L."
        ),
    },
    {
        "request_id": "20260729001", "start_date": _iso(-4),
        "agency_name": "Citywide Administrative Services",
        "short_title": "APPOINTED",
        "additional_description_1": (
            "Effective Date: 07/17/2026; Provisional Status: No; Title Code: 10026; "
            "Reason For Change: APPOINTED; Salary: 85000.00; Employee Name: WILLIAMS,JORDAN T."
        ),
    },
]

TITLE_CROSSWALK = [
    {
        "title_code": "53053",
        "official_title": "EMERGENCY MEDICAL SPECIALIST-EMT",
        "payroll_title": "EMERGENCY MEDICAL SPECIALIST-EMT",
    },
    {
        "title_code": "10026",
        "official_title": "ADMINISTRATIVE STAFF ANALYST",
        "payroll_title": "ADMINISTRATIVE STAFF ANALYST",
    },
]

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
    # Hermetic field case for ULURP pipeline position + ZAP hearing logistics (#land/2024Q0292).
    {"project_id": "2024Q0292", "project_name": "108-05 68th Road Rezoning",
     "project_brief": "Rezoning a daycare site in Forest Hills, Queens.",
     "primary_applicant": "All My Children Daycare and Nursery School",
     "public_status": "In Public Review", "project_status": "Active", "borough": "Queens",
     "community_district": "Q06", "actions": "ZM; ZR", "mih_flag": "false",
     "current_milestone": "Borough President Review",
     "current_milestone_date": "2026-07-09T00:00:00.000",
     "ulurp_numbers": "260234ZMQ; 260235ZRQ"},
]

# Wave-2 land default snapshot (site/data/land_default_ulurp.json) paints before SODA.
# Hermetic routes must serve the same fixture projects so demo/a11y still see
# "Example Street Rezoning" on #land — list fields only (brief hydrates live).
_LAND_LIST_FIELDS = (
    "project_id", "project_name", "primary_applicant", "public_status", "project_status",
    "borough", "community_district", "actions", "mih_flag", "current_milestone",
    "current_milestone_date", "ulurp_numbers",
)
LAND_DEFAULT_SNAPSHOT = {
    "schema_version": 1,
    "delivery_tier": "inline-at-build",
    "generated_at": _iso(0),
    "source": {
        "name": "Zoning Application Portal projects (Open Data)",
        "dataset": "hgx4-8ukb",
        "url": "https://data.cityofnewyork.us/d/hgx4-8ukb",
    },
    "query": {
        "$select": ",".join(_LAND_LIST_FIELDS),
        "$where": "ulurp_non='ULURP' AND project_status='Active'",
        "$order": "current_milestone_date DESC",
        "$limit": "40",
        "note": "Hermetic fixture mirror of land default snapshot; list fields only.",
    },
    "count": len(ZAP_ROWS),
    "projects": [{k: r[k] for k in _LAND_LIST_FIELDS if k in r} for r in ZAP_ROWS],
}

# Production-stable Property Disposition notice used by the property-bbl-fallback demo.
# Site geography is only in the body (Block/Lot + borough) — no usable street_address_1.
# Exemplar for propertyLocationFromRow body-fallback → BBL 1006440001.
PROPERTY_BBL_FALLBACK_NOTICE = {
    "request_id": "20241112003",
    "start_date": "2024-11-12T00:00:00.000",
    "agency_name": "Small Business Services",
    "type_of_notice_description": "Public Hearing",
    "section_name": "Property Disposition",
    "short_title": "NOTICE OF VOLUNTARY PUBLIC HEARING",
    "event_date": "2024-11-26T10:00:00.000",
    "additional_description_1": (
        "PUBLIC NOTICE IS HEREBY GIVEN THAT a voluntary public hearing will be held on "
        "Tuesday November 26, 2024, commencing at 10:00 am via Conference Call No. "
        "1-555-0100, Access Code 555-0199 relating to the early surrender of the "
        "lease by the tenant of The City of New York (the “City”) on Block 644, Lot 1 "
        "(the “Property”) in the Borough of Manhattan. The Property is currently occupied "
        "by Gansevoort Market, Inc., pursuant to the lease from the City, acting by and "
        "through its Commissioner of the Department of Small Business Services. In order "
        "to access the Public Hearing and testify, please call 1-555-0100."
    ),
}

PROPERTY_ROWS = [
    {"request_id": "20260701006", "start_date": _iso(-3), "agency_name": "Citywide Administrative Services",
     "type_of_notice_description": "Sale by Auction", "event_date": _iso(10),
     "short_title": "PUBLIC AUCTION OF CITY-OWNED PROPERTY, DISPOSITION AREA, BOROUGH OF BROOKLYN",
     "street_address_1": "123 Example Street, Brooklyn, NY",
     "additional_description_1": "Public auction of City-owned property. The minimum upset price for the parcel will be $850,000 per the appraisal."},
    {"request_id": "20260701007", "start_date": _iso(-6), "agency_name": "Parks and Recreation",
     "type_of_notice_description": "Sale", "event_date": _iso(12),
     "short_title": "SALE OF FOREST MANAGEMENT PRODUCTS, PROJECT #5205",
     "additional_description_1": "Sale of an estimated 134,164 board feet of sawtimber."},
    {"request_id": "20260701008", "start_date": _iso(-8), "agency_name": "Police Department",
     "type_of_notice_description": "Notice", "short_title": "OWNERS ARE WANTED FOR PROPERTY IN THE CUSTODY OF THE PROPERTY CLERK",
     "additional_description_1": "Property in the custody of the property clerk division."},
    dict(PROPERTY_BBL_FALLBACK_NOTICE),
]
# Production-stable Agency Rules notice used by the rules-lifecycle-spine demo.
# Matches the live City Record id that joins to NYC Rules commercial-meter parking.
RULES_LIFECYCLE_NOTICE = {
    "request_id": "20260714029",
    "start_date": "2026-07-22T00:00:00.000",
    "agency_name": "Transportation",
    "type_of_notice_description": "Public Hearings",
    "section_name": "Agency Rules",
    "short_title": (
        "Notice of Public Hearing and Opportunity to Comment-  FHV and Taxi Parking "
        "at Commercial Meters and Commercial Vehicle Markings"
    ),
    "event_date": "2026-09-01T10:00:00.000",
    "additional_description_1": (
        "The Department of Transportation proposes to amend rules governing FHV and "
        "taxi parking at commercial meters. The public may submit comments through NYC Rules."
    ),
}

# Production-stable land hearing used by notice-land-zap-spine demo.
# Body carries ULURP C 240046 HAM / C 240047 PQM → warehouse project 2022M0258 (Timbale Terrace).
# source: City Record Online dg92-zbpx request_id 20230912001; ZAP Open Data hgx4-8ukb 2022M0258
NOTICE_LAND_ZAP_SPINE_NOTICE = {
    "request_id": "20230912001",
    "start_date": "2023-09-12T00:00:00.000",
    "event_date": "2023-09-26T18:30:00.000",
    "section_name": "Public Hearings and Meetings",
    "agency_name": "City Planning",
    "type_of_notice_description": "Public Hearings",
    "short_title": "Timbale Terrace",
    "additional_description_1": (
        "Public hearing for ULURP Nos. C 240046 HAM and C 240047 PQM — Timbale Terrace "
        "affordable housing project in East Harlem."
    ),
    "additional_description_2": "",
    "additional_description_3": "",
    "other_info_1": "",
    "other_info_2": "",
    "other_info_3": "",
    "printout_1": "",
    "printout_2": "",
    "printout_3": "",
    "street_address_1": "",
    "building_name": "",
    "city": "New York",
    "state": "NY",
    "zip_code": "10029",
    "pin": "",
}

# Edge /zap-outcomes payload for 2022M0258 (phase-grouped spine on #nland).
# source: same demo shape as tools/capture_notice_land_zap_spine.py / land-event-spine
_NOTICE_LAND_PORTAL = "https://zap.planning.nyc.gov/projects/2022M0258"
_NOTICE_LAND_CR = "https://a856-cityrecord.nyc.gov/RequestDetail/20230912001"
NOTICE_LAND_ZAP_OUTCOMES = {
    "ok": True,
    "cached": True,
    "sections": {
        "project_connections": {
            "schema_version": 1,
            "status": "unavailable",
            "reason": "read_model_unavailable",
        },
    },
    "record": {
        "project_id": "2022M0258",
        "project_name": "Timbale Terrace",
        "public_status": "Completed",
        "portal_url": _NOTICE_LAND_PORTAL,
        "join": {"matched": True, "method": "exact_project_id"},
        "filled": True,
        "n_documents": 1,
        "approved_actions": [
            {"action": "HA", "ulurp_number": "C240046HAM", "status": "Approved"}
        ],
        "dispositions": [],
        "documents": [],
        "dob": {"matched": False, "reason": "Screenshot fixture — no DOB side-car."},
        "open_data": {
            "project_id": "2022M0258",
            "project_name": "Timbale Terrace",
            "public_status": "Completed",
            "ulurp_numbers": "240046HAM; 240047PQM",
            "current_milestone": "HA - Project Completed",
            "current_milestone_date": "2024-03-13",
            "certified_referred": "2023-08-21",
        },
        "project_connections": {
            "schema_version": 1,
            "status": "unavailable",
            "project_ref": "project:2022M0258",
            "reason": "read_model_unavailable",
        },
        "spine": {
            "schema_version": 1,
            "project_id": "2022M0258",
            "events": [
                {
                    "id": "m1",
                    "kind": "zap_milestone",
                    "title": "Land Use Application Filed",
                    "detail": "Completed",
                    "time": {
                        "value": "2023-07-26",
                        "precision": "day",
                        "basis": "actual_end",
                        "certainty": "actual",
                    },
                    "source": {
                        "id": "zap-project-api",
                        "label": "Zoning Application Portal",
                        "url": _NOTICE_LAND_PORTAL,
                    },
                },
                {
                    "id": "m2",
                    "kind": "zap_milestone",
                    "title": "Application Reviewed at City Planning Commission Review Session",
                    "detail": "Certified",
                    "time": {
                        "value": "2023-08-21",
                        "precision": "day",
                        "basis": "review_meeting",
                        "certainty": "actual",
                    },
                    "source": {
                        "id": "zap-project-api",
                        "label": "Zoning Application Portal",
                        "url": _NOTICE_LAND_PORTAL,
                    },
                },
                {
                    "id": "n1",
                    "kind": "city_record_notice_published",
                    "title": "Timbale Terrace public hearing",
                    "detail": "City Planning",
                    "time": {
                        "value": "2023-09-12",
                        "precision": "day",
                        "basis": "publication_date",
                        "certainty": "actual",
                    },
                    "source": {
                        "id": "city-record",
                        "label": "City Record",
                        "url": _NOTICE_LAND_CR,
                    },
                },
                {
                    "id": "n2",
                    "kind": "city_record_hearing",
                    "title": "Timbale Terrace public hearing",
                    "detail": "City Planning",
                    "time": {
                        "value": "2023-09-26",
                        "precision": "day",
                        "basis": "event_date",
                        "certainty": "actual",
                    },
                    "source": {
                        "id": "city-record",
                        "label": "City Record",
                        "url": _NOTICE_LAND_CR,
                    },
                },
                {
                    "id": "d1",
                    "kind": "zap_disposition",
                    "title": "Community Board",
                    "detail": "Conditional Favorable",
                    "time": {
                        "value": "2023-10-24",
                        "precision": "day",
                        "basis": "vote_date",
                        "certainty": "actual",
                    },
                    "source": {
                        "id": "zap-project-api",
                        "label": "Zoning Application Portal",
                        "url": _NOTICE_LAND_PORTAL,
                    },
                },
                {
                    "id": "m3",
                    "kind": "zap_milestone",
                    "title": "City Council Review",
                    "detail": "Approved",
                    "time": {
                        "value": "2024-03-13",
                        "precision": "day",
                        "basis": "actual_end",
                        "certainty": "actual",
                    },
                    "source": {
                        "id": "zap-project-api",
                        "label": "Zoning Application Portal",
                        "url": _NOTICE_LAND_PORTAL,
                    },
                },
            ],
            "gaps": [],
            "lag": {
                "open_data_vs_portal": {
                    "status": "behind",
                    "days": 41,
                    "open_data_date": "2024-02-01",
                    "portal_date": "2024-03-13",
                }
            },
        },
    },
}

# Hermetic /zap-outcomes for #land/2024Q0292 — pipeline sentence + hearing logistics.
_LAND_PIPELINE_PORTAL = "https://zap.planning.nyc.gov/projects/2024Q0292"
LAND_PIPELINE_ZAP_OUTCOMES = {
    "ok": True,
    "cached": True,
    "record": {
        "project_id": "2024Q0292",
        "project_name": "108-05 68th Road Rezoning",
        "public_status": "In Public Review",
        "portal_url": _LAND_PIPELINE_PORTAL,
        "certified_referred": "2026-05-11",
        "join": {"matched": True, "method": "exact_project_id"},
        "filled": True,
        "n_documents": 0,
        "approved_actions": [],
        "dispositions": [],
        "documents": [],
        "dob": {"matched": False, "reason": "Demo fixture — no DOB side-car."},
        "open_data": {
            "project_id": "2024Q0292",
            "project_name": "108-05 68th Road Rezoning",
            "public_status": "In Public Review",
            "borough": "Queens",
            "current_milestone": "Borough President Review",
            "current_milestone_date": "2026-07-09",
        },
        "hearing_logistics": [
            {
                "representing": "Borough President",
                "phase_id": "borough_president",
                "hearing_date": "2026-09-02",
                "hearing_at": "2026-09-02T13:30:00.000Z",
                "hearing_location_raw": (
                    "In person at 120-55 Queens Blvd or livestreamed at "
                    "www.youtube.com/@queensbp"
                ),
                "venue_address": "120-55 Queens Blvd",
                "livestream_url": "https://www.youtube.com/@queensbp",
                "attendance_modes": ["in_person", "livestream"],
                "maps_url": (
                    "https://www.google.com/maps/search/?api=1&query="
                    "120-55%20Queens%20Blvd%2C%20New%20York%2C%20NY"
                ),
                "parse_status": "parsed",
                "portal_url": _LAND_PIPELINE_PORTAL,
                "project_id": "2024Q0292",
                "borough": "Queens",
            }
        ],
        "statutory_clock": {
            "schema_version": 1,
            "statute_ref": "NYC Charter §197-c",
            "status": "open",
            "certified_date": "2026-05-11",
            "total_days": 205,
            "phases": [
                {
                    "phase_id": "community_board",
                    "short": "CB",
                    "label_key": "land_phase_community_board",
                    "days": 60,
                    "due_date": "2026-07-10",
                    "status": "open",
                },
                {
                    "phase_id": "borough_president",
                    "short": "BP",
                    "label_key": "land_phase_borough_president",
                    "days": 30,
                    "due_date": "2026-08-09",
                    "status": "open",
                },
                {
                    "phase_id": "cpc",
                    "short": "CPC",
                    "label_key": "land_phase_cpc",
                    "days": 60,
                    "due_date": "2026-10-08",
                    "status": "open",
                },
                {
                    "phase_id": "city_council",
                    "short": "Council",
                    "label_key": "land_phase_city_council",
                    "days": 50,
                    "due_date": "2026-11-27",
                    "status": "open",
                },
                {
                    "phase_id": "mayoral_appeals",
                    "short": "Mayor",
                    "label_key": "land_phase_mayoral_appeals",
                    "days": 5,
                    "due_date": "2026-12-02",
                    "status": "open",
                },
            ],
        },
        "spine": {
            "schema_version": 1,
            "project_id": "2024Q0292",
            "events": [
                {
                    "id": "cert",
                    "kind": "zap_milestone",
                    "title": "Application Reviewed at City Planning Commission Review Session",
                    "detail": "Certified",
                    "status": "Completed",
                    "time": {
                        "value": "2026-05-11",
                        "precision": "day",
                        "basis": "actual_end",
                        "certainty": "actual",
                    },
                    "source": {
                        "id": "zap-project-api",
                        "label": "Zoning Application Portal",
                        "url": _LAND_PIPELINE_PORTAL,
                    },
                },
                {
                    "id": "cb",
                    "kind": "zap_milestone",
                    "title": "Community Board Review",
                    "detail": "Completed",
                    "status": "Completed",
                    "time": {
                        "value": "2026-07-08",
                        "precision": "day",
                        "basis": "actual_end",
                        "certainty": "actual",
                    },
                    "source": {
                        "id": "zap-project-api",
                        "label": "Zoning Application Portal",
                        "url": _LAND_PIPELINE_PORTAL,
                    },
                },
                {
                    "id": "bp",
                    "kind": "zap_milestone",
                    "title": "Borough President Review",
                    "detail": "In Progress",
                    "status": "In Progress",
                    "time": {
                        "value": "2026-07-09",
                        "precision": "day",
                        "basis": "actual_start",
                        "certainty": "actual",
                    },
                    "source": {
                        "id": "zap-project-api",
                        "label": "Zoning Application Portal",
                        "url": _LAND_PIPELINE_PORTAL,
                    },
                },
            ],
            "gaps": [],
            "lag": {"open_data_vs_portal": {"status": "unknown"}},
        },
    },
}

RULES_ROWS = [
    {"request_id": "20260701009", "start_date": _iso(-1), "agency_name": "Buildings",
     "type_of_notice_description": "Notice of Adoption",
     "short_title": "NOTICE OF ADOPTION OF RULE RELATING TO ELEVATOR INSPECTIONS",
     "additional_description_1": "Notice of adoption of amendments to rules relating to elevator inspections."},
    {"request_id": "20260701010", "start_date": _iso(-2), "agency_name": "Transportation",
     "type_of_notice_description": "Public Hearings", "event_date": _iso(6),
     "section_name": "Agency Rules",
     "short_title": "BRONX CURB MANAGEMENT RULE HEARING",
     "street_address_1": "255 Greenwich Street",
     "additional_description_1": (
         "The hearing will be held at 255 Greenwich Street in Manhattan. "
         "IN THE MATTER OF proposed curb management rules in the Borough of the Bronx."
     )},
    dict(RULES_LIFECYCLE_NOTICE),
]

# Precomputed /rules read model for the lifecycle-spine notice (proposal → hearing → comment).
RULES_VIEW = {
    "schema_version": 2,
    "generated_at": _iso(0),
    "source": {
        "primary": {
            "name": "City Record Online",
            "dataset": "dg92-zbpx",
            "url": "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
        },
        "enrichment": {
            "name": "NYC Rules",
            "feed": "https://rules.cityofnewyork.us/feed/",
            "status": "ok",
        },
    },
    "counts": {
        "total": 1,
        "matched": 1,
        "unmatched_notices": 0,
        "unmatched_rules": 0,
        "by_stage": {"comment-open": 1},
    },
    "rules": [{
        "request_id": RULES_LIFECYCLE_NOTICE["request_id"],
        "agency": RULES_LIFECYCLE_NOTICE["agency_name"],
        "title": RULES_LIFECYCLE_NOTICE["short_title"],
        "notice_date": RULES_LIFECYCLE_NOTICE["start_date"],
        "stage": "comment-open",
        "city_record": {
            "request_id": RULES_LIFECYCLE_NOTICE["request_id"],
            "agency": RULES_LIFECYCLE_NOTICE["agency_name"],
            "title": RULES_LIFECYCLE_NOTICE["short_title"],
            "notice_date": RULES_LIFECYCLE_NOTICE["start_date"],
            "notice_type": RULES_LIFECYCLE_NOTICE["type_of_notice_description"],
        },
        "nyc_rules": {
            "url": "https://rules.cityofnewyork.us/rule/fhv-and-taxi-parking-at-commercial-meters-and-commercial-vehicle-markings/",
            "comment_url": "https://rules.cityofnewyork.us/rule/fhv-and-taxi-parking-at-commercial-meters-and-commercial-vehicle-markings/",
            "pub_date": "2026-07-23T16:18:07.000Z",
            "title": "FHV and Taxi Parking at Commercial Meters and Commercial Vehicle Markings",
            "agency_abbr": "DOT",
            "agency_name": "DOT",
            "adoption_published_at": None,
            "effective_date": None,
            "comment_by_date": "2026-09-01",
            "hearing_date": "2026-09-01",
            "comment_count": 0,
            "summary": "Amend parking rules for for-hire vehicles at commercial meters.",
        },
        "events": [
            {
                "event_type": "proposal_published",
                "valid_at": "2026-07-23T16:18:07.000Z",
                "valid_at_precision": "instant",
                "valid_timezone": "UTC",
                "status": "occurred",
            },
            {
                "event_type": "public_hearing",
                "valid_at": "2026-09-01",
                "valid_at_precision": "day",
                "valid_timezone": "America/New_York",
                "status": "scheduled",
            },
            {
                "event_type": "comment_close",
                "valid_at": "2026-09-01",
                "valid_at_precision": "day",
                "valid_timezone": "America/New_York",
                "status": "scheduled",
                "alert": {"eligible": True, "trigger_field": "valid_at", "lead_days": [14, 3, 1, 0]},
            },
        ],
        "join": {
            "matched": True,
            "confidence": "high",
            "basis": "agency + date + title overlap",
        },
    }],
}
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

# Phase 1b (prior-cycle client swap): priorCycleAwards() reads GET /priorcycle/<request_id>.
# With the worker API otherwise dead in fixtures, that fetch would abort and paint nothing.
# Absence no longer renders prior_cycle_none_* disclaimer copy; a response with empty strict +
# one near match still paints the "Find possible matches" reveal (near_match_reveal_btn), so the
# near_match_* family stays guard-walked. Collapsed near-match body text is not walked.
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
    "source": {"kind": "abo", "dataset": "8w5p-k45m", "authority": "New York City School Construction Authority", "refreshed": "2025-12-01"},
    "ok": True,
}

# Every fixture string value that may surface in the UI as DATA (legitimately English).
# section_name is intentionally omitted — sections render as chrome and must translate.
_DATA_ROWS = ([RFP_OPEN, RFP_OPEN_2, AWARD_ROW, HEARING_ROW, NOTICE_PERMALINK_ROW] + CHAIN_ROWS + PROPERTY_ROWS
              + RULES_ROWS + MEETINGS_ROWS + ZAP_ROWS + PAY_ROLES + CSL_ROLES + PERSONNEL_ROWS + TITLE_CROSSWALK
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
        for row in (
            RFP_OPEN,
            RFP_OPEN_2,
            AWARD_ROW,
            NOTICE_PERMALINK_ROW,
            MWBE_SOLICITATION_ROW,
            MWBE_AWARD_ROW,
            RULES_LIFECYCLE_NOTICE,
            PROPERTY_BBL_FALLBACK_NOTICE,
            NOTICE_LAND_ZAP_SPINE_NOTICE,
            DINING_OUT_HEARING,
            HEARING_ROW,
        ):
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
        return PERSONNEL_ROWS
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
    page.route("https://data.ny.gov/d/**",
               lambda r: r.fulfill(status=200, content_type="text/html",
                                   body="<html><title>ABO dataset</title></html>"))
    page.route("https://data.ny.gov/resource/8w5p-k45m.json*", fixed(AUTHORITY_AWARDS))
    page.route("https://data.ny.gov/resource/d84c-dk28.json*", fixed(AUTHORITY_AWARDS))
    page.route("https://geosearch.planninglabs.nyc/**", fixed({"features": []}))
    page.route("https://services5.arcgis.com/**", fixed({}))
    # Worker API and third-party scripts: dead. Every feature must degrade gracefully.
    page.route("https://api.cityscroll.org/**", lambda r: r.abort())
    # ...except /inv/<name> forecast lookups (see FORECAST_ROWS above) — registered after the
    # catch-all abort so it wins (Playwright matches newest-registered route first).
    page.route("https://api.cityscroll.org/inv/**", fixed(FORECAST_ROWS))
    # ...and /priorcycle/<request_id> (see PRIOR_CYCLE_MATCHES above) — same reason: registered
    # after the catch-all abort so the prior-cycle panel renders and stays guard-covered.
    page.route("https://api.cityscroll.org/priorcycle/**", fixed(PRIOR_CYCLE_MATCHES))
    # ...and /externalaward (awards published elsewhere) — a fuzzy ABO response so the agency
    # profile's external-awards panel renders and stays guard-covered.
    page.route("https://api.cityscroll.org/externalaward*", fixed(EXTERNAL_AWARD))
    # ...and /rules (Agency Rules lifecycle spine). Without a matched record the notice
    # detail fail-softs and never mounts #nrules — the public demo needs a joined spine.
    page.route("https://api.cityscroll.org/rules*", fixed(RULES_VIEW))
    page.route("https://api.cityscroll.org/zap-outcomes?id=2022M0258", fixed(NOTICE_LAND_ZAP_OUTCOMES))
    # Award sub-outreach demo needs award_prime_goal on /contract-lifecycle.
    def contract_lifecycle(route):
        url = route.request.url
        if "id=20231222103" in url or "id%3D20231222103" in url:
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(MWBE_AWARD_LIFECYCLE),
            )
            return
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": False}))
    page.route("https://api.cityscroll.org/contract-lifecycle*", contract_lifecycle)
    page.route("https://crol-worker.crol-worker.workers.dev/**", lambda r: r.abort())
    page.route("https://crol-worker.crol-worker.workers.dev/priorcycle/**", fixed(PRIOR_CYCLE_MATCHES))
    page.route("https://crol-worker.crol-worker.workers.dev/externalaward*", fixed(EXTERNAL_AWARD))
    page.route("https://crol-worker.crol-worker.workers.dev/rules*", fixed(RULES_VIEW))
    page.route("https://crol-worker.crol-worker.workers.dev/zap-outcomes?id=2022M0258",
               fixed(NOTICE_LAND_ZAP_OUTCOMES))
    page.route("https://crol-worker.crol-worker.workers.dev/contract-lifecycle*", contract_lifecycle)
    page.route("https://challenges.cloudflare.com/**", lambda r: r.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda r: r.abort())
    page.route("https://unpkg.com/**", lambda r: r.abort())
    # Committed seed data: empty in fixtures — the guard exercises the live-search path.
    page.route("**/data/people_examples.json", fixed([]))
    page.route("**/data/title_crosswalk.json", fixed(TITLE_CROSSWALK))
    # Wave-2 batch-precompute first paint: align land default snapshot with ZAP_ROWS so
    # #land auto-select still yields "Example Street Rezoning" in hermetic demo/a11y gates.
    page.route("**/data/land_default_ulurp.json", fixed(LAND_DEFAULT_SNAPSHOT))
