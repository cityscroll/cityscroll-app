#!/usr/bin/env python3
"""Capture deterministic before/after evidence for tax-lien sale surfaces.

The page is served from ``site/`` and the Property API is replaced with one
stable listed-BBL fixture. The before frames hide the new panel and card note,
matching the preceding Property lens without requiring a second checkout.

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

PROPERTY = {
    "request_id": "20250601001",
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

PROPERTY_PAYLOAD = {
    "generated_at": "2026-08-03T00:00:00Z",
    "properties": [PROPERTY],
    "disposition_spines": [],
}

BEFORE_CSS = """
#tax-lien-sale-panel,
.tax-lien-card-slot { display: none !important; }
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
    # Specific routes are registered last because Playwright matches in reverse order.
    page.route(
        "https://api.cityscroll.org/property-locations*",
        lambda route: json_response(route, PROPERTY_PAYLOAD),
    )
    page.route(
        "https://crol-worker.crol-worker.workers.dev/property-locations*",
        lambda route: json_response(route, PROPERTY_PAYLOAD),
    )


def open_property(page: Page, base: str, *, wait_for_note: bool) -> None:
    page.goto(f"{base}/#property", wait_until="domcontentloaded")
    page.wait_for_selector("#propertyfeed .property-fcard", timeout=20_000)
    page.wait_for_selector("#tax-lien-sale-panel h2", timeout=20_000, state="attached")
    if wait_for_note:
        page.wait_for_selector("#propertyfeed .tax-lien-card-note", timeout=20_000)
    page.wait_for_timeout(300)


def assert_layout(page: Page) -> None:
    overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
    if overflow:
        raise RuntimeError("tax-lien capture has horizontal overflow")
    text = page.locator("#tax-lien-sale-panel").inner_text()
    if "lien, not the property" not in text or "historical context, not a current warning" not in text:
        raise RuntimeError("owner-protective or expired-cycle copy is missing")
    if "observed BBL status and cohort statistics only" not in text:
        raise RuntimeError("below-bar cohort-only copy is missing")
    if "ended June 3, 2025" not in text or "due June 2, 2025" not in text:
        raise RuntimeError("date-only civic dates shifted across a time-zone boundary")
    if page.locator("#tax-lien-sale-panel .tax-lien-nta-scroll tbody tr").count() <= 12:
        raise RuntimeError("aggregate lens did not expose the complete NTA table")


def capture_after(page: Page, base: str, out: Path) -> None:
    open_property(page, base, wait_for_note=True)
    assert_layout(page)

    panel = page.locator("#tax-lien-sale-panel")
    panel.screenshot(path=str(out / "after-aggregate-view.png"))

    lookup = page.locator("#tax-lien-bbl")
    lookup.fill(BBL)
    page.locator("#tax-lien-bbl-go").click()
    page.wait_for_selector("#tax-lien-bbl-result .tax-lien-result-card")
    result = page.locator("#tax-lien-bbl-result").inner_text()
    if BBL not in result or "Latest observed stage" not in result:
        raise RuntimeError("BBL result did not render its observed stage")

    card = page.locator("#propertyfeed .property-fcard")
    card.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    page.screenshot(path=str(out / "after-listed-property-page.png"), full_page=False)


def capture_before(page: Page, base: str, out: Path) -> None:
    open_property(page, base, wait_for_note=False)
    page.add_style_tag(content=BEFORE_CSS)
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=str(out / "before-aggregate-view.png"), full_page=False)
    card = page.locator("#propertyfeed .property-fcard")
    card.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    page.screenshot(path=str(out / "before-listed-property-page.png"), full_page=False)


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
