#!/usr/bin/env python3
"""Capture the Staffing landing viewport before and after its content-first rebuild."""
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
OUTPUT = ROOT / "site" / "media" / "review" / "staffing-content-first"
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

    failures = []  # Runtime viewport-check results; no sourced data.
    captures = []  # Paths created by this run; no sourced data.
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                page = browser.new_page(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                install_routes(page)
                page.goto(base + "#people", wait_until="load")
                page.locator("#tab-people").wait_for(state="visible")
                page.wait_for_timeout(1000)
                focus = "#staffing-feed" if args.stage == "after" else "#staffing-pathways"

                if args.stage == "after":
                    page.locator("#staffing-notice-list .staffing-notice-card").first.wait_for(
                        state="visible"
                    )
                    if not page.locator("#staffing-feed-heading").is_visible():
                        failures.append(f"{width}px: newest-notices heading is not visible")
                    first_date = page.locator(
                        "#staffing-notice-list .staffing-notice-date"
                    ).first.inner_text()
                    if not first_date:
                        failures.append(f"{width}px: first staffing notice has no date")

                page.eval_on_selector(focus, "el => el.scrollIntoView({block: 'start'})")
                page.wait_for_timeout(100)
                overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                if overflow > 1:
                    failures.append(f"{width}px: horizontal overflow is {overflow}px")

                if not args.verify_only:
                    OUTPUT.mkdir(parents=True, exist_ok=True)
                    target = OUTPUT / f"{args.stage}-{width}.png"
                    page.screenshot(path=target, animations="disabled")
                    captures.append(str(target.relative_to(ROOT)))
                if args.stage == "after":
                    page.locator('[data-staffing-type="exam"]').click()
                    page.locator(
                        '#staffing-notice-list .staffing-notice-card[data-kind="exam"]'
                    ).first.wait_for(state="visible")
                    page.locator("#staffing-exam-help").click()
                    page.locator("#career-guide").wait_for(state="visible")
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
