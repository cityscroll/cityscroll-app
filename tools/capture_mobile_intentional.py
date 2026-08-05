#!/usr/bin/env python3
"""Capture production-before/local-after responsive evidence at phone and desktop widths."""

from __future__ import annotations

import functools
import http.server
import json
from pathlib import Path
import sys
import threading

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from i18n_fixtures import install_routes  # noqa: E402

OUT = ROOT / "docs" / "screenshots" / "mobile-intentional"
PRODUCTION = "https://cityscroll.org/"
VIEWPORTS = ((360, 800), (1280, 900))
SURFACES = (
    ("contracts", "#money", "#list .row", "#tab-money .lens-intro"),
    ("staffing", "#people?view=guide", "#staffing-ledger", "#staffing-feed"),
    ("rules-stepper", "#notice/20260714029", ".rule-phase-stepper", ".rule-phase-stepper"),
    ("reader-action", "#notice/20260701099", "#noticeview .panel", "#noticeview .panel"),
    ("map", "#map", "#mapAreaList button", ".map-explore"),
)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self) -> None:
        handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def prepare(page: Page, name: str) -> None:
    if name == "contracts":
        ask = page.locator("#tab-money .ask-cityscroll")
        ask.evaluate("el => { el.open = true; }")
    elif name == "staffing":
        ledger = page.locator("#staffing-ledger")
        if ledger.count():
            ledger.evaluate("el => { el.open = true; }")
    elif name == "reader-action":
        page.add_style_tag(
            content="#noticeview .panel > .note:last-child{display:none!important}"
        )


def install_table(page: Page) -> None:
    page.evaluate(
        """async () => {
          const mod = await import('./attachment_tables_ui.mjs');
          document.querySelector('#mobile-table-capture')?.remove();
          const detail = document.createElement('section');
          detail.id = 'mobile-table-capture';
          detail.className = 'panel detail';
          detail.setAttribute('aria-label', 'Structured attachment table');
          document.querySelector('#tab-money .grid').insertAdjacentElement('beforebegin', detail);
          detail.innerHTML = mod.attachmentTablesHTML({
            tables_status: 'ok',
            tables_preview: 'Species and timber volume',
            extracted_tables: [{
              caption: 'Forest products',
              headers: ['Species', 'Sawtimber (MBF)', 'Pulp (cords)', 'Percent of sawtimber'],
              rows: [
                ['Red Oak', '91.6', '28', '49%'],
                ['White Ash', '41.1', '18', '22%'],
                ['Red Maple', '26.2', '22', '14%'],
              ],
            }],
          }, {t: key => key});
          detail.querySelector('.attachment-tables').open = true;
        }"""
    )


def capture_page(page: Page, target: str, path: Path) -> dict:
    locator = page.locator(target).first
    locator.wait_for(state="visible", timeout=20_000)
    locator.scroll_into_view_if_needed()
    page.evaluate("scrollBy(0, -72)")
    page.wait_for_timeout(150)
    page.screenshot(path=str(path), animations="disabled")
    return page.evaluate(
        """() => ({
          inner_width: innerWidth,
          document_scroll_width: document.documentElement.scrollWidth,
          overflow_px: document.documentElement.scrollWidth - innerWidth,
        })"""
    )


def capture_phase(browser, base: str, phase: str) -> list[dict]:
    records = []  # Derived inventory: one record for each captured surface and viewport.
    for width, height in VIEWPORTS:
        context = browser.new_context(
            viewport={"width": width, "height": height}, has_touch=width <= 480
        )
        for name, route, ready, focus in SURFACES:
            page = context.new_page()
            install_routes(page)
            page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=45_000)
            page.locator(ready).first.wait_for(state="visible", timeout=20_000)
            prepare(page, name)
            target = OUT / f"{phase}-{name}-{width}.png"
            metrics = capture_page(page, focus, target)
            records.append({
                "phase": phase,
                "surface": name,
                "viewport": [width, height],
                "file": str(target.relative_to(ROOT)),
                **metrics,
            })
            page.close()

        page = context.new_page()
        install_routes(page)
        page.goto(f"{base}#money", wait_until="domcontentloaded", timeout=45_000)
        page.locator("#detail").wait_for(state="visible", timeout=20_000)
        install_table(page)
        target = OUT / f"{phase}-table-{width}.png"
        metrics = capture_page(page, "#mobile-table-capture .attachment-tables", target)
        records.append({
            "phase": phase,
            "surface": "table",
            "viewport": [width, height],
            "file": str(target.relative_to(ROOT)),
            **metrics,
        })
        page.close()
        context.close()
    return records


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        before = capture_phase(browser, PRODUCTION, "before")
        with StaticServer() as local:
            after = capture_phase(browser, local, "after")
        browser.close()
    receipt = {
        "schema_version": 1,
        "production_before": PRODUCTION,
        "local_after": "local static site with hermetic public-data fixtures",
        "staffing_route_check": (
            "Verified independently at 360px in headless Chromium and at 500px in an "
            "interactive Chrome viewport. The tab, career results, feed, appointments "
            "disclosure, and appointment list all rendered with nonzero geometry. The "
            "initial capture failure waited for disclosure content before opening its parent."
        ),
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "captures": before + after,
    }
    (OUT / "capture-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote {len(before) + len(after)} captures to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
