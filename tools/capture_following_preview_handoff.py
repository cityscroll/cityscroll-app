#!/usr/bin/env python3
"""Before/after capture: Following preview handoff from a notice and an unrecognized scope.

Frames at 390 and 1440:
  positive  meetings watch started from a notice
  empty     unrecognized lens (honest, no save)

    CROL_REGROUND_LABEL=before python3 tools/capture_following_preview_handoff.py
    CROL_REGROUND_LABEL=after python3 tools/capture_following_preview_handoff.py
"""

from __future__ import annotations

import functools
import json
import os
import subprocess
import textwrap
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = None
    ImageDraw = None
    ImageFont = None

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LABEL = os.environ.get("CROL_REGROUND_LABEL", "")
OUT = Path(
    os.environ.get(
        "CROL_REGROUND_OUT",
        str(ROOT / "docs" / "screenshots" / "following-preview-handoff"),
    )
)
SITE = Path(os.environ.get("CROL_REGROUND_ROOT", str(ROOT / "site")))
VIEWPORTS = ((390, 844), (1440, 900))

POSITIVE_BEFORE_QUERY = (
    "lens=meetings"
    "&filter=%7B%22agency%22%3A%22Transportation%22%7D"
    "&freq=daily"
)
POSITIVE_AFTER_QUERY = (
    "lens=meetings"
    "&filter=%7B%22agency%22%3A%22Transportation%22%7D"
    "&notice=20260716009"
    "&from=%2Fnotices%2F20260716009%2F"
    "&freq=daily"
)
EMPTY_BEFORE_QUERY = ""
EMPTY_AFTER_QUERY = "lens=not-a-lens&filter=%7B%22agency%22%3A%22Parks%22%7D"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path in {"/following", "/following/"}:
            body = render_following(self.server.public_base, parsed.query)
            payload = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()


class StaticServer:
    def __init__(self, directory: Path) -> None:
        handler = functools.partial(QuietHandler, directory=str(directory))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        base = f"http://127.0.0.1:{self.server.server_port}/"
        self.server.public_base = base
        return base

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def render_following(base: str, query: str) -> str:
    origin = str(base).rstrip("/")
    script = f"""
import {{ buildFollowingViewModel, renderFollowingDocument, watchFromFollowingParams }} from "./site/following_view.mjs";
const parsed = watchFromFollowingParams(new URLSearchParams({json.dumps(query)}));
const previewItems = parsed.noticeId === "20260716009" ? [{{
  id: "20260716009",
  title: "Dining Out NYC Public Hearing",
  url: "/notices/20260716009/",
  summary: "Transportation · event 2026-08-06",
  phase: "Hearing / meeting",
  nextStep: "Event 2026-08-06",
}}] : [];
const view = buildFollowingViewModel({{
  ...parsed,
  matchCount: parsed.scopeStatus === "unrecognized_scope" ? null : (previewItems.length || parsed.matchCount),
  previewItems,
}});
process.stdout.write(renderFollowingDocument(view, {{
  assetPrefix: "/",
  siteBase: {json.dumps(origin)},
}}));
"""
    html = subprocess.check_output(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
    )
    return html.replace("https://cityscroll.org/following", f"{origin}/following")


def annotate(source: Path, destination: Path, caption: str) -> None:
    if Image is None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.read_bytes())
        return
    image = Image.open(source).convert("RGB")
    font = ImageFont.load_default(size=15)
    pad = 14
    wrapped = textwrap.fill(caption, width=max(24, (image.width - 2 * pad) // 8))
    lines = wrapped.count("\n") + 1
    bar_height = 28 + (lines * 18)
    canvas = Image.new("RGB", (image.width, image.height + bar_height), "#1a1714")
    canvas.paste(image, (0, bar_height))
    draw = ImageDraw.Draw(canvas)
    draw.text((pad, 10), wrapped, fill="#f4efe4", font=font)
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, optimize=True)


def shot(page, base: str, name: str, path: str, wait_sel: str, caption: str, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base}{path.lstrip('/')}", wait_until="domcontentloaded")
    page.wait_for_selector(wait_sel, timeout=25_000)
    page.wait_for_timeout(400)
    prefix = f"{LABEL}-" if LABEL else ""
    raw = OUT / f"{prefix}{name}-{width}-raw.png"
    page.screenshot(path=str(raw), full_page=True)
    annotate(raw, OUT / f"{prefix}{name}-{width}.png", caption)
    raw.unlink(missing_ok=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with StaticServer(SITE) as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            frames = (
                (
                    "before-positive",
                    f"following/?{POSITIVE_BEFORE_QUERY}",
                    "[data-following-subscribe-panel], [data-following-preview-panel]",
                    "Before: meetings watch from a result, without the originating record on the preview.",
                ),
                (
                    "after-positive",
                    f"following/?{POSITIVE_AFTER_QUERY}",
                    "[data-following-preview-focus], [data-following-subscribe-panel]",
                    "After: same meetings watch, with the originating notice kept in preview and one save.",
                ),
                (
                    "before-empty",
                    "following/",
                    "[data-following-preview-form], [data-following-subscribe-panel]",
                    "Before: common Following landing, no watch yet.",
                ),
                (
                    "after-empty",
                    f"following/?{EMPTY_AFTER_QUERY}",
                    "[data-following-handoff-status], [data-following-preview-panel]",
                    "After: unrecognized scope stays honest and does not save a broader watch.",
                ),
            )
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                for name, path, wait_sel, caption in frames:
                    shot(page, base, name, path, wait_sel, caption, width, height)
                page.close()
        finally:
            browser.close()
    print(f"wrote {OUT} ({LABEL})")


if __name__ == "__main__":
    main()
