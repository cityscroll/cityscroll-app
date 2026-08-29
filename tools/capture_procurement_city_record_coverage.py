#!/usr/bin/env python3
"""Capture the City Record coverage disclosure at 390px and 1440px."""

from __future__ import annotations

import functools
import json
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "procurement-city-record-coverage"
VIEWPORTS = ((390, 844), (1440, 1000))
sys.path.insert(0, str(ROOT / "tools"))


class SiteServer:
    def __init__(self, directory: Path):
        from local_site_server import QuietHandler

        self.server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            functools.partial(QuietHandler, directory=str(directory)),
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def open_coverage(page) -> None:
    coverage = page.locator("#contracts-analytics-coverage")
    if coverage.get_attribute("open") is None:
        coverage.locator("summary").click()
    page.wait_for_function(
        "() => document.querySelector('#contracts-analytics-coverage')?.open === true",
        timeout=60000,
    )
    page.wait_for_function(
        "() => document.querySelector('#contracts-analytics-coverage-statement')?.textContent",
        timeout=60000,
    )


def capture(page, url: str, width: int) -> dict:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url + "browse/contracts/?mode=award", wait_until="domcontentloaded")
    page.wait_for_selector("#contracts-analytics-groups a", timeout=60000)
    page.wait_for_selector("#contracts-analytics-coverage", timeout=60000)
    closed = {
        "open": bool(page.locator("#contracts-analytics-coverage").get_attribute("open")),
        "disclosure": page.locator("#contracts-analytics-coverage-disclosure").inner_text(),
        "groups": page.locator("#contracts-analytics-groups a").count(),
        "statement_visible": page.locator("#contracts-analytics-coverage-statement").is_visible(),
    }
    page.locator("#contracts-analytics").screenshot(
        path=str(OUT / f"after-{width}.png"),
        animations="disabled",
    )
    open_coverage(page)
    statement = page.locator("#contracts-analytics-coverage-statement").inner_text()
    summary_html = page.locator("#contracts-analytics-coverage-summary").inner_html()
    opened = {
        "open": True,
        "statement": statement,
        "rows": page.locator("#contracts-analytics-coverage-groups tr").count(),
        "exact": "Exact notice found" in summary_html,
        "none": "No exact notice found" in summary_html,
        "missing_pin": "Missing PIN" in summary_html,
    }
    page.locator("#contracts-analytics").screenshot(
        path=str(OUT / f"after-open-{width}.png"),
        animations="disabled",
    )
    page.select_option("#analytics-coverage-band", "Under $100,000")
    page.wait_for_function(
        "() => document.querySelector('#contracts-analytics-coverage-statement')?.textContent.includes('No registered contracts in this selection were evaluated')",
        timeout=60000,
    )
    empty_statement = page.locator("#contracts-analytics-coverage-statement").inner_text()
    page.locator("#contracts-analytics").screenshot(
        path=str(OUT / f"after-empty-{width}.png"),
        animations="disabled",
    )
    return {
        "viewport": width,
        "closed": closed,
        "opened": opened,
        "empty": {
            "statement": empty_statement,
            "rows": page.locator("#contracts-analytics-coverage-groups tr").count(),
        },
        "page_errors": errors,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    captures = []
    with SiteServer(ROOT / "_site") as url:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                page = context.new_page()
                page.route("https://**/*", lambda route: route.abort())
                page.route("http://api.**/*", lambda route: route.abort())
                captures.append(capture(page, url, width))
                context.close()
            browser.close()
    receipt = {
        "schema": "cityscroll.procurement-city-record-coverage.capture.v2",
        "captures": captures,
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(captures, indent=2))


if __name__ == "__main__":
    main()
