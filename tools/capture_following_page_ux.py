#!/usr/bin/env python3
"""Before/after capture: /following watches page UX refine.

Frames (each at 390 and 1440):
  create   mid-create URL with criteria (mandates/obligations watch)
  empty    bare /following landing

Env:
  CROL_REGROUND_LABEL   "before" | "after"  (default "after")
  CROL_REGROUND_OUT     output dir (default docs/screenshots/following-page-ux)
  CROL_REGROUND_ROOT    site root (default this worktree's site/)

    python3 tools/capture_following_page_ux.py
    CROL_REGROUND_LABEL=before python3 tools/capture_following_page_ux.py
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
from urllib.parse import quote

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LABEL = os.environ.get("CROL_REGROUND_LABEL", "after")
OUT = Path(
    os.environ.get(
        "CROL_REGROUND_OUT",
        str(ROOT / "docs" / "screenshots" / "following-page-ux"),
    )
)
SITE = Path(os.environ.get("CROL_REGROUND_ROOT", str(ROOT / "site")))
VIEWPORTS = ((390, 844), (1440, 900))

# Site-owner arrival path: mandate watch with place-ish agency criteria.
CREATE_FILTER = {
    "agency_id": "parks-and-recreation",
    "agency": "Parks and Recreation",
    "windowDays": 90,
}
# Before uses obligations; after prefers mandates (renderer normalizes either).
CREATE_LENS = "obligations" if LABEL == "before" else "mandates"


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


def annotate(source: Path, destination: Path, caption: str) -> None:
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


def render_following(base: str, *, lens: str | None, filter_obj: dict | None, freq: str | None) -> str:
    script = f"""
import {{ readFileSync }} from "node:fs";
import {{ buildFollowingViewModel, renderFollowingDocument, watchFromFollowingParams }} from "./site/following_view.mjs";
const templates = JSON.parse(readFileSync("./site/data/watch_templates.json", "utf8"));
const params = new URLSearchParams();
const lens = {json.dumps(lens)};
const filterObj = {json.dumps(filter_obj)};
const freq = {json.dumps(freq)};
if (lens) params.set("lens", lens);
if (filterObj) params.set("filter", JSON.stringify(filterObj));
if (freq) params.set("freq", freq);
const parsed = watchFromFollowingParams(params);
const view = buildFollowingViewModel({{
  ...parsed,
  matchCount: parsed.requested ? 3 : null,
  previewItems: parsed.requested ? [{{
    id: "mandate-preview-1",
    title: "Parks and Recreation — annual report due",
    url: "/agencies/parks-and-recreation/#mandates",
    summary: "Report · next 90 days",
  }}] : [],
}}, templates);
process.stdout.write(renderFollowingDocument(view, {{
  assetPrefix: {json.dumps(base)},
  siteBase: {json.dumps(base.rstrip("/"))},
}}));
"""
    return subprocess.check_output(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
    )


def shot(page, base: str, name: str, html: str, caption: str, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.set_content(html, wait_until="domcontentloaded")
    # Resolve relative CSS against the static site origin.
    page.evaluate(
        """(base) => {
      for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
        const href = link.getAttribute('href') || '';
        if (href.startsWith('http')) continue;
        link.href = new URL(href, base).href;
      }
      for (const script of document.querySelectorAll('script[src]')) {
        const src = script.getAttribute('src') || '';
        if (src.startsWith('http')) continue;
        script.src = new URL(src, base).href;
      }
    }""",
        base,
    )
    page.wait_for_selector("#main", timeout=15_000)
    page.wait_for_timeout(500)
    raw = OUT / f"{LABEL}-{name}-{width}-raw.png"
    page.screenshot(path=str(raw), full_page=False)
    annotate(raw, OUT / f"{LABEL}-{name}-{width}.png", caption)
    raw.unlink(missing_ok=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    if not (SITE / "index.html").is_file():
        raise SystemExit(f"site root missing index.html: {SITE}")
    with StaticServer(SITE) as base, sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        create_html = render_following(
            base,
            lens=CREATE_LENS,
            filter_obj=CREATE_FILTER,
            freq="weekly",
        )
        empty_html = render_following(base, lens=None, filter_obj=None, freq=None)
        for width, height in VIEWPORTS:
            shot(
                page,
                base,
                "create",
                create_html,
                f"{LABEL}: mid-create watch criteria ({CREATE_LENS}) — create flow first",
                width,
                height,
            )
            shot(
                page,
                base,
                "empty",
                empty_html,
                f"{LABEL}: bare Following — topic/place pickers, not empty-saved pinned top",
                width,
                height,
            )
        browser.close()
    # Keep a shareable deep-link sample in the receipt folder.
    sample = (
        f"/following?lens={CREATE_LENS}"
        f"&filter={quote(json.dumps(CREATE_FILTER, separators=(',', ':')))}"
        f"&freq=weekly"
    )
    (OUT / f"{LABEL}-sample-url.txt").write_text(sample + "\n", encoding="utf-8")
    print(f"wrote {LABEL} frames under {OUT}")


if __name__ == "__main__":
    main()
