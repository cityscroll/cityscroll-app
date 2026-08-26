#!/usr/bin/env python3
"""Capture the AP-04 Contracts before/after evidence matrix with Playwright."""

from __future__ import annotations

import json
import functools
import threading
import subprocess
import tarfile
import tempfile
from http.server import ThreadingHTTPServer
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "procurement-analytical-projection"
VIEWPORTS = ((390, 844), (1440, 1000))
AGENCY = "Department of Homeless Services"
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
    with tarfile.open(fileobj=__import__("io").BytesIO(archive), mode="r:") as tar:
        tar.extractall(destination)
    return destination / "site"


def capture_page(page, url: str, path: Path, timing_path: Path | None, after: bool) -> dict:
    print(f"capturing {'after' if after else 'before'} at {url} -> {path.name}", flush=True)
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.goto(url + "browse/contracts/?mode=award", wait_until="domcontentloaded")
    page.wait_for_selector("#list .row")
    if after:
        page.wait_for_function("() => document.querySelector('#contracts-analytics:not([hidden])') && document.querySelector('#contracts-analytics-population')?.textContent.includes('current registered contract value')", timeout=60000)
        page.select_option("#analytics-group", "agency")
        page.select_option("#analytics-measure", "current")
        page.wait_for_timeout(150)
        population = page.locator("#contracts-analytics-population").inner_text()
        groups = page.locator("#contracts-analytics-groups a").evaluate_all("els => els.slice(0, 3).map(el => ({label: el.textContent.trim(), href: el.getAttribute('href')}))")
        page.locator("#contracts-analytics").screenshot(path=str(path), animations="disabled")
        page.select_option("#analytics-group", "vendor")
        page.wait_for_function("() => document.querySelectorAll('#contracts-analytics-groups a').length > 0")
        vendor_groups = page.locator("#contracts-analytics-groups a").evaluate_all("els => els.slice(0, 3).map(el => ({label: el.textContent.trim(), href: el.getAttribute('href')}))")
        drill = groups[0] if groups else None
        drill_result = None
        if drill:
            page.goto(url.rstrip("/") + drill["href"], wait_until="domcontentloaded")
            page.wait_for_selector("#list .row")
            drill_result = {"href": drill["href"], "visible_contract_rows": page.locator("#list .row").count(), "result_count": page.locator("#rescount").inner_text()}
        page.goto(url + "browse/contracts/?mode=award", wait_until="domcontentloaded")
        page.wait_for_selector("#contracts-analytics-groups a")
        page.select_option("#analytics-view", "timing")
        page.wait_for_function("() => document.querySelector('#contracts-analytics-timing:not([hidden])') && document.querySelector('#contracts-analytics-groups a')", timeout=60000)
        timing = {
            "population": page.locator("#contracts-analytics-population").inner_text(),
            "metrics": page.locator("#contracts-analytics-timing").inner_text(),
            "groups": page.locator("#contracts-analytics-groups a").evaluate_all("els => els.slice(0, 3).map(el => ({label: el.textContent.trim(), href: el.getAttribute('href')}))"),
        }
        if timing_path:
            page.locator("#contracts-analytics").screenshot(path=str(timing_path), animations="disabled")
        page.goto(url + "browse/contracts/?mode=award&ap_agency=" + AGENCY.replace(" ", "+"), wait_until="domcontentloaded")
        page.wait_for_selector("#contracts-analytics-concentration:not([hidden])", timeout=60000)
        concentration = {
            "denominator": page.locator("#contracts-analytics-concentration-denominator").inner_text(),
            "top_shares": page.locator("#contracts-analytics-concentration-summaries").inner_text(),
            "vendors": page.locator("#contracts-analytics-concentration-vendors > li").count(),
        }
        page.locator("#contracts-analytics-concentration").screenshot(path=str(OUT / f"after-agency-{page.viewport_size['width']}.png"), animations="disabled")
        return {"population": population, "groups": groups, "vendor_groups": vendor_groups, "drill_through": drill_result, "timing": timing, "concentration": concentration, "page_errors": page_errors}
    page.goto(url + "browse/contracts/?mode=award&ap_agency=" + AGENCY.replace(" ", "+"), wait_until="domcontentloaded")
    page.wait_for_selector("#list .row")
    page.locator("#tab-money .grid").screenshot(path=str(OUT / f"before-agency-{page.viewport_size['width']}.png"), animations="disabled")
    page.locator("#tab-money .grid").screenshot(path=str(path), animations="disabled")
    return {"population": None, "groups": [], "agency": AGENCY, "page_errors": page_errors}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    captures = []
    with tempfile.TemporaryDirectory(prefix="cityscroll-ap-capture-") as temp_name:
        temp = Path(temp_name)
        baseline_site = extract_baseline(temp / "baseline")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for phase, directory, after in (("before", baseline_site, False), ("after", ROOT / "site", True)):
                with SiteServer(directory) as url:
                    for width, height in VIEWPORTS:
                        context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
                        page = context.new_page()
                        page.route("https://**/*", lambda route: route.abort())
                        result = capture_page(page, url, OUT / f"{phase}-{width}.png", OUT / f"{phase}-timing-{width}.png" if after else None, after)
                        captures.append({"phase": phase, "viewport": {"width": width, "height": height}, **result})
                        context.close()
            browser.close()
    (OUT / "capture-receipt.json").write_text(json.dumps({"schema": "cityscroll.procurement-analytical-projection.capture.v1", "captures": captures}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(captures, indent=2))


if __name__ == "__main__":
    main()
