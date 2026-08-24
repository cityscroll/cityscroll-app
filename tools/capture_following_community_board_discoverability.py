#!/usr/bin/env python3
"""Capture production-before and local-after Following discoverability evidence."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "following-community-board-discoverability"
PRODUCTION = "https://cityscroll.org"
ROUTE = "/following?lens=district&council=7"
VIEWPORTS = ((390, 900), (1440, 1000))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path) -> None:
        handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(directory), **kwargs)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def write_local_document(site_copy: Path, target_name: str, lens: str, filter_value: str) -> None:
    target = site_copy / "following" / target_name
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import { buildFollowingViewModel, renderFollowingDocument } from "
                "'./site/following_view.mjs'; "
                "import { writeFileSync } from 'node:fs'; "
                "const html = renderFollowingDocument(buildFollowingViewModel({ "
                f"lens: '{lens}', filter: {filter_value}, requested: true }})); "
                "writeFileSync(process.argv[1], html);"
            ),
            str(target),
        ],
        cwd=ROOT,
        check=True,
    )


def capture_page(browser, base: str, phase: str, route: str = ROUTE) -> None:
    for width, height in VIEWPORTS:
        page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
        page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_selector("[data-following-root]", timeout=45_000)
        page.wait_for_selector("#create", timeout=45_000)
        if phase == "after-community-board-picker":
            page.wait_for_selector('select[name="boardBorough"]', state="visible", timeout=10_000)
        page.locator("#create").screenshot(path=str(OUT / f"{phase}-{width}.png"), animations="disabled")
        page.close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="crol-following-capture-") as temp_dir:
        site_copy = Path(temp_dir) / "site"
        shutil.copytree(ROOT / "site", site_copy)
        write_local_document(site_copy, "index.html", "district", "{ councilDistrict: '7' }")
        write_local_document(site_copy, "meetings.html", "meetings", "{}")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            capture_page(browser, PRODUCTION, "before-district")
            with StaticServer(site_copy) as local:
                capture_page(browser, local, "after-district", "/following/")
                capture_page(browser, local, "after-community-board-picker", "/following/meetings.html")
            browser.close()
    receipt = {
        "route": ROUTE,
        "captured_before": f"{PRODUCTION}{ROUTE}",
        "captured_after": "local renderer from the committed branch",
        "viewports": [width for width, _height in VIEWPORTS],
        "captures": [
            "before-district",
            "after-district",
            "after-community-board-picker",
        ],
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote screenshots under {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
