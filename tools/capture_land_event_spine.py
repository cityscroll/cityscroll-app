#!/usr/bin/env python3
"""Capture the real Land detail UI with a deterministic event-spine response."""

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
OUT = ROOT / "docs" / "screenshots" / "land-event-spine"
PROJECT_ID = "2022M0258"
PROJECT = {
    "project_id": PROJECT_ID,
    "project_name": "Timbale Terrace",
    "project_brief": "A 19-story mixed-use building with affordable housing in East Harlem.",
    "primary_applicant": "NYC Housing Preservation and Development",
    "public_status": "Completed",
    "project_status": "Complete",
    "borough": "Manhattan",
    "community_district": "M11",
    "actions": "HA; PQ",
    "mih_flag": "false",
    "current_milestone": "City Council Review",
    "current_milestone_date": "2024-02-01T00:00:00.000",
    "ulurp_numbers": "240046HAM; 240047PQM",
}
PORTAL = f"https://zap.planning.nyc.gov/projects/{PROJECT_ID}"
CITY_RECORD = "https://a856-cityrecord.nyc.gov/RequestDetail/20230912001"
SPINE = {
    "schema_version": 1,
    "project_id": PROJECT_ID,
    "events": [
        {"id": "m1", "kind": "zap_milestone", "title": "Land Use Application Filed", "detail": "Completed", "time": {"value": "2023-07-26", "precision": "day", "basis": "actual_end", "certainty": "actual"}, "source": {"id": "zap-project-api", "label": "Zoning Application Portal", "url": PORTAL}},
        {"id": "m2", "kind": "zap_milestone", "title": "Application Reviewed at City Planning Commission Review Session", "detail": "Certified", "time": {"value": "2023-08-30", "precision": "day", "basis": "actual_end", "certainty": "actual"}, "source": {"id": "zap-project-api", "label": "Zoning Application Portal", "url": PORTAL}},
        {"id": "n1", "kind": "city_record_notice_published", "title": "Timbale Terrace public hearing", "detail": "City Planning", "time": {"value": "2023-09-12", "precision": "day", "basis": "publication_date", "certainty": "actual"}, "source": {"id": "city-record", "label": "City Record", "url": CITY_RECORD}},
        {"id": "n2", "kind": "city_record_hearing", "title": "Timbale Terrace public hearing", "detail": "City Planning", "time": {"value": "2023-09-26", "precision": "day", "basis": "event_date", "certainty": "actual"}, "source": {"id": "city-record", "label": "City Record", "url": CITY_RECORD}},
        {"id": "d1", "kind": "zap_disposition", "title": "Community Board", "detail": "Conditional Favorable", "time": {"value": "2023-10-24", "precision": "day", "basis": "vote_date", "certainty": "actual"}, "source": {"id": "zap-project-api", "label": "Zoning Application Portal", "url": PORTAL}},
        {"id": "m3", "kind": "zap_milestone", "title": "City Council Review", "detail": "Approved", "time": {"value": "2024-03-13", "precision": "day", "basis": "actual_end", "certainty": "actual"}, "source": {"id": "zap-project-api", "label": "Zoning Application Portal", "url": PORTAL}},
    ],
    "gaps": [],
    "lag": {"open_data_vs_portal": {"status": "behind", "days": 41, "open_data_date": "2024-02-01", "portal_date": "2024-03-13"}},
}
RECORD = {
    "project_id": PROJECT_ID,
    "project_name": PROJECT["project_name"],
    "public_status": "Completed",
    "portal_url": PORTAL,
    "join": {"matched": True, "method": "exact_project_id"},
    "filled": True,
    "n_documents": 1,
    "approved_actions": [{"action": "HA", "ulurp_number": "C240046HAM", "status": "Approved"}],
    "dispositions": [],
    "documents": [{"name": "Borough President Recommendation.pdf", "url": "https://zap-api-production.herokuapp.com/document/disposition/01QY2C5KIBZCEY6GXBF5GYXG77TTQVOFUG"}],
    "dob": {"matched": False, "reason": "No DOB NOW filings on the project tax lots in the current window."},
    "open_data": PROJECT,
    "spine": SPINE,
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


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_routes(page: Page) -> None:
    page.route("https://**", lambda route: route.abort())
    page.route("https://data.cityofnewyork.us/**", lambda route: json_response(route, []))
    page.route("https://geosearch.planninglabs.nyc/**", lambda route: json_response(route, {"features": []}))

    def zap(route: Route) -> None:
        query = dict(
            (key, values[0])
            for key, values in parse_qs(urlparse(route.request.url).query).items()
        )
        json_response(route, [PROJECT] if f"project_id='{PROJECT_ID}'" in query.get("$where", "") else [])

    def worker(route: Route) -> None:
        if urlparse(route.request.url).path == "/zap-outcomes":
            json_response(route, {"ok": True, "cached": True, "record": RECORD})
        else:
            json_response(route, {})

    page.route("https://data.cityofnewyork.us/resource/hgx4-8ukb.json*", zap)
    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    files = list()
    with StaticServer() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height in ((390, 844), (1440, 900)):
            page = browser.new_page(viewport={"width": width, "height": height})
            errors = list()
            page.on("pageerror", lambda error: errors.append(str(error)))
            install_routes(page)
            page.goto(f"{base_url}#land/{PROJECT_ID}", wait_until="domcontentloaded")
            page.locator("#land-outcomes .land-spine-event").first.wait_for(state="visible")
            assert page.locator("#land-outcomes .land-spine-event").count() == len(SPINE["events"])
            assert "41" in page.locator("#land-outcomes .note.warn").inner_text()
            page.evaluate("document.fonts && document.fonts.ready")
            out = OUT / f"event-spine-{width}.png"
            page.locator("#land-outcomes").screenshot(path=str(out), animations="disabled")
            data = out.read_bytes()
            files.append({"name": out.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "viewport": [width, height]})
            if errors:
                raise AssertionError(errors)
            page.close()
        browser.close()
    (OUT / "manifest.json").write_text(json.dumps({"schema_version": 1, "feature": "land-event-spine", "project_id": PROJECT_ID, "files": files}, indent=2) + "\n")
    print(f"captured {len(files)} event-spine screenshots")


if __name__ == "__main__":
    main()
