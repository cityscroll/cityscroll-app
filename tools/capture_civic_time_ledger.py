#!/usr/bin/env python3
"""Headless before/after captures for the Civic Time Ledger as-of view.

Serves site/ locally, opens Parks agency constellation at "now" and
?as_of=2024-06-01, and writes 390 + 1440 screenshots under
docs/screenshots/civic-time-ledger/.

    python3 tools/capture_civic_time_ledger.py
"""
from __future__ import annotations

import functools
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "civic-time-ledger"
VIEWPORTS = ((390, 844), (1440, 900))
PAGES = (
    ("parks-now", "/agencies/parks-and-recreation/"),
    ("parks-as-of-2024-06-01", "/agencies/parks-and-recreation/?as_of=2024-06-01"),
    ("probation-now", "/agencies/probation/"),
    ("probation-as-of-2024-06-01", "/agencies/probation/?as_of=2024-06-01"),
)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for name, path in PAGES:
                for width, height in VIEWPORTS:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        device_scale_factor=1,
                    )
                    page = context.new_page()
                    page.goto(base + path, wait_until="networkidle")
                    page.wait_for_selector("[data-civic-time-ledger='1']", timeout=15_000)
                    page.wait_for_selector("[data-agency-constellation-category]", timeout=15_000)
                    # Allow the as-of runtime module to project categories.
                    page.wait_for_timeout(400)
                    if "as_of=" in path:
                        page.wait_for_function(
                            """() => {
                              const panel = document.querySelector('[data-civic-time-ledger]');
                              return panel && panel.getAttribute('data-as-of') === '2024-06-01';
                            }""",
                            timeout=10_000,
                        )
                    dest = OUT / f"{name}-{width}.png"
                    page.screenshot(path=str(dest), full_page=True)
                    print("wrote", dest.relative_to(ROOT))
                    # Compact ledger panel crop (when present) for height comparison.
                    panel = page.query_selector("[data-civic-time-ledger='1']")
                    if panel:
                        crop = OUT / f"{name}-panel-{width}.png"
                        panel.screenshot(path=str(crop))
                        print("wrote", crop.relative_to(ROOT))
                    context.close()
            browser.close()
    finally:
        server.shutdown()

    print("demo:", "https://cityscroll.org/agencies/parks-and-recreation/?as_of=2024-06-01")
    print("demo:", "https://cityscroll.org/agencies/probation/?as_of=2024-06-01")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
