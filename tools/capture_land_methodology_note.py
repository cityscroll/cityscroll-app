#!/usr/bin/env python3
"""Before/after capture of the Land methodology note on a successful search.

The current checkout is the after state. Pass the revision immediately before the
change for the comparison state:

    python3 tools/capture_land_methodology_note.py --before HEAD^

Outputs land in docs/screenshots/land-methodology-note/.
"""

from __future__ import annotations

import argparse
import functools
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Browser, Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "land-methodology-note"
VIEWPORTS = ((390, 844), (1440, 900))
LAND_HASH = "#land?boro=Queens"
LAND_NOTICE = {
    "project_id": "P2026Q0004",
    "project_name": "Elmhurst neighborhood rezoning",
    "project_brief": "A mixed-use proposal with new homes and ground-floor shops.",
    "primary_applicant": "Neighborhood Development Partners",
    "public_status": "In Public Review",
    "project_status": "Active",
    "borough": "Queens",
    "community_district": "Q04",
    "actions": "Community Board Review",
    "mih_flag": "true",
    "current_milestone": "Community Board Review",
    "current_milestone_date": "2026-08-12T00:00:00.000",
    "ulurp_numbers": "260004ZMQ",
}
GEOSEARCH_RESPONSE = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [-73.883189, 40.747305]},
        "properties": {
            "label": "40-12 83 Street, Elmhurst, NY, USA",
            "borough": "Queens",
            "neighbourhood": "Elmhurst",
            "addendum": {"pad": {"bbl": "4014930012"}},
        },
    }],
}
LOT_GEOJSON = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {"BBL": "4014930012"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-73.8834, 40.7471],
                [-73.8830, 40.7471],
                [-73.8830, 40.7475],
                [-73.8834, 40.7475],
                [-73.8834, 40.7471],
            ]],
        },
    }],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path):
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


def revision_snapshot(revision: str, destination: Path) -> None:
    result = subprocess.run(
        ["git", "archive", "--format=tar", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
        archive.extractall(destination)


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_routes(page: Page) -> None:
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())
    page.route("https://api.cityscroll.org/**", lambda route: json_response(route, {}))
    page.route(
        "https://crol-worker.crol-worker.workers.dev/**",
        lambda route: json_response(route, {}),
    )
    page.route(
        "https://geosearch.planninglabs.nyc/**",
        lambda route: json_response(route, GEOSEARCH_RESPONSE),
    )

    def map_pluto(route: Route) -> None:
        query = parse_qs(urlparse(route.request.url).query)
        if query.get("f") == ["json"]:
            json_response(route, {"features": [{"attributes": {"CD": 404}}]})
        else:
            json_response(route, LOT_GEOJSON)

    page.route("https://services5.arcgis.com/**", map_pluto)

    def city_data(route: Route) -> None:
        parsed = urlparse(route.request.url)
        if parsed.path.endswith("/2iga-a6mk.json"):
            json_response(route, [])
            return
        if parsed.path.endswith("/hgx4-8ukb.json"):
            json_response(route, [LAND_NOTICE])
            return
        json_response(route, [])

    page.route("https://data.cityofnewyork.us/**", city_data)
    page.route("https://unpkg.com/**", lambda route: route.continue_())
    page.route("https://cdnjs.cloudflare.com/**", lambda route: route.continue_())


def open_land_success(page: Page, base_url: str) -> None:
    page.goto(base_url + LAND_HASH, wait_until="domcontentloaded")
    page.locator("#llist .row").first.wait_for(state="visible", timeout=20000)
    if page.viewport_size and page.viewport_size["width"] <= 680:
        toggle = page.locator("#tab-land .filtertoggle")
        if toggle.count() and page.locator("#tab-land .controls").is_hidden():
            toggle.click()


def position_capture(page: Page) -> None:
    page.locator("#tab-land .panelbar, #llist").first.scroll_into_view_if_needed()
    page.evaluate(
        """
        () => {
          const target = document.querySelector("#land-methodology")
            || document.querySelector("#llist")
            || document.querySelector("#tab-land .panelbar");
          if (!target) return;
          window.scrollTo(0, Math.max(0, target.getBoundingClientRect().top + scrollY - 80));
        }
        """
    )
    page.wait_for_timeout(120)


def annotate(page: Page, state: str) -> None:
    if state == "before":
        items = [
            ("#lrescount", "BEFORE · RESULT COUNT ONLY"),
            ("#llist .row", "SUCCESSFUL LAND RESULTS — NO METHODOLOGY NOTE"),
        ]
    else:
        items = [
            ("#land-methodology", "AFTER · SHARED METHODOLOGY NOTE"),
            ("#llist .row", "SUCCESSFUL LAND RESULTS"),
        ]
    page.evaluate(
        """
        items => {
          const colors = ["#16794b", "#b42318"];
          items.forEach((item, index) => {
            const target = document.querySelector(item.selector);
            if (!target) return;
            const rect = target.getBoundingClientRect();
            const left = Math.max(5, rect.left - 6);
            const top = Math.max(5, rect.top - 6);
            const width = Math.min(innerWidth - left - 5, Math.max(rect.width + 12, 40));
            const height = Math.min(innerHeight - top - 5, Math.max(rect.height + 12, 24));
            const color = colors[index % colors.length];
            const mark = document.createElement("div");
            Object.assign(mark.style, {
              position: "fixed", left: `${left}px`, top: `${top}px`,
              width: `${width}px`, height: `${height}px`,
              border: `4px solid ${color}`, borderRadius: "8px",
              boxSizing: "border-box", zIndex: "99998", pointerEvents: "none",
            });
            const label = document.createElement("div");
            label.textContent = item.label;
            Object.assign(label.style, {
              position: "fixed", left: `${left}px`,
              top: `${Math.max(5, top - 31 - (index * 2))}px`,
              maxWidth: `${Math.min(Math.max(width, 220), innerWidth - left - 5)}px`,
              background: color, color: "#fff", padding: "6px 9px",
              borderRadius: "5px", font: "800 11px/1.2 system-ui,sans-serif",
              zIndex: "99999", pointerEvents: "none",
            });
            document.body.append(mark, label);
          });
        }
        """,
        [{"selector": selector, "label": label} for selector, label in items],
    )


def capture_state(
    browser: Browser,
    tree: Path,
    state: str,
    width: int,
    height: int,
) -> None:
    with StaticServer(tree / "site" if (tree / "site").is_dir() else tree) as base_url:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        open_land_success(page, base_url)
        if state == "after":
            note = page.locator("#land-methodology")
            note.wait_for(state="visible", timeout=5000)
            text = note.inner_text()
            assert "Open Data" in text or "ZAP" in text, text
            assert "monthly" in text.lower() or "MapPLUTO" in text, text
        else:
            assert page.locator("#land-methodology").count() == 0
        position_capture(page)
        OUTPUT.mkdir(parents=True, exist_ok=True)
        raw = OUTPUT / f"{state}-{width}.png"
        page.screenshot(path=str(raw), animations="disabled")
        annotate(page, state)
        annotated = OUTPUT / f"{state}-{width}-annotated.png"
        page.screenshot(path=str(annotated), animations="disabled")
        assert raw.stat().st_size > 8_000
        assert annotated.stat().st_size > 8_000
        assert not errors, errors
        context.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--before",
        default="HEAD",
        help="git revision for the before snapshot (default: HEAD of branch base)",
    )
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="land-methodology-") as tmp:
        before_tree = Path(tmp) / "before"
        before_tree.mkdir()
        revision_snapshot(args.before, before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width, height in VIEWPORTS:
                capture_state(browser, before_tree, "before", width, height)
                capture_state(browser, ROOT, "after", width, height)
            browser.close()
    print(f"wrote captures under {OUTPUT}")


if __name__ == "__main__":
    main()
