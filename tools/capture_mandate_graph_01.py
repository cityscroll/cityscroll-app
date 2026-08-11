#!/usr/bin/env python3
"""Headless screenshots for mandate co-located graph neighbors (mand-graph-01).

Captures Parks & Recreation and Citywide Administrative Services agency
constellation mandate sections at 390 and 1440 after the pages are built.

  python3 tools/capture_mandate_graph_01.py
"""

from __future__ import annotations

import http.server
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OUT = ROOT / "docs" / "screenshots" / "mandate-graph-01"
VIEWPORTS = ((390, 844), (1440, 900))
DEMOS = (
    ("parks", "/agencies/parks-and-recreation/", ("#mandates-rules", "#mandates-reports", "#mandates-predictions")),
    ("dcas", "/agencies/citywide-administrative-services/", ("#mandates-rules", "#mandates-reports", "#mandates-predictions")),
)


class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def serve(site: Path) -> tuple[socketserver.TCPServer, str]:
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _Handler)
    httpd.allow_reuse_address = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host, port = httpd.server_address
    return httpd, f"http://{host}:{port}"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    httpd, base = serve(SITE)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for slug, path, sections in DEMOS:
                for width, height in VIEWPORTS:
                    page = browser.new_page(viewport={"width": width, "height": height})
                    page.goto(f"{base}{path}", wait_until="networkidle", timeout=60_000)
                    for selector in sections:
                        try:
                            page.wait_for_selector(selector, timeout=8_000)
                        except Exception:
                            continue
                    # Full page after for navigation context.
                    full = OUT / f"{slug}-after-{width}.png"
                    page.screenshot(path=str(full), full_page=True)
                    print(f"wrote {full.relative_to(ROOT)}")
                    for selector in sections:
                        loc = page.locator(selector)
                        if loc.count() == 0:
                            continue
                        loc.first.scroll_into_view_if_needed()
                        page.wait_for_timeout(120)
                        name = selector.lstrip("#")
                        out = OUT / f"{slug}-{name}-after-{width}.png"
                        loc.first.screenshot(path=str(out))
                        print(f"wrote {out.relative_to(ROOT)}")
                        # Assert clickable graph neighbors exist.
                        html = loc.first.inner_html()
                        assert "Source law" in html or "data-mandate-edge" in html or "mandate-source-law" in html
                        assert (
                            "Open in Rules" in html
                            or "Open in Meetings" in html
                            or "Open in Contracts" in html
                            or "data-mandate-graph-neighbor" in html
                        ), f"{slug} {selector} missing graph-neighbor actions"
                    page.close()
            browser.close()
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
