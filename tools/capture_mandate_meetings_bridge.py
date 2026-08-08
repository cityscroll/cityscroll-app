#!/usr/bin/env python3
"""Capture the mandate → meetings section at mobile and desktop widths."""

from __future__ import annotations

import http.server
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OUT = ROOT / "docs" / "screenshots" / "mandate-meetings-bridge"
VIEWPORTS = ((390, 844), (1440, 900))
DEMO_PATH = "/agencies/landmarks-preservation-commission/#mandates-meetings"


class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host, port = httpd.server_address
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.goto(
                    f"http://{host}:{port}{DEMO_PATH}",
                    wait_until="networkidle",
                    timeout=60_000,
                )
                section = page.locator("#mandates-meetings")
                section.wait_for(timeout=30_000)
                section.scroll_into_view_if_needed()
                page.wait_for_timeout(200)
                output = OUT / f"landmarks-mandates-meetings-{width}.png"
                section.screenshot(path=str(output))
                print(f"wrote {output.relative_to(ROOT)}")
                page.close()
            browser.close()
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
