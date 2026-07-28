#!/usr/bin/env python3
"""Capture annotated two-tier navigation evidence at 390px and 1440px.

The current checkout is the after state. The before state defaults to origin/main,
which should be the revision immediately before this navigation-only change.
Outputs land in test/e2e/shots/two-tier-navigation/.
"""

from __future__ import annotations

import argparse
import functools
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import textwrap
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "test" / "e2e" / "shots" / "two-tier-navigation"
VIEWPORTS = [(390, 844), (1440, 900)]


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


def install_routes(page: Page) -> None:
    def empty_json(route: Route) -> None:
        route.fulfill(status=200, content_type="application/json", body="[]")

    page.route("https://data.cityofnewyork.us/**", empty_json)
    page.route(
        "https://api.crol-list.org/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="{}"),
    )
    page.route("https://**", lambda route: route.abort())


def annotate(source: Path, destination: Path, state: str, target: dict[str, float]) -> None:
    image = Image.open(source).convert("RGB")
    draw = ImageDraw.Draw(image, "RGBA")
    color = (146, 54, 45, 255) if state == "before" else (35, 112, 83, 255)
    message = (
        "Before · Seven lenses share one undifferentiated navigation row."
        if state == "before"
        else "After · Contracts and Zoning lead; More keeps four lenses one disclosure away."
    )
    font = ImageFont.load_default(size=17 if image.width >= 700 else 14)
    label = "\n".join(textwrap.wrap(message, width=68 if image.width >= 700 else 38))
    text_box = draw.multiline_textbbox((0, 0), label, font=font, spacing=4)
    banner_height = text_box[3] - text_box[1] + 24
    draw.rounded_rectangle(
        (10, 10, image.width - 10, 10 + banner_height),
        radius=10,
        fill=(28, 25, 22, 240),
        outline=color,
        width=3,
    )
    draw.multiline_text((22, 22), label, font=font, fill="white", spacing=4)

    x1 = max(3, int(target["x"]) - 6)
    y1 = max(3, int(target["y"]) - 6)
    x2 = min(image.width - 3, int(target["x"] + target["width"]) + 6)
    y2 = min(image.height - 3, int(target["y"] + target["height"]) + 6)
    draw.rounded_rectangle((x1, y1, x2, y2), radius=8, outline=color, width=4)
    start = (image.width // 2, 10 + banner_height)
    end = ((x1 + x2) // 2, y1)
    draw.line((start, end), fill=color, width=4)
    draw.polygon(
        ((end[0], end[1]), (end[0] - 7, end[1] - 11), (end[0] + 7, end[1] - 11)),
        fill=color,
    )
    image.save(destination, optimize=True)


def capture(browser, tree: Path, state: str, width: int, height: int) -> None:
    with StaticServer(tree) as base_url:
        context = browser.new_context(
            viewport={"width": width, "height": height},
            device_scale_factor=1,
        )
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        page.goto(base_url + "#money", wait_until="domcontentloaded")
        selector = ".lens-nav" if state == "after" else ".tabs"
        target = page.locator(selector)
        target.wait_for(state="visible")
        page.evaluate("document.fonts && document.fonts.ready")
        page.wait_for_timeout(250)
        box = target.bounding_box()
        if box is None:
            raise AssertionError(f"{state}-{width}: navigation bounds unavailable")
        if box["x"] < 0 or box["y"] < 0 or box["width"] < 24 or box["height"] < 24:
            raise AssertionError(f"{state}-{width}: invalid navigation bounds {box}")

        OUTPUT.mkdir(parents=True, exist_ok=True)
        raw = OUTPUT / f"{state}-{width}.png"
        annotated = OUTPUT / f"{state}-{width}-annotated.png"
        page.screenshot(path=raw, animations="disabled")
        annotate(raw, annotated, state, box)
        if annotated.stat().st_size < 10_000:
            raise AssertionError(f"{annotated.name}: capture unexpectedly small")
        if errors:
            raise AssertionError(f"{state}-{width}: page errors: {errors}")
        context.close()
        print(f"captured {annotated.relative_to(ROOT)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", default="origin/main")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix=".capture-two-tier-", dir=ROOT) as temporary:
        before_tree = Path(temporary)
        revision_snapshot(args.before, before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width, height in VIEWPORTS:
                capture(browser, before_tree, "before", width, height)
                capture(browser, ROOT, "after", width, height)
            browser.close()


if __name__ == "__main__":
    main()
