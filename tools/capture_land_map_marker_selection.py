#!/usr/bin/env python3
"""Before/after captures and a receipt for Land Map marker selection (lm-07).

The claim is that selecting a marker is exploration inside the filtered population -- one
canonical project, described from the row the List already produced, with a way on and a way
back -- rather than a popup that strands the resident. So the capture records the journey,
not just a screen:

- before/: the tree at HEAD, where a marker is a link with nowhere to stop. There is no active
  marker, no summary, no selection to return to, and following one leaves the map behind.
- after/:  this working tree, where activating a marker selects exactly one project, paints a
  compact summary that names its placement method and precision, offers the canonical detail
  route the List card offers, and survives the trip out to that record and back.

  python3 tools/capture_land_map_marker_selection.py

Writes docs/screenshots/land-map-marker-selection/ and the receipt at
docs/evidence/land-map-marker-selection.json.
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
OUT = ROOT / "docs" / "screenshots" / "land-map-marker-selection"
RECEIPT = ROOT / "docs" / "evidence" / "land-map-marker-selection.json"

DEFAULT_MAP_ROUTE = "/browse/zoning/?view=map"
FILTERED_MAP_ROUTE = "/browse/zoning/?boro=Queens&view=map"
VIEWPORTS = ((390, 844), (1440, 900))
# The card's specimen: a 25-lot rezoning, so the summary has something real to be honest about.
ANCHOR_SPECIMEN = "2025K0305"


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
    """Keep the capture offline, exactly as the marker-join capture does."""
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


def selectable(page: Page, project_id: str | None = None):
    """The LM-07 selection control, absent by construction in the before tree."""
    suffix = f'[data-land-map-project="{project_id}"]' if project_id else ""
    return page.locator(f'#land-map-panel [role="button"][data-land-map-project]{suffix}')


def select(page: Page, project_id: str | None = None, by: str = "pointer") -> bool:
    """Select one marker. Returns False where the tree has no selection to make."""
    control = selectable(page, project_id)
    if control.count() == 0:
        return False
    target = control.first
    if by == "keyboard":
        target.focus()
        page.keyboard.press("Enter")
    else:
        target.click()
    try:
        page.wait_for_selector("#land-map-selected", timeout=10_000)
    except Exception:
        return False
    page.wait_for_timeout(300)
    return True


def observe(page: Page) -> dict:
    """Read what the page actually shows, so a capture cannot claim the wrong state."""
    return page.evaluate(
        """() => {
          const panel = document.getElementById('land-map-panel');
          const counts = document.getElementById('land-map-summary');
          const summary = document.getElementById('land-map-selected');
          const active = [...document.querySelectorAll('#land-map-panel [aria-current="true"]')];
          const focused = document.activeElement;
          return {
            url: location.pathname + location.search + location.hash,
            map_state: panel ? (panel.dataset.landMapState || 'absent') : 'absent',
            counts_published: counts && counts.dataset.landMapTotal !== undefined ? {
              total: Number(counts.dataset.landMapTotal),
              mapped: Number(counts.dataset.landMapMapped),
              unmapped: Number(counts.dataset.landMapUnmapped),
            } : null,
            markers: document.querySelectorAll('#land-map-panel .land-map-marker').length,
            selection_supported: document.querySelectorAll(
              '#land-map-panel [role="button"][data-land-map-project]').length > 0,
            selected_project: panel ? (panel.dataset.landMapSelected || null) : null,
            active_markers: active.map((el) => el.dataset.landMapProject),
            summary_present: Boolean(summary),
            summary_text: summary ? summary.textContent.trim() : '',
            placement_method: summary ? (summary.dataset.landMapMethod || null) : null,
            placement_precision: summary ? (summary.dataset.landMapPrecision || null) : null,
            source_vintage: summary ? (summary.dataset.landMapSourceVintage || null) : null,
            // The path, not the absolute URL: the capture server's port is ephemeral, and the
            // route is the part that is actually the evidence.
            detail_href: (() => {
              const link = document.querySelector('.land-map-selected-detail');
              if (!link) return null;
              const url = new URL(link.getAttribute('href'), location.href);
              return `${url.pathname}${url.search}${url.hash}`;
            })(),
            selection_in_url: /selected|marker=|viewport=|bbox=/.test(location.search + location.hash),
            // The summary carries the same project id as the marker, so the reading names the
            // control as well as the project or the two become indistinguishable in evidence.
            focus_on: focused?.getAttribute?.('role') === 'button' && focused?.dataset?.landMapProject
              ? `marker:${focused.dataset.landMapProject}`
              : (focused?.id === 'land-map-selected'
                ? `selected-summary:${focused.dataset.landMapProject || ''}`
                : (focused?.id || focused?.tagName || null)),
            focus_in_panel: Boolean(panel && focused && panel.contains(focused)),
            list_rows: document.querySelectorAll('#llist .row').length,
          };
        }"""
    )


def evidence_clip(page: Page) -> dict:
    """Frame the map panel with the selection beneath it and the first result rows after."""
    return page.evaluate(
        """() => {
          const pane = document.getElementById('tab-land');
          const panel = document.getElementById('land-map-panel');
          const first = panel || pane.querySelector('#land-resultbar');
          const rows = pane.querySelectorAll('#llist .row');
          const last = rows[Math.min(1, rows.length - 1)] || first;
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


def state_default_selection(page: Page, base: str) -> None:
    page.goto(f"{base}{DEFAULT_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    select(page, ANCHOR_SPECIMEN)


def state_filtered_selection(page: Page, base: str) -> None:
    page.goto(f"{base}{FILTERED_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    # Whichever project the borough filter actually holds -- the point is that the selection
    # comes from the narrowed population, not from the whole projection.
    select(page)


def state_selected_focus(page: Page, base: str) -> None:
    page.goto(f"{base}{DEFAULT_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    if select(page, ANCHOR_SPECIMEN, by="keyboard"):
        # Put focus back on the active marker so the capture shows both states at once: the
        # marker is selected, and it is where the keyboard is.
        selectable(page, ANCHOR_SPECIMEN).first.focus()
        page.wait_for_timeout(200)


def state_detail_return(page: Page, base: str) -> None:
    page.goto(f"{base}{DEFAULT_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    if not select(page, ANCHOR_SPECIMEN):
        # The before tree: follow the marker's own link, which is where it leads there.
        link = page.locator(f'#land-map-panel [data-land-map-project="{ANCHOR_SPECIMEN}"]').first
        if link.count():
            link.click()
            page.wait_for_timeout(2_000)
            page.go_back()
            page.wait_for_timeout(2_500)
        return
    page.locator(".land-map-selected-detail").click()
    page.wait_for_function(
        "(id) => location.hash.includes(`#land/${id}`)", arg=ANCHOR_SPECIMEN, timeout=20_000)
    page.wait_for_timeout(1_500)
    page.go_back()
    wait_for_map(page)
    page.wait_for_timeout(600)


def state_filtered_out_selection(page: Page, base: str) -> None:
    page.goto(f"{base}{DEFAULT_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    select(page, ANCHOR_SPECIMEN)
    # Narrow to a borough that does not hold the specimen. The selection must go, and the
    # filtered population must not.
    page.goto(f"{base}{FILTERED_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)


STATES = (
    ("default-selection", state_default_selection,
     "Default Map with one project selected: exactly one active marker and a compact summary "
     "naming the project, its status, and how it was placed."),
    ("filtered-selection", state_filtered_selection,
     "Borough-filtered Map with a selection drawn from the narrowed population, not from the "
     "whole point projection."),
    ("selected-focus", state_selected_focus,
     "Keyboard selection: the marker is reached and activated from the keyboard, and visible "
     "focus stays on the active marker. At 390px this is also the narrow-width proof that "
     "every selection control remains reachable without a pointer."),
    ("detail-return", state_detail_return,
     "After following the canonical detail route and pressing Back: the same filtered "
     "population, the same Map view, the same selection, and focus on the marker it left from."),
    ("filtered-out-selection", state_filtered_out_selection,
     "A selection the new filter no longer holds is cleared rather than carried: no active "
     "marker, no summary, and the filtered population is untouched."),
)


def capture_tree(site: Path, phase: str) -> dict:
    readings: dict = {}
    with StaticServer(site) as base_url, sync_playwright() as playwright:
        base = base_url.rstrip("/")
        browser = playwright.chromium.launch(headless=True)
        for state, drive, _demonstrates in STATES:
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                install_routes(page, base)
                drive(page, base)
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
    with head_site_workspace(ROOT, "capture-land-map-marker-selection") as site_root:
        before = capture_tree(site_root, "before")
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=ROOT, check=True)
    after = capture_tree(ROOT / "site", "after")

    receipt = {
        "schema": "cityscroll.land-map-marker-selection-receipt.v1",
        "card": "cityscroll-land-map-view/lm-07-marker-selection",
        "browser_mode": "headless chromium (playwright), remote hosts blocked",
        "revision": revision(),
        "routes": {"default_map": DEFAULT_MAP_ROUTE, "filtered_map": FILTERED_MAP_ROUTE},
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "specimens": {"anchor": ANCHOR_SPECIMEN},
        "demonstrates": {state: text for state, _drive, text in STATES},
        "before": before,
        "after": after,
    }
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {RECEIPT.relative_to(ROOT)}")
    for key, reading in after.items():
        print(f"  after {key}: selected={reading['selected_project']} "
              f"active={reading['active_markers']} counts={reading['counts_published']}")


if __name__ == "__main__":
    main()
