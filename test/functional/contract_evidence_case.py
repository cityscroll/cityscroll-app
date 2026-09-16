#!/usr/bin/env python3
"""Contract-evidence browser case for resident_document_presentation."""

from __future__ import annotations

import hashlib
import http.server
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
CONTRACT_ID = "procurement:contract:CT107120258801626"
CONTRACT_ROUTE = f"/procurements/{CONTRACT_ID.replace(':', '%3A')}"


def stage_contract_fixture() -> pathlib.Path:
    staging = pathlib.Path(tempfile.mkdtemp(prefix="cityscroll-contract-", dir=os.environ.get("CITYSCROLL_FUNCTIONAL_TMPDIR") or os.environ.get("FM_TASK_SCRATCH")))
    site = ROOT / "site"
    for name in (
        "coverage_reader_projection.css",
        "civic-documents.css",
        "brand.css",
        "report_issue.mjs",
    ):
        src = site / name
        if src.exists():
            shutil.copy2(src, staging / name)
    html_path = staging / "contract.html"
    subprocess.run(
        ["node", str(ROOT / "test/functional/render_contract_evidence_fixture.mjs"), str(html_path)],
        cwd=ROOT,
        check=True,
    )
    return staging


def start_contract_server():
    staging = stage_contract_fixture()
    from tools.local_site_server import _RobustThreadingHTTPServer
    contract_html = (staging / "contract.html").read_bytes()

    class FixtureHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(staging), **kwargs)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path.startswith("/procurements/"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(contract_html)))
                self.end_headers()
                self.wfile.write(contract_html)
                return
            return super().do_GET()

        def log_message(self, _format, *_args):
            return

    server = _RobustThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    return staging, base, server


def _heading_positions(page) -> dict[str, int]:
    return page.evaluate(
        """() => {
          const text = document.body ? document.body.innerText : '';
          const find = (label) => text.indexOf(label);
          return {
            facts: find('Contract facts'),
            events: Math.max(find('Observed events'), find('Observed stages')),
            sources: find('Sources'),
          };
        }"""
    )


def assert_contract_evidence(page, base: str, *, label: str, java_script_enabled: bool = True) -> dict[str, object]:
    page.set_default_timeout(20000)
    errors: list[str] = []
    if java_script_enabled:
        page.on("pageerror", lambda error: errors.append(str(error)))
    target = f"{base.rstrip('/')}/{CONTRACT_ROUTE.lstrip('/')}"
    response = page.goto(target, wait_until="domcontentloaded")
    assert response and response.status == 200, f"{label}: contract route did not return 200"
    page.wait_for_selector("main.node-document, main", state="visible")
    positions = _heading_positions(page)
    assert positions["facts"] >= 0, f"{label}: missing Contract facts"
    assert positions["events"] >= 0, f"{label}: missing Observed events/stages"
    assert positions["sources"] >= 0, f"{label}: missing Sources"
    assert positions["facts"] < positions["events"] < positions["sources"], (
        f"{label}: hierarchy was facts={positions['facts']} events={positions['events']} sources={positions['sources']}"
    )

    closed_text = page.evaluate(
        """() => {
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('[data-coverage-disclosure]').forEach((node) => node.remove());
          return clone.innerText || '';
        }"""
    )
    assert "Importer coverage:" not in closed_text
    assert "identity-bearing importer streams" not in closed_text
    assert "exact_pin" not in closed_text
    assert "exact_contract_id" not in closed_text
    assert re.search(r"\b\d+ in (City Record|Checkbook)", closed_text) is None

    disclosure = page.locator("[data-coverage-disclosure]")
    assert disclosure.count() == 1, f"{label}: Sources disclosure missing"
    disclosure.locator("summary").click()
    assert page.locator("[data-coverage-reader-projection] [data-coverage-state]").count() >= 2
    states = page.locator("[data-coverage-reader-projection] [data-coverage-state]").evaluate_all(
        "nodes => nodes.map((node) => node.getAttribute('data-coverage-state'))"
    )
    assert len(set(states)) >= 2, f"{label}: source states not distinguishable: {states}"

    paid_caveat = page.locator("[data-claim-caveat='paid_amount']")
    if paid_caveat.count():
        assert "$0" not in paid_caveat.inner_text()

    if java_script_enabled:
        page.keyboard.press("Tab")
        assert page.evaluate("document.activeElement && getComputedStyle(document.activeElement).display !== 'none'")
        assert not errors, f"{label}: client errors: {errors}"

    content = page.locator("main").inner_text()
    return {
        "route": CONTRACT_ROUTE,
        "viewport": page.viewport_size,
        "render_sha256": hashlib.sha256(content.encode()).hexdigest(),
        "positions": positions,
        "states": states,
    }


def write_capture_manifest(entries: list[dict]) -> pathlib.Path:
    evidence_dir = ROOT / "docs" / "evidence" / "contract-evidence-presentation"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    payload = {
        "schema": "cityscroll.capture_manifest.v1",
        "case": "contract-evidence",
        "revision": revision,
        "data_vintage": "fixture-or-served-materialization",
        "entries": entries,
    }
    path = evidence_dir / "capture-manifest.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def run_contract_evidence_case(base: str | None = None) -> None:
    from playwright.sync_api import sync_playwright

    staging = server = None
    owns_server = False
    if not base:
        staging, base, server = start_contract_server()
        owns_server = True
    base = base.rstrip("/") + "/"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            entries: list[dict] = []
            for viewport in ({"width": 1440, "height": 1000}, {"width": 390, "height": 844}):
                no_js = browser.new_context(viewport=viewport, java_script_enabled=False)
                no_js_result = assert_contract_evidence(no_js.new_page(), base, label="first paint/no JavaScript", java_script_enabled=False)
                entries.append({**no_js_result, "mode": "no-javascript", "passed": True})
                no_js.close()

                failed = browser.new_context(viewport=viewport)
                failed_page = failed.new_page()
                failed_page.route("**/report_issue.mjs", lambda route: route.abort())
                failed_result = assert_contract_evidence(failed_page, base, label="failed enhancement")
                entries.append({**failed_result, "mode": "failed-enhancement", "passed": True})
                failed.close()

                context = browser.new_context(viewport=viewport)
                page = context.new_page()
                result = assert_contract_evidence(page, base, label="successful enhancement")
                entries.append({**result, "mode": "successful-enhancement", "passed": True})
                print(
                    f"OK contract-evidence {viewport['width']}x{viewport['height']}: "
                    f"{result['render_sha256']} failed={failed_result['render_sha256']} nojs={no_js_result['render_sha256']}",
                    flush=True,
                )
                context.close()
            manifest = write_capture_manifest(entries)
            print(f"wrote {manifest}", flush=True)
            browser.close()
    finally:
        if owns_server and server:
            server.shutdown()
            server.server_close()
        if staging:
            shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    run_contract_evidence_case()
