#!/usr/bin/env python3
"""Capture deterministic desktop and mobile evidence for the additive Now surface."""

from __future__ import annotations

import functools
import hashlib
import json
from datetime import date, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OUT = ROOT / "docs" / "screenshots" / "now-surface"
VIEWPORTS = ((1440, 1000), (390, 844))


def day(offset: int) -> str:
    return (date.today() + timedelta(days=offset)).isoformat()


SOURCES = {
    "money": {
        "notices": [{
            "request_id": "now-bid",
            "short_title": "Neighborhood cooling-center supplies",
            "agency_name": "Emergency Management",
            "due_date": f"{day(2)}T14:00:00",
            "selection_method_description": "Competitive Sealed Bids",
        }],
    },
    "staffing": {
        "exams": [{
            "exam_number": "7001",
            "title": "Housing Inspector",
            "application_start": day(-2),
            "application_end": day(12),
            "official_application_url": "https://www.nyc.gov/examsforjobs",
        }],
    },
    "rules": {
        "schema_version": 6,
        "rules": [{
            "request_id": "now-rule",
            "agency": "Buildings",
            "title": "Energy code amendments",
            "stage": "comment-open",
            "nyc_rules": {
                "url": "https://rules.cityofnewyork.us/rule/energy-code/",
                "comment_url": "https://rules.cityofnewyork.us/rule/energy-code/",
                "comment_by_date": day(4),
                "hearing_date": day(4),
            },
            "events": [
                {"event_type": "comment_close", "valid_at": day(4), "source_field": "comment_by_date", "status": "scheduled"},
                {"event_type": "public_hearing", "valid_at": day(4), "source_field": "hearing_date", "status": "scheduled"},
            ],
        }],
    },
    "property": {
        "properties": [{
            "request_id": "now-property",
            "short_title": "City-owned parcel disposition",
            "agency_name": "Housing Preservation and Development",
            "disposition_stage": "auction_or_rfp",
            "commercial": {"timed_events": [
                {
                    "kind": "objection_deadline",
                    "deadline": day(3),
                    "confidence": "high",
                    "date_source": "literal",
                    "source_field": "additional_description_1",
                    "source_span": {"text": "Objections must be submitted by the published date."},
                },
                {
                    "kind": "auction",
                    "start": f"{day(6)}T10:00:00",
                    "confidence": "high",
                    "date_source": "literal",
                    "source_field": "additional_description_1",
                },
            ]},
            "property_location": {"scope": "local", "boroughs": ["Bronx"]},
        }],
    },
    "meetings": {
        "hearings": [{
            "request_id": "now-hearing",
            "agency": "Landmarks Preservation Commission",
            "title": "Public hearing agenda",
            "event_date": f"{day(1)}T09:00:00",
        }],
    },
    "land": {
        "hearings": [{
            "project_id": "2026X0001",
            "project_name": "Example rezoning hearing",
            "hearing_date": day(5),
            "hearing_at": f"{day(5)}T10:00:00",
            "borough": "Bronx",
            "provenance": {"field": "dcp-reviewmeetingdate"},
        }],
    },
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(SITE))
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
    route.fulfill(status=status, content_type="application/json; charset=utf-8", body=json.dumps(body))


def fixed_json(body: object):
    def handler(route: Route) -> None:
        json_response(route, body)

    return handler


def route_worker(page: Page, endpoint: str, body: object) -> None:
    for origin in (
        "https://api.cityscroll.org",
        "https://api.crol-list.org",
        "https://crol-worker.crol-worker.workers.dev",
    ):
        page.route(f"{origin}/{endpoint}*", fixed_json(body))


def install_routes(page: Page) -> None:
    page.route("https://api.cityscroll.org/**", lambda route: route.abort())
    page.route("https://api.crol-list.org/**", lambda route: route.abort())
    page.route("https://crol-worker.crol-worker.workers.dev/**", lambda route: route.abort())
    page.route("https://data.cityofnewyork.us/**", fixed_json([]))
    route_worker(page, "rules", SOURCES["rules"])
    route_worker(page, "property-locations", SOURCES["property"])
    route_worker(page, "hearings", SOURCES["meetings"])
    page.route("**/data/money_default_open.json", fixed_json(SOURCES["money"]))
    page.route("**/data/staffing_exams.json", fixed_json(SOURCES["staffing"]))
    page.route("**/data/land_upcoming_hearings.json", fixed_json(SOURCES["land"]))


def capture(page: Page, base: str, width: int) -> dict:
    install_routes(page)
    page.goto(f"{base}?evidence=now#now", wait_until="domcontentloaded", timeout=45_000)
    page.locator(".now-surface").wait_for(timeout=20_000)
    page.locator(".now-card").first.wait_for(timeout=20_000)
    page.wait_for_timeout(250)
    result = page.evaluate("""() => {
      const lists = [...document.querySelectorAll('[data-now-list]')].map(list => ({
        name: list.dataset.nowList,
        declared: Number(list.dataset.nowCount),
        rendered: list.querySelectorAll('.now-card').length,
      }));
      return {
        lists,
        currentLensTabs: document.querySelectorAll('.tabbtn[data-tab]').length,
        nowOwnsLensTab: Boolean(document.querySelector('.tabbtn[data-tab="now"]')),
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      };
    }""")
    assert result["lists"] and all(row["declared"] == row["rendered"] for row in result["lists"]), result
    assert result["currentLensTabs"] == 8, result
    assert result["nowOwnsLensTab"] is False, result
    assert result["horizontalOverflow"] == 0, result
    page.evaluate("scrollTo(0, document.querySelector('#tab-now').offsetTop)")
    page.wait_for_timeout(150)
    output = OUT / f"after-{width}.png"
    page.screenshot(path=output, animations="disabled")
    return {
        "viewport": page.viewport_size,
        "lists": result["lists"],
        "current_lens_tabs": result["currentLensTabs"],
        "now_owns_lens_tab": result["nowOwnsLensTab"],
        "horizontal_overflow_pixels": result["horizontalOverflow"],
        "file": output.name,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    captures = []  # Source: deterministic renders produced by capture() for VIEWPORTS.
    with StaticServer() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height in VIEWPORTS:
            context = browser.new_context(viewport={"width": width, "height": height})
            captures.append(capture(context.new_page(), base, width))
            context.close()
        browser.close()
    receipt = {
        "schema_version": 1,
        "reference_day": date.today().isoformat(),
        "source_models": ["money", "staffing", "rules", "property", "meetings", "land"],
        "captures": captures,
        "pass": True,
    }
    (OUT / "manifest.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
