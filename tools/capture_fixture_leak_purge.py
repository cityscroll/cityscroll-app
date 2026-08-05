#!/usr/bin/env python3
"""Capture the reported agency profile and invalid notice before/after states.

Production supplies the before state. The local static site supplies the after
state, with its entity endpoint fulfilled from the committed local payload.

    python3 tools/capture_fixture_leak_purge.py
"""

from __future__ import annotations

import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import Browser, Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "fixture-leak-purge"
PRODUCTION = "https://cityscroll.org/"
AGENCY_HASH = "#agency/Parks%20and%20Recreation?tab=forecast"
INVALID_NOTICE_HASH = "#notice/FIX005"


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


def local_parks_view() -> dict:
    payload = json.loads((ROOT / "site/data/entity_intelligence_lookup.json").read_text())
    return payload["by_ref"]["agency:id:parks-and-recreation"]


def fulfill_json(route: Route, body: object, status: int = 200) -> None:
    route.fulfill(
        status=status,
        content_type="application/json; charset=utf-8",
        headers={"access-control-allow-origin": "*"},
        body=json.dumps(body),
    )


def install_local_entity_route(page: Page) -> None:
    view = local_parks_view()

    def entity(route: Route) -> None:
        fulfill_json(route, view)

    page.route("https://api.cityscroll.org/entity-intelligence**", entity)
    page.route("https://crol-worker.crol-worker.workers.dev/entity-intelligence**", entity)


def capture_agency(browser: Browser, base: str, phase: str, local: bool) -> None:
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    if local:
        install_local_entity_route(page)
    page.goto(base + "index.html" + AGENCY_HASH, wait_until="domcontentloaded", timeout=60000)
    panel = page.locator("#entity-intelligence")
    panel.wait_for(state="attached", timeout=60000)
    overview = page.locator("#btn-overview")
    if overview.count():
        overview.click()
    panel.scroll_into_view_if_needed()
    text = panel.inner_text()
    if phase == "before":
        assert "Synthetic fixture row five" in text
        assert "domains have linked objects" in text
        assert "not siloed lists" in text
    else:
        assert "Synthetic" not in text
        assert "FIX005" not in text
        assert "domains have linked objects" not in text
        assert "not siloed lists" not in text
        assert "Published records about Parks and Recreation" in text
    panel.screenshot(path=str(OUT / f"{phase}-parks-agency.png"))
    page.close()


def capture_invalid_notice(browser: Browser, base: str, phase: str) -> None:
    page = browser.new_page(viewport={"width": 1440, "height": 800})
    page.goto(
        base + "index.html" + INVALID_NOTICE_HASH,
        wait_until="domcontentloaded",
        timeout=60000,
    )
    empty = page.locator("#noticeview .empty")
    empty.wait_for(state="visible", timeout=60000)
    final_copy = "wasn't found" if phase == "before" else "CityScroll couldn't find"
    empty.get_by_text(final_copy, exact=False).wait_for(timeout=60000)
    bad_link = empty.locator('a[href*="RequestDetail/FIX005"]')
    if phase == "before":
        assert bad_link.count() == 1
    else:
        assert bad_link.count() == 0
        assert "Check the notice number or try again later" in empty.inner_text()
    empty.screenshot(path=str(OUT / f"{phase}-invalid-notice.png"))
    page.close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        capture_agency(browser, PRODUCTION, "before", local=False)
        capture_invalid_notice(browser, PRODUCTION, "before")
        with StaticServer() as local:
            capture_agency(browser, local, "after", local=True)
            capture_invalid_notice(browser, local, "after")
        browser.close()
    for image in sorted(OUT.glob("*.png")):
        print(f"{image.relative_to(ROOT)} ({image.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
