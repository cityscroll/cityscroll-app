#!/usr/bin/env python3
"""Capture and verify disclosed hearing-result widening at review widths."""

from __future__ import annotations

import functools
import json
from pathlib import Path
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from PIL import Image
from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "media" / "review" / "preset-widening"
VIEWPORTS = ((390, 844), (1440, 900))

UPCOMING = {
    "request_id": "future-parks",
    "source_section": "Public Hearings and Meetings",
    "agency": "Parks and Recreation",
    "notice_type": "Public Hearing",
    "title": "Parks concession hearing",
    "event_date": "2026-08-10T10:00:00.000",
    "published_at": "2026-07-20T00:00:00.000",
    "decides": "A parks concession",
    "affects": [],
    "affected_area": {
        "scope": "unlocated",
        "boroughs": [],
        "neighborhoods": [],
        "community_districts": [],
        "addresses": [],
    },
    "venue": {"mode": "virtual", "building": "", "address": None},
    "participation": {"links": [], "emails": [], "phones": []},
    "source_url": "https://a856-cityrecord.nyc.gov/RequestDetail/future-parks",
    "description": "Parks concession hearing",
}

PAST_ROW = {
    "request_id": "20250227021",
    "start_date": "2025-03-07T00:00:00.000",
    "event_date": "2025-03-20T10:00:00.000",
    "agency_name": "Industrial Development Agency",
    "type_of_notice_description": "Public Hearing",
    "section_name": "Public Hearings and Meetings",
    "short_title": "IDA March 20th, 2025 Public Hearing Notice",
    "additional_description_1": "Industrial Development Agency public hearing.",
}


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


def install_routes(page: Page) -> None:
    def crol_api(route: Route) -> None:
        path = urlparse(route.request.url).path
        if path == "/hearings":
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"hearings": [UPCOMING]}),
            )
        elif path == "/suggestions":
            route.fulfill(status=404, content_type="application/json", body="{}")
        else:
            route.fulfill(status=200, content_type="application/json", body="[]")

    def city_data(route: Route) -> None:
        query = parse_qs(urlparse(route.request.url).query)
        where = " ".join(query.get("$where", []))
        keyword = " ".join(query.get("$q", []))
        if "event_date <" in where and keyword.upper() == "IDA":
            route.fulfill(status=200, content_type="application/json", body=json.dumps([PAST_ROW]))
        else:
            route.fulfill(status=200, content_type="application/json", body="[]")

    page.route("https://api.crol-list.org/**", crol_api)
    page.route("https://crol-worker.crol-worker.workers.dev/**", crol_api)
    page.route("https://data.cityofnewyork.us/**", city_data)
    page.route("https://data.ny.gov/**", lambda route: route.fulfill(status=200, content_type="application/json", body="[]"))
    page.route("https://geosearch.planninglabs.nyc/**", lambda route: route.fulfill(status=200, content_type="application/json", body='{"features":[]}'))
    page.route("https://**", lambda route: route.abort())


def capture(page: Page, base_url: str, width: int, height: int) -> Path:
    page.goto(f"{base_url}#meetings?when=upcoming&q=IDA", wait_until="domcontentloaded")
    banner = page.locator("#meetingswidening .widening-note")
    banner.wait_for(state="visible")
    page.locator("#meetingsfeed .fcard").wait_for(state="visible")
    assert "Showing recent past meetings for “IDA” (none upcoming)." in banner.inner_text()
    assert page.locator("#meetingsfeed .tag.closed", has_text="Past").count() == 1
    assert page.locator("#meetingsfeed .fcard").count() == 1
    page.evaluate(
        "document.querySelector('#meetingswidening').scrollIntoView({block:'start'}); window.scrollBy(0,-16)"
    )
    page.wait_for_timeout(150)
    output = OUTPUT / f"after-{width}.png"
    page.screenshot(path=str(output), full_page=False)
    image = Image.open(output)
    assert image.size == (width, height), f"{output.name}: got {image.size}"
    return output


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with StaticServer() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                page = context.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                install_routes(page)
                output = capture(page, base_url, width, height)
                if errors:
                    raise AssertionError(f"{output.name}: page errors: {errors}")
                print(f"{output.relative_to(ROOT)} {Image.open(output).size}")
                context.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()
