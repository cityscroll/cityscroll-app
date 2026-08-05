#!/usr/bin/env python3
"""Capture the filtered-list → Alerts scope handoff at desktop and phone widths.

Run before and after the change with:

    CROL_ALERTS_SCOPE_LABEL=before python3 tools/capture_alerts_scope_ingest.py
    CROL_ALERTS_SCOPE_LABEL=after python3 tools/capture_alerts_scope_ingest.py
"""

from __future__ import annotations

import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import threading
from urllib.parse import quote

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "alerts-scope-ingest"
LABEL = os.environ.get("CROL_ALERTS_SCOPE_LABEL", "after").strip() or "after"
FILTER = quote('{"agency":"Homeless Services","noticeType":"award"}', safe="")
ALERTS_HASH = f"#alerts?lens=money&filter={FILTER}&notice=20260724018"
VIEWPORTS = ((390, 844), (1440, 900))


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


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with StaticServer() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.goto(f"{base}index.html{ALERTS_HASH}", wait_until="domcontentloaded")
                page.wait_for_selector("#tab-alerts.active", timeout=15_000)
                # Capture the arrival state. The bug is specifically that scope application
                # waits behind the optional notice fetch, so a long network-idle wait hides it.
                page.wait_for_timeout(500)
                if LABEL == "after":
                    page.wait_for_selector("#acontextlead:not([hidden])", timeout=5_000)
                    state = page.evaluate(
                        """() => ({
                          lead: document.querySelector('#acontextlead').textContent,
                          keywordInputs: [...document.querySelectorAll('#quizpanel input')]
                            .filter((el) => el.offsetParent && /keyword/i.test(el.labels?.[0]?.textContent || '')).length,
                          monthsHidden: document.querySelector('#amoneymonthsbox').hidden,
                          moreOpen: document.querySelector('#advopts').open,
                          finishButtons: document.querySelectorAll('.alerts-finish button').length,
                        })"""
                    )
                    assert "Watching: Homeless Services awards" in state["lead"], state
                    assert state["keywordInputs"] == 1, state
                    assert state["monthsHidden"], state
                    assert not state["moreOpen"], state
                    assert state["finishButtons"] == 2, state
                page.screenshot(
                    path=str(OUTPUT / f"{LABEL}-{width}x{height}.png"),
                    full_page=True,
                )
                if LABEL == "after":
                    page.goto(f"{base}index.html{ALERTS_HASH}&count=17", wait_until="domcontentloaded")
                    page.wait_for_selector('[data-scope-count="17"]', timeout=15_000)
                    assert page.locator('[data-scope-count="17"]').count() == 1
                page.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()
