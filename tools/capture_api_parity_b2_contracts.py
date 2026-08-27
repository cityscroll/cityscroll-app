#!/usr/bin/env python3
"""Capture before/after evidence for the Contracts Overview capability slice."""

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
OUT = ROOT / "docs" / "screenshots" / "api-parity-b2-contracts"
sys.path.insert(0, str(ROOT / "tools"))


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


def extract_baseline(destination: Path) -> Path:
    archive = subprocess.run(["git", "archive", "HEAD"], cwd=ROOT, check=True, stdout=subprocess.PIPE).stdout
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        tar.extractall(destination)
    return destination / "site"


def build_site(source_root: Path, destination: Path) -> Path:
    subprocess.run(
        ["node", str(ROOT / "tools" / "build_public_site.mjs"), "--source-dir", str(source_root), "--site-dir", str(destination)],
        cwd=ROOT,
        check=True,
    )
    return destination


def capture(page, base_url: str, phase: str, width: int, height: int) -> dict:
    page.add_init_script(
        """window.__cityscrollB2Lcp = null;
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          if (entries.length) window.__cityscrollB2Lcp = entries.at(-1).startTime;
        }).observe({type: 'largest-contentful-paint', buffered: true});"""
    )
    requests = []
    page.on("request", lambda request: requests.append(request.url))
    page.goto(f"{base_url}browse/contracts/?mode=award", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("#list .row", timeout=60000)
    page.wait_for_selector("#contracts-analytics-groups a", timeout=60000)
    page.wait_for_function(
        "() => !document.querySelector('#list .loading') && document.querySelector('#contracts-analytics-population')?.textContent",
        timeout=60000,
    )
    panel = page.locator("#contracts-analytics")
    screenshot = OUT / f"{phase}-{width}.png"
    panel.screenshot(path=str(screenshot), animations="disabled")
    metrics = page.evaluate(
        """() => ({
          fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
          lcp: window.__cityscrollB2Lcp,
        })"""
    )
    return {
        "phase": phase,
        "viewport": {"width": width, "height": height},
        "screenshot": str(screenshot.relative_to(ROOT)),
        "population": page.locator("#contracts-analytics-population").inner_text(),
        "groups": page.locator("#contracts-analytics-groups a").evaluate_all(
            "els => els.slice(0, 3).map(el => ({label: el.textContent.trim(), href: el.getAttribute('href')}))"
        ),
        "visible_group_count": page.locator("#contracts-analytics-groups a").count(),
        "fcp_ms": metrics["fcp"],
        "lcp_ms": metrics["lcp"],
        "static_analytical_fetch_count": sum("/data/analytics_registered_contracts.json" in url for url in requests),
        "contracts_analysis_request_count": sum("/contracts/analysis" in url for url in requests),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    captures = []
    with tempfile.TemporaryDirectory(prefix="cityscroll-api-parity-b2-") as temp_name:
        temp = Path(temp_name)
        extract_baseline(temp / "baseline")
        baseline_site = build_site(temp / "baseline", temp / "baseline-built")
        after_site = build_site(ROOT, temp / "after-built")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for phase, directory in (("before", baseline_site), ("after", after_site)):
                with SiteServer(directory) as base_url:
                    for width, height in ((390, 844), (1440, 1000)):
                        context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
                        page = context.new_page()
                        page.route("https://**/*", lambda route: route.abort())
                        captures.append(capture(page, base_url, phase, width, height))
                        context.close()
            browser.close()
    (OUT / "capture-receipt.json").write_text(
        json.dumps({"schema": "cityscroll.api-parity-b2-contracts.capture.v1", "captures": captures}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(captures, indent=2))


if __name__ == "__main__":
    main()
