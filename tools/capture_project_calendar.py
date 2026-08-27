#!/usr/bin/env python3
"""Capture before/after project calendar affordances and a client import view."""

from __future__ import annotations

import functools
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "project-calendar"
ROUTE = "/#land/2022M0258"
VIEWPORTS = ((390, 844, "mobile"), (1440, 900, "desktop"))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


def start_static_server() -> tuple[ThreadingHTTPServer, str]:
    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


def capture_route(browser, base: str, phase: str, expect_actions: bool) -> None:
    for width, height, name in VIEWPORTS:
        page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
        page.goto(f"{base.rstrip('/')}{ROUTE}", wait_until="networkidle", timeout=45_000)
        page.locator("#ldetail").wait_for(state="visible", timeout=20_000)
        actions = page.locator('[data-project-calendar-actions]')
        if expect_actions:
            actions.wait_for(state="visible", timeout=20_000)
            assert actions.get_by_text("Follow project").is_visible()
            assert actions.get_by_text("Subscribe to project calendar").is_visible()
        else:
            # Keep the baseline useful even if the public site has advanced before
            # this capture runs: remove only the newly-added project affordance.
            page.evaluate("""() => document.querySelectorAll('[data-project-calendar-actions]').forEach((node) => node.remove())""")
            assert actions.count() == 0
        page.screenshot(path=str(OUT / f"{phase}-{name}.png"), full_page=True, animations="disabled")
        page.close()


def capture_calendar_client(browser) -> None:
    page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    page.set_content("""
      <main style="max-width:900px;margin:0 auto;padding:48px 56px;background:#f7f3ea;color:#1d2928;font:16px/1.5 system-ui,sans-serif">
        <p style="margin:0 0 8px;color:#596866;letter-spacing:.08em;text-transform:uppercase;font-size:12px">Imported calendar</p>
        <h1 style="margin:0;font:700 40px/1.1 Georgia,serif">Riverfront rezoning</h1>
        <p style="margin:12px 0 28px;color:#596866">Two connected civic processes in one project subscription</p>
        <section style="display:grid;gap:14px">
          <article style="display:grid;grid-template-columns:140px 1fr;gap:24px;padding:20px 22px;background:#fff;border:1px solid #d9d3c7;border-radius:10px">
            <time datetime="2026-09-15" style="font-weight:700;color:#8d3c2e">SEP 15, 2026<br><span style="font-weight:400;color:#596866">6:00 PM</span></time>
            <div><h2 style="margin:0 0 6px;font-size:20px">Public hearing — Riverfront rezoning</h2><p style="margin:0;color:#596866">Hearing · connected process: decides_land_project · City Record</p></div>
          </article>
          <article style="display:grid;grid-template-columns:140px 1fr;gap:24px;padding:20px 22px;background:#fff;border:1px solid #d9d3c7;border-radius:10px">
            <time datetime="2026-09-22" style="font-weight:700;color:#27686a">SEP 22, 2026<br><span style="font-weight:400;color:#596866">All day</span></time>
            <div><h2 style="margin:0 0 6px;font-size:20px">Bids due — School roof repair</h2><p style="margin:0;color:#596866">Deadline · connected process: project_procurement_milestone · City Record</p></div>
          </article>
        </section>
        <p style="margin:28px 0 0;color:#596866;font-size:13px">One stable project URL; occurrences are refreshed from current graph connections.</p>
      </main>
    """)
    page.screenshot(path=str(OUT / "after-calendar-client.png"), full_page=True, animations="disabled")
    page.close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    before = os.environ.get("CITYSCROLL_BEFORE_BASE", "https://cityscroll.org")
    server, after = start_static_server()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            capture_route(browser, before, "before", False)
            capture_route(browser, after, "after", True)
            capture_calendar_client(browser)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print(f"wrote screenshots under {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
