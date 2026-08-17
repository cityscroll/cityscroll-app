"""Legacy item routes preserve viewport and focus across document forwarding."""
import functools
import pathlib
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from ci_waits import wait_for_function, wait_for_locator, wait_for_url  # noqa: E402
from i18n_fixtures import install_routes  # noqa: E402


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        # The edge response supplies this shell in production. This browser test owns only
        # the enhancement island's focus behavior; response semantics have a separate gate.
        path = self.path.split("?", 1)[0]
        if path.startswith(("/notices/", "/agencies/", "/vendors/", "/officials/", "/browse/")):
            self.path = "/index.html"
        super().do_GET()


def assert_item_landing(page, selector):
    target = page.locator(selector)
    wait_for_locator(target, label=f"{selector} visible")
    wait_for_function(
        page,
        "selector => document.activeElement === document.querySelector(selector)",
        arg=selector,
        label=f"{selector} receives focus",
    )
    landing = target.evaluate(
        """element => ({
          active: document.activeElement === element,
          tabindex: element.getAttribute("tabindex"),
          aria_current: element.getAttribute("aria-current"),
          outlineStyle: getComputedStyle(element).outlineStyle,
          outlineWidth: parseFloat(getComputedStyle(element).outlineWidth),
          top: element.getBoundingClientRect().top,
          bottom: element.getBoundingClientRect().bottom,
          viewport: innerHeight
        })"""
    )
    assert landing["active"], f"{selector} was not the active element"
    assert landing["tabindex"] == "-1", f"{selector} was not programmatically focusable"
    assert landing["aria_current"] == "page", f"{selector} was not marked as the current route"
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
            wait_for_url(page, "**/exams/6125/", label="exam document forwarding")
            document = page.locator('[data-exam-document="1"]')
            wait_for_locator(document, label="exam document")
            assert page.locator("h1").inner_text().strip()
            assert page.locator('[data-exam-watch="6125"]').count() == 1
            page.close()

            page = browser.new_page(viewport={"width": 1440, "height": 900})
            install_routes(page)
            page.goto(base + "#notice/20260701099", wait_until="load")
            wait_for_url(page, "**/notices/20260701099", label="notice document forwarding")
            assert_item_landing(page, "#noticeview .route-item")
            page.close()

            # Compatibility translation is an ingress boundary: canonical
            # documents own their fragments and never re-enter the legacy hash
            # runtime. Exercise each document-forwarded legacy route from root.
            agency = browser.new_page(viewport={"width": 1440, "height": 900})
            install_routes(agency)
            agency.goto(
                base + "#agency/Housing%20Preservation%20and%20Development",
                wait_until="load",
            )
            wait_for_url(
                agency,
                "**/agencies/housing-preservation-and-development/",
                label="agency document forwarding",
            )
            assert_item_landing(agency, "#entityview .route-item")
            agency.close()

            # Retained item hashes remain same-document routes and continue to
            # preserve focus through Back/Forward history.
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            install_routes(page)
            page.goto(base + "#matter/8502026HP0001", wait_until="load")
            assert_item_landing(page, "#entityview .route-item")
            page.evaluate("location.hash = '#land/P2026K0001'")
            assert_item_landing(page, "#land-item-card")
            page.go_back()
            wait_for_function(
                page,
                "() => location.hash === '#matter/8502026HP0001'",
                label="history back to matter",
            )
            assert_item_landing(page, "#entityview .route-item")
            page.go_forward()
            wait_for_function(
                page,
                "() => location.hash === '#land/P2026K0001'",
                label="history forward to land",
            )
            assert_item_landing(page, "#land-item-card")
            page.close()

            initial_matter = browser.new_page(viewport={"width": 390, "height": 844})
            install_routes(initial_matter)
            initial_matter.goto(
                base + "#matter/8502026HP0001", wait_until="load"
            )
            assert_item_landing(initial_matter, "#entityview .route-item")
            initial_matter.close()

            official = browser.new_page(viewport={"width": 1440, "height": 900})
            install_routes(official)
            official.goto(base + "officials/7801/", wait_until="load")
            wait_for_locator(official.locator('[data-official-walk="1"]'), label="official in-page navigation")
            assert official.locator('.official-walk-link[href="/officials/7801/#official-lobby"]').count() == 1
            assert official.locator('.official-walk-link[href="/officials/7801/#official-cfb"]').count() == 1
            assert official.locator('.official-walk-link[href="/officials/7801/#official-skim"]').count() == 1
            for section in ("official-lobby", "official-cfb", "official-skim"):
                official.locator(f'.official-walk-link[href="/officials/7801/#{section}"]').click()
                wait_for_function(
                    official,
                    "section => location.pathname === '/officials/7801/' "
                    "&& location.hash === '#' + section "
                    "&& document.getElementById(section) "
                    "&& document.querySelector('#entityview .route-item')",
                    arg=section,
                    label=f"{section} stays on the official document",
                )
                assert official.locator(f"#{section}").evaluate(
                    "element => element.getBoundingClientRect().bottom > 0 "
                    "&& element.getBoundingClientRect().top < innerHeight"
                ), f"{section} did not scroll into view"
            assert official.locator('[data-route-back]').get_attribute("href") == "/browse/meetings/"
            official.close()

            paladino = browser.new_page(viewport={"width": 1440, "height": 900})
            install_routes(paladino)
            paladino.goto(base + "officials/7811/", wait_until="load")
            wait_for_locator(paladino.locator('.official-committee-memberships'), label="Paladino committee memberships")
            assert paladino.locator('.official-committee-memberships a[href^="/committees/"]').count() > 0
            assert "Provisional: destination not verified" not in paladino.locator("#entityview").inner_text()
            assert paladino.locator('.official-walk-link[href$="#official-skim"]').count() == 0
            assert paladino.locator('.local-constellation').count() == 0
            paladino.close()

            bare = browser.new_page(viewport={"width": 1440, "height": 900})
            install_routes(bare)
            bare.goto(base + "#exam", wait_until="load")
            wait_for_url(bare, "**/browse/exams/", label="bare exam route forwarding")
            wait_for_function(
                bare,
                "() => document.body.dataset.appReady === 'true'",
                label="bare exam route application ready",
            )
            assert bare.locator("#tab-exams").evaluate(
                "element => element.classList.contains('active')"
            ), "the bare #exam compatibility route should resolve by intent to Exams"

            bare.goto(base + "browse/exams/", wait_until="load")
            wait_for_function(
                bare,
                "() => location.pathname === '/browse/exams/' "
                "&& document.getElementById('tab-exams').classList.contains('active')",
                label="dedicated Exams route activation",
            )
            guide = bare.locator("#career-guide")
            wait_for_locator(guide, label="career guide")
            assert guide.evaluate(
                "element => element.getBoundingClientRect().bottom > 0 "
                "&& element.getBoundingClientRect().top < innerHeight"
            ), "the dedicated Exams route did not land on the exam guide"

            bare.evaluate("location.hash = '#matter'")
            wait_for_function(bare, "() => location.hash === '#money'", label="bare matter route forwarding")
            assert bare.locator("#tab-money").evaluate(
                "element => element.classList.contains('active')"
            ), "bare #matter did not land on Contracts"
            bare.close()

            browser.close()
    finally:
        server.shutdown()

    print("Legacy item routes preserve focus through document forwarding and history navigation.")


if __name__ == "__main__":
    main()
