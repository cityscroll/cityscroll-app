#!/usr/bin/env python3
"""Capture annotated standards-page evidence at the two review widths.

The current checkout is the after state. Pass the revision immediately before
the change as --before (HEAD by default):

    python3 tools/capture_standards_self_conformance.py --before HEAD

Outputs land in media/review/standards-self-conformance/.
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
from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "media" / "review" / "standards-self-conformance"
VIEWPORTS = ((390, 844), (1440, 900))


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


def prepare_page(page: Page, base_url: str, state: str) -> dict[str, float]:
    page.route("https://**", lambda route: route.abort())
    page_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.goto(f"{base_url}standards.html", wait_until="domcontentloaded")
    page.wait_for_function("document.querySelectorAll('#langJoinBody tr').length === 10")
    page.wait_for_function("document.querySelectorAll('#timelineList .timeline-entry').length > 0")
    page.evaluate("document.fonts && document.fonts.ready")

    if state == "after":
        section = page.locator("#selfConformance")
        assert "WCAG 2.1 Level AA" in section.text_content()
        page.evaluate(
            """() => {
              const el = document.querySelector("#selfConformance");
              window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 100));
            }"""
        )
        target = section
    else:
        assert page.locator("#selfConformance").count() == 0
        page.evaluate(
            """() => {
              const el = document.querySelector('[data-i18n="std_h_accessibility"]');
              window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 100));
            }"""
        )
        target = page.locator('[data-i18n="std_h_posture"]')

    page.wait_for_timeout(150)
    box = target.bounding_box()
    if box is None:
        raise AssertionError(f"annotation target missing for {state}")
    if page_errors:
        raise AssertionError(f"{state} page errors: {page_errors}")
    return box


def annotate(source: Path, destination: Path, state: str, target: dict[str, float]) -> None:
    image = Image.open(source).convert("RGB")
    draw = ImageDraw.Draw(image, "RGBA")
    color = (155, 48, 48, 255) if state == "before" else (35, 112, 83, 255)
    message = (
        "Before: the page moves from government targets to implementation facts "
        "without stating CityScroll's own target."
        if state == "before"
        else "After: a scoped section states CityScroll's target and three continuous observations."
    )
    font = ImageFont.load_default(size=18 if image.width >= 700 else 15)
    label = "\n".join(textwrap.wrap(message, width=66 if image.width >= 700 else 38))
    text_box = draw.multiline_textbbox((0, 0), label, font=font, spacing=4)
    banner_height = text_box[3] - text_box[1] + 24
    draw.rounded_rectangle(
        (10, 10, image.width - 10, 10 + banner_height),
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
    image.save(destination, optimize=True)


def capture_state(browser, tree: Path, state: str, width: int, height: int) -> None:
    with StaticServer(tree) as base_url:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        target = prepare_page(page, base_url, state)
        raw = OUTPUT / f"{state}-{width}.png"
        page.screenshot(path=raw, animations="disabled")
        annotate(raw, OUTPUT / f"{state}-{width}-annotated.png", state, target)
        context.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", default="HEAD", help="revision before the change")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="crol-standards-posture-") as temp:
        before_tree = Path(temp) / "before"
        before_tree.mkdir()
        revision_snapshot(args.before, before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height in VIEWPORTS:
                    capture_state(browser, before_tree, "before", width, height)
                    capture_state(browser, ROOT, "after", width, height)
            finally:
                browser.close()

    print("Standards self-conformance browser checks passed.")
    for asset in sorted(OUTPUT.glob("*.png")):
        print(f"  {asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
