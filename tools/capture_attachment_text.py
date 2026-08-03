#!/usr/bin/env python3
"""Capture Cannonsville notice detail before and after T1 attachment text."""

from __future__ import annotations

import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "attachment-text"
NOTICE_ID = "20240515016"
FILE_URL = (
    "https://a856-cityrecord.nyc.gov/Search/GetFile?sectionId=3&requestId=20240515016"
    "&requestStatus=Archived&documentId=37470"
)
EXTRACT = (
    "New York City Department of Environmental Protection\n"
    "Bureau of Water Supply - Natural Resources Division\n"
    "CARPENTERS EDDY EAST\n"
    "Forest Management Project # 5116\n"
    "NOTICE OF PROJECT AVAILABILITY\n"
    "Description: The City of New York will sell an estimated 187 MBF of hardwood "
    "sawtimber and 89 cords of hardwood pulp through Carpenters Eddy East Forest "
    "Management Project #5116 in the Cannonsville watershed basin.\n"
    "Summary: This sale is comprised of mostly mature red oak and white ash.\n"
    "Total Volume: 187 MBF +/- sawtimber & 89 cords hardwood pulp"
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
META_ONLY = {
    "request_id": NOTICE_ID,
    "n_attachments": 1,
    "n_with_text": 0,
    "attachments": [{
        "request_id": NOTICE_ID,
        "document_id": "37470",
        "title": "Description, maps, and volume report",
        "url": FILE_URL,
        "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "bytes": None,
        "source": "portal",
    }],
}
WITH_TEXT = {
    "request_id": NOTICE_ID,
    "n_attachments": 1,
    "n_with_text": 1,
    "attachments": [{
        **META_ONLY["attachments"][0],
        "text_status": "ok",
        "text_method": "docx_xml",
        "text_chars": len(EXTRACT),
        "text_preview": (
            "New York City Department of Environmental Protection · "
            "Bureau of Water Supply - Natural Resources Division · "
            "CARPENTERS EDDY EAST · Forest Management Project # 5116…"
        ),
        "extracted_text": EXTRACT,
    }],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


def fulfill_json(route: Route, value: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(value))


def install_routes(page: Page, with_text: bool) -> None:
    payload = WITH_TEXT if with_text else META_ONLY

    def city_data(route: Route) -> None:
        query = parse_qs(urlparse(route.request.url).query)
        where = " ".join(query.get("$where", []))
        fulfill_json(route, [NOTICE] if NOTICE_ID in where else [])

    def worker(route: Route) -> None:
        parsed = urlparse(route.request.url)
        query = parse_qs(parsed.query)
        if parsed.path == "/attachment-metadata" and (query.get("id") or [""])[0] == NOTICE_ID:
            fulfill_json(route, payload)
        else:
            fulfill_json(route, {})

    page.route("https://data.cityofnewyork.us/resource/dg92-zbpx.json*", city_data)
    page.route("https://api.cityscroll.org/**", worker)
    page.route("https://api.crol-list.org/**", worker)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker)
    page.route("**/data/attachment_metadata_lookup.json", lambda route: fulfill_json(route, {"notices": {}}))


def capture(page: Page, base: str, filename: str, with_text: bool) -> None:
    install_routes(page, with_text)
    page.goto(f"{base}#notice/{NOTICE_ID}", wait_until="domcontentloaded")
    page.locator("#noticeview .route-item").wait_for(state="visible")
    page.locator("#ncontext .attachment-chip").wait_for(state="visible")
    if with_text:
        page.locator("#ncontext .attachment-extract").wait_for(state="visible")
        # Expand once so the after frame shows progressive disclosure open.
        page.locator("#ncontext .attachment-extract > summary").click()
        page.locator("#ncontext .attachment-extract-body").wait_for(state="visible")
    else:
        page.wait_for_timeout(400)
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
                ("before-cannonsville-text.png", False),
                ("after-cannonsville-text.png", True),
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
    print(f"Wrote {OUT / 'before-cannonsville-text.png'}")
    print(f"Wrote {OUT / 'after-cannonsville-text.png'}")


if __name__ == "__main__":
    main()
