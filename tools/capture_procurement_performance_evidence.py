#!/usr/bin/env python3
"""Capture the public performance-evidence coverage before/after pair."""

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
import sys

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "procurement-performance-evidence"
VIEWPORTS = ((390, 844), (1440, 1000))


class SiteServer:
    def __init__(self, directory: Path):
        sys.path.insert(0, str(ROOT / "tools"))
        from local_site_server import QuietHandler

        self.server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            functools.partial(QuietHandler, directory=str(directory)),
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def extract_baseline(destination: Path) -> Path:
    archive = subprocess.run(
        ["git", "archive", "HEAD"],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        tar.extractall(destination)
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=destination, check=True)
    subprocess.run(
        ["node", "tools/build_public_site.mjs", "--source-dir", ".", "--site-dir", "_site"],
        cwd=destination,
        check=True,
    )
    return destination / "_site"


def capture(page, url: str, output: Path, after: bool) -> dict:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url + "browse/contracts/?mode=award", wait_until="domcontentloaded")
    page.wait_for_selector("#list .row")
    page.wait_for_selector("#contracts-analytics:not([hidden])")
    if after:
        page.select_option("#analytics-view", "performance_evidence")
        page.wait_for_function(
            "() => document.querySelector('#contracts-analytics-performance-evidence:not([hidden])') && "
            "document.querySelector('#contracts-analytics-performance-evidence-summary a')",
            timeout=60_000,
        )
        page.locator("#contracts-analytics").screenshot(path=str(output), animations="disabled")
        return {
            "phase": "after",
            "population": page.locator("#contracts-analytics-population").inner_text(),
            "states": page.locator("#contracts-analytics-performance-evidence-summary").inner_text(),
            "groups": page.locator("#contracts-analytics-performance-evidence-groups").inner_text(),
            "page_errors": errors,
        }

    page.locator("#contracts-analytics").screenshot(path=str(output), animations="disabled")
    return {
        "phase": "before",
        "visible_text": page.locator("#contracts-analytics").inner_text(),
        "page_errors": errors,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    captures: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="cityscroll-ap10-capture-") as temp_name:
        baseline_site = extract_baseline(Path(temp_name) / "baseline")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for phase, directory, after in (
                ("before", baseline_site, False),
                ("after", ROOT / "_site", True),
            ):
                with SiteServer(directory) as url:
                    for width, height in VIEWPORTS:
                        context = browser.new_context(
                            viewport={"width": width, "height": height},
                            device_scale_factor=1,
                        )
                        page = context.new_page()
                        page.route("https://**/*", lambda route: route.abort())
                        captures.append(
                            {
                                "viewport": {"width": width, "height": height},
                                **capture(page, url, OUT / f"{phase}-{width}.png", after),
                            }
                        )
                        context.close()
            browser.close()
    (OUT / "capture-receipt.json").write_text(
        json.dumps(
            {
                "schema": "cityscroll.procurement-performance-evidence.capture.v1",
                "captures": captures,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(json.dumps(captures, indent=2))


if __name__ == "__main__":
    main()
