#!/usr/bin/env python3
"""Before/after evidence for Staffing civil-service exam list vs redirect-only panel.

Field case: #people?type=exam&role=Police+Communications+Technician

Captures production (before) and the local site tree (after) at 390 and 1440,
focused on #staffing-feed so the result count and #staffing-notice-list rows
are visible.

  python3 tools/capture_staffing_exam_list.py
"""

from __future__ import annotations

import functools
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "staffing-exam-list"
VIEWPORTS = ((390, 844), (1440, 900))
ROLE = "Police Communications Technician"
HASH = f"#people?type=exam&role={ROLE.replace(' ', '+')}"
PROD = "https://cityscroll.org/"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def wait_exam_feed(page) -> None:
    page.wait_for_selector("#staffing-feed", timeout=45000)
    page.wait_for_selector("#staffing-result-count", timeout=45000)
    # Allow hire notices + staffing_exams.json to paint the exam list or redirect.
    page.wait_for_timeout(2500)
    page.evaluate(
        """() => {
      const el = document.querySelector("#staffing-feed");
      if (el) el.scrollIntoView({ block: "start" });
    }"""
    )
    page.wait_for_timeout(200)


def shot(page, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path), animations="disabled")


def capture(browser, base: str, phase: str) -> dict:
    stats = {"phase": phase, "viewports": {}}
    for width, height in VIEWPORTS:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.goto(base.rstrip("/") + "/" + "index.html" + HASH, wait_until="domcontentloaded", timeout=60000)
        wait_exam_feed(page)
        count_text = page.locator("#staffing-result-count").inner_text()
        exam_rows = page.locator('#staffing-notice-list [data-kind="exam"]').count()
        redirect = page.locator("#staffing-notice-list .staffing-exam-redirect").count()
        stats["viewports"][str(width)] = {
            "count_text": count_text,
            "exam_rows": exam_rows,
            "redirect_panels": redirect,
        }
        target = OUT / f"{phase}-{width}.png"
        shot(page, target)
        context.close()
    return stats


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    results = []  # Capture phase stats from this run; no sourced data.
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            results.append(capture(browser, PROD, "before"))
            with StaticServer() as local:
                # Brief pause so the bound port is ready for first request.
                time.sleep(0.15)
                results.append(capture(browser, local, "after"))
        finally:
            browser.close()

    print("staffing exam list captures:")
    for block in results:
        print(f"  {block['phase']}: {block['viewports']}")
    after = next(b for b in results if b["phase"] == "after")
    failures = []  # Runtime viewport-check results; no sourced data.
    for width, info in after["viewports"].items():
        if info["exam_rows"] < 1:
            failures.append(f"{width}px after: expected exam rows, got {info['exam_rows']}")
        if info["redirect_panels"] > 0:
            failures.append(f"{width}px after: unexpected redirect panel")
        if "0 exams" in (info["count_text"] or "").lower():
            failures.append(f"{width}px after: zero exam count ({info['count_text']!r})")
    if failures:
        raise SystemExit("; ".join(failures))


if __name__ == "__main__":
    main()
