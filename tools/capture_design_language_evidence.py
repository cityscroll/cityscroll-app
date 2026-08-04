#!/usr/bin/env python3
"""Capture before/after evidence for the design-language token change.

Serves a given site directory locally and screenshots home + three lenses + a notice detail at
390px and 1440px. First paint comes from committed batch-precompute snapshots (site/data/*.json), so
list views populate without waiting on a live API. Usage:

    CROL_SITE_DIR=/path/to/site CROL_EVID_LABEL=after python3 tools/capture_design_language_evidence.py

Output: docs/screenshots/design-language/<label>-<frame>-<width>.png
"""
from __future__ import annotations

import functools
import http.server
import os
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

SITE_DIR = Path(os.environ["CROL_SITE_DIR"]).resolve()
LABEL = os.environ.get("CROL_EVID_LABEL", "after")
OUT = Path(__file__).resolve().parents[1] / "docs" / "screenshots" / "design-language"
OUT.mkdir(parents=True, exist_ok=True)

FRAMES = {
    "home": "",
    "land": "#land",
    "property": "#property",
    "meetings": "#meetings",
    "notice": "#notice/20260714029",
}
WIDTHS = [390, 1440]


def serve(directory: Path) -> tuple[socketserver.TCPServer, int]:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def main() -> None:
    httpd, port = serve(SITE_DIR)
    base = f"http://127.0.0.1:{port}/"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for width in WIDTHS:
                ctx = browser.new_context(viewport={"width": width, "height": 900},
                                          device_scale_factor=2)
                page = ctx.new_page()
                for frame, route in FRAMES.items():
                    page.goto(base + route, wait_until="load")
                    # Give the SPA time to hydrate from precompute snapshots and settle layout.
                    page.wait_for_timeout(3500)
                    try:
                        page.wait_for_load_state("networkidle", timeout=6000)
                    except Exception:
                        pass
                    out = OUT / f"{LABEL}-{frame}-{width}.png"
                    page.screenshot(path=str(out), full_page=(frame in {"home", "notice"}))
                    print(f"wrote {out.relative_to(OUT.parents[2])}")
                ctx.close()
            browser.close()
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
