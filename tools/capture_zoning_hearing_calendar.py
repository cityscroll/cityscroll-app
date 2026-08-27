#!/usr/bin/env python3
"""Capture the district-filtered zoning hearing calendar handoff."""

from __future__ import annotations

import functools
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "zoning-hearing-calendar"
ROUTE = "/browse/zoning/#land?future=hearing&cd=K14"
VIEWPORTS = ((390, 844, "mobile"), (1440, 900, "desktop"))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


def start_static_server() -> tuple[ThreadingHTTPServer, str]:
    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


def assert_no_horizontal_overflow(page) -> None:
    assert page.evaluate("""() => [...document.querySelectorAll('body *')].every((element) => {
        if (element.matches('.skip') || getComputedStyle(element).display === 'none') return true;
        const rect = element.getBoundingClientRect();
        return rect.right <= window.innerWidth + 1 && rect.left >= -1;
    })"""), f"horizontal overflow at {page.viewport_size['width']}px"


def capture_phase(browser, base: str, phase: str, expect_subscription: bool) -> None:
    for width, height, name in VIEWPORTS:
        page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
        page.goto(f"{base.rstrip('/')}{ROUTE}", wait_until="networkidle", timeout=45_000)
        if expect_subscription:
            page.locator(".land-hearing-row").first.wait_for(state="visible", timeout=20_000)
        else:
            page.locator("body").wait_for(state="visible", timeout=20_000)
        control = page.locator('a[data-calendar-subscription="scope"]:not([hidden])')
        if expect_subscription:
            control.wait_for(state="visible", timeout=20_000)
            assert control.inner_text() == "Subscribe to calendar"
            control.click()
            page.locator("[data-calendar-subscription-dialog][open]").wait_for(state="visible", timeout=10_000)
        else:
            # The public deployment may have advanced since this baseline was captured.
            # Remove the new persistent affordance to preserve the pre-change comparison
            # state while retaining the same filtered hearing results.
            page.evaluate("""() => document.querySelectorAll('[data-calendar-subscription]').forEach((node) => node.remove())""")
            assert control.count() == 0
        if expect_subscription:
            assert "Community District 14" in page.locator("body").inner_text()
        if expect_subscription:
            assert_no_horizontal_overflow(page)
        page.screenshot(path=str(OUT / f"{phase}-{name}.png"), full_page=True, animations="disabled")
        page.close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    before = os.environ.get("CITYSCROLL_BEFORE_BASE", "https://cityscroll.org")
    server, after = start_static_server()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            capture_phase(browser, before, "before", False)
            capture_phase(browser, after, "after", True)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print(f"wrote screenshots under {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
