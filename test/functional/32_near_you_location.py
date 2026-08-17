#!/usr/bin/env python3
"""Browser regression: Near-you location matching commits one exact scope."""

from __future__ import annotations

import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Browser, Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
ASTORIA = {"latitude": 40.7644, "longitude": -73.9235}
OUTSIDE_NYC = {"latitude": 0, "longitude": 0}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def install_location(page: Page, coords: dict[str, float]) -> None:
    page.add_init_script(
        f"""
        (() => {{
          const coords = {json.dumps(coords)};
          Object.defineProperty(navigator, "geolocation", {{
            configurable: true,
            value: {{
              getCurrentPosition(success) {{
                success({{ coords }});
              }},
            }},
          }});
        }})()
        """
    )


def install_near_you_responses(page: Page, base: str, *, break_exact: bool = False) -> None:
    """Serve the same borough document for dynamic query routes used in this test."""
    queens = (ROOT / "site" / "near-you" / "borough" / "queens" / "index.html").read_text()
    queens = queens.replace("https://cityscroll.org", base.rstrip("/"))

    def fulfill(route: Route) -> None:
        query = parse_qs(urlparse(route.request.url).query)
        if query.get("boro") == ["Queens"]:
            body = (
                "<html><body>broken exact document</body></html>"
                if break_exact and query.get("cd")
                else queens
            )
            route.fulfill(status=200, content_type="text/html", body=body)
        else:
            route.continue_()

    page.route("**/near-you?*", fulfill)


def rebase_area_links(page: Page, base: str) -> None:
    page.locator("[data-map-area]").evaluate_all(
        """
        (links, origin) => links.forEach((link) => {
          const url = new URL(link.href);
          link.href = origin + url.pathname + url.search + url.hash;
          if (link.dataset.mapArea === "Queens") {
            const lens = document.querySelector("[data-near-you-root]")?.dataset.lens || "meetings";
            link.href = `${origin}/near-you?v=0&lens=${lens}&boro=Queens&level=borough&id=Queens`;
          }
        })
        """,
        base.rstrip("/"),
    )


def exercise(
    browser: Browser,
    base: str,
    coords: dict[str, float],
    *,
    break_exact: bool = False,
) -> Page:
    context = browser.new_context(viewport={"width": 390, "height": 844})
    page = context.new_page()
    install_location(page, coords)
    install_near_you_responses(page, base, break_exact=break_exact)
    page.goto(base + "near-you/", wait_until="networkidle")
    rebase_area_links(page, base)
    page.locator("[data-use-location]").click()
    page.wait_for_function(
        """() => {
          const text = document.querySelector('[data-map-status]')?.textContent.trim() || '';
          return Boolean(text) && text !== 'Finding your district…';
        }"""
    )
    return page


def main() -> None:
    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}/"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)

            matched = exercise(browser, base, ASTORIA)
            matched_status = matched.locator("[data-map-status]").inner_text()
            assert matched_status == "Location matched Q01.", f"{matched.url}: {matched_status}"
            assert parse_qs(urlparse(matched.url).query)["cd"] == ["Q01"]
            matched.context.close()

            unmatched = exercise(browser, base, OUTSIDE_NYC)
            assert unmatched.locator("[data-map-status]").inner_text().startswith(
                "Your district could not be matched."
            )
            assert urlparse(unmatched.url).query == ""
            unmatched.context.close()

            update_failed = exercise(browser, base, ASTORIA, break_exact=True)
            assert update_failed.locator("[data-map-status]").inner_text().startswith(
                "Location matched Q01, but the page could not update."
            )
            assert urlparse(update_failed.url).query == ""
            update_failed.context.close()

            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
