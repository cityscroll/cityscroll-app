#!/usr/bin/env python3
"""Before/after captures for the Land council-district filter.

The current checkout is the after state. Pass a parent revision for before:

    python3 tools/capture_council_district_filter.py --before HEAD^
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

from playwright.sync_api import Browser, BrowserContext, Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "council-district-filter"
VIEWPORTS = ((390, 844), (1440, 900))
LOCATED_HASH = "#land?boro=Queens&cd=Q04&council=25"
BEFORE_HASH = "#land?boro=Queens&cd=Q04"
AUTO_PROMPT_KEY = "crol_land_location_auto_asked_v1"
LAND_NOTICE = {
    "project_id": "P2026Q0025",
    "project_name": "Elmhurst neighborhood rezoning",
    "project_brief": "A mixed-use proposal with new homes and ground-floor shops.",
    "primary_applicant": "Neighborhood Development Partners",
    "public_status": "In Public Review",
    "project_status": "Active",
    "borough": "Queens",
    "community_district": "Q04",
    "cc_district": "25",
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
FIXTURE_RING = [
    [-73.89, 40.74],
    [-73.87, 40.74],
    [-73.87, 40.755],
    [-73.89, 40.755],
    [-73.89, 40.74],
]
UNIFIED_LAYER = {
    "schema": "cityscroll.district_boundaries.v1",
    "boundary_vintage": "2026-05-26",
    "sources": {
        "community_district": {
            "dataset_id": "5crt-au7u",
            "boundary_vintage": "2026-05-26",
        },
        "council_district": {
            "dataset_id": "872g-cjhh",
            "boundary_vintage": "2026-05-26",
        },
    },
    "community_district_count": 1,
    "council_district_count": 1,
    "community_districts": [{
        "id": "Q04",
        "boro_cd": "404",
        "label": "Queens Community District 4",
        "bbox": [-73.89, 40.74, -73.87, 40.755],
        "polygons": [{"rings": [FIXTURE_RING]}],
    }],
    "council_districts": [{
        "id": "25",
        "label": "City Council District 25",
        "bbox": [-73.89, 40.74, -73.87, 40.755],
        "polygons": [{"rings": [FIXTURE_RING]}],
    }],
}
# Compat name used by older capture paths.
COUNCIL_LAYER = UNIFIED_LAYER


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
        "https://geosearch.planninglabs.nyc/v2/reverse*",
        lambda route: json_response(route, GEOSEARCH_RESPONSE),
    )

    def map_pluto(route: Route) -> None:
        json_response(route, {"features": [{"attributes": {"CD": 404}}]})

    page.route("https://services5.arcgis.com/**", map_pluto)

    def city_data(route: Route) -> None:
        parsed = urlparse(route.request.url)
        if parsed.path.endswith("/2iga-a6mk.json"):
            json_response(route, [])
            return
        if parsed.path.endswith("/hgx4-8ukb.json"):
            query = parse_qs(parsed.query)
            where = query.get("$where", [""])[0]
            if "cc_district" in where or "Q04" in where or "borough='Queens'" in where:
                json_response(route, [LAND_NOTICE])
            else:
                json_response(route, [LAND_NOTICE])
            return
        json_response(route, [])

    page.route("https://data.cityofnewyork.us/**", city_data)

    def boundaries(route: Route) -> None:
        json_response(route, UNIFIED_LAYER)

    page.route("**/district_boundaries.json", boundaries)
    page.route("**/council_district_boundaries.json", boundaries)


def mock_location(context: BrowserContext) -> None:
    context.add_init_script(
        """
        (() => {
          Object.defineProperty(navigator, "geolocation", {
            configurable: true,
            value: {
              getCurrentPosition(success) {
                success({coords:{latitude:40.7473,longitude:-73.8832}});
              }
            }
          });
          Object.defineProperty(navigator, "permissions", {
            configurable: true,
            value: { query: async () => ({ state: "granted" }) }
          });
          try { localStorage.setItem(%s, "1"); } catch (_e) {}
        })();
        """ % json.dumps(AUTO_PROMPT_KEY)
    )


def capture_state(
    browser: Browser,
    site_root: Path,
    prefix: str,
    hash_value: str,
    use_location: bool,
) -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with StaticServer(site_root) as base:
        for width, height in VIEWPORTS:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                device_scale_factor=1,
            )
            if use_location:
                mock_location(context)
            page = context.new_page()
            install_routes(page)
            page.goto(base + "index.html" + hash_value, wait_until="domcontentloaded")
            page.wait_for_selector("#llist .row, #llist .empty", timeout=15000)
            if use_location:
                page.wait_for_timeout(400)
            page.screenshot(path=str(OUTPUT / f"{prefix}-{width}.png"), full_page=False)
            context.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", help="git revision for before screenshots")
    args = parser.parse_args()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        # After: current tree with council filter deep link.
        capture_state(browser, ROOT / "site", "after", LOCATED_HASH, use_location=False)
        # After with location tap path (resolved area chips).
        capture_state(browser, ROOT / "site", "after-located", "#land", use_location=True)

        if args.before:
            with tempfile.TemporaryDirectory() as tmp:
                dest = Path(tmp) / "before"
                dest.mkdir()
                revision_snapshot(args.before, dest)
                site = dest / "site"
                if not site.exists():
                    raise SystemExit(f"no site/ in revision {args.before}")
                capture_state(browser, site, "before", BEFORE_HASH, use_location=False)

        browser.close()

    print(f"wrote captures under {OUTPUT}")


if __name__ == "__main__":
    main()
