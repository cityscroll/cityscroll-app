"""Hash item routes move both the viewport and programmatic focus to the exact record."""
import functools
import pathlib
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from i18n_fixtures import install_routes  # noqa: E402


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        # The edge response supplies this shell in production. This browser test owns only
        # the enhancement island's focus behavior; response semantics have a separate gate.
        if self.path.split("?", 1)[0].startswith("/notices/"):
            self.path = "/index.html"
        super().do_GET()


def assert_item_landing(page, selector):
    target = page.locator(selector)
    target.wait_for(state="visible")
    page.wait_for_function(
        "selector => document.activeElement === document.querySelector(selector)",
        arg=selector,
    )
    landing = target.evaluate(
        """element => ({
          active: document.activeElement === element,
          tabindex: element.getAttribute("tabindex"),
          outlineStyle: getComputedStyle(element).outlineStyle,
          outlineWidth: parseFloat(getComputedStyle(element).outlineWidth),
          top: element.getBoundingClientRect().top,
          bottom: element.getBoundingClientRect().bottom,
          viewport: innerHeight
        })"""
    )
    assert landing["active"], f"{selector} was not the active element"
    assert landing["tabindex"] == "-1", f"{selector} was not programmatically focusable"
    assert landing["outlineStyle"] != "none" and landing["outlineWidth"] >= 2, (
        f"{selector} had no visible focus outline: {landing}"
    )
    assert landing["bottom"] > 0 and landing["top"] < landing["viewport"], (
        f"{selector} was outside the viewport: {landing}"
    )


def main():
    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)

            page = browser.new_page(viewport={"width": 1440, "height": 900})
            install_routes(page)
            page.goto(base + "#exam/6125", wait_until="load")
            assert_item_landing(page, "#career-exam-6125")

            in_page_routes = (
                ("#notice/20260701099", "#noticeview .route-item"),
                ("#land/P2026K0001", "#land-item-card"),
                (
                    "#agency/Housing%20Preservation%20and%20Development",
                    "#entityview .route-item",
                ),
                ("#matter/8502026HP0001", "#entityview .route-item"),
            )
            for route, selector in in_page_routes:
                page.evaluate("route => { location.hash = route; }", route)
                assert_item_landing(page, selector)

            page.go_back()
            page.wait_for_function(
                "() => location.hash.startsWith('#agency/')"
            )
            assert_item_landing(page, "#entityview .route-item")
            page.go_forward()
            page.wait_for_function(
                "() => location.hash === '#matter/8502026HP0001'"
            )
            assert_item_landing(page, "#entityview .route-item")
            page.close()

            initial_matter = browser.new_page(viewport={"width": 390, "height": 844})
            install_routes(initial_matter)
            initial_matter.goto(
                base + "#matter/8502026HP0001", wait_until="load"
            )
            assert_item_landing(initial_matter, "#entityview .route-item")
            initial_matter.close()

            bare = browser.new_page(viewport={"width": 1440, "height": 900})
            install_routes(bare)
            bare.goto(base + "#exam", wait_until="load")
            bare.wait_for_function(
                "() => location.hash === '#people?view=guide'"
            )
            guide = bare.locator("#career-guide")
            guide.wait_for(state="visible")
            assert guide.evaluate(
                "element => element.getBoundingClientRect().bottom > 0 "
                "&& element.getBoundingClientRect().top < innerHeight"
            ), "bare #exam did not land on the exam guide"

            bare.evaluate("location.hash = '#matter'")
            bare.wait_for_function("() => location.hash === '#money'")
            assert bare.locator("#tab-money").evaluate(
                "element => element.classList.contains('active')"
            ), "bare #matter did not land on Contracts"
            bare.close()

            browser.close()
    finally:
        server.shutdown()

    print("Item hashes focus and reveal exact records; bare routes and history navigation passed.")


if __name__ == "__main__":
    main()
