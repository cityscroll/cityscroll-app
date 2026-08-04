#!/usr/bin/env python3
"""Capture before/after evidence for tax-lien cycle context on notices.

Primary surface is notice detail (cycle position, historical leave rate,
deadline state, action rail) for a Property Disposition notice whose BBL is
on the published DOF list. The standalone aggregate panel remains available
via the unlinked archive deep link ``#property?view=tax-lien``.

  python3 tools/capture_tax_lien_sale_predictions.py
"""

from __future__ import annotations

import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "tax-lien-sale-predictions"
BBL = "1000110012"
NOTICE_ID = "20250601001"

PROPERTY = {
    "request_id": NOTICE_ID,
    "start_date": "2025-06-01T00:00:00.000",
    "event_date": "2025-06-15T10:00:00.000",
    "agency_name": "Department of Citywide Administrative Services",
    "section_name": "Property Disposition",
    "type_of_notice_description": "Public Hearings",
    "short_title": "Public hearing for 12 Test Street, Block 11, Lot 12",
    "additional_description_1": (
        "The city-owned property is in the Borough of Manhattan, Block 11, "
        "Lot 12. This deterministic record is used only for screenshot evidence."
    ),
    "end_date": None,
    "disposition_stage": "hearing",
    "property_location": {
        "scope": "local",
        "boroughs": ["Manhattan"],
        "neighborhoods": ["Financial District-Battery Park City"],
        "addresses": [{
            "label": "12 Test Street",
            "borough": "Manhattan",
            "neighborhood": "Financial District-Battery Park City",
            "latitude": None,
            "longitude": None,
            "bbl": BBL,
        }],
        "tax_lots": [{
            "label": "Block 11, Lot 12",
            "block": "11",
            "lots": ["12"],
            "bbl": BBL,
        }],
        "bbls": [BBL],
        "geometry": None,
    },
}

SODA_ROW = {
    "request_id": NOTICE_ID,
    "short_title": PROPERTY["short_title"],
    "agency_name": PROPERTY["agency_name"],
    "section_name": PROPERTY["section_name"],
    "type_of_notice_description": PROPERTY["type_of_notice_description"],
    "start_date": PROPERTY["start_date"],
    "event_date": PROPERTY["event_date"],
    "additional_description_1": PROPERTY["additional_description_1"],
    "end_date": None,
    "street_address_1": "12 Test Street",
}

PROPERTY_PAYLOAD = {
    "generated_at": "2026-08-03T00:00:00Z",
    "properties": [PROPERTY],
    "disposition_spines": [],
}

BEFORE_CSS = """
#ntaxlien,
.tax-lien-card-slot,
#tax-lien-sale-panel { display: none !important; }
"""


class SiteHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=str(directory or ROOT / "site"), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def start_server() -> tuple[ThreadingHTTPServer, int]:
    handler = lambda *a, **k: SiteHandler(*a, directory=ROOT / "site", **k)  # noqa: E731
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def json_response(route: Route, body: object, status: int = 200) -> None:
    route.fulfill(
        status=status,
        content_type="application/json; charset=utf-8",
        body=json.dumps(body),
    )


def install_routes(page: Page) -> None:
    # Playwright matches the most recently registered route first.
    # Register broad catch-alls first, then specific endpoints so they win.
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: json_response(route, []),
    )
    page.route(
        "https://api.cityscroll.org/**",
        lambda route: json_response(route, {"ok": False, "reason": "fixture"}, 404),
    )
    page.route(
        "https://crol-worker.crol-worker.workers.dev/**",
        lambda route: json_response(route, {"ok": False, "reason": "fixture"}, 404),
    )
    page.route(
        "**/contract-lifecycle**",
        lambda route: json_response(route, {}),
    )
    page.route(
        "**/subsidy-lifecycle**",
        lambda route: json_response(route, {}),
    )
    page.route(
        "**/meeting-outcomes**",
        lambda route: json_response(route, {}),
    )
    page.route(
        "**/franchise-concessions**",
        lambda route: json_response(route, {}),
    )
    page.route(
        "**/attachment-metadata**",
        lambda route: json_response(route, {"attachments": []}),
    )
    page.route(
        "**/resource/dg92-zbpx.json**",
        lambda route: json_response(route, [SODA_ROW]),
    )
    page.route(
        "**/property-locations**",
        lambda route: json_response(route, PROPERTY_PAYLOAD),
    )
    page.route(
        "https://api.cityscroll.org/property-locations*",
        lambda route: json_response(route, PROPERTY_PAYLOAD),
    )
    page.route(
        "https://crol-worker.crol-worker.workers.dev/property-locations*",
        lambda route: json_response(route, PROPERTY_PAYLOAD),
    )


def open_property_list(page: Page, base: str, *, wait_for_note: bool) -> None:
    page.goto(f"{base}/#property", wait_until="domcontentloaded")
    page.wait_for_selector("#propertyfeed .property-fcard", timeout=20_000)
    header = page.locator("#property-domain-intro").inner_text()
    if "Tax lien sale statistics" in header:
        raise RuntimeError("tax-lien stats link still present in property lens header")
    if wait_for_note:
        page.wait_for_selector("#propertyfeed .tax-lien-card-note", timeout=20_000)
    page.wait_for_timeout(300)


def open_notice(page: Page, base: str) -> None:
    page.goto(f"{base}/#notice/{NOTICE_ID}", wait_until="domcontentloaded")
    page.wait_for_selector("#ntaxlien [data-tax-lien-cycle-context]", timeout=30_000)
    page.wait_for_timeout(400)


def assert_notice_context(page: Page) -> None:
    panel = page.locator("#ntaxlien [data-tax-lien-cycle-context]")
    text = panel.inner_text()
    if "lien, not the property" not in text:
        raise RuntimeError("owner-protective lien-not-property copy is missing")
    if "historically left before sale" not in text:
        raise RuntimeError("historical leave-rate context is missing")
    if "Based on 3 prior cycles" not in text:
        raise RuntimeError("prior-cycle attribution is missing")
    if "Check exemptions" not in text or "Compare payment plans" not in text:
        raise RuntimeError("action rail buttons are missing")
    if "Lien sale help" not in text and "Call 311" not in text:
        raise RuntimeError("help / 311 actions are missing")
    if "10-day list" not in text and "10-day" not in text:
        raise RuntimeError("cycle stage for listed BBL is missing")
    if BBL not in text:
        raise RuntimeError("notice-scoped BBL is missing from parcel list")
    if page.locator("#ntaxlien .tax-lien-stepper .lc-step").count() < 5:
        raise RuntimeError("cycle stepper does not show the full ladder")
    if page.locator("#ntaxlien .tax-lien-stepper .lc-step.current").count() < 1:
        raise RuntimeError("current stage is not highlighted on the stepper")


def capture_after(page: Page, base: str, out: Path) -> None:
    open_property_list(page, base, wait_for_note=True)
    card = page.locator("#propertyfeed .property-fcard")
    card.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    page.screenshot(path=str(out / "after-listed-property-page.png"), full_page=False)

    open_notice(page, base)
    assert_notice_context(page)
    panel = page.locator("#ntaxlien [data-tax-lien-cycle-context]")
    panel.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    panel.screenshot(path=str(out / "after-notice-cycle-context.png"))
    page.screenshot(path=str(out / "after-notice-detail.png"), full_page=False)

    page.goto(f"{base}/#property?view=tax-lien", wait_until="domcontentloaded")
    page.wait_for_selector("#tax-lien-sale-panel h2", timeout=20_000)
    archive = page.locator("#tax-lien-sale-panel")
    archive_text = archive.inner_text()
    if "Archive reference" not in archive_text and "not linked from the property list" not in archive_text:
        raise RuntimeError("archive posture note is missing on deep-link panel")
    archive.screenshot(path=str(out / "after-archive-panel.png"))


def capture_before(page: Page, base: str, out: Path) -> None:
    open_property_list(page, base, wait_for_note=False)
    page.add_style_tag(content=BEFORE_CSS)
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=str(out / "before-listed-property-page.png"), full_page=False)

    page.goto(f"{base}/#notice/{NOTICE_ID}", wait_until="domcontentloaded")
    page.wait_for_selector("#noticeview .rolename, #noticeview h2", timeout=20_000)
    page.add_style_tag(content=BEFORE_CSS)
    page.wait_for_timeout(300)
    page.screenshot(path=str(out / "before-notice-detail.png"), full_page=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    server, port = start_server()
    base = f"http://127.0.0.1:{port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()

            after_context = browser.new_context(viewport={"width": 1440, "height": 1100})
            after_page = after_context.new_page()
            install_routes(after_page)
            capture_after(after_page, base, out)
            after_context.close()

            before_context = browser.new_context(viewport={"width": 1440, "height": 1100})
            before_page = before_context.new_page()
            install_routes(before_page)
            capture_before(before_page, base, out)
            before_context.close()

            browser.close()
    finally:
        server.shutdown()

    print(f"Wrote screenshots under {out}")
    for path in sorted(out.glob("*.png")):
        print(f"  {path.name} ({path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
