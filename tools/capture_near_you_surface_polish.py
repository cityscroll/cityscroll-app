#!/usr/bin/env python3
"""Capture focused Near-you public-copy evidence with the project Playwright pattern."""

from __future__ import annotations

import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "near-you-surface-polish"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return


def serve():
    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("before", "after"))
    args = parser.parse_args()

    OUTPUT.mkdir(parents=True, exist_ok=True)
    server, base = serve()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1440, "height": 1000},
                java_script_enabled=False,
            )
            page = context.new_page()
            page.goto(
                f"{base}/near-you/borough/bronx/",
                wait_until="domcontentloaded",
            )
            section = page.locator(".near-map-section")
            section.wait_for()
            section.screenshot(path=str(OUTPUT / f"{args.phase}-map-copy-1440.png"))
            context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    print("wrote", (OUTPUT / f"{args.phase}-map-copy-1440.png").relative_to(ROOT))


if __name__ == "__main__":
    main()
