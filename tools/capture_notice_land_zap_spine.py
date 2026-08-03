#!/usr/bin/env python3
"""Cache-busted before/after captures for notice-level ZAP project spine.

BEFORE: City Record land notice page without the notice→ZAP timeline mount
        (module import aborted — residual gap state prior to this change).
AFTER:  same notice with warehouse ULURP join + edge /zap-outcomes spine
        (phase-grouped stepper, statutory clocks when present).
"""

from __future__ import annotations

import functools
import hashlib
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "notice-land-zap-spine"
NOTICE_ID = "20230912001"
PROJECT_ID = "2022M0258"

NOTICE = {
    "request_id": NOTICE_ID,
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

PORTAL = f"https://zap.planning.nyc.gov/projects/{PROJECT_ID}"
CITY_RECORD = f"https://a856-cityrecord.nyc.gov/RequestDetail/{NOTICE_ID}"

SPINE = {
    "schema_version": 1,
    "project_id": PROJECT_ID,
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
            "source": {"id": "zap-project-api", "label": "Zoning Application Portal", "url": PORTAL},
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
            "source": {"id": "zap-project-api", "label": "Zoning Application Portal", "url": PORTAL},
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
            "source": {"id": "city-record", "label": "City Record", "url": CITY_RECORD},
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
            "source": {"id": "city-record", "label": "City Record", "url": CITY_RECORD},
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
            "source": {"id": "zap-project-api", "label": "Zoning Application Portal", "url": PORTAL},
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
            "source": {"id": "zap-project-api", "label": "Zoning Application Portal", "url": PORTAL},
        },
    ],
    "gaps": [],
    # source: same lag fixture as tools/capture_land_event_spine.py (demo 2022M0258)
    "lag": {
        "open_data_vs_portal": {
            "status": "behind",
            "days": 41,
            "open_data_date": "2024-02-01",
            "portal_date": "2024-03-13",
        }
    },
}

RECORD = {
    "project_id": PROJECT_ID,
    "project_name": "Timbale Terrace",
    "public_status": "Completed",
    "portal_url": PORTAL,
    "join": {"matched": True, "method": "exact_project_id"},
    "filled": True,
    "n_documents": 1,
    "approved_actions": [{"action": "HA", "ulurp_number": "C240046HAM", "status": "Approved"}],
    "dispositions": [],
    "documents": [],
    "dob": {"matched": False, "reason": "No DOB NOW filings in the current window."},
    "open_data": {
        "project_id": PROJECT_ID,
        "project_name": "Timbale Terrace",
        "public_status": "Completed",
        "ulurp_numbers": "240046HAM; 240047PQM",
        "current_milestone": "HA - Project Completed",
        "current_milestone_date": "2024-03-13",
        "certified_referred": "2023-08-21",
    },
    "spine": SPINE,
    "statutory_clock": {
        "status": "closed",
        "phases": [
            {
                "phase_id": "community_board",
                "label_key": "land_phase_community_board",
                "days": 60,
                "due_date": "2023-10-20",
            }
        ],
    },
    # source: screenshot fixture shape from site/data/zoning_statistics.json (illustrative rates only)
    "zoning_statistics": {
        "n": 40,
        "action_type": "ha",
        "train_from": "2018-01-01",
        "outcome_rates": {"approved": 0.72, "modified": 0.18, "disapproved": 0.1},
        "typical_months": {"low": 8, "high": 18},
        "formula_url": "about.html#zoning-base-rates",
    },
}

WAREHOUSE = {
    "schema_version": 1,
    "phase": "WH-05",
    "rows": [
        {
            "project_id": PROJECT_ID,
            "project_name": "Timbale Terrace",
            "public_status": "Completed",
            "ulurp_numbers": "240046HAM; 240047PQM",
            "borough": "Manhattan",
            "primary_applicant": "HPD",
            "current_milestone": "HA - Project Completed",
        }
    ],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def json_response(route: Route, body: object, status: int = 200) -> None:
    route.fulfill(status=status, content_type="application/json", body=json.dumps(body))


def install_common_routes(page: Page) -> None:
    page.route("https://**", lambda route: route.abort())
    page.route("https://data.cityofnewyork.us/**", lambda route: json_response(route, []))
    page.route("https://geosearch.planninglabs.nyc/**", lambda route: json_response(route, {"features": []}))

    def soda(route: Route) -> None:
        query = dict(
            (key, values[0])
            for key, values in parse_qs(urlparse(route.request.url).query).items()
        )
        where = query.get("$where", "")
        if f"request_id='{NOTICE_ID}'" in where or f'request_id="{NOTICE_ID}"' in where:
            json_response(route, [NOTICE])
        else:
            json_response(route, [])

    page.route("https://data.cityofnewyork.us/resource/dg92-zbpx.json*", soda)


def install_before_routes(page: Page) -> None:
    """Simulate pre-change residual gap: notice page has no land-spine module."""
    install_common_routes(page)

    def block_module(route: Route) -> None:
        route.fulfill(status=404, content_type="text/plain", body="not found")

    page.route("**/notice_land_spine.mjs", block_module)

    def worker(route: Route) -> None:
        json_response(route, {})

    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)


def install_after_routes(page: Page) -> None:
    install_common_routes(page)

    def warehouse(route: Route) -> None:
        json_response(route, WAREHOUSE)

    page.route("**/data/zap_projects_warehouse_lookup.json*", warehouse)

    def worker(route: Route) -> None:
        path = urlparse(route.request.url).path
        if path == "/zap-outcomes":
            json_response(route, {"ok": True, "cached": True, "record": RECORD})
        elif path == "/meeting-outcomes" or path.endswith("/meeting-outcomes"):
            json_response(route, {"ok": True, "record": {"join": {"matched": False}}})
        else:
            json_response(route, {})

    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)


def capture_state(
    page: Page,
    base_url: str,
    *,
    mode: str,
    width: int,
    height: int,
) -> dict:
    if mode == "before":
        install_before_routes(page)
    else:
        install_after_routes(page)

    page.goto(f"{base_url}#notice/{NOTICE_ID}", wait_until="domcontentloaded")
    page.locator("#noticeview .route-item, #noticeview .rolename").first.wait_for(
        state="visible", timeout=15000
    )
    # Wait for notice body to settle.
    page.wait_for_timeout(800)

    if mode == "after":
        page.locator("#nland [data-notice-land-spine='1']").first.wait_for(
            state="visible", timeout=15000
        )
        page.locator("#nland .land-phase-stepper").first.wait_for(state="visible", timeout=10000)
        # Ensure statutory / base-rate registers still paint (no regression).
        assert page.locator("#nland .land-phase-stepper").count() >= 1
        assert "Timbale" in page.locator("#nland").inner_text() or "2022M0258" in page.locator(
            "#nland"
        ).inner_text()
    else:
        # Residual gap: mount absent or empty — no phase stepper on the notice.
        page.wait_for_timeout(400)
        assert page.locator("#nland .land-phase-stepper").count() == 0
        assert page.locator("#nland [data-notice-land-spine='1']").count() == 0

    page.evaluate("document.fonts && document.fonts.ready")
    out = OUT / f"{mode}-{width}.png"
    # Prefer the land mount when filled; otherwise the notice panel.
    target = page.locator("#nland") if mode == "after" else page.locator("#noticeview .route-item")
    if mode == "after":
        # Include a bit of notice context: scroll nland into view and capture panel slice.
        page.locator("#nland").scroll_into_view_if_needed()
        page.locator("#noticeview .route-item").screenshot(path=str(out), animations="disabled")
    else:
        target.screenshot(path=str(out), animations="disabled")
    data = out.read_bytes()
    return {
        "name": out.name,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "viewport": [width, height],
        "mode": mode,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    files = list()
    with StaticServer() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for mode in ("before", "after"):
            for width, height in ((390, 844), (1440, 900)):
                page = browser.new_page(viewport={"width": width, "height": height})
                errors = list()
                page.on("pageerror", lambda error: errors.append(str(error)))
                files.append(
                    capture_state(page, base_url, mode=mode, width=width, height=height)
                )
                # Module-load 404 is expected in before mode; ignore that class of error.
                real = list(e for e in errors if "notice_land_spine" not in e)
                if real:
                    raise AssertionError(real)
                page.close()
        browser.close()

    manifest = {
        "schema_version": 1,
        "feature": "notice-land-zap-spine",
        "notice_id": NOTICE_ID,
        "project_id": PROJECT_ID,
        "files": files,
        "notes": (
            "before = notice page without notice_land_spine module (residual gap); "
            "after = warehouse ULURP join + phase-grouped /zap-outcomes spine on #nland."
        ),
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"captured {len(files)} notice-land-zap-spine screenshots → {OUT}")


if __name__ == "__main__":
    main()
