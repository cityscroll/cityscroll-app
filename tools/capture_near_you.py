#!/usr/bin/env python3
"""Capture static-first Near-you evidence with the project Playwright pattern."""

from __future__ import annotations

import functools
import json
from pathlib import Path
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "near-you-static-first"
VIEWPORTS = ((390, 844), (1440, 900))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return


def serve():
    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}"


def assert_count_contract(page):
    contract = page.evaluate(
        """() => ({
          count: Number(document.querySelector('.near-results')?.dataset.resultsCount || 0),
          ids: [...document.querySelectorAll('.near-results [data-record-id]')].map(el => el.dataset.recordId),
          paths: Object.fromEntries([...document.querySelectorAll('[data-map-id]')].map(el => [el.dataset.mapId, Number(el.dataset.count)])),
          areas: Object.fromEntries([...document.querySelectorAll('[data-map-area]')].map(el => [el.dataset.mapArea, Number(el.dataset.count)])),
        })"""
    )
    assert contract["count"] == len(set(contract["ids"])), contract
    assert contract["paths"] == contract["areas"], contract


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    server, base = serve()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                page.goto(f"{base}/near-you/borough/queens/", wait_until="networkidle")
                page.locator("[data-near-you-root][data-enhanced='true']").wait_for()
                assert_count_contract(page)
                page.screenshot(path=str(OUTPUT / f"after-summary-{width}.png"), full_page=False)
                page.locator(".near-map-section").screenshot(path=str(OUTPUT / f"after-map-{width}.png"))
                context.close()

            context = browser.new_context(viewport={"width": 390, "height": 844}, java_script_enabled=False)
            page = context.new_page()
            page.goto(f"{base}/near-you/borough/queens/", wait_until="domcontentloaded")
            page.locator(".near-area-list a").first.wait_for()
            assert_count_contract(page)
            page.locator(".near-map-section").screenshot(path=str(OUTPUT / "after-map-no-js-390.png"))
            context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    manifest = {
        "feature": "near-you-static-first",
        "before": {
            "390": "../map-exploration/after-borough-390.png",
            "1440": "../map-exploration/after-borough-1440.png",
        },
        "after": [
            "after-summary-390.png",
            "after-summary-1440.png",
            "after-map-390.png",
            "after-map-1440.png",
            "after-map-no-js-390.png",
        ],
        "scope": "/near-you/borough/queens/",
        "count_contract": "SVG paths, equivalent area links, and the server record list",
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("wrote", OUTPUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
