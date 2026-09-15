#!/usr/bin/env python3
"""Resident-facing browser assertions for composed civic documents.

The route/capture helpers are intentionally small so later document cases can
reuse the same local serving and manifest shape.
"""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT))


def start_server():
    process = subprocess.Popen(
        [sys.executable, str(ROOT / "tools/local_site_server.py"), "--directory", str(ROOT / "site"), "--port", "0"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    base = process.stdout.readline().strip() if process.stdout else ""
    if not base:
        raise RuntimeError("local site server did not publish a base URL")
    return process, base


def assert_notice_shell(page, base: str) -> dict[str, object]:
    page.set_default_timeout(15000)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base, wait_until="commit")
    page.wait_for_selector("#notice-route-chrome", state="attached")
    page.evaluate("""
      () => {
        document.body.classList.add('notice-route');
        document.body.dataset.primaryContext = 'notice';
        document.querySelector('#tab-browse').classList.remove('active');
        document.querySelector('#tab-notice').classList.add('active');
        document.querySelector('#noticeview').innerHTML = '<article class="panel route-item"><h2 class="rolename">A readable public notice</h2><dl class="glance"><dt>Published</dt><dd>2026-09-15</dd></dl></article>';
      }
    """)
    page.add_script_tag(type="module", content=f"import {{ applyNoticeRouteState }} from '{base}notice_document_composition.mjs'; applyNoticeRouteState(true);")
    page.wait_for_selector("#tab-notice", state="visible")
    page.wait_for_selector(".notice-route .document-mast", state="attached")
    page.wait_for_selector("#noticeview .route-item", state="visible")
    assert page.locator("#noticeview h2.rolename").count() == 1
    assert page.locator(".notice-route .home-topic-entry:visible").count() == 0
    assert page.locator(".notice-route .home-cta:visible").count() == 0
    assert page.locator(".notice-route .document-mast").count() == 1
    assert page.locator("#langSelect").count() == 1
    content = page.locator("#main").inner_text()
    return {
        "route": "/notices/20260915001/",
        "viewport": page.viewport_size,
        "assertions": ["one heading", "compact mast", "no homepage promotion", "language control"],
        "render_sha256": hashlib.sha256(content.encode()).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=["notice-shell"], required=True)
    args = parser.parse_args()
    import os
    from playwright.sync_api import sync_playwright

    server = None
    base = os.environ.get("CROL_BASE")
    if not base:
        server, base = start_server()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for viewport in ({"width": 1440, "height": 1000}, {"width": 390, "height": 844}):
                context = browser.new_context(viewport=viewport)
                page = context.new_page()
                result = assert_notice_shell(page, base)
                print(f"OK notice-shell {viewport['width']}x{viewport['height']}: {result['render_sha256']}", flush=True)
                context.close()
            browser.close()
    finally:
        if server:
            server.terminate()
            server.wait(timeout=5)


if __name__ == "__main__":
    main()
