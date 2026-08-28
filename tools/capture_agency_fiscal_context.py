#!/usr/bin/env python3
"""Capture AP-12 before/after evidence from the static agency document."""

from __future__ import annotations

import functools
import io
import json
import subprocess
import tarfile
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "agency-fiscal-context"
AGENCY = "parks-and-recreation"
URL = f"agencies/{AGENCY}/"


class SiteServer:
    def __init__(self, directory: Path):
        from local_site_server import QuietHandler

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(directory)))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def baseline_site(destination: Path) -> Path:
    archive = subprocess.run(["git", "archive", "HEAD"], cwd=ROOT, check=True, stdout=subprocess.PIPE).stdout
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        tar.extractall(destination)
    site = destination / "site"
    subprocess.run(["node", "tools/build_agency_constellation_documents.mjs"], cwd=destination, check=True, stdout=subprocess.PIPE)
    return site


def capture_page(page, base_url: str, phase: str, viewport: dict[str, int]) -> dict:
    page.goto(base_url + URL, wait_until="domcontentloaded")
    page.wait_for_selector("#main")
    context = page.locator("#agency-fiscal-context")
    if phase == "after":
        page.wait_for_selector("#agency-fiscal-context", timeout=60000)
        page.wait_for_selector("#agency-fiscal-context[data-fiscal-context-status='matched']", timeout=60000)
        page.wait_for_selector("#agency-fiscal-context table")
    else:
        page.wait_for_timeout(750)
    has_context = context.count() > 0
    path = OUT / f"{phase}-{viewport['width']}.png"
    page.locator("#main").screenshot(path=str(path), animations="disabled")
    return {
        "phase": phase,
        "viewport": viewport,
        "has_fiscal_context": has_context,
        "heading": page.locator("#agency-fiscal-context h2").inner_text() if has_context else None,
        "status": page.locator("#agency-fiscal-context").get_attribute("data-fiscal-context-status") if has_context else None,
        "source_link_count": page.locator("#agency-fiscal-context a").count() if has_context else 0,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    captures = []
    with tempfile.TemporaryDirectory(prefix="cityscroll-ap12-capture-") as temp_name:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for phase, directory in (("before", baseline_site(Path(temp_name) / "baseline")), ("after", ROOT / "site")):
                with SiteServer(directory) as base_url:
                    for width, height in ((390, 844), (1440, 1000)):
                        viewport = {"width": width, "height": height}
                        context = browser.new_context(viewport=viewport, device_scale_factor=1)
                        page = context.new_page()
                        page.route("https://**/*", lambda route: route.abort())
                        captures.append(capture_page(page, base_url, phase, viewport))
                        context.close()
            browser.close()
    (OUT / "capture-receipt.json").write_text(json.dumps({"schema": "cityscroll.agency-fiscal-context.capture.v1", "agency": AGENCY, "captures": captures}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(captures, indent=2))


if __name__ == "__main__":
    main()
