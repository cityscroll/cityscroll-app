#!/usr/bin/env python3
"""Capture annotated landing-identity-layer evidence at 390px and 1440px.

The current checkout is the after state (a bare "/" first-time visit now shows the
identity layer). The before state defaults to the revision immediately before this
layer existed. Outputs land in test/e2e/shots/landing-identity/.
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
SHOTS = ROOT / "test" / "e2e" / "shots"
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


def annotate(source: Path, destination: Path, state: str, target: dict[str, float], messages: dict[str, str]) -> None:
    image = Image.open(source).convert("RGB")
    draw = ImageDraw.Draw(image, "RGBA")
    color = (146, 54, 45, 255) if state == "before" else (35, 112, 83, 255)
    message = messages[state]
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


def capture(browser, tree: Path, state: str, width: int, height: int, selector: str | None, messages: dict[str, str], output: Path) -> None:
    with StaticServer(tree) as base_url:
        context = browser.new_context(
            viewport={"width": width, "height": height},
            device_scale_factor=1,
        )
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        # A genuinely fresh browser, no hash — exactly the visit this feature targets.
        page.goto(base_url, wait_until="domcontentloaded")
        if selector is None:
            selector = "#landing-identity" if state == "after" else "header.masthead"
        target = page.locator(selector)
        target.wait_for(state="visible")
        page.evaluate("document.fonts && document.fonts.ready")
        page.wait_for_timeout(250)
        box = target.bounding_box()
        if box is None:
            raise AssertionError(f"{state}-{width}: target bounds unavailable")
        if box["x"] < 0 or box["y"] < 0 or box["width"] < 24 or box["height"] < 24:
            raise AssertionError(f"{state}-{width}: invalid target bounds {box}")

        output.mkdir(parents=True, exist_ok=True)
        raw = output / f"{state}-{width}.png"
        annotated = output / f"{state}-{width}-annotated.png"
        page.screenshot(path=raw, animations="disabled")
        annotate(raw, annotated, state, box, messages)
        if annotated.stat().st_size < 10_000:
            raise AssertionError(f"{annotated.name}: capture unexpectedly small")
        if errors:
            raise AssertionError(f"{state}-{width}: page errors: {errors}")
        context.close()
        print(f"captured {annotated.relative_to(ROOT)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", default="HEAD")
    parser.add_argument(
        "--selector",
        default=None,
        help="override the captured element for BOTH states (default: the whole layer vs. "
        "the masthead, for the layer's introduction; pass a narrower selector — e.g. "
        "#landingCtaContracts — when before/after are both showing the layer and only a "
        "smaller region changed).",
    )
    parser.add_argument(
        "--message-before",
        default="Before · A bare first visit sees the full power tool immediately, no orientation.",
    )
    parser.add_argument(
        "--message-after",
        default="After · A first-time visitor sees a short welcome and two task-phrased choices first.",
    )
    parser.add_argument("--out-subdir", default="landing-identity")
    args = parser.parse_args()
    messages = {"before": args.message_before, "after": args.message_after}
    output = SHOTS / args.out_subdir

    with tempfile.TemporaryDirectory(prefix=".capture-landing-", dir=ROOT) as temporary:
        before_tree = Path(temporary)
        revision_snapshot(args.before, before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width, height in VIEWPORTS:
                capture(browser, before_tree, "before", width, height, args.selector, messages, output)
                capture(browser, ROOT, "after", width, height, args.selector, messages, output)
            browser.close()


if __name__ == "__main__":
    main()
