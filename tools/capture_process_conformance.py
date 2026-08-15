#!/usr/bin/env python3
"""Headless screenshots for mandates expected-vs-observed (process conformance).

Captures a deterministic Parks five-category fixture at 390 and 1440.

  python3 tools/capture_process_conformance.py
"""

from __future__ import annotations

import http.server
import shutil
import socketserver
import subprocess
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OUT = ROOT / "docs" / "screenshots" / "process-conformance"
VIEWPORTS = ((390, 844), (1440, 900))
FIXTURE_DIR = SITE / "agencies" / "mandate-conformance-fixture"
DEMO_PATH = "/agencies/mandate-conformance-fixture/#mandates-conformance"


class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def serve(site: Path) -> tuple[socketserver.TCPServer, str]:
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _Handler)
    httpd.allow_reuse_address = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host, port = httpd.server_address
    return httpd, f"http://{host}:{port}"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "node",
            str(ROOT / "tools" / "render_process_conformance_fixture.mjs"),
            str(FIXTURE_DIR / "index.html"),
        ],
        cwd=ROOT,
        check=True,
    )
    httpd, base = serve(SITE)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.goto(f"{base}{DEMO_PATH}", wait_until="networkidle", timeout=60_000)
                page.wait_for_selector("#mandates-conformance", timeout=30_000)
                # Scroll the conformance section into view for the full-page crop.
                page.locator("#mandates-conformance").scroll_into_view_if_needed()
                page.wait_for_timeout(200)
                out = OUT / f"multi-category-fixture-{width}.png"
                page.screenshot(path=str(out), full_page=True)
                print(f"wrote {out.relative_to(ROOT)}")
                # Section crop for wake-up demo.
                section = OUT / f"multi-category-fixture-section-{width}.png"
                page.locator("#mandates-conformance").screenshot(path=str(section))
                print(f"wrote {section.relative_to(ROOT)}")
                page.close()
            browser.close()
    finally:
        httpd.shutdown()
        shutil.rmtree(FIXTURE_DIR, ignore_errors=True)


if __name__ == "__main__":
    main()
