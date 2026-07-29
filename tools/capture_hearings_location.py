#!/usr/bin/env python3
"""Verify and capture the location-aware hearings surface at review widths."""

from __future__ import annotations

import functools
import json
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "hearings-location"
VIEWPORTS = ((390, 844), (1440, 900))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def future_date(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT14:00:00.000")


def hearing_payload() -> dict[str, object]:
    source = "https://a856-cityrecord.nyc.gov/RequestDetail/"
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "hearings": [
            {
                "request_id": "QUEENS-101",
                "source_section": "Public Hearings and Meetings",
                "agency": "City Planning",
                "notice_type": "Public Hearing",
                "title": "Sunnyside neighborhood rezoning",
                "event_date": future_date(2),
                "published_at": future_date(-4),
                "decides": "Whether to approve a zoning change near Queens Boulevard",
                "affects": ["audience_land_use"],
                "affected_area": {
                    "scope": "local",
                    "boroughs": ["Queens"],
                    "neighborhoods": ["Sunnyside"],
                    "community_districts": ["2"],
                    "community_boards": ["Community Board 2, Queens"],
                    "addresses": [{
                        "label": "37-18 Queens Boulevard",
                        "borough": "Queens",
                        "neighborhood": "Sunnyside",
                    }],
                    "street_ranges": [{
                        "label": "Queens Boulevard between 39th Street and 43rd Street",
                    }],
                    "tax_lots": [{"label": "Block 123, Lot 45"}],
                    "project_names": ["Sunnyside Yard plan"],
                    "application_numbers": ["C250001ZMQ"],
                },
                "venue": {
                    "mode": "hybrid",
                    "building": "NYC Planning Commission Hearing Room",
                    "address": "120 Broadway, New York, NY, 10271",
                    "borough": "Manhattan",
                    "neighborhood": "Financial District",
                },
                "participation": {
                    "links": [{"label": "Join online", "url": "https://example.org/join"}],
                    "emails": [],
                    "phones": [],
                    "source_url": source + "QUEENS-101",
                },
                "source_url": source + "QUEENS-101",
                "description": "The commission will hear testimony on a proposed zoning map change in Sunnyside, Queens Community District 2.",
            },
            {
                "request_id": "RULE-202",
                "source_section": "Agency Rules",
                "agency": "Department of Transportation",
                "notice_type": "Rule Hearing",
                "title": "Dining Out NYC sidewalk and roadway dining rules",
                "event_date": future_date(3),
                "published_at": future_date(-5),
                "decides": "How permanent outdoor dining may use sidewalks and roadways",
                "affects": ["audience_restaurants"],
                "affected_area": {
                    "scope": "citywide",
                    "boroughs": [],
                    "neighborhoods": [],
                    "community_districts": [],
                    "addresses": [],
                },
                "venue": {
                    "mode": "virtual",
                    "building": "",
                    "address": None,
                    "borough": None,
                    "neighborhood": None,
                },
                "participation": {
                    "links": [{"label": "Join online", "url": "https://example.org/dining-out"}],
                    "emails": [],
                    "phones": [],
                    "source_url": source + "RULE-202",
                },
                "source_url": source + "RULE-202",
                "description": "A citywide hearing on operating requirements for the permanent outdoor dining program.",
            },
            {
                "request_id": "OPEN-303",
                "source_section": "Public Hearings and Meetings",
                "agency": "Department of Consumer and Worker Protection",
                "notice_type": "Public Hearing",
                "title": "License policy public hearing",
                "event_date": future_date(4),
                "published_at": future_date(-2),
                "decides": "Proposed updates to a license policy",
                "affects": ["audience_businesses"],
                "affected_area": {
                    "scope": "unlocated",
                    "boroughs": [],
                    "neighborhoods": [],
                    "community_districts": [],
                    "addresses": [],
                },
                "venue": {
                    "mode": "not-stated",
                    "building": "",
                    "address": None,
                    "borough": None,
                    "neighborhood": None,
                },
                "participation": {
                    "links": [],
                    "emails": [],
                    "phones": [],
                    "source_url": source + "OPEN-303",
                },
                "source_url": source + "OPEN-303",
                "description": "The notice does not identify a geographic subject or meeting venue.",
            },
        ],
    }


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_routes(page: Page) -> None:
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())

    def worker(route: Route) -> None:
        if urlparse(route.request.url).path == "/hearings":
            json_response(route, hearing_payload())
        else:
            json_response(route, {})

    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)

    def city_data(route: Route) -> None:
        query = parse_qs(urlparse(route.request.url).query)
        if "$group" in query and "agency_name" in query["$group"]:
            json_response(route, [
                {"agency_name": "City Planning"},
                {"agency_name": "Department of Transportation"},
                {"agency_name": "Department of Consumer and Worker Protection"},
            ])
        else:
            json_response(route, [])

    page.route("https://data.cityofnewyork.us/**", city_data)
    page.route("https://data.ny.gov/**", lambda route: json_response(route, []))


def verify_and_capture(page: Page, base_url: str, width: int) -> None:
    errors = list()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url + "#meetings?when=week", wait_until="domcontentloaded")
    page.locator("#meetingsfeed .hcard").first.wait_for(state="visible")

    controls = page.locator("#tab-meetings .controls")
    toggle = page.locator("#tab-meetings .filtertoggle")
    if controls.is_hidden() and toggle.count():
        toggle.click()

    assert page.locator("#meetingsfeed .hcard").count() == 3
    assert page.locator("#meetingsfeed").get_by_text("Sunnyside", exact=False).count() > 0
    assert page.locator("#meetingsfeed").get_by_text("120 Broadway", exact=False).count() > 0
    assert page.locator("#meetingsfeed").get_by_text("Citywide", exact=False).count() > 0
    assert page.locator("#meetingsfeed").get_by_text(
        "No affected area identified in this notice",
        exact=False,
    ).count() > 0

    page.locator("#meetingsboro").select_option(label="Queens")
    page.locator("#meetingsfeed .hcard").first.wait_for(state="visible")
    assert page.locator("#meetingsfeed .hcard").count() == 2, "Queens includes local and citywide hearings"
    assert page.locator("#meetingsfeed").get_by_text("Sunnyside", exact=False).count() > 0
    assert page.locator("#meetingsfeed").get_by_text("License policy", exact=False).count() == 0
    page.locator("#meetingsboro").select_option("")
    page.locator("#meetingsfeed .hcard").nth(2).wait_for(state="visible")

    overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
    assert not overflow, f"horizontal overflow at {width}px"
    assert not errors, f"page errors at {width}px: {errors}"

    OUTPUT.mkdir(parents=True, exist_ok=True)
    page.locator("#tab-meetings .wrap").screenshot(path=str(OUTPUT / f"meetings-{width}.png"))


def main() -> None:
    with StaticServer() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                install_routes(page)
                verify_and_capture(page, base_url, width)
                context.close()
        finally:
            browser.close()
    print(f"verified and wrote {len(VIEWPORTS)} hearing captures to {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
