#!/usr/bin/env python3
"""Capture the failed notice document before/after at narrow and wide widths."""

from __future__ import annotations

import argparse
import functools
import re
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "notice-fallback"
NOTICE_ID = "20991231999"
VIEWPORTS = ((390, 900), (1440, 1000))

BEFORE_MARKUP = f'''<div class="panel route-item" tabindex="-1" data-edge-rendered="notice-unavailable">
  <p class="ftype">City Record notice</p><h2 class="rolename">Notice {NOTICE_ID}</h2>
  <p>The public record could not be loaded at this moment. The official source remains available.</p>
  <div class="actions"><a class="act" href="/browse/">Back to Browse</a><a class="act primary" href="https://a856-cityrecord.nyc.gov/RequestDetail/{NOTICE_ID}" target="_blank" rel="noopener noreferrer">View City Record</a></div>
</div>'''


def current_markup() -> str:
    script = (
        'import { renderEdgeNotice } from "./site/pages_edge.mjs"; '
        f'process.stdout.write(renderEdgeNotice(null, "{NOTICE_ID}"));'
    )
    return subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def document(markup: str) -> str:
    html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
    html = re.sub(r"<script\b[^>]*>[\s\S]*?</script>", "", html)
    html = html.replace('class="tabpane active"', 'class="tabpane"')
    html = html.replace('id="tab-notice" class="tabpane"', 'id="tab-notice" class="tabpane active"')
    html = re.sub(
        r'<div id="noticeview" translate="no">[\s\S]*?</div>\s*<!-- permalink views',
        f'<div id="noticeview" translate="no">{markup}</div><!-- permalink views',
        html,
        count=1,
    )
    return html


class QuietHandler(SimpleHTTPRequestHandler):
    page_html = ""

    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == f"/notices/{NOTICE_ID}":
            body = self.page_html.encode()
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", choices=("before", "after"), required=True)
    args = parser.parse_args()
    markup = BEFORE_MARKUP if args.label == "before" else current_markup()
    QuietHandler.page_html = document(markup)
    OUT.mkdir(parents=True, exist_ok=True)

    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.goto(f"http://127.0.0.1:{server.server_port}/notices/{NOTICE_ID}", wait_until="networkidle")
                panel = page.locator('[data-edge-rendered="notice-unavailable"]')
                panel.wait_for(state="visible")
                text = panel.inner_text()
                if args.label == "before":
                    assert "View City Record" in text
                else:
                    assert "Browse public records" in text
                    assert "View City Record" not in text
                page.screenshot(path=str(OUT / f"{args.label}-{width}.png"), full_page=True)
                page.close()
            browser.close()
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    print(f"Wrote {args.label} captures to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
