#!/usr/bin/env python3
"""Capture the live CityScroll notice-detail rule event spine at review widths.

The browser runs the real public ``site/index.html`` and intercepts only its data
requests with deterministic, live-shaped City Record and ``/rules`` fixtures.

    python3 tools/capture_rule_event_spine.py
"""

from __future__ import annotations

import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "rule-event-spine"
NOTICE_ID = "CR-RULE-SPINE-001"
VIEWPORTS = ((390, 844), (1440, 900))

NOTICE = {
    "request_id": NOTICE_ID,
    "start_date": "2026-07-23T00:00:00.000",
    "agency_name": "Department of Transportation",
    "section_name": "Agency Rules",
    "type_of_notice_description": "Agency Rules",
    "short_title": "Commercial Meter Parking for For-Hire Vehicles",
    "additional_description_1": (
        "The Department of Transportation proposes to amend rules governing "
        "commercial parking meters. The public may submit comments through NYC Rules."
    ),
}

RULE_RECORD = {
    "request_id": NOTICE_ID,
    "agency": NOTICE["agency_name"],
    "title": NOTICE["short_title"],
    "notice_date": NOTICE["start_date"],
    "stage": "comment-open",
    "nyc_rules": {
        "url": "https://rules.cityofnewyork.us/rule/meter-parking/",
        "comment_url": "https://rules.cityofnewyork.us/rule/meter-parking/#comments",
        "comment_by_date": "2026-09-01",
        "hearing_date": "2026-08-27",
        "adoption_published_at": None,
        "effective_date": None,
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
            "valid_at": "2026-08-27",
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
    "join": {"matched": True, "confidence": "high", "basis": "fixture"},
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
        return f"http://127.0.0.1:{self.server.server_port}/index.html"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def json_response(route: Route, body: object, status: int = 200) -> None:
    route.fulfill(
        status=status,
        content_type="application/json; charset=utf-8",
        body=json.dumps(body),
    )


def capture() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with StaticServer() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for width, height in VIEWPORTS:
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()

            page.route(
                "https://data.cityofnewyork.us/**",
                lambda route: json_response(route, [NOTICE]),
            )
            # Playwright evaluates matching routes in reverse registration order, so the
            # broad fail-soft API fixture is registered before the specific Rules payload.
            page.route(
                "https://api.cityscroll.org/**",
                lambda route: json_response(route, {"ok": False, "reason": "fixture"}, 404),
            )
            page.route(
                "https://api.cityscroll.org/rules*",
                lambda route: json_response(
                    route,
                    {"schema_version": 2, "generated_at": "2026-08-01T12:00:00Z", "rules": [RULE_RECORD]},
                ),
            )

            page.goto(f"{base}#notice/{NOTICE_ID}", wait_until="domcontentloaded", timeout=45_000)
            spine = page.locator("#nrules")
            spine.locator(".chain-h").wait_for(timeout=20_000)
            assert spine.get_by_text("Comment deadline", exact=True).count() == 1
            assert spine.get_by_text("Effective", exact=True).count() == 1
            assert spine.get_by_text("The city has not published").count() == 2

            overflow = page.evaluate(
                """() => ({
                  page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
                  spine: document.querySelector('#nrules').scrollWidth > document.querySelector('#nrules').clientWidth
                })"""
            )
            assert overflow == {"page": False, "spine": False}, overflow

            spine.screenshot(path=str(OUT / f"rule-event-spine-{width}.png"))
            context.close()
        browser.close()


if __name__ == "__main__":
    capture()
    for image in sorted(OUT.glob("*.png")):
        print(f"{image.relative_to(ROOT)} ({image.stat().st_size} bytes)")
