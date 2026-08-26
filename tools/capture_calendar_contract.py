#!/usr/bin/env python3
"""Capture the pre-calendar-affordance Meetings surface as local evidence."""
from __future__ import annotations

import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "evidence" / "calendar-contract" / "before"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height, name in ((390, 844, "mobile"), (1440, 900, "desktop")):
                page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
                page.goto(base + "#meetings", wait_until="networkidle")
                page.locator("#meetingsfeed .meetings-fcard").first.wait_for(state="visible")
                body = page.locator("body").inner_text()
                assert "Subscribe to calendar" not in body
                assert page.locator('a[href*="feed.ics"]').count() == 0
                page.screenshot(path=OUTPUT / f"meetings-ui-{name}.png", animations="disabled")
                page.close()
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
