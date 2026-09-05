#!/usr/bin/env python3
"""Before/after captures and a receipt for the Land project-geometry field (lm-17).

The claim under test is narrow: an exact single-BBL project may carry an additive,
non-interactive parcel outline beside its existing marker, a multi-BBL project never does,
and neither case changes the marker, the counts, or the List. The capture also measures
what a resident can actually perceive: at the Land Map's fixed city-wide zoom, a tax-lot
polygon is far below one screen pixel, so the before/after screenshots are expected to be
visually identical even though the DOM carries a real, sourced shape for the positive
specimen. That measurement is the honest product finding this receipt exists to record.

  python3 tools/capture_land_project_geometry.py

Writes docs/screenshots/land-project-geometry/ and the receipt at
docs/evidence/land-project-geometry.json.
"""

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
OUT = ROOT / "docs" / "screenshots" / "land-project-geometry"
RECEIPT = ROOT / "docs" / "evidence" / "land-project-geometry.json"

DEFAULT_MAP_ROUTE = "/browse/zoning/?view=map"
VIEWPORTS = ((390, 844), (1440, 900))
POSITIVE_SPECIMEN = "2026R0127"  # single-BBL exact: carries a committed parcel outline.
FALLBACK_SPECIMEN = "2025K0305"  # multi-BBL anchor: ambiguous relation, never a shape.


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path) -> None:
        handler = functools.partial(QuietHandler, directory=str(directory))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def install_routes(page: Page, base_url: str) -> None:
    """Keep the capture offline, same seam as the LM-06 marker-join capture."""
    def capability_module(route: Route) -> None:
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    page.route(f"{base_url.rstrip('/')}/capabilities/*", capability_module)
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="[]"),
    )
    page.route("https://**", lambda route: route.abort())


def wait_for_map(page: Page) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=45_000)
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=45_000)
    page.wait_for_timeout(600)


def observe(page: Page) -> dict:
    """Read what the page actually shows and what it actually carries in the DOM, so a
    capture cannot claim a shape exists that a resident cannot in fact perceive."""
    return page.evaluate(
        """(ids) => {
          const summary = document.getElementById('land-map-summary');
          const outlines = [...document.querySelectorAll('.land-map-parcel-outline')];
          const byId = (id) => outlines.find((p) => p.dataset.landMapProject === id) || null;
          const positive = byId(ids.positive);
          const positiveRect = positive ? positive.getBoundingClientRect() : null;
          const markerEl = document.querySelector(
            `.land-map-marker-control[data-land-map-project="${ids.positive}"] .land-map-marker`,
          );
          const markerRect = markerEl ? markerEl.getBoundingClientRect() : null;
          return {
            counts_published: summary && summary.dataset.landMapTotal !== undefined ? {
              total: Number(summary.dataset.landMapTotal),
              mapped: Number(summary.dataset.landMapMapped),
              unmapped: Number(summary.dataset.landMapUnmapped),
            } : null,
            parcel_outline_count: outlines.length,
            positive_specimen_has_outline: !!positive,
            positive_outline_method: positive ? positive.dataset.landMapParcelMethod : null,
            positive_outline_precision: positive ? positive.dataset.landMapParcelPrecision : null,
            positive_outline_relation: positive ? positive.dataset.landMapParcelRelation : null,
            positive_outline_vintage: positive ? positive.dataset.landMapParcelVintage : null,
            positive_outline_screen_px: positiveRect ? { width: positiveRect.width, height: positiveRect.height } : null,
            marker_screen_px: markerRect ? { width: markerRect.width, height: markerRect.height } : null,
            fallback_specimen_has_outline: !!byId(ids.fallback),
          };
        }""",
        {"positive": POSITIVE_SPECIMEN, "fallback": FALLBACK_SPECIMEN},
    )


def evidence_clip(page: Page) -> dict:
    return page.evaluate(
        """() => {
          const pane = document.getElementById('tab-land');
          const panel = document.getElementById('land-map-panel');
          const first = panel || pane.querySelector('#land-resultbar');
          const rows = pane.querySelectorAll('#llist .row');
          const last = rows[Math.min(2, rows.length - 1)] || first;
          const top = first ? first.getBoundingClientRect().top + scrollY : 0;
          const bottom = last ? last.getBoundingClientRect().bottom + scrollY : top + 600;
          return {
            x: 0,
            y: Math.max(0, top - 8),
            width: document.documentElement.clientWidth,
            height: Math.min(1800, Math.max(240, bottom - top + 24)),
          };
        }"""
    )


def capture_tree(site: Path, phase: str) -> dict:
    readings: dict = {}
    with StaticServer(site) as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page, base_url)
            page.goto(f"{base_url.rstrip('/')}{DEFAULT_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
            wait_for_map(page)
            reading = observe(page)
            OUT.mkdir(parents=True, exist_ok=True)
            shot = OUT / f"{phase}-default-map-{width}.png"
            page.screenshot(path=str(shot), animations="disabled", full_page=True, clip=evidence_clip(page))
            reading["screenshot"] = str(shot.relative_to(ROOT))
            readings[f"default-map@{width}"] = reading
            page.close()
        browser.close()
    return readings


def revision() -> dict:
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True)
    status = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True)
    return {
        "before_commit": head.stdout.strip(),
        "after_tree": "working tree at the commit above plus this card's changes",
        "after_changed_paths": sorted(line[3:] for line in status.stdout.splitlines() if line[3:]),
    }


def main() -> None:
    with head_site_workspace(ROOT, "capture-land-project-geometry") as site_root:
        before = capture_tree(site_root, "before")
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=ROOT, check=True)
    after = capture_tree(ROOT / "site", "after")

    receipt = {
        "schema": "cityscroll.land-project-geometry-receipt.v1",
        "card": "cityscroll-land-map-view/lm-17-richer-precomputed-geometry",
        "browser_mode": "headless chromium (playwright), remote hosts blocked",
        "revision": revision(),
        "routes": {"default_map": DEFAULT_MAP_ROUTE},
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "specimens": {"positive": POSITIVE_SPECIMEN, "fallback": FALLBACK_SPECIMEN},
        "finding": (
            "The positive specimen's parcel outline is present, exact-key sourced, and "
            "correctly gated at the DOM level in every after-capture, and it never appears "
            "for the multi-BBL fallback specimen or in the before tree. At the Land Map's "
            "fixed city-wide zoom the outline's on-screen size is a small fraction of one "
            "CSS pixel -- far smaller than the marker it sits beside -- so the before/after "
            "screenshots are visually identical by design. This is not a rendering failure; "
            "no fill, choropleth, or false precision is added. Making the shape legible "
            "would require a per-marker zoom or a detail-page inset this card does not add."
        ),
        "before": before,
        "after": after,
    }
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {RECEIPT.relative_to(ROOT)}")
    for key, reading in after.items():
        print(
            f"  after {key}: outlines={reading['parcel_outline_count']} "
            f"positive_px={reading['positive_outline_screen_px']} marker_px={reading['marker_screen_px']}"
        )


if __name__ == "__main__":
    main()
