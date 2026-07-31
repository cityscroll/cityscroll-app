"""Capture the Contracts method-select and award-threshold states."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "method-dropdown"


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

    def log_message(self, *_args):
        pass


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    Thread(target=server.serve_forever, daemon=True).start()
    base_url = f"http://127.0.0.1:{server.server_port}/index.html#money?mode=open"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page.goto(base_url, wait_until="domcontentloaded")
        page.locator("#methodwrap").wait_for(state="visible", timeout=30_000)
        page.locator("#methodselect option").nth(1).wait_for(state="attached", timeout=30_000)
        page.screenshot(path=OUTPUT / "open-rfp.png", full_page=False)

        page.select_option("#mode", "award")
        page.locator("#minwrap").wait_for(state="visible")
        page.screenshot(path=OUTPUT / "award.png", full_page=False)
        browser.close()
    server.shutdown()


if __name__ == "__main__":
    main()
