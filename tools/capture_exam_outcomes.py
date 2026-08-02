#!/usr/bin/env python3
"""Capture exam-card outcome joins at review viewports (joined, list_joined, not-yet-ingested)."""
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
OUTPUT = ROOT / "docs" / "screenshots" / "exam-outcomes"
VIEWPORTS = ((390, 844), (1440, 900))

sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    failures = []
    captures = []

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                page = context.new_page()
                install_routes(page)
                page.add_init_script("localStorage.setItem('crol_exam_how_seen_v1', '1')")

                # Joined outcomes on EMT (6125).
                page.goto(base + "#exam/6125", wait_until="load")
                card = page.locator("#career-exam-6125")
                card.wait_for(state="visible", timeout=15000)
                joined = card.locator('.career-outcomes[data-outcome="joined"]')
                if joined.count() != 1:
                    failures.append(f"{width}px: exam 6125 missing joined outcomes block")
                else:
                    text = joined.inner_text()
                    # text-transform:uppercase on the heading; match case-insensitively.
                    lower = text.lower()
                    for needle in ("1,010", "74", "68", "1,280", "post-cycle outcomes", "eligible list", "hiring pool"):
                        if needle not in lower and needle not in text:
                            failures.append(f"{width}px: 6125 outcomes missing {needle!r}")

                if not args.verify_only:
                    OUTPUT.mkdir(parents=True, exist_ok=True)
                    path = OUTPUT / f"joined-6125-{width}.png"
                    card.screenshot(path=path, animations="disabled")
                    captures.append(str(path.relative_to(ROOT)))

                # Class-(a) not-yet-ingested gap on Automotive Service Worker (7013).
                page.evaluate("location.hash='#exam/7013'")
                pending = page.locator("#career-exam-7013")
                pending.wait_for(state="visible", timeout=10000)
                gap = pending.locator('.career-outcomes[data-outcome="not_yet_ingested"]')
                if gap.count() != 1:
                    failures.append(f"{width}px: exam 7013 missing not-yet-ingested outcomes block")
                else:
                    gap_text = gap.inner_text()
                    lower = gap_text.lower()
                    if "not yet shown" not in lower and "eligible-list" not in lower:
                        failures.append(f"{width}px: 7013 gap missing class-(a) register")
                    if "does not publish" in lower:
                        failures.append(f"{width}px: 7013 still uses false class-(b) city-withhold copy")

                if not args.verify_only:
                    path = OUTPUT / f"pending-7013-{width}.png"
                    pending.screenshot(path=path, animations="disabled")
                    captures.append(str(path.relative_to(ROOT)))

                # list_joined depth on a closed exam with Civil Service List presence (6024).
                page.evaluate("location.hash='#exam/6024'")
                list_card = page.locator("#career-exam-6024")
                list_card.wait_for(state="visible", timeout=10000)
                list_block = list_card.locator('.career-outcomes[data-outcome="list_joined"]')
                if list_block.count() != 1:
                    failures.append(f"{width}px: exam 6024 missing list_joined outcomes block")
                else:
                    list_text = list_block.inner_text().lower()
                    if "civil service list" not in list_text and "eligible list" not in list_text:
                        failures.append(f"{width}px: 6024 list_joined missing list copy")

                if not args.verify_only:
                    path = OUTPUT / f"list-joined-6024-{width}.png"
                    list_card.screenshot(path=path, animations="disabled")
                    captures.append(str(path.relative_to(ROOT)))

                # Open list with joined + class-(a) gap states visible.
                page.evaluate("location.hash='#people?view=guide&window=open'")
                page.locator("#career-results .career-card").first.wait_for(state="visible")
                page.wait_for_timeout(200)
                if page.locator('.career-outcomes[data-outcome="joined"]').count() < 1:
                    failures.append(f"{width}px: open list has no joined outcome cards")
                if page.locator('.career-outcomes[data-outcome="not_yet_ingested"]').count() < 1:
                    failures.append(f"{width}px: open list has no not-yet-ingested outcome cards")

                if not args.verify_only:
                    path = OUTPUT / f"open-list-{width}.png"
                    page.locator(".career-browser").screenshot(path=path, animations="disabled")
                    captures.append(str(path.relative_to(ROOT)))

                context.close()
            browser.close()
    finally:
        server.shutdown()

    if failures:
        print("FAILURES:")
        for item in failures:
            print(" -", item)
        raise SystemExit(1)

    summary = {
        "viewports": [list(v) for v in VIEWPORTS],
        "captures": captures,
        "verify_only": args.verify_only,
    }
    if not args.verify_only:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        (OUTPUT / "metrics.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
