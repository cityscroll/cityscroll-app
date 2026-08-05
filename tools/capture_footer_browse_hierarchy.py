#!/usr/bin/env python3
"""Capture before/after primary-navigation evidence at phone and desktop widths."""

from __future__ import annotations

import functools
import io
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import shutil
import tarfile
import tempfile
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "footer-browse-hierarchy"
VIEWPORTS = ((390, 844), (1440, 900))
ROUTES = ("now/", "near-you/", "following/", "browse/")


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
    result = subprocess.run(
        ["git", "archive", "--format=tar", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
        archive.extractall(destination)
    subprocess.run(
        ["node", "tools/build_primary_documents.mjs"],
        cwd=destination,
        check=True,
        stdout=subprocess.DEVNULL,
    )


def capture_tree(browser, tree: Path, phase: str) -> list[dict]:
    records: list[dict] = list()
    with StaticServer(tree / "site") as base:
        for width, height in VIEWPORTS:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                java_script_enabled=False,
                has_touch=width <= 480,
            )
            page = context.new_page()
            for route in ROUTES:
                response = page.goto(f"{base}{route}", wait_until="load")
                if response is None or not response.ok:
                    raise AssertionError(f"{phase} {route} returned {response and response.status}")
                page.evaluate("window.scrollTo(0, 0)")
                page.evaluate("document.fonts && document.fonts.ready")
                overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                if overflow > 1:
                    raise AssertionError(f"{phase} {route} {width}px overflows by {overflow}px")
                name = route.strip("/").replace("-", "_")
                target = OUTPUT / f"{phase}-{name}-{width}.png"
                page.screenshot(path=target, animations="disabled")
                records.append({
                    "phase": phase,
                    "route": f"/{route}",
                    "viewport": [width, height],
                    "file": str(target.relative_to(ROOT)),
                    "overflow_px": overflow,
                })
            context.close()
    return records


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    generated = (ROOT / "site" / "now", ROOT / "site" / "browse")
    existed = {
        path: (path / "index.html").exists()
        for path in generated
    }
    with tempfile.TemporaryDirectory(prefix="crol-nav-before-") as tmp:
        before = Path(tmp)
        revision_snapshot("HEAD", before)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            records = capture_tree(browser, before, "before")
            subprocess.run(
                ["node", "tools/build_primary_documents.mjs"],
                cwd=ROOT,
                check=True,
                stdout=subprocess.DEVNULL,
            )
            try:
                records.extend(capture_tree(browser, ROOT, "after"))
            finally:
                for path in generated:
                    if not existed[path] and path.exists():
                        shutil.rmtree(path)
            browser.close()
    manifest = {
        "schema_version": 1,
        "before_revision": subprocess.check_output(
            ["git", "rev-parse", "--short=12", "HEAD"], cwd=ROOT, text=True
        ).strip(),
        "javascript": "disabled (no-JS document parity)",
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "captures": records,
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote {len(records)} captures to {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
