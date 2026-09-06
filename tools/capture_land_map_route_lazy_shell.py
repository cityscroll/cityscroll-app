#!/usr/bin/env python3
"""Before/after captures and a network receipt for the route-lazy Land Map shell (lm-05).

The claim under test is a cost claim, so it is measured rather than asserted: what a resident
who only reads the List pays for, what Map activation adds on top, and what is left on screen
when the map cannot load at all.

- before/: the tree at HEAD (a detached worktree plus its own document build), where opening
  the Land tab warms Leaflet from unpkg before anyone asks for a map.
- after/:  this working tree, where List first paint touches no map dependency and the browse
  Map shell arrives only on activation, over the committed point projection.

  python3 tools/capture_land_map_route_lazy_shell.py

Writes docs/screenshots/land-map-route-lazy-shell/ and the measured receipt at
docs/evidence/land-map-route-lazy-shell.json.
"""

from __future__ import annotations

import functools
import hashlib
import json
import subprocess
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright

from lib.temp_workspace import head_site_workspace

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "land-map-route-lazy-shell"
RECEIPT = ROOT / "docs" / "evidence" / "land-map-route-lazy-shell.json"
# The LM-04 specimen scope. List is the default, so the List address carries no `view`.
LIST_ROUTE = "/browse/zoning/?boro=Queens&stage=public_review"
MAP_ROUTE = "/browse/zoning/?boro=Queens&stage=public_review&view=map"
PROJECTION = "data/land_project_map_points.json"
VIEWPORTS = ((390, 844), (1440, 900))
# Every map-shaped request, recorded so the ordering record stays complete.
MAP_DEPENDENCY_MARKERS = ("leaflet", "cartocdn", "land_project_map_points", "map_runtime")
# The subset A1 is actually about: the assets List must never wait on. `map_runtime.mjs` is
# deliberately not here. It is a 19KB same-origin module with no assets of its own, and the
# List auto-selects its first row, so the selected project's detail map can start fetching it
# in the same frame the rows paint. That is the unchanged detail map, not a browse dependency.
BLOCKING_MAP_DEPENDENCIES = ("leaflet", "cartocdn", "land_project_map_points")


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


def install_routes(page: Page, base_url: str, *, block_projection: bool = False) -> None:
    """Keep the capture offline. The Land browse route is already precompute-first.

    Leaflet's own origin is deliberately reachable-shaped: it is aborted like every other
    remote host, but the request itself is still recorded, which is exactly how the before
    tree's Land-entry warm-up shows up in the receipt.
    """
    def empty_json(route: Route) -> None:
        route.fulfill(status=200, content_type="application/json", body=json.dumps([]))

    def capability_module(route: Route) -> None:
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    page.route(f"{base_url.rstrip('/')}/capabilities/*", capability_module)
    if block_projection:
        page.route(f"**/{PROJECTION}", lambda route: route.abort("failed"))
    page.route("https://data.cityofnewyork.us/**", empty_json)
    page.route("https://geosearch.planninglabs.nyc/**", empty_json)
    page.route(
        "https://api.cityscroll.org/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="{}"),
    )
    page.route(
        "https://cityscroll-worker.crol-worker.workers.dev/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="{}"),
    )
    page.route("https://**", lambda route: route.abort())


def record_requests(page: Page) -> list[dict]:
    """Every request the page issues, in order, with the size the browser actually moved."""
    log: list[dict] = []  # accumulator (not a measured table)

    def on_request(request) -> None:
        log.append({"url": request.url, "resource_type": request.resource_type, "bytes": 0})

    def on_response(response) -> None:
        for entry in log:
            if entry["url"] == response.url and entry["bytes"] == 0:
                try:
                    entry["bytes"] = len(response.body())
                except Exception:  # aborted, opaque, or already-consumed responses
                    entry["bytes"] = 0
                entry["status"] = response.status
                return

    page.on("request", on_request)
    page.on("response", on_response)
    return log


def strip_origin(entries: list[dict], base_url: str) -> list[dict]:
    prefix = base_url.rstrip("/")
    return [
        {
            "url": entry["url"].replace(prefix, "") or "/",
            "resource_type": entry["resource_type"],
            "bytes": entry["bytes"],
        }
        for entry in entries
    ]


def observe(page: Page) -> dict:
    """Read what the page actually shows, so a capture cannot claim the wrong state."""
    return page.evaluate(
        """() => {
          const chips = [...document.querySelectorAll('#land-view-switch [data-land-view]')];
          const note = document.getElementById('land-view-note');
          const panel = document.getElementById('land-map-panel');
          const params = new URLSearchParams((location.hash.split('?')[1]) || location.search);
          return {
            url: `${location.pathname}${location.search}${location.hash}`,
            semantic: [...params.entries()].filter(([key]) => key !== 'view')
              .map(([key, value]) => `${key}=${value}`).sort(),
            view: params.get('view'),
            controls: chips.map((chip) => ({
              view: chip.dataset.landView,
              pressed: chip.getAttribute('aria-pressed') === 'true',
            })),
            note: note && !note.hidden ? note.textContent.trim() : '',
            rows: document.querySelectorAll('#llist .row').length,
            count: (document.getElementById('lrescount') || {}).textContent || '',
            map_state: panel ? (panel.dataset.landMapState || '') : 'absent',
            map_markers: document.querySelectorAll('#land-map-panel .land-map-marker').length,
            map_summary: (document.getElementById('land-map-summary') || {}).textContent || '',
            map_retry: !!document.querySelector('[data-land-map-retry]'),
            list_visible: !!document.querySelector('#llist .row'),
          };
        }"""
    )


def evidence_clip(page: Page) -> dict:
    """Frame the presentation evidence: the result bar, the List/Map control, the map panel
    when one is mounted, and the first result rows. The detail panel is out of scope."""
    return page.evaluate(
        """() => {
          const pane = document.getElementById('tab-land');
          const first = pane.querySelector('.lens-search-state') || pane.querySelector('#land-resultbar');
          const rows = pane.querySelectorAll('#llist .row');
          const last = rows[Math.min(2, rows.length - 1)] || first;
          const top = first ? first.getBoundingClientRect().top + scrollY : 0;
          const bottom = last ? last.getBoundingClientRect().bottom + scrollY : top + 600;
          return {
            x: 0,
            y: Math.max(0, top - 8),
            width: document.documentElement.clientWidth,
            height: Math.min(1600, Math.max(240, bottom - top + 24)),
          };
        }"""
    )


# Mark first paint in the page's own clock, so "before first paint" is an ordering fact rather
# than a stopwatch race between the harness and the browser.
FIRST_PAINT_PROBE = """
window.__landFirstRowAt = null;
const observer = new MutationObserver(() => {
  if (window.__landFirstRowAt === null && document.querySelector('#llist .row')) {
    window.__landFirstRowAt = performance.now();
    observer.disconnect();
  }
});
// The init script runs before the parser creates <html>, so observe the document node itself.
observer.observe(document, { childList: true, subtree: true });
"""


def wait_for_land(page: Page) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=45000)


def first_paint_ordering(page: Page) -> dict:
    """Which map dependencies the browser had started before the first result row existed."""
    return page.evaluate(
        """(markers) => {
          const at = window.__landFirstRowAt;
          const before = performance.getEntriesByType('resource')
            .filter((entry) => at !== null && entry.startTime <= at)
            .map((entry) => entry.name);
          return {
            first_row_at_ms: at === null ? null : Math.round(at),
            resources_before_first_row: before.length,
            map_dependencies_before_first_row: before.filter(
              (name) => markers.all.some((marker) => name.includes(marker)),
            ),
            blocking_map_dependencies_before_first_row: before.filter(
              (name) => markers.blocking.some((marker) => name.includes(marker)),
            ),
          };
        }""",
        {"all": list(MAP_DEPENDENCY_MARKERS), "blocking": list(BLOCKING_MAP_DEPENDENCIES)},
    )


def shoot(page: Page, path: Path, viewport: tuple[int, int], state: dict) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path), animations="disabled", full_page=True, clip=evidence_clip(page))
    data = path.read_bytes()
    print("wrote", path)
    return {
        "name": str(path.relative_to(OUT)),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "viewport": list(viewport),
        "observed": state,
    }


def measure(context, base_url: str, cache_state: str) -> dict:
    """One List-then-Map run: what List costs, then what activation adds on top of it."""
    page = context.new_page()
    page.add_init_script(FIRST_PAINT_PROBE)
    install_routes(page, base_url)
    log = record_requests(page)
    started = time.perf_counter()
    page.goto(f"{base_url.rstrip('/')}{LIST_ROUTE}", wait_until="domcontentloaded")
    wait_for_land(page)
    list_first_paint_ms = round((time.perf_counter() - started) * 1000, 1)
    # The A1 window: everything the browser asked for up to the first painted result row.
    list_requests = strip_origin(list(log), base_url)
    ordering = first_paint_ordering(page)
    # The List auto-selects its first row, which opens that project's detail map. That is
    # existing detail-map behavior this card preserves, not a browse dependency, so it is
    # measured as its own phase instead of being folded into List first paint.
    page.wait_for_timeout(1500)
    detail_requests = strip_origin(log[len(list_requests):], base_url)
    list_state = observe(page)

    activation_started = time.perf_counter()
    page.locator('#land-view-switch [data-land-view="map"]').click()
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30000)
    map_activation_ms = round((time.perf_counter() - activation_started) * 1000, 1)
    page.wait_for_timeout(400)
    activation_requests = strip_origin(log[len(list_requests) + len(detail_requests):], base_url)
    map_state = observe(page)
    page.close()

    return {
        "cache_state": cache_state,
        "route": LIST_ROUTE,
        "list_first_paint_ms": list_first_paint_ms,
        "list_requests": list_requests,
        "list_bytes": sum(entry["bytes"] for entry in list_requests),
        "list_first_paint_ordering": ordering,
        "post_paint_detail_map": {
            "cause": "the List auto-selects its first row; the selected project's detail map is "
                     "existing behavior this card preserves rather than a browse dependency",
            "requests": [
                entry["url"] for entry in detail_requests
                if any(marker in entry["url"] for marker in MAP_DEPENDENCY_MARKERS)
            ],
            "bytes": sum(
                entry["bytes"] for entry in detail_requests
                if any(marker in entry["url"] for marker in MAP_DEPENDENCY_MARKERS)
            ),
        },
        "list_observed": list_state,
        "map_activation_ms": map_activation_ms,
        "map_activation_requests": activation_requests,
        "map_activation_bytes": sum(entry["bytes"] for entry in activation_requests),
        "map_observed": map_state,
    }


def measure_head_entry(base_url: str, playwright) -> dict:
    """The before tree, for the one comparison this card actually claims: whether opening the
    Land tab -- with no Map request at all -- reaches for a map dependency."""
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.add_init_script(FIRST_PAINT_PROBE)
    install_routes(page, base_url)
    log = record_requests(page)
    page.goto(f"{base_url.rstrip('/')}{LIST_ROUTE}", wait_until="domcontentloaded")
    wait_for_land(page)
    first_paint = strip_origin(list(log), base_url)
    ordering = first_paint_ordering(page)
    page.wait_for_timeout(1500)
    entries = strip_origin(list(log), base_url)
    page.close()
    browser.close()
    return {
        "route": LIST_ROUTE,
        "requests": len(entries),
        "first_paint_requests": len(first_paint),
        "first_paint_ordering": ordering,
        "map_dependency_requests": [
            entry["url"] for entry in entries
            if any(marker in entry["url"] for marker in MAP_DEPENDENCY_MARKERS)
        ],
    }


def capture_failure(base_url: str, playwright) -> tuple[list[dict], dict]:
    """Block the projection on the Map route and record what the resident is left with."""
    browser = playwright.chromium.launch(headless=True)
    files: list[dict] = []  # accumulator (not a measured table)
    before = None
    after = None
    for width, height in VIEWPORTS:
        page = browser.new_page(viewport={"width": width, "height": height})
        install_routes(page, base_url, block_projection=True)
        page.goto(f"{base_url.rstrip('/')}{LIST_ROUTE}", wait_until="domcontentloaded")
        wait_for_land(page)
        before = observe(page)
        page.locator('#land-view-switch [data-land-view="map"]').click()
        page.wait_for_selector('#land-map-panel[data-land-map-state="failed"]', timeout=30000)
        page.wait_for_timeout(400)
        after = observe(page)
        print(f"blocked-map {width}px:", json.dumps(after, ensure_ascii=False))
        files.append(shoot(page, OUT / "after" / f"land-map-blocked-{width}.png", (width, height), after))
        page.close()
    browser.close()
    return files, {
        "blocked_request": PROJECTION,
        "list_rows_before_failure": before["rows"],
        "list_rows_after_failure": after["rows"],
        "list_count_after_failure": after["count"],
        "semantic_filters_after_failure": after["semantic"],
        "retry_control_present": after["map_retry"],
        "list_control_pressed": next(
            (chip["pressed"] for chip in after["controls"] if chip["view"] == "list"), None
        ),
        "fallback_note": after["note"],
    }


def capture_states(base_url: str, playwright) -> list[dict]:
    """List first paint and explicit Map activation, at both viewports."""
    browser = playwright.chromium.launch(headless=True)
    files: list[dict] = []  # accumulator (not a measured table)
    for width, height in VIEWPORTS:
        page = browser.new_page(viewport={"width": width, "height": height})
        install_routes(page, base_url)
        page.goto(f"{base_url.rstrip('/')}{LIST_ROUTE}", wait_until="domcontentloaded")
        wait_for_land(page)
        files.append(shoot(page, OUT / "after" / f"land-list-{width}.png", (width, height), observe(page)))
        page.locator('#land-view-switch [data-land-view="map"]').click()
        page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30000)
        page.wait_for_timeout(400)
        files.append(shoot(page, OUT / "after" / f"land-map-{width}.png", (width, height), observe(page)))
        page.close()
    browser.close()
    return files


def capture_before(site_dir: Path) -> list[dict]:
    files: list[dict] = []  # accumulator (not a measured table)
    with StaticServer(site_dir) as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page, base_url)
            page.goto(f"{base_url.rstrip('/')}{LIST_ROUTE}", wait_until="domcontentloaded")
            wait_for_land(page)
            files.append(shoot(page, OUT / "before" / f"land-list-{width}.png", (width, height), observe(page)))
            page.close()
        head_entry = measure_head_entry(base_url, playwright)
        browser.close()
    for entry in files:
        entry["head_entry"] = head_entry
    return files


def module_sizes() -> dict:
    """The gate this card had to clear before any activation logic could be written."""
    def size(path: str) -> int:
        return len((ROOT / path).read_bytes())

    head = subprocess.run(
        ["git", "show", "HEAD:site/app/land.mjs"], cwd=ROOT, check=True, capture_output=True
    ).stdout
    return {
        "limit_bytes": 100000,
        "limit_source": "docs/evidence/index-module-split.json#after.working_bar_bytes",
        "command": "node --test test/site_module_architecture.test.mjs",
        "before": {"site/app/land.mjs": len(head)},
        "after": {
            "site/app/land.mjs": size("site/app/land.mjs"),
            "site/app/map_runtime.mjs": size("site/app/map_runtime.mjs"),
        },
    }


def snapshot_vintage() -> dict:
    receipt = json.loads((ROOT / "site/data/land_project_map_points_receipt.json").read_text("utf-8"))
    return {
        "projection_schema": json.loads(
            (ROOT / "site/data/land_project_map_points.json").read_text("utf-8")
        )["schema"],
        "resolver_version": receipt["resolver_version"],
        "join_version": receipt["join_version"],
        "inputs": {
            name: {"path": value["path"], "count": value["count"], "sha256": value["sha256"]}
            for name, value in receipt["inputs"].items()
            if isinstance(value, dict) and "sha256" in value
        },
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with head_site_workspace(ROOT, "capture-land-map-route-lazy-shell") as site_root:
        files = capture_before(site_root)

    with StaticServer(ROOT / "site") as base_url, sync_playwright() as playwright:
        files += capture_states(base_url, playwright)
        failure_files, failure = capture_failure(base_url, playwright)
        files += failure_files
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        cold = measure(context, base_url, "cold")
        warm = measure(context, base_url, "warm")
        context.close()
        browser.close()

    head_entry = files[0]["head_entry"]
    receipt = {
        "schema": "cityscroll.land-map-route-lazy-shell-receipt.v1",
        "card": "cityscroll-engineering/land-map-route-lazy-shell",
        "browser_mode": "headless chromium (playwright), offline: every remote host aborted",
        "routes": {"list": LIST_ROUTE, "map": MAP_ROUTE},
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "before_source": "git worktree at HEAD + node tools/build_primary_documents.mjs",
        "after_source": "working tree site/",
        "before_land_entry": head_entry,
        "module_size_gate": module_sizes(),
        "dependency_identity": {
            "projection": PROJECTION,
            "substrate": "site/map_exploration.mjs (local SVG projection, no SDK, no tile provider)",
            "model": "site/land_map_model.mjs (LM-03 filtered result model)",
            "detail_map_unchanged": ["unpkg.com/leaflet@1.9.4", "basemaps.cartocdn.com"],
            "snapshot_vintage": snapshot_vintage(),
        },
        "measurements": {"cold": cold, "warm": warm},
        "failure_behavior": failure,
        "files": files,
    }
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print("wrote", RECEIPT)
    (OUT / "manifest.json").write_text(
        json.dumps(
            {
                "schema": "cityscroll.capture_receipt.v1",
                "capture": "land-map-route-lazy-shell",
                "routes": {"list": LIST_ROUTE, "map": MAP_ROUTE},
                "viewports": [list(viewport) for viewport in VIEWPORTS],
                "before_source": "git worktree at HEAD + node tools/build_primary_documents.mjs",
                "after_source": "working tree site/",
                "files": files,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print("wrote", OUT / "manifest.json")


if __name__ == "__main__":
    main()
