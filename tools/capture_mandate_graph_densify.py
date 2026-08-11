#!/usr/bin/env python3
"""Headless before/after captures for mandate graph densify.

Captures:
  - Sanitation #mandates-rules (CWZ rule edge)
  - Commission on Human Rights #mandates-reports (annual-report filing receipts)
  - Notice reverse backlinks for the CWZ final rule and CCHR annual report

  python3 tools/capture_mandate_graph_densify.py
"""

from __future__ import annotations

import http.server
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OUT = ROOT / "docs" / "screenshots" / "mandate-graph-densify"
VIEWPORTS = ((390, 844), (1440, 900))

TARGETS = (
    ("sanitation-rules", "/agencies/sanitation/#mandates-rules", "#mandates-rules"),
    ("cchr-reports", "/agencies/commission-on-human-rights/#mandates-reports", "#mandates-reports"),
    ("sanitation-conformance", "/agencies/sanitation/#mandates-conformance", "#mandates-conformance"),
    ("notice-cwz-backlink", "/notices/20260605008", "#notice-mandate-backlinks, [data-mandate-backlinks], .notice-mandate-backlinks, main"),
    ("notice-cchr-backlink", "/notices/20251001039", "#notice-mandate-backlinks, [data-mandate-backlinks], .notice-mandate-backlinks, main"),
    ("notice-dhs-contract", "/notices/20210820102", "#notice-mandate-backlinks, [data-mandate-backlinks], .notice-mandate-backlinks, main"),
)


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
    httpd, base = serve(SITE)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                for slug, path, selector in TARGETS:
                    page.goto(f"{base}{path}", wait_until="domcontentloaded", timeout=60_000)
                    try:
                        page.wait_for_selector(selector.split(",")[0].strip(), timeout=15_000)
                        loc = page.locator(selector.split(",")[0].strip()).first
                        loc.scroll_into_view_if_needed()
                        page.wait_for_timeout(250)
                        section = OUT / f"{slug}-section-{width}.png"
                        loc.screenshot(path=str(section))
                        print(f"wrote {section.relative_to(ROOT)}")
                    except Exception as err:  # noqa: BLE001
                        print(f"section miss {slug}@{width}: {err}")
                    full = OUT / f"{slug}-{width}.png"
                    page.screenshot(path=str(full), full_page=True)
                    print(f"wrote {full.relative_to(ROOT)}")
                page.close()
            browser.close()
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
