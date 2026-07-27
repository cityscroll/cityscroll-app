#!/usr/bin/env python3
"""Capture annotated before/after evidence for WCAG 2.2 map pan controls."""

from __future__ import annotations

import argparse
import functools
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import textwrap
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "media" / "review" / "wcag22-upgrade"
PROJECT_ID = "2023M0452"
PROJECT = {
    "project_id": PROJECT_ID,
    "project_name": "Allen Street Mall Demapping",
    "project_brief": (
        "An application by the New York City Department of Parks and Recreation "
        "to map part of Allen Street as parkland."
    ),
    "primary_applicant": "Department of Parks and Recreation",
    "public_status": "Completed",
    "project_status": "Active",
    "borough": "Manhattan",
    "community_district": "M03",
    "actions": "MM; ZR",
    "mih_flag": "false",
    "current_milestone": "Final letter sent",
    "ulurp_numbers": "250306MMM",
}
LOT_GEOJSON = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {"BBL": "1004160001"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-73.9904, 40.7195],
                [-73.9897, 40.7195],
                [-73.9897, 40.7201],
                [-73.9904, 40.7201],
                [-73.9904, 40.7195],
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
    page.route("https://**", lambda route: route.abort())
    page.route("https://unpkg.com/**", lambda route: route.continue_())
    page.route("https://*.basemaps.cartocdn.com/**", lambda route: route.continue_())
    page.route("https://api.crol-list.org/**", lambda route: json_response(route, {}))
    page.route("https://geosearch.planninglabs.nyc/**", lambda route: json_response(route, {"features": []}))
    page.route(
        "https://services5.arcgis.com/**",
        lambda route: json_response(route, LOT_GEOJSON),
    )

    def zap(route: Route) -> None:
        query = {
            key: values[0]
            for key, values in parse_qs(urlparse(route.request.url).query).items()
        }
        where = query.get("$where", "")
        if "$select" in query and query["$select"] == "bbl":
            body = [{"bbl": "1004160001"}]
        else:
            body = [PROJECT] if f"project_id='{PROJECT_ID}'" in where else []
        json_response(route, body)

    page.route("https://data.cityofnewyork.us/resource/hgx4-8ukb.json*", zap)


def open_map(page: Page, base_url: str, state: str) -> None:
    page.goto(f"{base_url}?evidence={state}#land/{PROJECT_ID}", wait_until="domcontentloaded")
    page.locator("#landmap.leaflet-container").wait_for(state="visible", timeout=20_000)
    if state == "after":
        page.locator("#landpan:not([hidden])").wait_for(state="visible")
        sizes = page.locator("#landpan button").evaluate_all(
            "els => els.map(el => { const r=el.getBoundingClientRect(); return [r.width,r.height]; })"
        )
        assert sizes == [[32, 32]] * 4, sizes
    else:
        assert page.locator("#landpan").count() == 0
    page.evaluate("document.fonts && document.fonts.ready")


def position_capture(page: Page) -> None:
    page.locator("#landmap").scroll_into_view_if_needed()
    page.evaluate(
        """() => {
          const map = document.querySelector('#landmap');
          window.scrollTo(0, Math.max(0, map.getBoundingClientRect().top + scrollY - 255));
        }"""
    )
    page.wait_for_timeout(350)


def annotate(source: Path, destination: Path, state: str, target: dict[str, float]) -> None:
    image = Image.open(source).convert("RGB")
    draw = ImageDraw.Draw(image, "RGBA")
    color = (155, 48, 48, 255) if state == "before" else (35, 112, 83, 255)
    message = (
        "Before · panning the map requires dragging."
        if state == "before"
        else "After · four 32px buttons pan the map with a click or tap."
    )
    font = ImageFont.load_default(size=18 if image.width >= 700 else 15)
    label = "\n".join(textwrap.wrap(message, width=58 if image.width >= 700 else 35))
    text_box = draw.multiline_textbbox((0, 0), label, font=font, spacing=4)
    banner_height = text_box[3] - text_box[1] + 24
    draw.rounded_rectangle(
        (10, 10, image.width - 10, 10 + banner_height),
        radius=10,
        fill=(28, 25, 22, 238),
        outline=color,
        width=3,
    )
    draw.multiline_text((22, 22), label, font=font, fill="white", spacing=4)

    x1 = max(2, target["x"] - 7)
    y1 = max(2, target["y"] - 6)
    x2 = min(image.width - 2, target["x"] + target["width"] + 7)
    y2 = min(image.height - 2, target["y"] + target["height"] + 6)
    draw.rounded_rectangle((x1, y1, x2, y2), radius=7, outline=color, width=4)
    image.save(destination, optimize=True)


def capture(browser, tree: Path, state: str, width: int, height: int) -> None:
    with StaticServer(tree) as base_url:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        open_map(page, base_url, state)
        position_capture(page)
        target = page.locator("#landpan" if state == "after" else "#landmap").bounding_box()
        assert target is not None
        raw = OUTPUT / f"{state}-{width}.png"
        page.screenshot(path=raw, animations="disabled")
        annotate(raw, OUTPUT / f"{state}-{width}-annotated.png", state, target)
        assert not errors, errors
        context.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", default="HEAD", help="revision before the WCAG 2.2 change")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="crol-wcag22-map-") as temp:
        before_tree = Path(temp) / "before"
        before_tree.mkdir()
        revision_snapshot(args.before, before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height in ((390, 844), (1440, 900)):
                    capture(browser, before_tree, "before", width, height)
                    capture(browser, ROOT, "after", width, height)
            finally:
                browser.close()

    print("WCAG 2.2 map-control captures passed.")
    for asset in sorted(OUTPUT.glob("*.png")):
        print(f"  {asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
