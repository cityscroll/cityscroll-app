#!/usr/bin/env python3
"""Capture and verify the CityScroll identity at review viewports."""
from __future__ import annotations

import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "media" / "review" / "cityscroll-rebrand"
VIEWPORTS = ((390, 844), (1440, 900))

sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=("before", "after"))
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"

    captures = []
    failures = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                page = browser.new_page(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                install_routes(page)
                page.goto(base, wait_until="load")
                page.locator("header.masthead").wait_for(state="visible")
                page.wait_for_timeout(700)

                overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                if overflow > 1:
                    failures.append(f"{width}px: horizontal overflow is {overflow}px")

                if args.stage == "after":
                    brand = page.locator(".brand-lockup")
                    if brand.count() != 1 or not brand.is_visible():
                        failures.append(f"{width}px: CityScroll brand lockup is not visible")
                    if page.locator('link[rel="icon"][type="image/svg+xml"]').count() != 1:
                        failures.append(f"{width}px: SVG favicon metadata is missing")
                    if page.locator('link[rel="apple-touch-icon"]').count() != 1:
                        failures.append(f"{width}px: touch-icon metadata is missing")
                    if "CityScroll" not in page.title():
                        failures.append(f"{width}px: CityScroll is missing from the title")

                if not args.verify_only:
                    OUTPUT.mkdir(parents=True, exist_ok=True)
                    target = OUTPUT / f"{args.stage}-{width}.png"
                    page.screenshot(path=target, animations="disabled")
                    captures.append(str(target.relative_to(ROOT)))
                page.close()
            browser.close()
    finally:
        server.shutdown()

    result = {
        "stage": args.stage,
        "captured_viewports": [width for width, _ in VIEWPORTS],
        "captures": captures,
        "failures": failures,
    }
    print(json.dumps(result, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
