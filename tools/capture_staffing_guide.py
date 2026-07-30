#!/usr/bin/env python3
"""Verify and capture the precomputed Staffing guide at review viewports."""
from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "staffing-guide"
VIEWPORTS = ((390, 844), (1440, 900))

sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def file_metrics():
    paths = ["index.html", "i18n.js", "staffing.js", "data/staffing_exams.json"]  # Static guide dependencies.
    files = {}  # Exact size measurements keyed by dependency.
    for name in paths:
        raw = (ROOT / "site" / name).read_bytes()
        files[name] = {"bytes": len(raw), "gzip_bytes": len(gzip.compress(raw, compresslevel=9))}  # Measured bytes.
    files["guide_incremental"] = {
        "bytes": files["staffing.js"]["bytes"] + files["data/staffing_exams.json"]["bytes"],
        "gzip_bytes": files["staffing.js"]["gzip_bytes"] + files["data/staffing_exams.json"]["gzip_bytes"],
    }
    return files


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **kw: QuietHandler(*a, directory=str(ROOT / "site"), **kw))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"

    failures = []  # Browser assertions collected across both viewports.
    captures = []  # Repository-relative paths written during capture mode.
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
                install_routes(page)
                page.goto(base + "#people", wait_until="load")
                page.locator("#staffing-upcoming-list .staffing-upcoming-item").first.wait_for(state="visible")
                if page.locator("#staffing-upcoming-list .staffing-upcoming-item").count() != 4:
                    failures.append(f"{width}px: Staffing page did not render four featured exams")
                if not page.locator("#staffing-upcoming-list .staffing-upcoming-item").first.get_attribute("href").startswith("#exam/"):
                    failures.append(f"{width}px: featured exam does not deep-link to its guide detail")
                if page.locator('a[href="#people?view=guide"]').count() < 2:
                    failures.append(f"{width}px: contextual Staffing-to-guide links are missing")
                if page.locator("#staffing-notice-list .staffing-notice-card").count() < 1:
                    failures.append(f"{width}px: Staffing does not open on live appointment notices")
                tagged_role = page.evaluate(
                    """() => roleRowHTML(
                      {title_description:'CASEWORKER', n:'20', mn:'50000', mx:'70000'},
                      0, ['caseworker'], true,
                      CrolStaffing.examForTitle(careerData.exams, 'CASEWORKER', careerToday())
                    )"""
                )
                if 'class="staffing-exam-link"' not in tagged_role or 'href="#exam/7016"' not in tagged_role:
                    failures.append(f"{width}px: matching Staffing role was not tagged with its exam detail")
                card = page.locator("#career-exam-7016")
                page.evaluate("location.hash='#exam/7016'")
                card.wait_for(state="visible")
                if page.evaluate("location.hash") != "#exam/7016":
                    failures.append(f"{width}px: exam deep link was rewritten")
                if "CASEWORKER" not in card.inner_text().upper():
                    failures.append(f"{width}px: deep-linked exam did not render")
                if card.locator('a[href="https://www.nyc.gov/examsforjobs"]').count() != 1:
                    failures.append(f"{width}px: open exam has no OASys action")
                overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                if overflow > 1:
                    failures.append(f"{width}px: horizontal overflow is {overflow}px")
                if not args.verify_only:
                    OUTPUT.mkdir(parents=True, exist_ok=True)
                    target = OUTPUT / f"guide-{width}.png"
                    page.evaluate("location.hash='#people'")
                    page.locator("#staffing-feed").wait_for(state="visible")
                    page.locator("#staffing-feed").screenshot(path=target, animations="disabled")
                    captures.append(str(target.relative_to(ROOT)))
                page.close()
            browser.close()
    finally:
        server.shutdown()

    metrics = {
        "captured_viewports": [width for width, _ in VIEWPORTS],
        "page_weight": file_metrics(),
        "notes": "Guide incremental weight is the dependency-free staffing module plus the precomputed exam JSON. The Staffing-page exam module and exam tags reuse that artifact; no NYC API request is required to render them.",
        "captures": captures,
    }
    if not args.verify_only:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        (OUTPUT / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    print(json.dumps(metrics, indent=2))
    if failures:
        for failure in failures:
            print("FAIL", failure)
        raise SystemExit(1)
    print("Staffing notice feed, contextual guide, exam-tag, deep-link, responsive-layout, and capture checks passed.")


if __name__ == "__main__":
    main()
