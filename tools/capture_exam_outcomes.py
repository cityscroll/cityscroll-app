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

                # Joined outcomes on a cycle-coherent closed exam (6311 Police Officer).
                page.goto(base + "#exam/6311", wait_until="load")
                card = page.locator("#career-exam-6311")
                card.wait_for(state="visible", timeout=15000)
                joined = card.locator('.career-outcomes[data-outcome="joined"]')
                if joined.count() != 1:
                    failures.append(f"{width}px: exam 6311 missing joined outcomes block")
                else:
                    text = joined.inner_text()
                    # text-transform:uppercase on the heading; match case-insensitively.
                    lower = text.lower()
                    for needle in ("1,010", "74", "68", "1,280", "post-cycle outcomes", "eligible list", "hiring pool"):
                        if needle not in lower and needle not in text:
                            failures.append(f"{width}px: 6311 outcomes missing {needle!r}")

                if not args.verify_only:
                    OUTPUT.mkdir(parents=True, exist_ok=True)
                    path = OUTPUT / f"joined-6311-{width}.png"
                    card.screenshot(path=path, animations="disabled")
                    captures.append(str(path.relative_to(ROOT)))

                # Open EMT (6125): application open; process spine owns empty post-list stages
                # (careerOutcomeHTML skips the redundant gap when the spine is mounted).
                page.evaluate("location.hash='#exam/6125'")
                open_card = page.locator("#career-exam-6125")
                open_card.wait_for(state="visible", timeout=10000)
                spine = open_card.locator("[data-exam-spine='1']")
                if spine.count() != 1:
                    failures.append(f"{width}px: exam 6125 missing process spine")
                spine_text = open_card.inner_text().lower()
                if "open now" not in spine_text and "apply by" not in spine_text:
                    failures.append(f"{width}px: 6125 missing open application lead")
                # Must not claim mid-window list / hire counts.
                if "68 hired" in spine_text or "1,010 on list" in spine_text:
                    failures.append(f"{width}px: 6125 timeline still shows mid-window post-list events")
                if open_card.locator('.career-outcomes[data-outcome="joined"]').count() != 0:
                    failures.append(f"{width}px: 6125 must not show joined annual outcomes mid-window")
                if "does not publish" in spine_text:
                    failures.append(f"{width}px: 6125 still uses false class-(b) city-withhold copy")

                if not args.verify_only:
                    path = OUTPUT / f"open-coherent-6125-{width}.png"
                    open_card.screenshot(path=path, animations="disabled")
                    captures.append(str(path.relative_to(ROOT)))

                # Open pending exam 7013: application spine + no joined hire counts.
                page.evaluate("location.hash='#exam/7013'")
                pending = page.locator("#career-exam-7013")
                pending.wait_for(state="visible", timeout=10000)
                pending_text = pending.inner_text().lower()
                if pending.locator("[data-exam-spine='1']").count() != 1:
                    failures.append(f"{width}px: exam 7013 missing process spine")
                if pending.locator('.career-outcomes[data-outcome="joined"]').count() != 0:
                    failures.append(f"{width}px: 7013 must not show joined annual outcomes")
                if "does not publish" in pending_text:
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

                # Guide list browse (collapsed cards — outcomes mount only on expanded detail).
                page.evaluate("location.hash='#people?view=guide&window=open'")
                page.locator("#career-results .career-card").first.wait_for(state="visible")
                page.wait_for_timeout(200)
                # Collapsed open list must not embed joined outcome metrics in card chrome.
                open_list_text = page.locator("#career-results").inner_text().lower()
                if "68 hired" in open_list_text or "post-cycle outcomes" in open_list_text:
                    failures.append(f"{width}px: open guide list still paints post-cycle outcomes mid-window")

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
