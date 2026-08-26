#!/usr/bin/env python3
"""Capture before/after evidence for the community-board map-first page."""

from __future__ import annotations

import functools
import io
import json
import subprocess
import tarfile
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "community-boards-map"
VIEWPORTS = ((1440, 1000, "desktop"), (390, 844, "mobile"))
GIT_DIR = Path((ROOT / ".git").read_text().split(":", 1)[1].strip())


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


def revision_snapshot(revision: str, destination: Path) -> None:
    archive = subprocess.run(
        ["git", "--git-dir", str(GIT_DIR), "archive", "--format=tar", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    with tarfile.open(fileobj=io.BytesIO(archive.stdout), mode="r:") as source:
        source.extractall(destination)


def capture(browser, tree: Path, state: str, width: int, height: int, label: str) -> dict:
    with StaticServer(tree / "site") as base:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        response = page.goto(f"{base}community-boards/", wait_until="networkidle")
        if response is None or not response.ok:
            raise AssertionError(f"{state} community boards returned {response and response.status}")
        if state == "after":
            if page.locator('[data-view-panel="map"]:visible').count() != 1:
                raise AssertionError("Map is not the default visible view")
            if page.locator('[data-board-id]').count() != 59:
                raise AssertionError("Map does not expose all 59 board boundaries")
            if page.locator('[data-view-panel="table"]:visible').count() != 0:
                raise AssertionError("Table should be hidden in the default Map view")
            board = page.locator('[data-board-id="manhattan-cb-03"]')
            board.focus()
            board.press("Enter")
            if page.locator('[data-board-detail="manhattan-cb-03"]:visible').count() != 1:
                raise AssertionError("Keyboard selection did not update the detail panel")
            page.locator('[data-scorecard-view="table"]').click()
            if page.locator('[data-view-panel="table"]:visible').count() != 1:
                raise AssertionError("Table view did not open")
            if page.locator('[data-board-detail="manhattan-cb-03"]:visible').count() != 0:
                raise AssertionError("Map detail panel should be hidden in Table view")
            page.locator('[data-scorecard-view="map"]').click()
            if page.locator('[data-board-detail="manhattan-cb-03"]:visible').count() != 1:
                raise AssertionError("Selected board was not preserved across view switch")
        overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
        if overflow > 1:
            raise AssertionError(f"{state} {label} overflows by {overflow}px")
        target = OUTPUT / f"{state}-{label}.png"
        page.screenshot(path=target, full_page=True, animations="disabled")
        context.close()
        return {"state": state, "viewport": [width, height], "file": str(target.relative_to(ROOT)), "overflow_px": overflow}


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    records = []
    with tempfile.TemporaryDirectory(prefix="cityscroll-community-boards-before-") as temp:
        before_tree = Path(temp)
        revision_snapshot("HEAD", before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height, label in VIEWPORTS:
                    records.append(capture(browser, before_tree, "before", width, height, label))
                    records.append(capture(browser, ROOT, "after", width, height, label))
            finally:
                browser.close()
    manifest = {"schema_version": 1, "route": "/community-boards/", "captures": records}
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
