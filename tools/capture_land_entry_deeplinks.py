#!/usr/bin/env python3
"""Capture and verify the Land-entry permalink at the two review widths.

The current checkout is the after state. Pass the revision immediately before the
change as --before (HEAD by default):

    python3 tools/capture_land_entry_deeplinks.py --before HEAD

Outputs land in test/e2e/shots/land-entry-deeplinks/.
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
import textwrap
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "test" / "e2e" / "shots" / "land-entry-deeplinks"
# Fixture: real ZAP project 2023M0452 (Allen Street Mall Demapping), captured from NYC
# Open Data dataset hgx4-8ukb on 2026-07-27 and retained as a deterministic network mock.
PROJECT_ID = "2023M0452"
PROJECT = {
    "project_id": PROJECT_ID,
    "project_name": "Allen Street Mall Demapping",
    "project_brief": (
        "An application by the New York City Department of Parks and Recreation (DPR) "
        "to demap as street and map as parkland a portion of Allen Street between "
        "Delancey Street and Rivington Street."
    ),
    "primary_applicant": "DPR - Department of Parks & Recreation NYC",
    "public_status": "Completed",
    "project_status": "Active",
    "borough": "Manhattan",
    "community_district": "M03",
    "actions": "MM; ZR",
    "mih_flag": "false",
    "current_milestone": "MM - Final Letter Sent",
    "ulurp_numbers": "250306MMM; N250307ZRM",
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
    page.route("https://data.cityofnewyork.us/**", lambda route: json_response(route, []))
    page.route("https://api.crol-list.org/**", lambda route: json_response(route, {}))
    page.route(
        "https://geosearch.planninglabs.nyc/**",
        lambda route: json_response(route, {"features": []}),
    )

    def zap(route: Route) -> None:
        query = {
            key: values[0]
            for key, values in parse_qs(urlparse(route.request.url).query).items()
        }
        where = query.get("$where", "")
        json_response(route, [PROJECT] if f"project_id='{PROJECT_ID}'" in where else [])

    page.route("https://data.cityofnewyork.us/resource/hgx4-8ukb.json*", zap)


def open_entry(page: Page, base_url: str) -> None:
    page.goto(f"{base_url}#land/{PROJECT_ID}", wait_until="domcontentloaded")
    page.locator("#landcopy").wait_for(state="visible")
    page.evaluate("document.fonts && document.fonts.ready")
    assert page.locator("#tab-land").evaluate("el => el.classList.contains('active')")
    assert page.locator("#ldetail .rolename").text_content() == PROJECT["project_name"]
    assert page.locator("#llist .row").count() == 1
    assert page.evaluate("location.hash") == f"#land/{PROJECT_ID}"


def position_capture(page: Page, state: str, width: int) -> dict[str, float]:
    target = page.locator('.tabbtn[data-tab="land"]')
    target.scroll_into_view_if_needed()
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(150)
    box = target.bounding_box()
    if box is None:
        raise AssertionError(f"annotation target missing for {state}-{width}")
    if box["y"] > 120:
        page.evaluate(
            "(y) => window.scrollTo(0, Math.max(0, y - 25))",
            box["y"],
        )
        page.wait_for_timeout(150)
        box = target.bounding_box()
        if box is None:
            raise AssertionError(
                f"annotation target missing after recenter for {state}-{width}"
            )
    if box["y"] > 120:
        raise AssertionError(
            f"annotation target y too low for {state}-{width}: {box['y']} (expected top nav row)"
        )
    if box["x"] < 0:
        raise AssertionError(f"annotation target x invalid for {state}-{width}: {box['x']}")
    return box


def annotate(
    source: Path, destination: Path, state: str, target: dict[str, float]
) -> dict[str, float]:
    image = Image.open(source).convert("RGB")
    draw = ImageDraw.Draw(image, "RGBA")
    width = image.width
    color = (155, 48, 48, 255) if state == "before" else (35, 112, 83, 255)
    message = (
        "Before: the entry URL falls through to Contracts."
        if state == "before"
        else "After: the exact Land entry opens with a Copy link."
    )
    font = ImageFont.load_default(size=18 if width >= 700 else 15)
    chars = 58 if width >= 700 else 34
    label = "\n".join(textwrap.wrap(message, width=chars))
    text_box = draw.multiline_textbbox((0, 0), label, font=font, spacing=4)
    banner_height = text_box[3] - text_box[1] + 24
    draw.rounded_rectangle(
        (10, 10, width - 10, 10 + banner_height),
        radius=10,
        fill=(28, 25, 22, 238),
        outline=color,
        width=3,
    )
    draw.multiline_text((22, 22), label, font=font, fill=(255, 255, 255, 255), spacing=4)

    x1 = max(2, target["x"] - 7)
    y1 = max(2, target["y"] - 6)
    x2 = min(image.width - 2, target["x"] + target["width"] + 7)
    y2 = min(image.height - 2, target["y"] + target["height"] + 6)
    draw.rounded_rectangle((x1, y1, x2, y2), radius=7, outline=color, width=4)
    start = (width // 2, 10 + banner_height)
    end = ((x1 + x2) // 2, y1)
    draw.line((start, end), fill=color, width=4)
    draw.polygon(
        ((end[0], end[1]), (end[0] - 7, end[1] - 11), (end[0] + 7, end[1] - 11)),
        fill=color,
    )
    image.save(destination, optimize=True)
    return {"x": x1, "y": y1, "x2": x2, "y2": y2}


def assert_annotation_crops(path: Path, rect: dict[str, float], state: str, width: int) -> None:
    image = Image.open(path).convert("RGB")
    x1 = max(0, int(rect["x"]))
    y1 = max(0, int(rect["y"]) - 4)
    x2 = min(image.width, int(rect["x2"]) + 4)
    y2 = min(image.height, int(rect["y2"]) + 4)
    crop = image.crop((x1, y1, x2, y2))
    gray = crop.convert("L")
    pixel_count = gray.width * gray.height
    non_background = sum(1 for p in gray.getdata() if p < 240)
    ratio = non_background / pixel_count if pixel_count else 0
    print(f"{path.name}: rect={rect}, dark_ratio={ratio:.4f}, size={crop.size}")
    if ratio < 0.02:
        raise AssertionError(
            f"{state}-{width} annotated crop has insufficient contrast: "
            f"ratio={ratio:.4f}, check if annotation is drawing wrong area"
        )


def capture_state(browser, tree: Path, state: str, width: int, height: int) -> None:
    with StaticServer(tree) as base_url:
        context = browser.new_context(
            viewport={"width": width, "height": height},
            device_scale_factor=1,
            permissions=["clipboard-read", "clipboard-write"],
        )
        page = context.new_page()
        page_errors: list[str] = list()
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        install_routes(page)
        if state == "after":
            open_entry(page, base_url)
        else:
            page.goto(f"{base_url}#land/{PROJECT_ID}", wait_until="domcontentloaded")
            page.locator('.tabbtn[data-tab="land"]').wait_for(state="visible")
        target = position_capture(page, state, width)
        raw = OUTPUT / f"{state}-{width}.png"
        page.screenshot(path=raw, animations="disabled")
        annotated = OUTPUT / f"{state}-{width}-annotated.png"
        drawn_rect = annotate(raw, annotated, state, target)
        assert_annotation_crops(annotated, drawn_rect, state, width)
        if page_errors:
            raise AssertionError(f"{state}-{width} page errors: {page_errors}")
        context.close()


def verify_interactions(browser) -> None:
    with StaticServer(ROOT) as base_url:
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            permissions=["clipboard-read", "clipboard-write"],
        )
        page = context.new_page()
        page_errors: list[str] = list()
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        install_routes(page)

        page.goto(f"{base_url}#land", wait_until="domcontentloaded")
        page.locator("#llist .empty:not(.skel)").wait_for(state="visible")
        page.goto(f"{base_url}#land/{PROJECT_ID}", wait_until="domcontentloaded")
        page.locator("#landcopy").wait_for(state="visible")
        page.locator("#landcopy").click()
        page.wait_for_function(
            "document.querySelector('#landcopy').textContent.includes('Copied')"
        )
        copied = page.evaluate("navigator.clipboard.readText()")
        assert copied == f"{base_url}#land/{PROJECT_ID}"
        page.locator('.lang-btn[data-lang="es"]').click()
        page.wait_for_function("document.documentElement.lang === 'es'")
        page.locator("#landcopy").wait_for(state="visible")
        assert page.evaluate("location.hash") == f"#land/{PROJECT_ID}"
        assert page.locator("#llist .row").count() == 1
        page.locator('.lang-btn[data-lang="en"]').click()
        page.wait_for_function("document.documentElement.lang === 'en'")
        page.go_back(wait_until="domcontentloaded")
        page.wait_for_function("location.hash === '#land'")
        page.locator("#llist .empty:not(.skel)").wait_for(state="visible")

        page.goto(f"{base_url}#land/%E0%A4%A", wait_until="domcontentloaded")
        page.locator("#tab-land.active").wait_for(state="visible")
        page.wait_for_function("document.querySelector('#lrescount').textContent === '0'")
        assert page.locator("#llist .empty").count() == 1
        assert page.locator("#ldetail .empty").count() == 1
        assert not page_errors, page_errors
        context.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", default="HEAD", help="revision before the change")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="crol-land-deeplink-") as temp:
        before_tree = Path(temp) / "before"
        before_tree.mkdir()
        revision_snapshot(args.before, before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in ((390, 844), (1440, 900)):
                capture_state(browser, before_tree, "before", width, height)
                capture_state(browser, ROOT, "after", width, height)
            verify_interactions(browser)
            browser.close()

    print("Land-entry permalink browser checks passed.")
    for asset in sorted(OUTPUT.glob("*.png")):
        print(f"  {asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
