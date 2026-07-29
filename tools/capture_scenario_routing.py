#!/usr/bin/env python3
"""Capture and verify the task-first scenario layer at review widths."""

from __future__ import annotations

import functools
from pathlib import Path
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image
from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "media" / "review" / "audience-scenarios"
VIEWPORTS = ((390, 844), (1440, 900))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT))
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
    expected = (
        ("city-work", "money", "#money?mode=open&closing=week"),
        ("neighborhood", "land", "#land"),
        ("hearings", "meetings", "#meetings?when=upcoming"),
        ("city-career", "people", "#people"),
        ("subsidies-land-use", "meetings", "#meetings?when=upcoming&q=IDA"),
        ("legal-compliance", "property", "#property?asset=realty"),
    )
    for scenario, lens, expected_hash in expected:
        page.goto(base_url, wait_until="domcontentloaded")
        selector = f'[data-scenario="{scenario}"][data-scenario-lens="{lens}"]'
        page.locator(selector).first.click()
        page.wait_for_function(
            "(lens) => document.querySelector(`#tab-${lens}`)?.classList.contains('active')",
            arg=lens,
        )
        assert page.evaluate("location.hash") == expected_hash


def capture(page: Page, base_url: str, width: int, height: int) -> Path:
    page.goto(base_url, wait_until="domcontentloaded")
    page.locator(".scenario-nav").wait_for(state="visible")
    page.evaluate("document.fonts && document.fonts.ready")
    page.wait_for_timeout(150)
    assert page.locator(".scenario-card").count() == 6
    assert page.locator(".scenario-route").count() == 13
    assert page.locator(".tabbtn").count() == 7
    if width < 700:
        page.evaluate(
            "window.scrollTo(0, document.querySelector('.scenario-nav').getBoundingClientRect().top + window.scrollY - 8)"
        )
        page.wait_for_timeout(100)

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
