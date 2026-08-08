#!/usr/bin/env python3
"""Headless screenshots for Mandates prediction-alerts card.

Captures Parks & Recreation agency constellation #mandates-predictions at 390 and 1440.

  python3 tools/capture_mandate_prediction_alerts.py
"""

from __future__ import annotations

import http.server
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OUT = ROOT / "docs" / "screenshots" / "mandate-prediction-alerts"
VIEWPORTS = ((390, 844), (1440, 900))
DEMO_PATH = "/agencies/parks-and-recreation/#mandates-predictions"


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
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.goto(f"{base}{DEMO_PATH}", wait_until="networkidle", timeout=60_000)
                page.wait_for_selector("#mandates-predictions", timeout=30_000)
                page.locator("#mandates-predictions").scroll_into_view_if_needed()
                page.wait_for_timeout(200)
                out = OUT / f"parks-mandates-predictions-{width}.png"
                page.screenshot(path=str(out), full_page=True)
                print(f"wrote {out.relative_to(ROOT)}")
                section = OUT / f"parks-mandates-predictions-section-{width}.png"
                page.locator("#mandates-predictions").screenshot(path=str(section))
                print(f"wrote {section.relative_to(ROOT)}")
                page.close()
            browser.close()
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
