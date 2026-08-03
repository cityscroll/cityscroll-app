#!/usr/bin/env python3
"""Capture the cache-busted Staffing landing before/after its action-first inversion."""
from __future__ import annotations

import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import time

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "staffing-action-first"
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

    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    cache_bust = str(time.time_ns())
    failures = []
    captures = []

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                page = browser.new_page(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                install_routes(page)
                page.goto(f"{base}?staffing-capture={cache_bust}#people", wait_until="load")
                if args.stage == "before":
                    page.locator("#staffing-notice-list .staffing-hire-row").first.wait_for(
                        state="visible"
                    )
                    if not page.locator("#staffing-feed-heading").is_visible():
                        failures.append(f"{width}px: the pre-inversion personnel heading is missing")
                else:
                    page.locator("#career-results .career-card").first.wait_for(state="visible")
                    if not page.locator("#career-browser-heading").is_visible():
                        failures.append(f"{width}px: the action-first exam heading is missing")
                    if page.locator("#staffing-ledger").get_attribute("open") is not None:
                        failures.append(f"{width}px: the appointments ledger is open by default")
                    if page.locator("#career-results .career-action-facts").count() < 1:
                        failures.append(f"{width}px: exam cards do not expose action facts")

                overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                if overflow > 1:
                    failures.append(f"{width}px: horizontal overflow is {overflow}px")
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
        "cache_bust": cache_bust,
        "captured_viewports": [width for width, _ in VIEWPORTS],
        "captures": captures,
        "failures": failures,
    }
    print(json.dumps(result, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
