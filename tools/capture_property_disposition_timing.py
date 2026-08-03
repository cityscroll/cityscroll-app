#!/usr/bin/env python3
"""Before/after screenshots for property disposition-timing cohort estimate.

before: timing model fetch blocked (spine only)
after:  model loads → cohort Estimate line on hearing-matched, auction-empty chain
"""

from __future__ import annotations

import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "property-disposition-timing"
NOTICE_ID = "20241112003"
HISTORY = json.loads(
    (ROOT / "site/data/property_sources/property_disposition_history.json").read_text()
)
NOTICE = next(n for n in HISTORY["notices"] if n["request_id"] == NOTICE_ID)
SODA_ROW = {
    "request_id": NOTICE_ID,
    "short_title": NOTICE.get("short_title") or "NOTICE OF VOLUNTARY PUBLIC HEARING",
    "agency_name": NOTICE.get("agency_name") or "Housing Preservation and Development",
    "section_name": "Property Disposition",
    "type_of_notice_description": NOTICE.get("type_of_notice_description") or "Public Hearings",
    "start_date": NOTICE.get("start_date") or "2024-11-15T00:00:00.000",
    "event_date": NOTICE.get("event_date") or "2024-12-10T00:00:00.000",
    "additional_description_1": NOTICE.get("additional_description_1")
    or "Voluntary public hearing for disposition of City-owned property.",
    "end_date": NOTICE.get("end_date"),
}

SPINE = {
    "schema_version": 1,
    "subject_ref": f"disposition:demo:notice:{NOTICE_ID}",
    "join": {
        "matched": True,
        "method": "single_notice",
        "keys": [],
        "notice_count": 1,
        "agency": SODA_ROW["agency_name"],
    },
    "stages": [
        {
            "kind": "hearing",
            "matched": True,
            "notice_count": 1,
            "request_ids": [NOTICE_ID],
            "events": [
                {
                    "id": f"city-record:{NOTICE_ID}:hearing",
                    "kind": "disposition_hearing",
                    "stage": "hearing",
                    "title": SODA_ROW["short_title"],
                    "request_id": NOTICE_ID,
                    "time": {
                        "value": str(SODA_ROW["event_date"])[:10],
                        "precision": "day",
                        "basis": "event_date",
                        "certainty": "planned",
                    },
                    "source": {
                        "id": "city-record",
                        "label": "City Record Online",
                        "url": f"https://a856-cityrecord.nyc.gov/RequestDetail/{NOTICE_ID}",
                    },
                    "status": "published",
                }
            ],
        },
        {
            "kind": "auction_or_rfp",
            "matched": False,
            "notice_count": 0,
            "request_ids": [],
            "events": [],
        },
        {
            "kind": "award_or_conveyance",
            "matched": False,
            "notice_count": 0,
            "request_ids": [],
            "events": [],
        },
    ],
    "events": [],
    "gaps": [
        {"slot": "auction_or_rfp", "class": "not_yet_ingested", "source": "City Record Online"},
        {"slot": "award_or_conveyance", "class": "not_yet_ingested", "source": "City Record Online"},
    ],
}

PROPERTY_LOCATIONS = {
    "schema_version": 1,
    "properties": [
        {
            **SODA_ROW,
            "property_location": NOTICE.get("property_location"),
            "disposition_stage": "hearing",
            "disposition_subject_ref": SPINE["subject_ref"],
            "disposition_join_keys": [],
        }
    ],
    "disposition_spines": [SPINE],
    "generated_at": "2026-08-03T12:00:00Z",
}


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

    def log_message(self, _fmt, *_args):
        return


def serve():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def install_mocks(page, *, block_model: bool) -> None:
    def soda(route):
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps([SODA_ROW]),
        )

    def property_locations(route):
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(PROPERTY_LOCATIONS),
        )

    def empty_json(route):
        route.fulfill(status=200, content_type="application/json", body="{}")

    page.route("**/resource/dg92-zbpx.json**", soda)
    page.route("**/property-locations**", property_locations)
    page.route("**/contract-lifecycle**", empty_json)
    page.route("**/subsidy-lifecycle**", empty_json)
    page.route("**/meeting-outcomes**", empty_json)
    page.route("**/franchise-concessions**", empty_json)
    page.route("**/rules**", empty_json)
    if block_model:
        page.route(
            "**/property_disposition_timing_model.json**",
            lambda route: route.fulfill(status=404, body="missing"),
        )


def capture(label: str, block_model: bool) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    base = f"http://127.0.0.1:{port}"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1200, "height": 900})
            install_mocks(page, block_model=block_model)
            page.goto(f"{base}/#notice/{NOTICE_ID}", wait_until="networkidle")
            page.wait_for_selector("#ndisposition .chain-h, #ndisposition .lc-stepper", timeout=15000)
            page.wait_for_timeout(800)
            if not block_model:
                page.wait_for_selector("[data-property-disposition-timing]", timeout=10000)
            el = page.query_selector("#ndisposition")
            if el:
                el.scroll_into_view_if_needed()
                page.wait_for_timeout(300)
            path = OUT / f"{label}-notice-{NOTICE_ID}.png"
            # Crop to disposition panel when possible
            if el:
                el.screenshot(path=str(path))
            else:
                page.screenshot(path=str(path))
            has_estimate = page.query_selector("[data-property-disposition-timing]") is not None
            print(f"wrote {path} estimate={has_estimate} block_model={block_model}")
            browser.close()
    finally:
        httpd.shutdown()


def main() -> None:
    capture("before", block_model=True)
    capture("after", block_model=False)


if __name__ == "__main__":
    main()
