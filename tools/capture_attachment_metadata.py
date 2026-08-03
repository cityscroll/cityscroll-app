#!/usr/bin/env python3
"""Capture Cannonsville notice detail before and after attachment metadata."""

from __future__ import annotations

import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "attachment-metadata"
NOTICE_ID = "20240515016"
FILE_URL = (
    "https://a856-cityrecord.nyc.gov/Search/GetFile?sectionId=3&requestId=20240515016"
    "&requestStatus=Archived&documentId=37470"
)
NOTICE = {
    "request_id": NOTICE_ID,
    "start_date": "2024-05-15T00:00:00.000",
    "agency_name": "Environmental Protection",
    "type_of_notice_description": "Property Disposition",
    "section_name": "Property Disposition",
    "short_title": "Cannonsville watershed basin timber sale",
    "additional_description_1": "Sale of standing timber in the Cannonsville watershed basin.",
}
ATTACHMENTS = {
    "request_id": NOTICE_ID,
    "n_attachments": 1,
    "attachments": [{
        "request_id": NOTICE_ID,
        "document_id": "37470",
        "title": "Description, maps, and volume report",
        "url": FILE_URL,
        "content_type": None,
        "bytes": None,
        "source": "portal",
    }],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


def fulfill_json(route: Route, value: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(value))


def install_routes(page: Page, with_attachments: bool) -> None:
    def city_data(route: Route) -> None:
        query = parse_qs(urlparse(route.request.url).query)
        where = " ".join(query.get("$where", []))
        fulfill_json(route, [NOTICE] if NOTICE_ID in where else [])

    def worker(route: Route) -> None:
        parsed = urlparse(route.request.url)
        query = parse_qs(parsed.query)
        if parsed.path == "/attachment-metadata" and (query.get("id") or [""])[0] == NOTICE_ID:
            fulfill_json(route, ATTACHMENTS if with_attachments else {
                "request_id": NOTICE_ID, "n_attachments": 0, "attachments": [],
            })
        else:
            fulfill_json(route, {})

    page.route("https://data.cityofnewyork.us/resource/dg92-zbpx.json*", city_data)
    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://api.crol-list.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)
    page.route("**/data/attachment_metadata_lookup.json", lambda route: fulfill_json(route, {"notices": {}}))


def capture(page: Page, base: str, filename: str, with_attachments: bool) -> None:
    install_routes(page, with_attachments)
    page.goto(f"{base}#notice/{NOTICE_ID}", wait_until="domcontentloaded")
    page.locator("#noticeview .route-item").wait_for(state="visible")
    if with_attachments:
        page.locator("#ncontext .attachment-chip").wait_for(state="visible")
    else:
        page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / filename), full_page=True, animations="disabled")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}/"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for filename, enabled in (
                ("before-cannonsville.png", False),
                ("after-cannonsville.png", True),
            ):
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                page = context.new_page()
                capture(page, base, filename, enabled)
                context.close()
            browser.close()
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()
    print(f"Wrote {OUT / 'before-cannonsville.png'}")
    print(f"Wrote {OUT / 'after-cannonsville.png'}")


if __name__ == "__main__":
    main()
