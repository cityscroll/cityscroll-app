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
MANIFEST = json.loads((ROOT / "site" / "demo" / "demo-links.json").read_text())
BASE = os.environ.get("CROL_BASE", "")
MATTER_PINS = {
    "84124P0003001",
    "06820P8165KXLR002",
    "07124N0007001R001",
    "82626B0029001",
}
NOW = datetime.now()


def is_production_base(base: str) -> bool:
    """True when the contract is pointed at a public deploy, not the local fixture server."""
    value = (base or "").strip().lower()
    if not value:
        return False
    return value.startswith("https://") and "127.0.0.1" not in value and "localhost" not in value


def entry_applies(entry: dict, base: str = BASE) -> bool:
    """localOnly routes are hermetic PR coverage; skip them against production hosts."""
    if entry.get("localOnly") and is_production_base(base):
        return False
    return True


def iso_date(days: int, hour: int = 10) -> str:
    return (NOW + timedelta(days=days)).strftime(f"%Y-%m-%dT{hour:02d}:00:00.000")

sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from i18n_fixtures import (  # noqa: E402
    CHAIN_ROWS,
    NOTICE_LAND_ZAP_OUTCOMES,
    install_routes,
)


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
        path = urlparse(route.request.url).path
        query = parse_qs(urlparse(route.request.url).query)
        if path == "/hearings":
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"hearings": [UPCOMING_HEARING]}),
            )
        elif path == "/zap-outcomes":
            # Notice-level land spine demo: hermetic full record for Timbale Terrace.
            project_id = (query.get("id") or [""])[0]
            if project_id == "2022M0258":
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(NOTICE_LAND_ZAP_OUTCOMES),
                )
                return
            # Land detail always requests this. Abort-or-hang races the 12s workerFetch
            # budget (and a fallback host) and keeps the outcomes spinner up past the
            # old 15s assert. Fulfill a fast unmatched shell so the spinner clears;
            # demo assertions still require the fixture project name on the detail.
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"ok": True, "record": None}),
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


# Land/zoning detail hydrates GET /zap-outcomes on select. Cold edge builds have been
# measured at ~12–17s ("Loading decision documents and outcomes…"), so a flat 15s
# wait_for races that spinner and flakes every merge-group candidate. Wait out the
# known-slow load rather than weakening the assertions.
DEFAULT_WAIT_MS = 15_000
SLOW_LAND_WAIT_MS = 30_000
DEFAULT_GOTO_MS = 30_000
SLOW_LAND_GOTO_MS = 45_000
SLOW_LAND_ENTRY_IDS = frozenset({
    "scenario-neighborhood",
})
SLOW_LAND_FEATURES = frozenset({
    "scenario-neighborhood",
})


def is_slow_land_entry(entry: dict) -> bool:
    """True for demo routes that hit the Land list + detail (zap-outcomes) cold path."""
    return entry.get("id") in SLOW_LAND_ENTRY_IDS or entry.get("feature") in SLOW_LAND_FEATURES


def entry_wait_ms(entry: dict) -> int:
    return SLOW_LAND_WAIT_MS if is_slow_land_entry(entry) else DEFAULT_WAIT_MS


def entry_goto_ms(entry: dict) -> int:
    return SLOW_LAND_GOTO_MS if is_slow_land_entry(entry) else DEFAULT_GOTO_MS


def wait_land_detail_ready(page, timeout_ms: int) -> None:
    """Wait for the Land cold path to finish before asserting demo targets.

    Sequence: list rows paint → detail shell (rolename) → outcomes spinner clears.
    Deterministic on both warm and cold /zap-outcomes; does not change what is asserted.
    """
    page.locator("#llist .row").first.wait_for(state="visible", timeout=timeout_ms)
    page.wait_for_function(
        """() => {
            const detail = document.querySelector('#ldetail');
            if (!detail) return false;
            // List/detail skeletons: direct-child loading only (outcomes uses a nested one).
            if (detail.querySelector(':scope > .loading, :scope > .empty.skel, :scope > .skl')) {
                return false;
            }
            if (!detail.querySelector('.rolename')) return false;
            const outcomes = detail.querySelector('#land-outcomes');
            if (!outcomes) return true;
            if (outcomes.querySelector('.loading')) return false;
            const note = outcomes.querySelector('.note');
            if (note && /loading/i.test(note.textContent || '')) return false;
            return true;
        }""",
        timeout=timeout_ms,
    )


class DemoLinkContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        global BASE
        cls.server = None
        if not BASE:
            handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
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
        wait_ms = entry_wait_ms(entry)
        self.page_errors.clear()
        page.goto(BASE + entry["url"], wait_until="domcontentloaded", timeout=entry_goto_ms(entry))

        if is_slow_land_entry(entry):
            wait_land_detail_ready(page, wait_ms)

        for expected in expectations["visible"]:
            locator = visible_locator(page, expected)
            locator.first.wait_for(state="visible", timeout=wait_ms)

        expected_hash = expectations.get("hash", entry["url"])
        page.wait_for_function("value => location.hash === value", arg=expected_hash, timeout=wait_ms)
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
            locator.wait_for(state="attached", timeout=wait_ms)
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
                locator.wait_for(state="visible", timeout=wait_ms)
                if banner.get("text"):
                    self.assertIn(banner["text"], locator.inner_text())
            else:
                visible_count = sum(locator.nth(index).is_visible() for index in range(locator.count()))
                self.assertEqual(visible_count, 0, f"{entry['id']}: banner must stay hidden")

        if expectations.get("focus"):
            page.wait_for_function(
                "selector => document.activeElement?.matches(selector)",
                arg=expectations["focus"],
                timeout=wait_ms,
            )
            self.assertTrue(page.locator(expectations["focus"]).first.is_visible())

        self.assertEqual(self.page_errors, [], f"{entry['id']}: page errors: {self.page_errors}")


def add_manifest_test(entry: dict) -> None:
    def generated_test(self) -> None:
        if not entry_applies(entry):
            self.skipTest(f"{entry['id']} is localOnly and BASE={BASE!r} is production")
        self.run_entry(entry)

    name = "test_" + re.sub(r"[^a-z0-9]+", "_", entry["id"])
    generated_test.__name__ = name
    generated_test.__doc__ = entry["description"]
    setattr(DemoLinkContract, name, generated_test)


for manifest_entry in MANIFEST["entries"]:
    add_manifest_test(manifest_entry)


if __name__ == "__main__":
    unittest.main(verbosity=2)
