#!/usr/bin/env python3
"""Capture production-before/local-after notice-detail action rail evidence.

Uses real City Record notice 20260716022 with its published August 10, 2026
hearing date and official NYC handoff. The Socrata response is pinned here so
both phases render the same public record even if the upstream row changes.
"""

from __future__ import annotations

import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "next-action-rail"
NOTICE_ID = "20260716022"
VIEWPORTS = ((390, 844), (1440, 900))
PRODUCTION = "https://cityscroll.org/"
FIXTURE = {
    "request_id": NOTICE_ID,
    "start_date": "2026-07-24T00:00:00.000",
    "event_date": "2026-08-10T14:30:00.000",
    "section_name": "Public Hearings and Meetings",
    "type_of_notice_description": "Public Hearings",
    "agency_name": "Parks and Recreation",
    "short_title": "Notice of Joint Public Hearing: WNYC Transmitter Park, Brooklyn",
    "street_address_1": "255 Greenwich Street, 8th Floor",
    "additional_description_1": (
        "Written testimony may be submitted until the close of the public hearing. "
        "The agenda and related documentation will be posted on the official MOCS page at "
        "https://www.nyc.gov/site/mocs/opportunities/franchises-concessions.page"
    ),
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


def pin_notice(route: Route) -> None:
    if "dg92-zbpx" in route.request.url and NOTICE_ID in route.request.url:
        route.fulfill(status=200, content_type="application/json", body=json.dumps([FIXTURE]))
    else:
        route.continue_()


def capture(browser, base: str, phase: str) -> None:
    for width, height in VIEWPORTS:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.route("**/*", pin_notice)
        page.goto(f"{base}index.html#notice/{NOTICE_ID}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#noticeview .panel", timeout=45000)
        if phase == "after":
            page.wait_for_selector(".next-action-rail", timeout=10000)
        # Evidence focuses on the public action surface; omit the environment-specific
        # permalink footer so the local capture contains no localhost review URL.
        page.add_style_tag(content="#noticeview .panel > .note:last-child{display:none!important}")
        page.evaluate("document.querySelector('#noticeview .panel').scrollIntoView({block:'start'})")
        page.wait_for_timeout(800)
        OUT.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(OUT / f"{phase}-{width}.png"), full_page=False)
        context.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        capture(browser, PRODUCTION, "before")
        with StaticServer() as local:
            capture(browser, local, "after")
        browser.close()
    receipt = {
        "notice_id": NOTICE_ID,
        "source": "NYC Open Data City Record Online (dg92-zbpx)",
        "captured_before": PRODUCTION,
        "captured_after": "local static site",
        "viewports": [width for width, _height in VIEWPORTS],
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote before/after screenshots to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
