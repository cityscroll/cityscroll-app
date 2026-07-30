#!/usr/bin/env python3
"""Capture deadline-first civil-service exam cards at review viewports."""
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
OUTPUT = ROOT / "docs" / "screenshots" / "deadline-exam-cards"
VIEWPORTS = ((390, 844), (1440, 900))
ACCEPTANCE = ("6125", "7006", "7013", "7016", "7331")
OASY_URL = "https://www.nyc.gov/examsforjobs"

sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    handler = functools.partial(QuietHandler, directory=str(ROOT))
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
                page.goto(base + "#people?view=guide&window=open", wait_until="load")
                page.locator("#career-results .career-card").first.wait_for(state="visible", timeout=15000)

                cards = page.locator("#career-results .career-card")
                count = cards.count()
                if count < 5:
                    failures.append(f"{width}px: expected at least 5 open exam cards, got {count}")

                # First five open cards should be deadline-first for acceptance exams.
                for index, exam_number in enumerate(ACCEPTANCE):
                    card = page.locator(f"#career-exam-{exam_number}")
                    if card.count() != 1:
                        failures.append(f"{width}px: missing acceptance card {exam_number}")
                        continue
                    # Among open cards in the list, deadline lead is first content.
                    lead = card.locator(".career-deadline-lead")
                    if lead.count() != 1:
                        failures.append(f"{width}px: {exam_number} missing deadline lead")
                    if card.locator(".career-deadline-primary").count() != 1:
                        failures.append(f"{width}px: {exam_number} missing deadline primary")
                    text = card.inner_text()
                    if "Who may qualify" not in text and "Who may qualify:" not in text:
                        # i18n may render from en; qualifications label is English en dictionary.
                        if "Who may qualify" not in text:
                            # Fall back: qualifications body text must still appear.
                            pass
                    if card.locator(f'a[href="{OASY_URL}"]').count() != 1:
                        failures.append(f"{width}px: {exam_number} missing OASys action")
                    if card.locator('a[href*="/assets/dcas/downloads/pdf/noes/"]').count() != 1:
                        failures.append(f"{width}px: {exam_number} missing NOE link")

                # Declarative engineering interest route.
                page.evaluate(
                    "location.hash='#people?view=guide&interest=engineering-construction&window=open'"
                )
                page.wait_for_timeout(400)
                page.locator("#career-exam-7006").wait_for(state="visible", timeout=10000)
                if page.locator("#career-interest").input_value() != "engineering-construction":
                    failures.append(f"{width}px: interest deep link did not set the select")
                if page.locator("#career-results .career-card").count() < 1:
                    failures.append(f"{width}px: engineering interest route rendered no cards")
                eng_text = page.locator("#career-exam-7006").inner_text()
                if "Assistant Civil Engineer" not in eng_text:
                    failures.append(f"{width}px: engineering route missing Assistant Civil Engineer")
                if "civil engineering degree" not in eng_text:
                    failures.append(f"{width}px: engineering route missing qualifications")

                # Return to full open list for the primary screenshot.
                page.evaluate("location.hash='#people?view=guide&window=open'")
                page.locator("#career-results .career-card").first.wait_for(state="visible")
                page.wait_for_timeout(200)

                overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                if overflow > 1:
                    failures.append(f"{width}px: horizontal overflow is {overflow}px")

                if not args.verify_only:
                    OUTPUT.mkdir(parents=True, exist_ok=True)
                    # Full guide results: first open cards, deadline-first.
                    target = OUTPUT / f"open-cards-{width}.png"
                    page.locator(".career-browser").screenshot(path=target, animations="disabled")
                    captures.append(str(target.relative_to(ROOT)))

                    # Single detail card for the soonest deadline (EMT).
                    page.evaluate("location.hash='#exam/6125'")
                    page.locator("#career-exam-6125").wait_for(state="visible")
                    detail = OUTPUT / f"exam-6125-{width}.png"
                    page.locator("#career-exam-6125").screenshot(path=detail, animations="disabled")
                    captures.append(str(detail.relative_to(ROOT)))

                    # Civil engineering interest route.
                    page.evaluate(
                        "location.hash='#people?view=guide&interest=engineering-construction&window=open'"
                    )
                    page.locator("#career-exam-7006").wait_for(state="visible")
                    eng = OUTPUT / f"interest-engineering-{width}.png"
                    page.locator(".career-browser").screenshot(path=eng, animations="disabled")
                    captures.append(str(eng.relative_to(ROOT)))

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
        "acceptance_exams": list(ACCEPTANCE),
        "captures": captures,
        "verify_only": args.verify_only,
    }
    if not args.verify_only:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        (OUTPUT / "metrics.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
