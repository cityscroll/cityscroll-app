#!/usr/bin/env python3
"""Capture and verify the quiet homepage masthead flow at review widths.

The audience scenario grid was removed from the homepage (owner noise cut).
This tool now checks category-tab navigation and captures the masthead area.
"""

from __future__ import annotations

import functools
from pathlib import Path
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image
from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "site" / "media" / "review" / "audience-scenarios"
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


def install_routes(page: Page) -> None:
    def empty_json(route: Route) -> None:
        route.fulfill(status=200, content_type="application/json", body="[]")

    page.route("https://data.cityofnewyork.us/**", empty_json)
    page.route("https://data.ny.gov/**", empty_json)
    page.route("https://api.cityscroll.org/**", empty_json)
    page.route("https://geosearch.planninglabs.nyc/**", empty_json)
    page.route("https://**", lambda route: route.abort())


def verify_routes(page: Page, base_url: str) -> None:
    page.goto(base_url, wait_until="domcontentloaded")
    assert page.locator("#homeCta").count() == 1, "homepage email CTA required"
    assert page.locator(".scenario-nav").count() == 0, "scenario grid must stay off the homepage"
    assert page.locator(".tabbtn").count() == 7
    for lens in ("people", "land", "meetings", "money"):
        page.click(f'.tabbtn[data-tab="{lens}"]')
        page.wait_for_function(
            "(lens) => document.querySelector(`#tab-${lens}`)?.classList.contains('active')",
            arg=lens,
        )


def capture(page: Page, base_url: str, width: int, height: int) -> Path:
    page.goto(base_url, wait_until="domcontentloaded")
    page.locator("#homeCta").wait_for(state="visible")
    page.locator(".tabs").wait_for(state="visible")
    page.evaluate("document.fonts && document.fonts.ready")
    page.wait_for_timeout(150)
    assert page.locator("#homeCta").count() == 1
    assert page.locator(".scenario-nav").count() == 0
    assert page.locator(".tabbtn").count() == 7

    output = OUTPUT / f"after-{width}.png"
    page.screenshot(path=str(output), full_page=False)
    image = Image.open(output)
    assert image.size == (width, height), f"{output.name}: got {image.size}"
    return output


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with StaticServer() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            check_context = browser.new_context(viewport={"width": 1000, "height": 900})
            check_page = check_context.new_page()
            install_routes(check_page)
            verify_routes(check_page, base_url)
            check_context.close()

            for width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                page = context.new_page()
                # Source: uncaught browser pageerror events observed during this capture.
                errors: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                install_routes(page)
                output = capture(page, base_url, width, height)
                if errors:
                    raise AssertionError(f"{output.name}: page errors: {errors}")
                print(f"{output.relative_to(ROOT)} {Image.open(output).size}")
                context.close()
        finally:
            browser.close()


if __name__ == "__main__":
    main()
