#!/usr/bin/env python3
"""Generate one hermetic Playwright regression test per public demo-link entry."""

from __future__ import annotations

import functools
import json
import os
import pathlib
import re
import sys
import threading
import unittest
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


ROOT = pathlib.Path(__file__).parents[2]
MANIFEST = json.loads((ROOT / "demo" / "demo-links.json").read_text())
BASE = os.environ.get("CROL_BASE", "")
MATTER_PINS = {
    "84124P0003001",
    "06820P8165KXLR002",
    "07124N0007001R001",
    "82626B0029001",
}
NOW = datetime.now()


def iso_date(days: int, hour: int = 10) -> str:
    return (NOW + timedelta(days=days)).strftime(f"%Y-%m-%dT{hour:02d}:00:00.000")

sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from i18n_fixtures import CHAIN_ROWS, install_routes  # noqa: E402


UPCOMING_HEARING = {
    "request_id": "future-parks",
    "source_section": "Public Hearings and Meetings",
    "agency": "Parks and Recreation",
    "notice_type": "Public Hearing",
    "title": "Parks concession hearing",
    "event_date": iso_date(30),
    "published_at": iso_date(-10, 0),
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

PAST_IDA_HEARING = {
    "request_id": "20250227021",
    "start_date": iso_date(-45, 0),
    "event_date": iso_date(-30),
    "agency_name": "Industrial Development Agency",
    "type_of_notice_description": "Public Hearing",
    "section_name": "Public Hearings and Meetings",
    "short_title": "IDA March 20th, 2025 Public Hearing Notice",
    "additional_description_1": "Industrial Development Agency public hearing.",
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args: object) -> None:
        pass


def install_demo_routes(page) -> None:
    def worker(route) -> None:
        if urlparse(route.request.url).path == "/hearings":
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"hearings": [UPCOMING_HEARING]}),
            )
        else:
            route.fallback()

    def city_data(route) -> None:
        query = parse_qs(urlparse(route.request.url).query)
        where = " ".join(query.get("$where", []))
        keyword = " ".join(query.get("$q", []))
        exact_pin = re.search(r"\bpin='([^']+)'", where)
        if exact_pin and exact_pin.group(1) in MATTER_PINS:
            pin = exact_pin.group(1)
            rows = [
                {**row, "pin": pin, "request_id": f"demo-{index}-{pin}"}
                for index, row in enumerate(CHAIN_ROWS, start=1)
            ]
            route.fulfill(status=200, content_type="application/json", body=json.dumps(rows))
        elif keyword.upper() == "IDA" and "event_date <" in where:
            route.fulfill(status=200, content_type="application/json", body=json.dumps([PAST_IDA_HEARING]))
        else:
            route.fallback()

    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://api.crol-list.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)
    page.route("https://data.cityofnewyork.us/resource/dg92-zbpx.json*", city_data)


def visible_locator(page, expected: dict):
    locator = page.locator(expected["selector"])
    if expected.get("text"):
        locator = locator.filter(has_text=expected["text"])
    return locator


class DemoLinkContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        global BASE
        cls.server = None
        if not BASE:
            handler = functools.partial(QuietHandler, directory=str(ROOT))
            cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            threading.Thread(target=cls.server.serve_forever, daemon=True).start()
            BASE = f"http://127.0.0.1:{cls.server.server_port}/"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)
        cls.context = cls.browser.new_context(viewport={"width": 1280, "height": 900})
        cls.page = cls.context.new_page()
        cls.page_errors = list()
        cls.page.on("pageerror", lambda error: cls.page_errors.append(str(error)))
        install_routes(cls.page)
        install_demo_routes(cls.page)
        cls.page.add_init_script("localStorage.setItem('crol_exam_how_seen_v1', '1')")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.context.close()
        cls.browser.close()
        cls.playwright.stop()
        if cls.server:
            cls.server.shutdown()
            cls.server.server_close()

    def run_entry(self, entry: dict) -> None:
        page = self.page
        expectations = entry["expectations"]
        self.page_errors.clear()
        page.goto(BASE + entry["url"], wait_until="domcontentloaded", timeout=30000)

        for expected in expectations["visible"]:
            locator = visible_locator(page, expected)
            locator.first.wait_for(state="visible", timeout=15000)

        expected_hash = expectations.get("hash", entry["url"])
        page.wait_for_function("value => location.hash === value", arg=expected_hash, timeout=15000)
        self.assertEqual(page.evaluate("location.hash"), expected_hash)

        for expected in expectations["notVisible"]:
            locator = visible_locator(page, expected)
            page.wait_for_timeout(50)
            visible_count = sum(locator.nth(index).is_visible() for index in range(locator.count()))
            self.assertEqual(
                visible_count,
                0,
                f"{entry['id']}: {expected!r} must not be visible",
            )

        for state in expectations.get("states", []):
            locator = page.locator(state["selector"]).first
            locator.wait_for(state="attached", timeout=15000)
            actual = (
                locator.get_attribute(state["attribute"])
                if "attribute" in state
                else locator.evaluate("(element, property) => element[property]", state["property"])
            )
            self.assertEqual(actual, state["equals"], f"{entry['id']}: state mismatch for {state['selector']}")

        if "banner" in expectations:
            banner = expectations["banner"]
            locator = page.locator(banner["selector"])
            if banner["visible"]:
                locator.wait_for(state="visible", timeout=15000)
                if banner.get("text"):
                    self.assertIn(banner["text"], locator.inner_text())
            else:
                visible_count = sum(locator.nth(index).is_visible() for index in range(locator.count()))
                self.assertEqual(visible_count, 0, f"{entry['id']}: banner must stay hidden")

        if expectations.get("focus"):
            page.wait_for_function(
                "selector => document.activeElement?.matches(selector)",
                arg=expectations["focus"],
                timeout=15000,
            )
            self.assertTrue(page.locator(expectations["focus"]).first.is_visible())

        self.assertEqual(self.page_errors, [], f"{entry['id']}: page errors: {self.page_errors}")


def add_manifest_test(entry: dict) -> None:
    def generated_test(self) -> None:
        self.run_entry(entry)

    name = "test_" + re.sub(r"[^a-z0-9]+", "_", entry["id"])
    generated_test.__name__ = name
    generated_test.__doc__ = entry["description"]
    setattr(DemoLinkContract, name, generated_test)


for manifest_entry in MANIFEST["entries"]:
    add_manifest_test(manifest_entry)


if __name__ == "__main__":
    unittest.main(verbosity=2)
