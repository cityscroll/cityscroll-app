#!/usr/bin/env python3
"""Capture the Homeless Services Mandates → Contracts section at review widths."""

from __future__ import annotations

import http.server
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OUT = ROOT / "docs" / "screenshots" / "mandate-contracts-bridge"
VIEWPORTS = ((390, 844), (1440, 900))
DEMO_PATH = "/agencies/homeless-services/#mandates-contracts"


class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def serve() -> tuple[socketserver.TCPServer, str]:
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _Handler)
    httpd.allow_reuse_address = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    host, port = httpd.server_address
    return httpd, f"http://{host}:{port}"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    httpd, base = serve()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.goto(f"{base}{DEMO_PATH}", wait_until="networkidle", timeout=60_000)
                section = page.locator("#mandates-contracts")
                section.wait_for(timeout=30_000)
                section.scroll_into_view_if_needed()
                page.wait_for_timeout(200)
                page.screenshot(
                    path=str(OUT / f"homeless-services-mandates-contracts-{width}.png"),
                    full_page=True,
                )
                section.screenshot(
                    path=str(OUT / f"homeless-services-mandates-contracts-section-{width}.png"),
                )
                page.close()
            browser.close()
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
