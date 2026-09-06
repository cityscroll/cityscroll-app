#!/usr/bin/env python3
"""Before/after captures and a receipt for the Land Map marker join (lm-06).

The claim is that Map markers are a rendering of the filtered List rather than a second
database of places, so the capture records what a resident can actually see and follow:

- before/: the tree at HEAD, where browse Map already paints a dot per mapped project but a
  dot leads nowhere, says nothing about how it was placed, and the panel reports only how
  many projects are on the map.
- after/:  this working tree, where every marker is a link to the same project detail a List
  card opens, carries its placement method and precision, and the panel reports all three
  counts so the map cannot imply the List is complete when it is not.

  python3 tools/capture_land_map_marker_join.py

Writes docs/screenshots/land-map-marker-join/ and the receipt at
docs/evidence/land-map-marker-join.json.
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
OUT = ROOT / "docs" / "screenshots" / "land-map-marker-join"
RECEIPT = ROOT / "docs" / "evidence" / "land-map-marker-join.json"

# The card's own specimen scope. Default Map is where the 40/29/11 arithmetic is visible;
# the borough route is where "a subset of the filtered rows, never of the projection" is.
DEFAULT_MAP_ROUTE = "/browse/zoning/?view=map"
FILTERED_MAP_ROUTE = "/browse/zoning/?boro=Queens&view=map"
VIEWPORTS = ((390, 844), (1440, 900))
MAPPED_SPECIMEN = "2025K0305"
UNMAPPED_SPECIMEN = "2025M0252"

STATES = (
    ("default-map", DEFAULT_MAP_ROUTE,
     "Default Map: every mapped project is a link, and the panel reports mapped, unmapped, and total together."),
    ("filtered-map", FILTERED_MAP_ROUTE,
     "Borough-filtered Map: markers are a subset of the filtered rows, not of the 29-point projection."),
)


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
    """Keep the capture offline. `capabilities/` is served from the repository root rather
    than from `site/`; the remote analytics and open-data origins are not part of what this
    shows, so they are stubbed or aborted rather than reached."""
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
    """Read what the page actually shows, so a capture cannot claim the wrong state."""
    return page.evaluate(
        """(ids) => {
          const summary = document.getElementById('land-map-summary');
          const markers = [...document.querySelectorAll('#land-map-panel .land-map-marker')];
          const links = [...document.querySelectorAll('#land-map-panel .land-map-marker-control')];
          const byId = (id) => links.find((a) => a.dataset.landMapProject === id) || null;
          const specimen = byId(ids.mapped);
          return {
            url: `${location.pathname}${location.search}${location.hash}`,
            list_rows: document.querySelectorAll('#llist .row').length,
            result_count: (document.getElementById('lrescount')?.textContent || '').trim(),
            map_state: (document.getElementById('land-map-panel') || {}).dataset?.landMapState || 'absent',
            counts_published: summary && summary.dataset.landMapTotal !== undefined ? {
              total: Number(summary.dataset.landMapTotal),
              mapped: Number(summary.dataset.landMapMapped),
              unmapped: Number(summary.dataset.landMapUnmapped),
            } : null,
            summary_text: summary ? summary.textContent.trim() : '',
            unmapped_note: (document.querySelector('.land-map-unmapped')?.textContent || '').trim(),
            markers: markers.length,
            marker_links: links.length,
            methods_published: markers.filter((m) => m.dataset.landMapMethod).length,
            specimen_href: specimen ? (specimen.dataset.landMapHref || null) : null,
            specimen_label: specimen ? (specimen.getAttribute('aria-label') || '') : '',
            unmapped_drawn: markers.some((m) => m.dataset.landMapProject === ids.unmapped),
          };
        }""",
        {"mapped": MAPPED_SPECIMEN, "unmapped": UNMAPPED_SPECIMEN},
    )


def evidence_clip(page: Page) -> dict:
    """Frame the map panel and the first result rows beneath it. The detail panel is out of
    scope: this card is about the browse marker layer, not selection."""
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
        for state, route, _demonstrates in STATES:
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                install_routes(page, base_url)
                page.goto(f"{base_url.rstrip('/')}{route}", wait_until="domcontentloaded", timeout=45_000)
                wait_for_map(page)
                reading = observe(page)
                OUT.mkdir(parents=True, exist_ok=True)
                shot = OUT / f"{phase}-{state}-{width}.png"
                page.screenshot(path=str(shot), animations="disabled", full_page=True, clip=evidence_clip(page))
                reading["screenshot"] = str(shot.relative_to(ROOT))
                readings[f"{state}@{width}"] = reading
                page.close()
        browser.close()
    return readings


def revision() -> dict:
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True)
    status = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True)
    return {
        "before_commit": head.stdout.strip(),
        "after_tree": "working tree at the commit above plus this card's changes",
        "after_changed_paths": sorted(
            line[3:] for line in status.stdout.splitlines() if line[3:]
        ),
    }


def main() -> None:
    with head_site_workspace(ROOT, "capture-land-map-marker-join") as site_root:
        before = capture_tree(site_root, "before")
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=ROOT, check=True)
    after = capture_tree(ROOT / "site", "after")

    receipt = {
        "schema": "cityscroll.land-map-marker-join-receipt.v1",
        "card": "cityscroll-engineering/land-map-marker-join",
        "browser_mode": "headless chromium (playwright), remote hosts blocked",
        "revision": revision(),
        "routes": {"default_map": DEFAULT_MAP_ROUTE, "filtered_map": FILTERED_MAP_ROUTE},
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "specimens": {"mapped": MAPPED_SPECIMEN, "unmapped": UNMAPPED_SPECIMEN},
        "demonstrates": {state: text for state, _route, text in STATES},
        "before": before,
        "after": after,
    }
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {RECEIPT.relative_to(ROOT)}")
    for key, reading in after.items():
        print(f"  after {key}: {reading['counts_published']} markers={reading['markers']} links={reading['marker_links']}")


if __name__ == "__main__":
    main()
