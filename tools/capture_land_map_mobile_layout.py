#!/usr/bin/env python3
"""Before/after captures and a receipt for Land Map narrow-screen usability (lm-10).

The claim is that a phone resident keeps the same canonical Map/List model LM-05 through
LM-09 already built -- the same switch, the same total/mapped/unmapped counts, the same
selection contract -- and gains an orientation strip that reads before the canvas and an
unconditional List exit, so nothing about the population or the way out depends on
scrolling past the map first:

- before/: the tree at HEAD. The switch and selection already work (LM-07/LM-09), but the
  population summary and unmapped count sit after the canvas, and the only List exit is the
  top switch -- nothing inside the Map panel itself names a way back.
- after/:  this working tree. An orientation strip -- counts, unmappedness, and a real,
  shareable List link -- reads first, at every width, and touch selection still reveals
  identity, method, precision, and canonical detail access without a hover.

  python3 tools/capture_land_map_mobile_layout.py

Writes docs/screenshots/land-map-mobile-layout/ and the receipt at
docs/evidence/land-map-mobile-layout.json.
"""

from __future__ import annotations

import functools
import json
import subprocess
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "land-map-mobile-layout"
RECEIPT = ROOT / "docs" / "evidence" / "land-map-mobile-layout.json"

DEFAULT_MAP_ROUTE = "/browse/zoning/?view=map"
# The registered fixtures (320, 375, 768) plus the mandated stable evidence pair (390, 1440).
VIEWPORTS = ((320, 568), (375, 667), (390, 844), (768, 1024), (1440, 900))
# A 25-lot rezoning: on the map, and emphatically not at an address (LM-07's anchor).
ANCHOR_SPECIMEN = "2025K0305"
# A project with no published point at all -- reachable only through the List.
UNMAPPED_SPECIMEN = "2026K0123"


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


def head_site(destination: Path) -> Path:
    """Build the pre-change tree offline, with no checkout switch in this working copy."""
    tree = destination / "head"
    subprocess.run(["git", "worktree", "add", "--detach", str(tree), "HEAD"], cwd=ROOT, check=True)
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=tree, check=True)
    return tree / "site"


def release_head_site(destination: Path) -> None:
    subprocess.run(["git", "worktree", "remove", "--force", str(destination / "head")], cwd=ROOT, check=False)
    subprocess.run(["git", "worktree", "prune"], cwd=ROOT, check=False)


def install_routes(page: Page, base_url: str) -> None:
    """Keep the capture offline, exactly as the marker-selection capture does."""
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
    page.wait_for_timeout(500)


def tap_marker(page: Page, project_id: str) -> bool:
    """Select one marker by touch. Never a hover: this is the A2 proof."""
    control = page.locator(f'#land-map-panel [role="button"][data-land-map-project="{project_id}"]')
    if control.count() == 0:
        return False
    control.first.tap()
    try:
        page.wait_for_selector("#land-map-selected", timeout=10_000)
    except Exception:
        return False
    page.wait_for_timeout(300)
    return True


def observe(page: Page) -> dict:
    """Read what the page actually shows, so a capture cannot claim the wrong state."""
    return page.evaluate(
        """(unmappedId) => {
          const doc = document.documentElement;
          const summary = document.getElementById('land-map-summary');
          const selected = document.getElementById('land-map-selected');
          const listLink = document.querySelector('.land-map-list-link');
          const switchChips = [...document.querySelectorAll('#land-view-switch [data-land-view]')];
          const inViewport = (el) => {
            if (!el) return false;
            const box = el.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && box.right <= window.innerWidth + 1;
          };
          return {
            url: location.pathname + location.search + location.hash,
            overflow: doc.scrollWidth - doc.clientWidth,
            view: document.getElementById('land-results-grid')?.dataset.landView || null,
            switch_state: switchChips.map((el) => ({
              view: el.dataset.landView, pressed: el.getAttribute('aria-pressed'),
            })),
            counts_published: summary && summary.dataset.landMapTotal !== undefined ? {
              total: Number(summary.dataset.landMapTotal),
              mapped: Number(summary.dataset.landMapMapped),
              unmapped: Number(summary.dataset.landMapUnmapped),
            } : null,
            counts_reachable: inViewport(summary),
            list_link_present: Boolean(listLink),
            list_link_reachable: inViewport(listLink),
            list_link_href: listLink ? listLink.getAttribute('href') : null,
            map_mounted: Boolean(document.getElementById('land-map-panel')),
            selected_project: selected ? selected.dataset.landMapProject : null,
            selected_method: selected ? (selected.dataset.landMapMethod || null) : null,
            selected_precision: selected ? (selected.dataset.landMapPrecision || null) : null,
            selected_reachable: inViewport(selected),
            detail_href: (() => {
              const link = document.querySelector('.land-map-selected-detail');
              if (!link) return null;
              const url = new URL(link.getAttribute('href'), location.href);
              return `${url.pathname}${url.search}${url.hash}`;
            })(),
            focus_on: document.activeElement?.id === 'land-map-selected'
              ? 'selected-summary'
              : (document.activeElement?.id || document.activeElement?.tagName || null),
            list_rows: document.querySelectorAll('#llist .row').length,
            unmapped_specimen_in_list: Boolean(
              [...document.querySelectorAll('#llist .row')].find((row) => row.outerHTML.includes(unmappedId))
            ),
          };
        }""",
        UNMAPPED_SPECIMEN,
    )


def evidence_clip(page: Page) -> dict:
    """Frame the resultbar and the whole Map panel, so the orientation strip is in frame."""
    return page.evaluate(
        """() => {
          const pane = document.getElementById('tab-land');
          const bar = pane.querySelector('#land-resultbar');
          const panel = document.getElementById('land-map-panel') || bar;
          const top = bar ? bar.getBoundingClientRect().top + scrollY : 0;
          const bottom = panel ? panel.getBoundingClientRect().bottom + scrollY : top + 700;
          return {
            x: 0,
            y: Math.max(0, top - 8),
            width: document.documentElement.clientWidth,
            height: Math.min(2200, Math.max(280, bottom - top + 24)),
          };
        }"""
    )


def state_orientation(page: Page, base: str) -> None:
    page.goto(f"{base}{DEFAULT_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)


def state_touch_selected(page: Page, base: str) -> None:
    page.goto(f"{base}{DEFAULT_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    tap_marker(page, ANCHOR_SPECIMEN)


def state_list_handoff(page: Page, base: str) -> None:
    page.goto(f"{base}{DEFAULT_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    tap_marker(page, ANCHOR_SPECIMEN)
    # The unconditional exit this card adds; the before tree has none, so it falls back to
    # the one List access every tree has always had -- the top switch -- for a fair before/after.
    generic = page.locator(".land-map-list-link")
    if generic.count():
        generic.first.tap()
    else:
        page.locator('#land-view-switch [data-land-view="list"]').tap()
    page.wait_for_function(
        "() => document.getElementById('land-results-grid')?.dataset.landView === 'list'",
        timeout=15_000,
    )
    page.wait_for_timeout(300)


STATES = (
    ("orientation", state_orientation,
     "Default Map, nothing selected yet: the switch, the total/mapped/unmapped counts, and a "
     "List exit all read before the canvas, at every width, without horizontal overflow."),
    ("touch-selected", state_touch_selected,
     "A touch tap -- never a hover -- selects the anchor specimen and reveals its identity, "
     "placement method, precision, and canonical detail link, still without overflow."),
    ("list-handoff", state_list_handoff,
     "The List exit switches presentation without losing a row: the unmapped specimen, which "
     "never had a marker, is still in the List's own denominator afterward."),
)


def capture_tree(site: Path, phase: str) -> dict:
    readings: dict = {}
    with StaticServer(site) as base_url, sync_playwright() as playwright:
        base = base_url.rstrip("/")
        browser = playwright.chromium.launch(headless=True)
        for state, drive, _demonstrates in STATES:
            for width, height in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height}, has_touch=True)
                page = context.new_page()
                install_routes(page, base)
                drive(page, base)
                reading = observe(page)
                OUT.mkdir(parents=True, exist_ok=True)
                shot = OUT / f"{phase}-{state}-{width}.png"
                page.screenshot(path=str(shot), animations="disabled", full_page=True, clip=evidence_clip(page))
                reading["screenshot"] = str(shot.relative_to(ROOT))
                readings[f"{state}@{width}"] = reading
                context.close()
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
    with tempfile.TemporaryDirectory() as workspace:
        destination = Path(workspace)
        try:
            before = capture_tree(head_site(destination), "before")
        finally:
            release_head_site(destination)
        subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=ROOT, check=True)
        after = capture_tree(ROOT / "site", "after")

    receipt = {
        "schema": "cityscroll.land-map-mobile-layout-receipt.v1",
        "card": "cityscroll-land-map-view/lm-10-mobile-map-list",
        "browser_mode": "headless chromium (playwright) with touch emulation, remote hosts blocked",
        "revision": revision(),
        "routes": {"default_map": DEFAULT_MAP_ROUTE},
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "specimens": {"anchor": ANCHOR_SPECIMEN, "unmapped": UNMAPPED_SPECIMEN},
        "demonstrates": {state: text for state, _drive, text in STATES},
        "before": before,
        "after": after,
    }
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {RECEIPT.relative_to(ROOT)}")
    for key, reading in after.items():
        print(
            f"  after {key}: overflow={reading['overflow']} counts={reading['counts_published']} "
            f"list_link={reading['list_link_present']}"
        )


if __name__ == "__main__":
    main()
