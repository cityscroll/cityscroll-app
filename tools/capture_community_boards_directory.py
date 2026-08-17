#!/usr/bin/env python3
"""Capture the People directory's compact community-board links before and after polish."""

from __future__ import annotations

import argparse
import functools
import io
import json
import shutil
import subprocess
import tarfile
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "community-boards-directory"
VIEWPORTS = ((390, 844), (1440, 1000))
SELECTOR = "#community-boards"


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
    subprocess.run(
        ["node", "tools/build_primary_documents.mjs"],
        cwd=tree,
        check=True,
        stdout=subprocess.DEVNULL,
    )


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


def capture_tree(browser, tree: Path, state: str, width: int, height: int) -> dict:
    with StaticServer(tree / "site") as base:
        context = browser.new_context(
            viewport={"width": width, "height": height},
            java_script_enabled=False,
        )
        page = context.new_page()
        response = page.goto(f"{base}browse/people/", wait_until="load")
        if response is None or not response.ok:
            raise AssertionError(f"{state} People directory returned {response and response.status}")
        section = page.locator(SELECTOR)
        section.wait_for(state="visible")
        board_links = section.locator('a[href^="/community-boards/"]').count()
        verbose_rows = section.locator(".browse-board-organization").count()
        borough_rows = section.locator(".browse-board-borough").count()
        covers = section.get_by_text("Covers ", exact=False).count()
        if board_links != 59:
            raise AssertionError(f"{state} rendered {board_links} board links, expected 59")
        if borough_rows != 5 or covers != 0:
            raise AssertionError(f"compaction missing: boroughs={borough_rows}, covers={covers}")
        geometry = section.locator(".browse-board-number-link").evaluate_all(
            """links => links.map(link => {
                const box = link.getBoundingClientRect();
                return { left: box.left, right: box.right, top: box.top,
                         width: box.width, height: box.height };
            })"""
        )
        minimum_target = min(min(item["width"], item["height"]) for item in geometry)
        same_row_gaps = [
            current["left"] - previous["right"]
            for previous, current in zip(geometry, geometry[1:])
            if abs(current["top"] - previous["top"]) < 1
        ]
        minimum_gap = min(same_row_gaps)
        if state == "after" and (minimum_target < 36 or minimum_gap < 8):
            raise AssertionError(
                f"board links remain cramped: target={minimum_target}px gap={minimum_gap}px"
            )
        overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
        if overflow > 1:
            raise AssertionError(f"{state} {width}px overflows by {overflow}px")
        target = OUTPUT / f"{state}-{width}.png"
        section.screenshot(path=target, animations="disabled")
        box = section.bounding_box() or {}
        context.close()
        return {
            "state": state,
            "viewport": [width, height],
            "file": str(target.relative_to(ROOT)),
            "board_links": board_links,
            "verbose_rows": verbose_rows,
            "borough_rows": borough_rows,
            "covers_restatements": covers,
            "minimum_target_px": round(minimum_target),
            "minimum_same_row_gap_px": round(minimum_gap),
            "section_height": round(box.get("height", 0)),
            "overflow_px": overflow,
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", default="HEAD", help="revision before the change")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    generated = (ROOT / "site" / "now", ROOT / "site" / "browse")
    cleanup = tuple(path for path in generated if not path.exists())
    records = []

    with tempfile.TemporaryDirectory(prefix="crol-community-boards-before-") as temp:
        before_tree = Path(temp)
        revision_snapshot(args.before, before_tree)
        build_documents(ROOT)
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    for width, height in VIEWPORTS:
                        records.append(capture_tree(browser, before_tree, "before", width, height))
                        records.append(capture_tree(browser, ROOT, "after", width, height))
                finally:
                    browser.close()
        finally:
            for path in cleanup:
                shutil.rmtree(path, ignore_errors=True)

    manifest = {
        "schema_version": 1,
        "before_revision": subprocess.check_output(
            ["git", "rev-parse", "--short=12", args.before], cwd=ROOT, text=True
        ).strip(),
        "route": "/browse/people/#community-boards",
        "javascript": "disabled (no-JS document parity)",
        "captures": records,
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
