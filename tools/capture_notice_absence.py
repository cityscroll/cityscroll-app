#!/usr/bin/env python3
"""Capture a live-rendered notice with an unpopulated procurement lifecycle."""
from __future__ import annotations

import argparse
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "notice-absence-slots"
NOTICE_ID = "20260808001"
VIEWPORTS = ((390, 900), (1440, 1100))
ABSENCE_COPY = "registration and payments would appear in Checkbook NYC if released with a PIN"

NOTICE = {
    "request_id": NOTICE_ID,
    "agency_name": "Department of Citywide Administrative Services",
    "type_of_notice_description": "Solicitation",
    "category_description": "Goods",
    "short_title": "Office supplies",
    "section_name": "Procurement",
    "start_date": "2026-08-08T00:00:00.000",
    "end_date": "2026-08-22T17:00:00.000",
    "additional_description_1": "The agency is seeking office supplies.",
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_GET(self):
        path_only, _, query = self.path.partition("?")
        if path_only.rstrip("/").startswith("/notices/"):
            self.path = "/index.html" + (f"?{query}" if query else "")
        super().do_GET()


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


def fulfill_json(route: Route, payload: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))


def install_routes(page) -> None:
    def city_data(route: Route) -> None:
        if NOTICE_ID in route.request.url:
            fulfill_json(route, [NOTICE])
        else:
            fulfill_json(route, [])

    def worker(route: Route) -> None:
        if "contract-lifecycle" in route.request.url:
            route.fulfill(status=503, content_type="application/json", body='{"ok":false}')
        else:
            fulfill_json(route, {"ok": True})

    page.route("**/resource/dg92-zbpx.json**", city_data)
    page.route("https://data.cityofnewyork.us/**", city_data)
    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://api.crol-list.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", choices=("before", "after"), required=True)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        with StaticServer() as base:
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                install_routes(page)
                page.goto(f"{base}notices/{NOTICE_ID}", wait_until="domcontentloaded", timeout=60000)
                page.wait_for_selector("#noticeview .panel", timeout=45000)
                page.wait_for_timeout(1200)
                panel = page.locator("#noticeview .panel").first
                text = panel.inner_text()
                if args.label == "before":
                    assert ABSENCE_COPY.lower() in text.lower(), text
                else:
                    assert ABSENCE_COPY.lower() not in text.lower(), text
                    assert "Office supplies" in text, text
                panel.screenshot(path=str(OUT / f"{args.label}-{width}.png"))
                context.close()
        browser.close()

    print(f"Wrote {args.label} captures to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
