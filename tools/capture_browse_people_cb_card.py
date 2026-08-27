#!/usr/bin/env python3
"""Capture the Community Board card before and after the People browse fix."""

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
OUTPUT = ROOT / "docs" / "screenshots" / "browse-people-cb-card"
VIEWPORTS = ((390, 844, "mobile"), (1440, 1000, "desktop"))
QUERY = "Bronx Community Board 1"


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


def build_documents(tree: Path) -> None:
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=tree, check=True)


def revision_snapshot(revision: str, destination: Path) -> None:
    result = subprocess.run(
        ["git", "archive", "--format=tar", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
        archive.extractall(destination)
    build_documents(destination)


def capture_tree(browser, tree: Path, state: str) -> list[dict[str, object]]:
    captures = []
    with StaticServer(tree / "site") as base:
        for width, height, name in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
            page.goto(f"{base}browse/people/", wait_until="domcontentloaded")
            page.locator("[data-people-organizations-search]").wait_for(state="visible")
            page.locator("[data-people-organizations-search]").fill(QUERY)
            card = page.locator('[data-people-organization-row][data-row-kind="community-board"]')
            page.wait_for_function(
                """() => document.querySelectorAll('[data-people-organization-row][data-row-kind="community-board"]').length === 1"""
            )
            if card.count() != 1:
                raise AssertionError(f"{state} {name}: expected one Community Board card, got {card.count()}")
            target = OUTPUT / f"{state}-{name}.png"
            page.locator("[data-people-organizations-list]").screenshot(path=target, animations="disabled")
            captures.append({"state": state, "viewport": [width, height], "file": str(target.relative_to(ROOT))})
            page.close()
    return captures


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    captures = []
    with tempfile.TemporaryDirectory(prefix="cityscroll-browse-people-before-") as temp:
        before_tree = Path(temp)
        revision_snapshot("HEAD", before_tree)
        build_documents(ROOT)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                captures.extend(capture_tree(browser, before_tree, "before"))
                captures.extend(capture_tree(browser, ROOT, "after"))
            finally:
                browser.close()
    (OUTPUT / "capture-receipt.json").write_text(
        json.dumps({"route": "/browse/people/", "query": QUERY, "captures": captures}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(captures, indent=2))


if __name__ == "__main__":
    main()
