#!/usr/bin/env python3
"""Capture and verify the shared lens template on Staffing."""
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
OUTPUT = ROOT / "docs" / "screenshots" / "staffing-lens-template"
VIEWPORTS = ((390, 844, "mobile"), (1440, 900, "desktop"))

sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"

    failures: list[str] = []
    captures: list[str] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height, name in VIEWPORTS:
                page = browser.new_page(
                    viewport={"width": width, "height": height}, device_scale_factor=1
                )
                install_routes(page)
                page.goto(base + "#people", wait_until="load")
                page.locator("#career-results .career-card").first.wait_for(state="visible")

                if page.locator("#staffing-more-filters").get_attribute("open") is not None:
                    failures.append(f"{name}: secondary filters are open by default")
                if page.locator("#staffing-ledger").get_attribute("open") is not None:
                    failures.append(f"{name}: appointment history is open by default")
                if page.locator("#career-format-rail .chip").count() < 2:
                    failures.append(f"{name}: primary exam-format rail has fewer than two choices")
                count = page.locator("#career-result-count").inner_text().strip()
                if not count:
                    failures.append(f"{name}: result count is empty")
                overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                if overflow > 1:
                    failures.append(f"{name}: horizontal overflow is {overflow}px")

                page.locator("#career-guide").scroll_into_view_if_needed()
                if not args.verify_only:
                    OUTPUT.mkdir(parents=True, exist_ok=True)
                    target = OUTPUT / f"{name}.png"
                    page.screenshot(path=target, animations="disabled")
                    captures.append(str(target.relative_to(ROOT)))

                page.locator("#career-results .career-card a[href^='#exam/']").first.click()
                page.locator("#career-results .career-card.selected").wait_for(state="visible")
                if page.locator(
                    "#career-results .lc-norecord, #career-results [data-outcome='not_yet_ingested']"
                ).count():
                    failures.append(f"{name}: absent exam data produced an apology panel")
                page.close()
            browser.close()
    finally:
        server.shutdown()

    result = {"captures": captures, "failures": failures}
    print(json.dumps(result, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
