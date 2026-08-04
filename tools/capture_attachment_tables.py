#!/usr/bin/env python3
"""Capture Cannonsville notice detail before and after T2 structured tables."""

from __future__ import annotations

import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "attachment-tables"
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
    "Description: The City of New York will sell 187 MBF of hardwood "
    "sawtimber and 89 cords of hardwood pulp through Carpenters Eddy East Forest "
    "Management Project #5116 in the Cannonsville watershed basin.\n"
    "Total Volume: 187 MBF sawtimber and 89 cords hardwood pulp"
)
TABLES = [
    {
        "index": 0,
        "caption": None,
        "headers": ["Species", "Sawtimber (MBF)", "Pulp (cords)", "Percent of sawtimber"],
        "rows": [
            ["Red Oak", "91.6", "28", "49%"],
            ["White Ash", "41.1", "18", "22%"],
            ["Red Maple", "26.2", "22", "14%"],
            ["Chestnut Oak", "16.8", "12", "9%"],
            ["Other hardwoods", "11.3", "9", "6%"],
            ["Total", "187.0", "89", "100%"],
        ],
        "n_rows": 6,
        "n_cols": 4,
        "method": "docx_tbl",
    },
    {
        "index": 1,
        "caption": None,
        "headers": ["Stand", "Acres", "Dominant species", "Sawtimber (MBF)", "Treatment"],
        "rows": [
            ["1", "28", "Red Oak", "62.4", "Shelterwood"],
            ["2", "35", "White Ash / Red Oak", "71.2", "Shelterwood"],
            ["3", "24", "Red Maple", "38.1", "Group selection"],
            ["4", "16", "Mixed hardwoods", "15.3", "Trail / access"],
            ["Total", "103", "—", "187.0", "—"],
        ],
        "n_rows": 5,
        "n_cols": 5,
        "method": "docx_tbl",
    },
]
NOTICE = {
    "request_id": NOTICE_ID,
    "start_date": "2024-05-15T00:00:00.000",
    "agency_name": "Environmental Protection",
    "type_of_notice_description": "Property Disposition",
    "section_name": "Property Disposition",
    "short_title": "Cannonsville watershed basin timber sale",
    "additional_description_1": "Sale of standing timber in the Cannonsville watershed basin.",
}
META_TEXT_ONLY = {
    "request_id": NOTICE_ID,
    "n_attachments": 1,
    "n_with_text": 1,
    "n_with_tables": 0,
    "attachments": [{
        "request_id": NOTICE_ID,
        "document_id": "37470",
        "title": "Description, maps, and volume report",
        "url": FILE_URL,
        "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "bytes": None,
        "source": "portal",
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
WITH_TABLES = {
    "request_id": NOTICE_ID,
    "n_attachments": 1,
    "n_with_text": 1,
    "n_with_tables": 1,
    "attachments": [{
        **META_TEXT_ONLY["attachments"][0],
        "tables_status": "ok",
        "tables_method": "docx_tbl",
        "tables_count": 2,
        "tables_preview": (
            "2 tables: Species · Sawtimber (MBF) · Pulp (cords) · Percent of sawtimber "
            "— Red Oak · 91.6 · 28 · 49% · +11 more"
        ),
        "extracted_tables": TABLES,
    }],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


def fulfill_json(route: Route, value: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(value))


def install_routes(page: Page, with_tables: bool) -> None:
    payload = WITH_TABLES if with_tables else META_TEXT_ONLY

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


def capture(page: Page, base: str, filename: str, with_tables: bool) -> None:
    install_routes(page, with_tables)
    page.goto(f"{base}#notice/{NOTICE_ID}", wait_until="domcontentloaded")
    page.locator("#noticeview .route-item").wait_for(state="visible")
    page.locator("#ncontext .attachment-chip").wait_for(state="visible")
    if with_tables:
        page.locator("#ncontext .attachment-tables, #ncontext [data-attachment-tables-host]").wait_for(state="visible")
        # Deferred module paints real tables into the host.
        page.locator("#ncontext .attachment-tables").wait_for(state="visible")
        page.locator("#ncontext .attachment-tables > summary").click()
        page.locator("#ncontext table.attachment-table").first.wait_for(state="visible")
        # Ensure species MBF is painted before screenshot.
        page.get_by_text("Red Oak", exact=True).first.wait_for(state="visible")
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
                ("before-cannonsville-tables.png", False),
                ("after-cannonsville-tables.png", True),
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
    print(f"Wrote {OUT / 'before-cannonsville-tables.png'}")
    print(f"Wrote {OUT / 'after-cannonsville-tables.png'}")


if __name__ == "__main__":
    main()
