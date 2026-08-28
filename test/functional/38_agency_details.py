"""Agency connection Details controls survive deferred relationship hydration."""

from __future__ import annotations

import functools
import pathlib
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright


ROOT = pathlib.Path(__file__).parents[2]
AGENCY_PATH = "/agencies/police-department/"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def assert_details_opens(page, trigger: str) -> None:
    details = page.locator("a.edge-prov-why").first
    details.wait_for(state="visible", timeout=10_000)
    claim_id = details.get_attribute("data-edge-claim")
    assert claim_id

    if trigger == "click":
        details.click()
    else:
        details.focus()
        details.press("Enter")

    panel = page.locator("#edge-provenance")
    panel.wait_for(state="visible", timeout=10_000)
    assert page.locator("#edge-provenance").get_attribute("data-active-claim") == claim_id
    inspector = page.locator("#edge-provenance details.edge-prov-inspector").first
    assert inspector.count() == 1
    assert inspector.get_attribute("data-edge-claim") == claim_id
    assert inspector.get_attribute("open") is not None
    assert page.url.split("?", 1)[1].split("#", 1)[0].endswith(
        f"claim={claim_id.replace(':', '%3A')}"
    )


def assert_direct_claim_opens(page, base: str) -> None:
    claim_id = "staffing:exam:6306"
    page.goto(
        f"{base}{AGENCY_PATH}?claim={claim_id.replace(':', '%3A')}",
        wait_until="networkidle",
        timeout=30_000,
    )
    panel = page.locator("#edge-provenance")
    panel.wait_for(state="visible", timeout=10_000)
    assert panel.get_attribute("data-active-claim") == claim_id
    assert page.locator("#edge-provenance details.edge-prov-inspector[open]").count() == 1


def main() -> None:
    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.goto(base + AGENCY_PATH, wait_until="networkidle", timeout=30_000)
            assert_details_opens(page, "click")

            page.goto(base + AGENCY_PATH, wait_until="networkidle", timeout=30_000)
            assert_details_opens(page, "keyboard")

            assert_direct_claim_opens(page, base)
            browser.close()
    finally:
        server.shutdown()

    print("agency Details controls open the deferred connection evidence panel")


if __name__ == "__main__":
    main()
