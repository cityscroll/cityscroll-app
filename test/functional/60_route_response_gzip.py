#!/usr/bin/env python3
"""Real Chromium: route HTML mutation survives a gzip body without Content-Encoding.

Reproduces the near-search flake mode (APIResponse.text UnicodeDecodeError on
byte 0x8b, then Playwright's UnicodeDecodeError rewrite TypeError) and proves
the shared harness helper fixes it. No product code is exercised.
"""

from __future__ import annotations

import gzip
import http.server
import pathlib
import sys
import threading

from playwright.sync_api import sync_playwright

ASSETS = pathlib.Path(__file__).parent / "assets"
sys.path.insert(0, str(ASSETS))
from route_response_text import fetch_uncompressed, fulfill_with_text, response_text  # noqa: E402

HTML = (
    b"<!doctype html><html><body>"
    b'<nav class="near-place-suggestions"><a data-near-place-suggestion>x</a></nav>'
    b"<div id='ok'>ok</div></body></html>"
)


def main() -> None:
    compressed = gzip.compress(HTML)
    assert compressed[:2] == b"\x1f\x8b"

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(compressed)))
            self.end_headers()
            self.wfile.write(compressed)

        def log_message(self, *_args):
            return

    httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)

            broken_errors: list[BaseException] = []
            page = browser.new_page()

            def broken_handler(route) -> None:
                try:
                    response = route.fetch()
                    route.fulfill(response=response, body=response.text())
                except BaseException as error:  # noqa: BLE001 - capture exact failure mode
                    broken_errors.append(error)
                    route.abort()

            page.route(base + "/broken", broken_handler)
            try:
                page.goto(base + "/broken", wait_until="domcontentloaded", timeout=5_000)
            except Exception:
                pass
            page.close()
            assert broken_errors, "expected response.text() to fail on raw gzip"
            assert isinstance(broken_errors[0], UnicodeDecodeError), broken_errors[0]
            assert "0x8b" in str(broken_errors[0]), broken_errors[0]

            def fixed_handler(route) -> None:
                response = fetch_uncompressed(route)
                body = response_text(response)
                start = body.index('<nav class="near-place-suggestions"')
                end = body.index("</nav>", start) + len("</nav>")
                fulfill_with_text(route, response, body[:start] + body[end:])

            page2 = browser.new_page()
            page2.route(base + "/fixed", fixed_handler)
            page2.goto(base + "/fixed", wait_until="domcontentloaded", timeout=10_000)
            assert page2.locator("#ok").inner_text() == "ok"
            assert page2.locator("[data-near-place-suggestion]").count() == 0
            browser.close()
    finally:
        httpd.shutdown()
    print("PASS: route HTML mutation survives gzip without Content-Encoding")


if __name__ == "__main__":
    main()
