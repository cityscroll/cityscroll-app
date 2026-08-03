#!/usr/bin/env python3
"""Cache-busted capture of People guide exam rows for OASys deep-link evidence."""
from __future__ import annotations

import argparse
import functools
import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "oasys-exam-deeplink"
GOLDEN = ("6125", "7312")
VIEWPORTS = ((390, 844), (1440, 900))


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
    exams = {}

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                page = browser.new_page(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                page.goto(
                    f"{base}?oasys-deeplink={cache_bust}#people?view=guide&window=open",
                    wait_until="load",
                )
                page.locator("#career-results .career-card").first.wait_for(
                    state="visible", timeout=20000
                )
                for num in GOLDEN:
                    card = page.locator(f"#career-exam-{num}")
                    if card.count() == 0:
                        failures.append(f"{width}px: missing exam card {num}")
                        exams[num] = {"present": False}
                        continue
                    apply = card.locator("a.act.primary").first
                    href = apply.get_attribute("href") if apply.count() else None
                    label = apply.inner_text().strip() if apply.count() else None
                    handoff = apply.get_attribute("data-oasys-handoff") if apply.count() else None
                    exams[num] = {
                        "present": True,
                        "href": href,
                        "label": label,
                        "handoff": handoff,
                    }
                    if args.stage == "after":
                        if not href or "examsforjobs" in (href or ""):
                            failures.append(
                                f"{width}px: exam {num} still links examsforjobs hub ({href})"
                            )
                        if not href or "noe?examId=" not in (href or ""):
                            failures.append(
                                f"{width}px: exam {num} missing OASys NOE deep link ({href})"
                            )
                        if handoff != "deep":
                            failures.append(
                                f"{width}px: exam {num} data-oasys-handoff={handoff!r}"
                            )
                    if not args.verify_only:
                        OUTPUT.mkdir(parents=True, exist_ok=True)
                        card.scroll_into_view_if_needed()
                        target = OUTPUT / f"{args.stage}-{num}-{width}.png"
                        card.screenshot(path=str(target))
                        captures.append(str(target.relative_to(ROOT)))
                if not args.verify_only:
                    guide = OUTPUT / f"{args.stage}-guide-open-{width}.png"
                    page.screenshot(path=str(guide), animations="disabled")
                    captures.append(str(guide.relative_to(ROOT)))
                page.close()
            browser.close()
    finally:
        server.shutdown()

    result = {
        "stage": args.stage,
        "cache_bust": cache_bust,
        "exams": exams,
        "captures": captures,
        "failures": failures,
    }
    print(json.dumps(result, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
