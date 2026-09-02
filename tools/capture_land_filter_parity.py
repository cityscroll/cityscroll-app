#!/usr/bin/env python3
"""Before/after captures and a receipt for Land filter parity (lm-08).

The claim is that List and Map are two renderings of one canonical query, for every filter and
combination -- so the capture records the pairs where that could quietly stop being true:

- before/: the tree at HEAD, where the pair already looks right for the common scopes but an
  empty Map reports "0 of 0 projects are on the map." beside a blank canvas, which reads as a
  map that failed rather than a filter that matched nothing.
- after/:  this working tree, where the same combined URL renders the same population in both
  views, an empty Map says so plainly, and an all-unmapped scope still points at the List.

  python3 tools/capture_land_filter_parity.py

Writes docs/screenshots/land-filter-parity/ and the receipt at
docs/evidence/land-filter-parity-capture.json. Every reading is measured from the page, so a
capture cannot claim a state the page was not in.
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
OUT = ROOT / "docs" / "screenshots" / "land-filter-parity"
RECEIPT = ROOT / "docs" / "evidence" / "land-filter-parity-capture.json"

VIEWPORTS = ((390, 844), (1440, 900))

# One combined canonical scope, shown in both renderings, plus the population shapes a
# count-only comparison would pass.
COMBINED = "status=all&stage=any&boro=Queens&family=rezoning"
UNMAPPED_ONLY = "status=all&stage=any&cd=K09"
ZERO_RESULT = "status=all&stage=any&q=zzzznotathing"
# The canonical query's limit is 40 and this scope fills it exactly, so the capture shows the
# boundary the population is actually held at.
LIMIT_BOUNDARY = "status=all&stage=any"
# The hearings scope paints through its own search. The route repaints the Map before that
# search returns, so before this card the Map kept rendering the previous filter's population.
HEARINGS = "status=all&future=hearing"

STATES = (
    ("combined-list", f"/browse/zoning/?{COMBINED}",
     "The combined canonical URL in List: borough and family together, one population."),
    ("combined-map", f"/browse/zoning/?{COMBINED}&view=map",
     "The same combined canonical URL in Map. Only `view` differs, so the population, its "
     "order, and the result count may not."),
    ("unmapped-only", f"/browse/zoning/?{UNMAPPED_ONLY}&view=map",
     "A scope whose only result has no published location: no marker, no invented coordinate, "
     "and the project is still a result the List holds."),
    ("zero-result", f"/browse/zoning/?{ZERO_RESULT}&view=map",
     "A scope nothing matches. The Map explains that no projects matched rather than reading "
     "as a map that could not load; the List keeps the way to widen the filter."),
    ("limit-boundary", f"/browse/zoning/?{LIMIT_BOUNDARY}&view=map",
     "The population held at the canonical query's limit of 40, with the mapped/unmapped "
     "partition and all three counts agreeing at the boundary."),
    ("hearings-scope", f"/browse/zoning/?{HEARINGS}&view=map",
     "The hearings scope, which paints through its own search. Before, the Map still showed the "
     "population the previous filter produced; after, it renders the distinct projects this "
     "search actually returned. A List row here is one hearing, so the Map's unit is the "
     "project and the panel says so."),
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
    """Keep the capture offline, exactly as the sibling Land captures do."""
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


def settle(page: Page, *, expect_map: bool) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.wait_for_function(
        "() => document.querySelectorAll('#llist .row').length > 0"
        " || !!document.querySelector('.land-empty-state')",
        timeout=45_000,
    )
    if expect_map:
        page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=45_000)
    page.wait_for_timeout(900)


def observe(page: Page) -> dict:
    """Read what the page actually shows, so a capture cannot claim the wrong state."""
    return page.evaluate(
        """() => {
          const panel = document.getElementById('land-map-panel');
          const summary = document.getElementById('land-map-summary');
          const markers = [...document.querySelectorAll(
            '#land-map-panel [data-land-map-project][role="button"]')]
            .map((m) => m.dataset.landMapProject);
          const listedRaw = [...document.querySelectorAll('#llist a[href*="#land/"]')]
            .map((a) => decodeURIComponent(a.getAttribute('href').split('#land/')[1] || ''))
            .filter(Boolean);
          // The Map's unit is the project. In the hearings scope a List row is one hearing and a
          // project can hold several, so the partition is compared against the distinct projects
          // the List painted rather than against its rows.
          const seen = new Set();
          const listIds = listedRaw.filter((id) => (seen.has(id) ? false : seen.add(id)));
          const markerSet = new Set(markers);
          const unmapped = listIds.filter((id) => !markerSet.has(id));
          return {
            // The path, not the absolute URL: the capture server's port is ephemeral and the
            // route is the part that is actually the evidence.
            url: location.pathname + location.search + location.hash,
            view: (document.getElementById('land-results-grid') || {}).dataset?.landView || null,
            map_state: panel ? (panel.dataset.landMapState || 'absent') : 'absent',
            map_failed: !!document.querySelector('.land-map-failed'),
            counts_published: summary && summary.dataset.landMapTotal !== undefined ? {
              total: Number(summary.dataset.landMapTotal),
              mapped: Number(summary.dataset.landMapMapped),
              unmapped: Number(summary.dataset.landMapUnmapped),
            } : null,
            summary_text: summary ? summary.textContent.trim() : '',
            unmapped_note: ((document.querySelector('.land-map-unmapped') || {}).textContent || '').trim(),
            marker_ids: markers,
            list_ids: listIds,
            list_link_count: listedRaw.length,
            distinct_project_count: listIds.length,
            derived_unmapped_ids: unmapped,
            list_rows: document.querySelectorAll('#llist .row').length,
            rows_are_projects: listedRaw.length === listIds.length,
            list_empty_state: !!document.querySelector('.land-empty-state'),
            result_count_text: ((document.getElementById('lrescount') || {}).textContent || '').trim(),
            filters: {
              status: (document.getElementById('lstatus') || {}).value,
              stage: (document.getElementById('lstage') || {}).value,
              future: (document.getElementById('lfuture') || {}).value,
              procedure: (document.getElementById('lprocedure') || {}).value,
              family: (document.getElementById('lfamily') || {}).value,
              regulatory_effect: (document.getElementById('leffect') || {}).value,
              keyword: (document.getElementById('lkw') || {}).value,
            },
            partition: {
              // The one that catches a Map answering a different question than the List: the
              // published total has to be the population the List actually painted.
              // null in List view, where there is no Map panel to agree or disagree.
              counts_match_population: summary
                ? Number(summary.dataset.landMapTotal) === listIds.length
                : null,
              markers_within_list: markers.every((id) => listIds.includes(id)),
              disjoint: markers.every((id) => !unmapped.includes(id)),
              union_equals_list:
                [...markers, ...unmapped].sort().join(',') === [...listIds].sort().join(','),
              order_follows_list:
                markers.join(',') === listIds.filter((id) => markerSet.has(id)).join(','),
            },
          };
        }"""
    )


def evidence_clip(page: Page) -> dict:
    """Frame the map panel, or the result bar in List, with the first result rows after it."""
    return page.evaluate(
        """() => {
          const pane = document.getElementById('tab-land');
          const panel = document.getElementById('land-map-panel');
          const first = panel || pane.querySelector('#land-resultbar');
          const rows = pane.querySelectorAll('#llist .row');
          const empty = pane.querySelector('.land-empty-state');
          const last = rows[Math.min(1, rows.length - 1)] || empty || first;
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
        base = base_url.rstrip("/")
        browser = playwright.chromium.launch(headless=True)
        for state, route, _demonstrates in STATES:
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                install_routes(page, base)
                page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=45_000)
                settle(page, expect_map="view=map" in route)
                reading = observe(page)
                OUT.mkdir(parents=True, exist_ok=True)
                shot = OUT / f"{phase}-{state}-{width}.png"
                page.screenshot(path=str(shot), animations="disabled", full_page=True,
                                clip=evidence_clip(page))
                reading["screenshot"] = str(shot.relative_to(ROOT))
                reading["viewport"] = [width, height]
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
        "after_changed_paths": sorted(line[3:] for line in status.stdout.splitlines() if line[3:]),
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
        "schema": "cityscroll.land-filter-parity-capture-receipt.v1",
        "card": "cityscroll-land-map-view/lm-08-filter-parity",
        "browser_mode": "headless chromium (playwright), remote hosts blocked",
        "population_note": (
            "The served page merges the warehouse ZAP lookup with the default snapshot, so these "
            "counts are larger than the pure fixture corpus in docs/evidence/land-filter-parity.json. "
            "The parity invariants are identical in both; only the population differs."
        ),
        "revision": revision(),
        "routes": {state: route for state, route, _text in STATES},
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "demonstrates": {state: text for state, _route, text in STATES},
        "before": before,
        "after": after,
    }
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {RECEIPT.relative_to(ROOT)}")
    for key, reading in after.items():
        checks = [value for value in reading["partition"].values() if value is not None]
        print(f"  after {key}: counts={reading['counts_published']} "
              f"markers={len(reading['marker_ids'])} rows={reading['list_rows']} "
              f"partition_ok={all(checks)}")


if __name__ == "__main__":
    main()
