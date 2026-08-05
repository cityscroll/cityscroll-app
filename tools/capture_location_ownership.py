#!/usr/bin/env python3
"""Capture the Zoning and Near-you location-ownership surfaces."""

from __future__ import annotations

import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading

from playwright.sync_api import Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "location-ownership"
VIEWPORTS = ((390, 844), (1440, 900))

sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402


class RouteAwareHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        route = self.path.split("?", 1)[0].rstrip("/")
        if route == "/browse" or route.startswith("/browse/"):
            self.path = "/index.html"
        super().do_GET()


def fixed_json(route: Route, payload) -> None:
    route.fulfill(
        status=200,
        content_type="application/json",
        body=json.dumps(payload),
    )


def install_location_probe(context) -> None:
    context.add_init_script(
        """
        (() => {
          window.__geoCalls = 0;
          Object.defineProperty(navigator, "permissions", {
            configurable: true,
            value: { query: async () => ({ state: "prompt" }) },
          });
          Object.defineProperty(navigator, "geolocation", {
            configurable: true,
            value: {
              getCurrentPosition(success) {
                window.__geoCalls += 1;
                success({ coords: { latitude: 40.7473, longitude: -73.8832 } });
              },
            },
          });
        })();
        """
    )


def capture_zoning(browser, base: str, phase: str, width: int, height: int) -> None:
    context = browser.new_context(viewport={"width": width, "height": height})
    install_location_probe(context)
    page = context.new_page()
    install_routes(page)
    page.route(
        "https://geosearch.planninglabs.nyc/**",
        lambda route: fixed_json(route, {"features": [{"properties": {
            "borough": "Queens",
            "neighbourhood": "Elmhurst",
            "label": "Elmhurst, Queens",
            "addendum": {"pad": {"bbl": "4014930012"}},
        }}]}),
    )
    page.goto(base + "browse/zoning/", wait_until="domcontentloaded")
    page.locator("#tab-land.active").wait_for()
    page.wait_for_function("!document.querySelector('#llist .loading')")
    page.wait_for_timeout(250)
    page.locator("#land-domain-intro").scroll_into_view_if_needed()
    page.evaluate(
        """() => window.scrollTo(0, Math.max(0,
          document.querySelector('#land-domain-intro').getBoundingClientRect().top + scrollY - 24))"""
    )
    page.screenshot(
        path=str(OUTPUT / f"{phase}-zoning-{width}.png"),
        animations="disabled",
    )
    context.close()


def capture_near_you(browser, base: str, phase: str, width: int, height: int) -> None:
    context = browser.new_context(viewport={"width": width, "height": height})
    install_location_probe(context)
    page = context.new_page()
    page.goto(base + "near-you/", wait_until="networkidle")
    page.locator("[data-near-you-root][data-enhanced='true']").wait_for()
    page.screenshot(
        path=str(OUTPUT / f"{phase}-near-you-{width}.png"),
        animations="disabled",
    )
    context.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("before", "after"), required=True)
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(RouteAwareHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}/"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                capture_zoning(browser, base, args.phase, width, height)
                capture_near_you(browser, base, args.phase, width, height)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print(f"captured {args.phase} location-ownership surfaces")


if __name__ == "__main__":
    main()
