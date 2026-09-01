#!/usr/bin/env python3
"""Before/after captures for additive Land List/Map presentation state (lm-04).

Both captures load the same semantic Land scope --
``#land?boro=Queens&stage=public_review&view=map`` -- at 390px and 1440px.

- before/: the tree at the merge base (``git archive HEAD site``), where ``view`` is not a
  known Land parameter, so the route drops it and paints List with no presentation control.
- after/:  this working tree, where the same link keeps every filter, offers a reversible
  List/Map control, and shows the honest List fallback while no Map renderer is registered.

  python3 tools/capture_land_map_view_state.py
"""

from __future__ import annotations

import functools
import hashlib
import json
import subprocess
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "land-map-view-state"
# The resident address for the specimen scope. `#land?...` forwards here on entry.
ROUTE = "/browse/zoning/?boro=Queens&stage=public_review&view=map"
LIST_ROUTE = "/browse/zoning/?boro=Queens&stage=public_review"
VIEWPORTS = ((390, 844), (1440, 900))


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


def merge_base_site(destination: Path) -> Path:
    """Build the merge-base site tree offline, with no checkout switch in this working copy.

    Browse documents are generated (site/browse/ is gitignored), so the before tree needs its
    own detached worktree and its own document build rather than a source archive.
    """
    tree = destination / "head"
    subprocess.run(["git", "worktree", "add", "--detach", str(tree), "HEAD"], cwd=ROOT, check=True)
    subprocess.run(["node", "tools/build_primary_documents.mjs"], cwd=tree, check=True)
    return tree / "site"


def release_merge_base(destination: Path) -> None:
    subprocess.run(
        ["git", "worktree", "remove", "--force", str(destination / "head")], cwd=ROOT, check=False
    )
    subprocess.run(["git", "worktree", "prune"], cwd=ROOT, check=False)


def install_routes(page: Page, base_url: str) -> None:
    """Keep the capture offline: the Land browse route is already precompute-first.

    `/capabilities/*` lives beside site/ in the repository, not inside it, so a plain static
    root cannot serve it. Fulfilling it from disk keeps the application module graph intact.
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


def observe(page: Page) -> dict:
    """Read what the page actually shows, so a capture cannot silently claim the wrong state."""
    return page.evaluate(
        """() => {
          const chips = [...document.querySelectorAll('#land-view-switch [data-land-view]')];
          const note = document.getElementById('land-view-note');
          const params = new URLSearchParams((location.hash.split('?')[1]) || location.search);
          const semantic = [...params.entries()].filter(([key]) => key !== 'view')
            .map(([key, value]) => `${key}=${value}`).sort();
          return {
            url: `${location.pathname}${location.search}${location.hash}`,
            semantic,
            view: params.get('view'),
            controls: chips.map((chip) => ({
              view: chip.dataset.landView,
              pressed: chip.getAttribute('aria-pressed') === 'true',
            })),
            note: note && !note.hidden ? note.textContent.trim() : '',
            rows: document.querySelectorAll('#llist .row').length,
            count: (document.getElementById('lrescount') || {}).textContent || '',
          };
        }"""
    )


def evidence_clip(page: Page) -> dict:
    """Frame the presentation evidence only: the applied filter summary, the result count, the
    List/Map control, the fallback note, and the first result rows. The project detail panel is
    outside the change and is deliberately left out of the capture."""
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


def wait_for_land(page: Page) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=45000)
    page.wait_for_timeout(750)


def capture_history_receipt(base_url: str, playwright) -> dict:
    """Prove in a real browser that the switch is reversible and Back/Forward honor it."""
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    install_routes(page, base_url)
    page.goto(f"{base_url.rstrip('/')}{LIST_ROUTE}", wait_until="domcontentloaded")
    wait_for_land(page)
    steps = list()  # accumulator (not a measured table)

    def step(name: str) -> None:
        state = observe(page)
        steps.append({"step": name, **state})
        print(f"history {name}:", json.dumps(state, ensure_ascii=False))

    step("list")
    page.locator('#land-view-switch [data-land-view="map"]').click()
    page.wait_for_timeout(400)
    step("clicked-map")
    page.go_back()
    wait_for_land(page)
    step("back")
    page.go_forward()
    wait_for_land(page)
    step("forward")
    page.close()
    browser.close()
    return {"route": LIST_ROUTE, "steps": steps}


def capture_map_failure(base_url: str, playwright) -> tuple[dict, dict]:
    """Register a Map renderer that cannot paint and record what the resident is left with."""
    directory = OUT / "after"
    directory.mkdir(parents=True, exist_ok=True)
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    install_routes(page, base_url)
    page.add_init_script(
        "window.CROL_LAND_MAP_RENDERER = { mount(){ throw new Error('tiles unavailable'); } };"
    )
    page.goto(f"{base_url.rstrip('/')}{ROUTE}", wait_until="domcontentloaded")
    wait_for_land(page)
    state = observe(page)
    print("map-load-failure:", json.dumps(state, ensure_ascii=False))
    out = directory / "land-view-state-map-failure-1440.png"
    page.screenshot(
                path=str(out), animations="disabled", full_page=True, clip=evidence_clip(page)
            )
    data = out.read_bytes()
    page.close()
    browser.close()
    return (
        {
            "name": f"after/{out.name}",
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "viewport": [1440, 900],
            "observed": state,
        },
        state,
    )


def capture(label: str, site_dir: Path) -> list[dict]:
    directory = OUT / label
    directory.mkdir(parents=True, exist_ok=True)
    files = list()  # accumulator (not a measured table)
    with StaticServer(site_dir) as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            install_routes(page, base_url)
            page.goto(f"{base_url.rstrip('/')}{ROUTE}", wait_until="domcontentloaded")
            wait_for_land(page)
            state = observe(page)
            print(f"{label} {width}px:", json.dumps(state, ensure_ascii=False))
            out = directory / f"land-view-state-{width}.png"
            page.screenshot(
                path=str(out), animations="disabled", full_page=True, clip=evidence_clip(page)
            )
            data = out.read_bytes()
            files.append(
                {
                    "name": f"{label}/{out.name}",
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "viewport": [width, height],
                    "observed": state,
                }
            )
            print("wrote", out)
            page.close()
        browser.close()
    return files


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as staging:
        staging_path = Path(staging)
        try:
            files = capture("before", merge_base_site(staging_path))
        finally:
            release_merge_base(staging_path)
    files += capture("after", ROOT / "site")
    with StaticServer(ROOT / "site") as base_url, sync_playwright() as playwright:
        history = capture_history_receipt(base_url, playwright)
        failure_file, failure = capture_map_failure(base_url, playwright)
    files.append(failure_file)
    receipt = {
        "schema": "cityscroll.capture_receipt.v1",
        "capture": "land-map-view-state",
        "route": ROUTE,
        "viewports": [list(viewport) for viewport in VIEWPORTS],
        "before_source": "git archive HEAD site",
        "after_source": "working tree site/",
        "files": files,
        "history": history,
        "map_load_failure": failure,
    }
    (OUT / "manifest.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print("wrote", OUT / "manifest.json")


if __name__ == "__main__":
    main()
