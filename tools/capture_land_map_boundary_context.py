#!/usr/bin/env python3
"""Headless before/after evidence for LM-09 boundary context."""

from __future__ import annotations

import functools
import json
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright

from lib.temp_workspace import head_site_workspace

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "land-map-boundary-context"
RECEIPT = ROOT / "docs" / "evidence" / "land-map-boundary-context.json"
VIEWPORTS = ((390, 844), (1440, 900))
ROUTES = {
    "brooklyn": "/browse/zoning/?boro=Brooklyn&view=map",
    "scope": "/browse/zoning/?boro=Brooklyn&view=map",
    "missing": "/browse/zoning/?boro=Brooklyn&view=map",
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(directory)))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def install_routes(page: Page, base_url: str, missing: bool = False) -> None:
    def capability_module(route: Route) -> None:
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    page.route(
        f"{base_url.rstrip('/')}/capabilities/*",
        capability_module,
    )
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="[]"),
    )
    page.route("https://**", lambda route: route.abort())
    if missing:
        page.route(
            f"{base_url.rstrip('/')}/data/geography/layers/community_district/*",
            lambda route: route.fulfill(status=404, body=""),
        )


def observe(page: Page) -> dict:
    return page.evaluate(
        """() => {
          const panel = document.getElementById('land-map-panel');
          const summary = document.getElementById('land-map-summary');
          return {
            url: location.pathname + location.search + location.hash,
            map_state: panel?.dataset?.landMapState || null,
            boundary_state: panel?.dataset?.landMapBoundaryState || null,
            counts: summary ? {
              total: Number(summary.dataset.landMapTotal),
              mapped: Number(summary.dataset.landMapMapped),
              unmapped: Number(summary.dataset.landMapUnmapped),
            } : null,
            marker_ids: [...document.querySelectorAll('.land-map-marker')].map((node) => node.dataset.landMapProject),
            boundary_levels: [...new Set([...document.querySelectorAll('[data-land-boundary-level]')].map((node) => node.dataset.landBoundaryLevel))],
            labels: document.querySelectorAll('.land-map-boundary-label').length,
            source_vintage: [...document.querySelectorAll('[data-land-boundary-vintage]')].map((node) => node.dataset.landBoundaryVintage)[0] || null,
            evidence: !!document.querySelector('.land-map-boundary-evidence'),
          };
        }"""
    )


def capture(site: Path, phase: str, route_key: str = "brooklyn", missing: bool = False, handoff: bool = False) -> dict:
    readings: dict = {}
    capture_name = "missing" if missing else route_key
    with StaticServer(site) as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page, base_url, missing=missing)
            page.goto(f"{base_url.rstrip('/')}{ROUTES[route_key]}", wait_until="domcontentloaded", timeout=45_000)
            page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
            page.wait_for_function(
                "() => document.querySelectorAll('#llist .row').length > 0 || !!document.querySelector('.land-empty-state')",
                timeout=45_000,
            )
            page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=45_000)
            if handoff:
                scope = page.locator(".land-map-boundary-label[data-land-boundary-link='K03']")
                scope.focus()
                scope.press("Enter")
                page.wait_for_function("() => location.hash.includes('cd=K03')", timeout=20_000)
                page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=45_000)
            page.wait_for_timeout(900)
            reading = observe(page)
            OUT.mkdir(parents=True, exist_ok=True)
            shot = OUT / f"{phase}-{capture_name}-{width}.png"
            page.screenshot(path=str(shot), full_page=True, animations="disabled")
            reading["screenshot"] = str(shot.relative_to(ROOT))
            readings[f"{capture_name}@{width}"] = reading
            page.close()
        browser.close()
    return readings


def main() -> None:
    with head_site_workspace(
        ROOT, "capture-land-map-boundary-context", disable_sparse_checkout=True
    ) as site_root:
        before = capture(site_root, "before")
        before_scope = capture(site_root, "before", route_key="scope")
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=ROOT, check=True)
    after = capture(ROOT / "site", "after")
    after_scope = capture(ROOT / "site", "after", route_key="scope", handoff=True)
    missing = capture(ROOT / "site", "after", missing=True)
    receipt = {
        "schema": "cityscroll.land-map-boundary-context-receipt.v1",
        "card": "cityscroll-land-map-view/lm-09-boundary-context",
        "browser_mode": "headless chromium (playwright), remote hosts blocked",
        "revision": subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip(),
        "artifact_vintage": "2026-05-26",
        "routes": ROUTES,
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "assertions": [
            "Boundary outlines and labels are contextual; project markers remain the only quantitative layer.",
            "Boundary source and vintage are disclosed through the evidence affordance.",
            "Unavailable community-district context leaves project counts and markers unchanged.",
        ],
        "before": before,
        "before_scope": before_scope,
        "after": after,
        "scope_handoff": after_scope,
        "missing_context": missing,
    }
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {RECEIPT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
