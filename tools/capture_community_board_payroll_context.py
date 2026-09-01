#!/usr/bin/env python3

import functools
import http.server
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/screenshots/community-board-payroll-context"
VIEWPORTS = ((390, 844), (1440, 1000))
BOARDS = ("bronx-cb-02", "queens-cb-12")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def serve(directory: Path):
    handler = functools.partial(Quiet, directory=str(directory))
    server = socketserver.TCPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def main():
    before = ROOT / ".artifacts/community-board-payroll-before/site"
    if not before.exists():
        raise SystemExit("missing before site; materialize origin/main under .artifacts/community-board-payroll-before")
    OUT.mkdir(parents=True, exist_ok=True)
    servers = []
    try:
        for phase, site in (("before", before), ("after", ROOT / "site")):
            server, base = serve(site)
            servers.append(server)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                for board in BOARDS:
                    for width, height in VIEWPORTS:
                        page = browser.new_page(viewport={"width": width, "height": height})
                        page.goto(f"{base}/community-boards/{board}/", wait_until="networkidle")
                        page.locator("main").screenshot(
                            path=str(OUT / f"{phase}-{board}-{width}.png"),
                            animations="disabled",
                        )
                        overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
                        if overflow:
                            raise RuntimeError(f"horizontal overflow: {phase} {board} {width}")
                        page.close()
                browser.close()
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
    print(f"wrote captures under {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
