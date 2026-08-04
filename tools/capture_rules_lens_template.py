#!/usr/bin/env python3
"""Capture and verify the shared lens template on Rules."""
from __future__ import annotations

import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import sys
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "rules-lens-template"
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

    failures: list[str] = list()
    captures: list[str] = list()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height, name in VIEWPORTS:
                page = browser.new_page(
                    viewport={"width": width, "height": height}, device_scale_factor=1
                )
                install_routes(page)
                page.goto(base + "#rules", wait_until="load")
                page.locator("#rulesfeed .rules-fcard").first.wait_for(state="visible")

                if page.locator("#rules-more-filters").get_attribute("open") is not None:
                    failures.append(f"{name}: secondary filters are open by default")
                if page.locator("#rules-domain-intro .lens-method").get_attribute("open") is not None:
                    failures.append(f"{name}: methodology is open by default")
                if page.locator("#rulesprocessrail button").count() < 5:
                    failures.append(f"{name}: rulemaking-stage rail has fewer than five choices")
                if page.locator("#rulesprocessrail button[aria-pressed='true']").count() != 1:
                    failures.append(f"{name}: rulemaking-stage rail lacks one selected choice")

                count = page.locator("#rules-count").inner_text().strip()
                cards = page.locator("#rulesfeed .rules-fcard").count()
                count_number = re.search(r"\d+", count)
                if count_number is None or int(count_number.group()) != cards:
                    failures.append(f"{name}: result count {count!r} does not equal {cards} cards")
                if page.locator("#rulesfeed .empty").count():
                    failures.append(f"{name}: loaded list contains an empty-state panel")
                overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                if overflow > 1:
                    failures.append(f"{name}: horizontal overflow is {overflow}px")

                page.locator("#rules-toolbar").scroll_into_view_if_needed()
                if not args.verify_only:
                    OUTPUT.mkdir(parents=True, exist_ok=True)
                    target = OUTPUT / f"{name}.png"
                    page.screenshot(path=target, animations="disabled", full_page=True)
                    captures.append(str(target.relative_to(ROOT)))

                page.locator("#rulesfeed .rules-fcard .ftitle a").first.click()
                page.locator("#noticeview").wait_for(state="visible")
                page.wait_for_timeout(100)
                if page.locator("#noticeview .lc-norecord, #noticeview .box.unmatched, #noticeview .box.unknown").count():
                    failures.append(f"{name}: unpublished lifecycle data produced an apology panel")
                page.close()
            browser.close()
    finally:
        server.shutdown()

    result = dict(captures=captures, failures=failures)
    print(json.dumps(result, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
