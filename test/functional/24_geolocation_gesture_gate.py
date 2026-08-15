#!/usr/bin/env python3
"""Browser regression: route entry never requests location; empty Zoning can widen."""

from __future__ import annotations

import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402
from ci_waits import wait_for_function  # noqa: E402


class RouteAwareHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        route = self.path.split("?", 1)[0].rstrip("/")
        if route == "/now" or route == "/browse" or route.startswith("/browse/"):
            self.path = "/index.html"
        super().do_GET()


def install_probe(context) -> None:
    context.add_init_script(
        """
        (() => {
          window.__geoCalls = 0;
          Object.defineProperty(navigator, "geolocation", {
            configurable: true,
            value: { getCurrentPosition(_success, error) {
              window.__geoCalls += 1;
              error?.({ code: 1, message: "fixture denial" });
            } },
          });
        })();
        """
    )


def main() -> None:
    handler = functools.partial(RouteAwareHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}/"
    routes = [
        "", "now/", "near-you/", "following/", "browse/", "browse/contracts/",
        "browse/staffing/", "browse/zoning/", "browse/property/", "browse/rules/",
        "browse/meetings/",
    ]
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for route in routes:
                context = browser.new_context(viewport={"width": 390, "height": 844})
                install_probe(context)
                page = context.new_page()
                install_routes(page)
                page.goto(base + route, wait_until="domcontentloaded")
                wait_for_function(
                    page,
                    "() => document.readyState !== 'loading'",
                    label=f"{route or 'home'} document settled",
                )
                assert page.evaluate("window.__geoCalls") == 0, route
                context.close()

            context = browser.new_context(viewport={"width": 390, "height": 844})
            install_probe(context)
            page = context.new_page()
            install_routes(page)
            page.goto(base + "near-you/", wait_until="networkidle")
            page.locator("[data-use-location]").click()
            assert page.evaluate("window.__geoCalls") == 1
            context.close()

            context = browser.new_context(viewport={"width": 390, "height": 844})
            install_probe(context)
            page = context.new_page()
            install_routes(page)
            page.route(
                "**/data/land_default_ulurp.json",
                lambda route: route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"schema_version": 1, "projects": [], "outcomes": []}),
                ),
            )
            page.route(
                "**/data/zap_projects_warehouse_lookup.json",
                lambda route: route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"schema_version": 1, "rows": []}),
                ),
            )
            page.goto(base + "browse/zoning/?boro=Queens", wait_until="domcontentloaded")
            empty = page.locator(".land-empty-state")
            empty.wait_for(state="visible")
            widen = empty.locator("[data-land-widen]")
            assert widen.is_visible()
            assert widen.bounding_box()["height"] >= 44
            widen.click()
            page.wait_for_function(
                """(() => {
                  const control = document.querySelector('#land-borough-rail [data-borough-scope-link="all"]');
                  return control?.tagName === 'BUTTON' && control.getAttribute('aria-pressed') === 'true';
                })"""
            )
            assert page.locator("#lstatus").input_value() == "all"
            context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
