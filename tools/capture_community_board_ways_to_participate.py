#!/usr/bin/env python3
"""Capture selected-board Ways to participate at 390px and 1440px.

Renders the positive Manhattan CB2 fixture and the negative Bronx CB2 fixture
from committed read models. No request-time publisher fetch is used.
"""

from __future__ import annotations

import functools
import json
import subprocess
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "evidence" / "civic-action-paths" / "after"
VIEWPORTS = ((1440, 1000, "desktop"), (390, 844, "mobile"))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path):
        handler = functools.partial(QuietHandler, directory=str(directory))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        served = Path(tmp) / "site"
        served.mkdir()
        subprocess.run(
            ["node", str(ROOT / "tools/render_community_board_ways_to_participate.mjs"), str(served)],
            cwd=ROOT,
            check=True,
        )
        receipts = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            with StaticServer(served) as base:
                for board, slug in (("manhattan-cb-02", "cb_source_backed"), ("bronx-cb-02", "cb_unknown")):
                    for width, height, suffix in VIEWPORTS:
                        page = browser.new_page(viewport={"width": width, "height": height})
                        response = page.goto(f"{base}community-boards/{board}/", wait_until="networkidle")
                        if response is None or not response.ok:
                            raise AssertionError(f"{board} returned {response and response.status}")
                        section = page.locator("[data-community-board-participation]")
                        if section.count() != 1:
                            raise AssertionError(f"{board} is missing Ways to participate")
                        if board == "manhattan-cb-02":
                            if page.get_by_text("Apply now").count():
                                raise AssertionError("closed application rendered Apply now")
                            if page.get_by_text("Attend the next board meeting").count() != 1:
                                raise AssertionError("positive board missing attend path")
                        else:
                            if page.get_by_text("Public committee membership").count():
                                raise AssertionError("negative board inherited application copy")
                        dest = OUT / f"{slug}-{suffix}.png"
                        page.screenshot(path=str(dest), full_page=True)
                        receipts.append({"board": board, "viewport": suffix, "path": dest.name})
                        page.close()
            browser.close()
        (OUT / "ways-to-participate-capture.json").write_text(
            json.dumps({
                "schema": "cityscroll.community_board_participation_capture.v1",
                "captures": receipts,
            }, indent=2) + "\n",
            encoding="utf-8",
        )
        print("wrote", OUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
