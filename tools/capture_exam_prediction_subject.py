#!/usr/bin/env python3
"""Capture the exam 6125 Apply-now card before and after claim-first copy."""

from __future__ import annotations

import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "exam-prediction-subject"
PRODUCTION = "https://cityscroll.org/"
ROUTE = "index.html#exam/6125"
VIEWPORTS = ((390, 900), (1440, 1100))


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


def capture(browser, base: str, stage: str) -> None:
    for width, height in VIEWPORTS:
        page = browser.new_page(viewport={"width": width, "height": height})
        page.goto(base + ROUTE, wait_until="domcontentloaded", timeout=60_000)
        card = page.locator("#career-exam-6125")
        card.wait_for(state="visible", timeout=45_000)
        prediction = card.locator('[data-staffing-list-prediction="1"]').first
        prediction.wait_for(state="visible", timeout=45_000)
        page.wait_for_timeout(300)

        text = card.inner_text()
        if stage == "before" and "Predicted based on 307 eligible lists" not in text:
            raise RuntimeError("production card no longer contains the captured basis-first copy")
        if stage == "after":
            if "expect the eligible list for exams like this about 8 months" not in text:
                raise RuntimeError("local card does not lead with the 8-month eligible-list claim")
            if prediction.get_attribute("data-prediction-subject") != "eligible-list-establishment":
                raise RuntimeError("local card lacks its prediction subject contract")
            if prediction.get_attribute("data-prediction-value") != "8-months":
                raise RuntimeError("local card lacks its concrete prediction value contract")

        OUT.mkdir(parents=True, exist_ok=True)
        card.screenshot(path=str(OUT / f"{stage}-exam-6125-{width}.png"), animations="disabled")
        (OUT / f"{stage}-exam-6125-{width}.txt").write_text(text + "\n", encoding="utf-8")
        page.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            capture(browser, PRODUCTION, "before")
            with StaticServer() as local:
                capture(browser, local, "after")
        finally:
            browser.close()
    print(f"captured exam 6125 before/after cards in {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
