#!/usr/bin/env python3
"""Capture the unofficial notice-translation UI at review widths (390 and 1440).

Serves the site statically, mocks SODA + the /translate edge so the original
English notice and the unofficial translation pane both render without live
upstream calls, and writes screenshots under docs/screenshots/unofficial-translation/.
"""

from __future__ import annotations

import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "unofficial-translation"
VIEWPORTS = ((390, 844), (1440, 900))

NOTICE = {
    "request_id": "20220314107",
    "start_date": "2022-03-18",
    "agency_name": "Housing Preservation and Development",
    "type_of_notice_description": "Award",
    "category_description": "Construction/Construction Services",
    "short_title": "IMMEDIATE EMERGENCY DEMOLITION OF 28 W 130th St, MANHATTAN (DM00121 E-6038R)",
    "pin": "80622E0016001",
    "contract_amount": "550000",
    "vendor_name": "Granite Environmental, LLC",
    "due_date": "2022-04-01T17:00:00.000",
    "address_to_request": "100 Gold Street, New York, NY 10038",
    "contact_name": "Contracts Unit",
    "contact_phone": "212-863-0000",
    "email": "contracts@hpd.nyc.gov",
    "selection_method_description": "Negotiated Acquisition",
    "additional_description_1": (
        "Emergency demolition at 28 W 130th St. Contract amount $550,000. "
        "Due 2022-04-01. Request ID 20220314107."
    ),
    "other_info_1": "",
    "section_name": "Procurement",
}

TRANSLATION = {
    "ok": True,
    "id": "20220314107",
    "lang": "es",
    "title": "DEMOLICIÓN DE EMERGENCIA INMEDIATA DE 28 W 130th St, MANHATTAN (DM00121 E-6038R)",
    "description": (
        "Demolición de emergencia en 28 W 130th St. Monto del contrato $550,000. "
        "Vence 2022-04-01. Request ID 20220314107. "
        "Housing Preservation and Development. PIN 80622E0016001. "
        "100 Gold Street, New York, NY 10038."
    ),
    "model": "test",
    "cached": True,
    "label": "unofficial_translation",
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self) -> None:
        # Serve from site/ so index.html paths resolve like production Pages.
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


def install_routes(page: Page) -> None:
    def soda(route: Route) -> None:
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps([NOTICE]),
        )

    def translate(route: Route) -> None:
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(TRANSLATION),
        )

    def empty_json(route: Route) -> None:
        route.fulfill(status=200, content_type="application/json", body="[]")

    def empty_obj(route: Route) -> None:
        route.fulfill(status=200, content_type="application/json", body="{}")

    # Playwright matches last-registered first — register broad stubs before the
    # specific /translate handlers so the unofficial translation response wins.
    page.route("https://data.ny.gov/**", empty_json)
    page.route("https://geosearch.planninglabs.nyc/**", empty_json)
    page.route("https://api.cityscroll.org/**", empty_obj)
    page.route("https://crol-worker.crol-worker.workers.dev/**", empty_obj)
    page.route("https://data.cityofnewyork.us/**", soda)
    page.route("https://api.cityscroll.org/translate/**", translate)
    page.route("https://crol-worker.crol-worker.workers.dev/translate/**", translate)


def capture(page: Page, base_url: str, width: int, height: int) -> Path:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(base_url.rstrip("/") + "/index.html", wait_until="domcontentloaded")
    # Spanish UI so the unofficial-translation control mounts.
    page.evaluate(
        """() => {
          try { localStorage.setItem('crol_lang', 'es'); } catch (e) {}
          if (typeof setLang === 'function') setLang('es');
        }"""
    )
    page.wait_for_timeout(400)
    page.evaluate("() => { location.hash = '#notice/20220314107'; }")
    page.wait_for_function(
        """() => {
          const box = document.querySelector('#noticeview');
          if (!box) return false;
          return !!box.querySelector('[data-xlate-btn]');
        }""",
        timeout=20000,
    )
    # Open the unofficial translation pane (scoped to the notice deep-link view).
    btn = page.locator("#noticeview [data-xlate-btn]")
    btn.wait_for(state="visible", timeout=10000)
    btn.click()
    page.wait_for_function(
        """() => {
          const pane = document.querySelector('#noticeview [data-xlate-pane]');
          return pane && !pane.hidden && pane.textContent && pane.textContent.includes('DEMOLIC');
        }""",
        timeout=10000,
    )
    page.evaluate("document.fonts && document.fonts.ready")
    page.wait_for_timeout(200)
    # Capture the notice panel region when possible.
    target = page.locator("#noticeview .panel").first
    if target.count() == 0:
        target = page.locator("#noticeview")
    out = OUTPUT / f"notice-es-{width}.png"
    target.screenshot(path=str(out))
    return out


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with StaticServer() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        install_routes(page)
        written: list[Path] = []
        for width, height in VIEWPORTS:
            written.append(capture(page, base_url, width, height))
        browser.close()
    for path in written:
        print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
