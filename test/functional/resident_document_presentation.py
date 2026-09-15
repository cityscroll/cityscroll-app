#!/usr/bin/env python3
"""Browser proof for the composed notice document delivered by the edge route."""

from __future__ import annotations

import argparse
import hashlib
import http.server
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT))
NOTICE_ID = "20260810048"
NOTICE_ROUTE = f"/notices/{NOTICE_ID}/"


def stage_assets() -> pathlib.Path:
    staging = pathlib.Path(tempfile.mkdtemp(prefix="cityscroll-pages-", dir=os.environ.get("CITYSCROLL_FUNCTIONAL_TMPDIR")))
    built_site = ROOT / "_site"
    if not built_site.is_dir():
        raise RuntimeError("verified _site artifact is missing; build it before running notice-shell")
    shutil.copytree(built_site, staging, copy_function=os.link, symlinks=True, dirs_exist_ok=True)
    (staging / "data" / "procurement_spine_sources.json").unlink(missing_ok=True)
    return staging


def start_server():
    staging = stage_assets()
    state_dir = pathlib.Path(tempfile.mkdtemp(prefix="cityscroll-wrangler-", dir=os.environ.get("CITYSCROLL_FUNCTIONAL_TMPDIR")))
    from tools.local_site_server import _RobustThreadingHTTPServer

    class ReadModelHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = ('{"ok":true,"row":{"request_id":"20260810048",'
                    '"short_title":"ACEDCA215 Brooklyn Childrens Museum HVAC Upgrade",'
                    '"type_of_notice_description":"Solicitation",'
                    '"agency_name":"Design and Construction",'
                    '"start_date":"2026-08-14","pin":"85026B0110"},"civic_time":null}').encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, _format, *_args):
            return

    upstream = _RobustThreadingHTTPServer(("127.0.0.1", 0), ReadModelHandler)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    config = state_dir / "wrangler.toml"
    config.write_text(
        f'name = "cityscroll-notice-local"\nmain = "{ROOT / "site" / "_worker.js"}"\ncompatibility_date = "2026-07-27"\n'
        f'[assets]\nbinding = "ASSETS"\ndirectory = "{staging}"\n', encoding="utf-8"
    )
    process = subprocess.Popen(
        ["npx", "--yes", "wrangler@4.126.0", "dev",
         "--config", str(config), "--ip", "127.0.0.1", "--port", "0",
         "--compatibility-date", "2026-07-27", "--var", f"NOTICE_READ_MODEL=http://127.0.0.1:{upstream.server_port}/notice",
         "--persist-to", str(state_dir),
         "--show-interactive-dev-session", "false"],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    base = ""
    output_lines = []
    for _ in range(120):
        line = process.stdout.readline() if process.stdout else ""
        output_lines.append(line)
        match = re.search(r"Ready on (http://127\.0\.0\.1:\d+)", line)
        if match:
            base = f"{match.group(1)}/"
            break
        if process.poll() is not None:
            break
    if not base:
        output = "".join(output_lines) + (process.stdout.read() if process.stdout else "")
        process.terminate()
        upstream.shutdown()
        upstream.server_close()
        raise RuntimeError(f"wrangler dev did not become ready: {output[-2000:]}")
    return process, staging, state_dir, base, upstream


def assert_composed(page, base: str, *, label: str) -> dict[str, object]:
    page.set_default_timeout(20000)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("requestfailed", lambda request: errors.append(f"request {request.url}: {request.failure}")
            if "app/main.mjs" not in request.url else None)
    response = page.goto(f"{base}{NOTICE_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, f"{label}: notice route did not return 200"
    page.wait_for_selector("#notice-route-chrome .document-mast", state="visible")
    page.wait_for_selector("#noticeview .route-item", state="visible")
    assert not errors, f"{label}: client errors: {errors}"
    assert page.locator("#noticeview .rolename").count() == 1
    assert page.locator("#noticeview .glance dt").count() >= 1
    assert page.locator(".notice-route .home-topic-entry:visible").count() == 0
    assert page.locator(".notice-route .home-cta:visible").count() == 0
    assert page.locator(".notice-route .document-mast").count() == 1
    assert page.locator("#langSelect").count() == 1
    hidden_focus = page.locator("#notice-route-chrome [hidden] :is(a,button,input,select,textarea,summary):not([disabled])")
    assert hidden_focus.count() == 0, f"{label}: hidden focusable control remains"
    page.keyboard.press("Tab")
    assert page.evaluate("document.activeElement && getComputedStyle(document.activeElement).display !== 'none'")
    content = page.locator("#main").inner_text()
    return {"route": NOTICE_ROUTE, "viewport": page.viewport_size, "render_sha256": hashlib.sha256(content.encode()).hexdigest()}


def assert_no_javascript(page, base: str) -> None:
    response = page.goto(f"{base}{NOTICE_ROUTE.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == 200, f"edge response status={response.status if response else 'none'} body={page.locator('body').inner_text()[:300]}"
    assert page.locator("#notice-route-chrome .document-mast").count() == 1
    assert page.locator("#noticeview .rolename").count() == 1
    assert page.locator("#noticeview .glance dt").count() >= 1
    assert page.locator(".home-topic-entry:visible").count() == 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=["notice-shell"], required=True)
    parser.parse_args()
    from playwright.sync_api import sync_playwright

    process = staging = state_dir = upstream = None
    base = os.environ.get("CROL_BASE")
    if not base:
        process, staging, state_dir, base, upstream = start_server()
    base = base.rstrip("/") + "/"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for viewport in ({"width": 1440, "height": 1000}, {"width": 390, "height": 844}):
                no_js = browser.new_context(viewport=viewport, java_script_enabled=False)
                assert_no_javascript(no_js.new_page(), base)
                no_js.close()

                failed = browser.new_context(viewport=viewport)
                failed_page = failed.new_page()
                failed_page.route("**/app/main.mjs", lambda route: route.abort())
                failed_result = assert_composed(failed_page, base, label="failed enhancement")
                failed.close()

                context = browser.new_context(viewport=viewport)
                page = context.new_page()
                result = assert_composed(page, base, label="successful hydration")
                page.goto(base, wait_until="domcontentloaded")
                page.go_back(wait_until="domcontentloaded")
                page.wait_for_selector("#notice-route-chrome .document-mast", state="visible")
                assert page.locator("#noticeview .route-item").count() == 1
                print(f"OK notice-shell {viewport['width']}x{viewport['height']}: {result['render_sha256']} failed={failed_result['render_sha256']}", flush=True)
                context.close()
            browser.close()
    finally:
        if process:
            process.terminate()
            process.wait(timeout=10)
        if upstream:
            upstream.shutdown()
            upstream.server_close()
        if staging:
            shutil.rmtree(staging, ignore_errors=True)
        if state_dir:
            shutil.rmtree(state_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
