#!/usr/bin/env python3
"""Before/after capture: Create-a-watch topic/place click tab bounce.

Replays the recognized-session path: existing watches, Create a watch,
click a topic chip, then a place chip. Records the URL sequence and the
active tab after each click.

    CROL_REGROUND_LABEL=before python3 tools/capture_following_create_tab_bounce.py
    CROL_REGROUND_LABEL=after python3 tools/capture_following_create_tab_bounce.py
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

from playwright.sync_api import Route, sync_playwright

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # host capture can still write raw frames
    Image = None
    ImageDraw = None
    ImageFont = None

ROOT = Path(__file__).resolve().parents[1]
LABEL = os.environ.get("CROL_REGROUND_LABEL", "after")
OUT = Path(
    os.environ.get(
        "CROL_REGROUND_OUT",
        str(ROOT / "docs" / "screenshots" / "following-create-tab-bounce"),
    )
)
SITE = Path(os.environ.get("CROL_REGROUND_ROOT", str(ROOT / "site")))
VIEWPORT = (1440, 900)

PERSONAL_HTML = """
<div data-session-recognized="true">
  <article class="following-watch" data-watch-key="sub:fixture" data-watch-lens="meetings"
    data-watch-filter="{&quot;borough&quot;:&quot;Queens&quot;}">
    <div class="following-watch-heading"><h3>Queens public meetings</h3><p class="watch-meta">Active</p></div>
  </article>
</div>
"""


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
import {{ readFileSync }} from "node:fs";
import {{ buildFollowingViewModel, renderFollowingDocument, watchFromFollowingParams }} from "./site/following_view.mjs";
const templates = JSON.parse(readFileSync("./site/data/watch_templates.json", "utf8"));
const params = new URLSearchParams({json.dumps(query)});
const parsed = watchFromFollowingParams(params);
const view = buildFollowingViewModel({{
  ...parsed,
  matchCount: parsed.requested ? 2 : null,
  previewItems: parsed.requested ? [{{
    id: "mandate-preview-1",
    title: "Parks and Recreation — annual report due",
    url: "/agencies/parks-and-recreation/#mandates",
    summary: "Report · next 90 days",
  }}] : [],
}}, templates);
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


def tab_state(page) -> dict[str, object]:
    return page.evaluate(
        """() => {
          const selected = document.querySelector('[data-following-tab][aria-selected="true"]');
          const create = document.querySelector('#create');
          const watches = document.querySelector('#your-following');
          return {
            url: location.href,
            tab: selected ? selected.dataset.followingTab : null,
            tabLabel: selected ? selected.textContent.trim() : null,
            createVisible: !!(create && !create.hidden),
            watchesVisible: !!(watches && !watches.hidden),
          };
        }"""
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    receipt: list[dict[str, object]] = []
    with StaticServer(SITE) as base, sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.set_viewport_size({"width": VIEWPORT[0], "height": VIEWPORT[1]})

        origin = base.rstrip("/")
        cors = {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Headers": "Accept, Content-Type",
        }

        def api(route: Route) -> None:
            if route.request.method == "OPTIONS":
                route.fulfill(status=204, headers=cors, body="")
                return
            path = urlparse(route.request.url).path
            if path == "/following/personal":
                route.fulfill(status=200, content_type="text/html", headers=cors, body=PERSONAL_HTML)
            else:
                route.fulfill(status=404, content_type="application/json", headers=cors, body="{}")

        page.route("https://api.cityscroll.org/**", api)

        logs: list[str] = []
        page.on("console", lambda msg: logs.append(f"{msg.type}: {msg.text}"))
        page.on("pageerror", lambda err: logs.append(f"pageerror: {err}"))
        page.on("requestfailed", lambda req: logs.append(f"failed {req.url} {req.failure}"))
        page.goto(f"{base}following/", wait_until="domcontentloaded", timeout=30_000)
        try:
            page.locator('[data-personal-watch-list] [data-session-recognized="true"]').wait_for(state="attached", timeout=8_000)
        except Exception:
            print("DEBUG logs:\n" + "\n".join(logs[-40:]))
            print("DEBUG url", page.url)
            print("DEBUG html snippet", page.content()[:1500])
            raise
        page.locator('[data-following-tab="watches"][aria-selected="true"]').wait_for(timeout=10_000)
        receipt.append({"step": "land-with-watches", **tab_state(page)})
        shot(page, "land-watches", "existing watches promote Your watches")

        page.get_by_role("tab", name="Create a watch").click()
        page.locator('[data-following-tab="create"][aria-selected="true"]').wait_for()
        receipt.append({"step": "click-create-tab", **tab_state(page)})
        shot(page, "in-create", "Create a watch selected before topic click")

        page.locator('[data-following-scope-axis="topic"][data-following-scope-value="mandates"]').click()
        page.wait_for_url("**lens=mandates**", timeout=15_000)
        page.locator('[data-personal-watch-list] [data-session-recognized="true"]').wait_for(state="attached")
        page.wait_for_timeout(400)
        after_topic = tab_state(page)
        receipt.append({"step": "click-topic-mandates", **after_topic})
        shot(
            page,
            "after-topic",
            f"{LABEL}: after Mandates topic click — tab={after_topic['tabLabel']}",
        )

        if after_topic["tab"] != "create":
            page.get_by_role("tab", name="Create a watch").click()
            page.locator('[data-following-tab="create"][aria-selected="true"]').wait_for()

        page.locator('[data-following-scope-axis="place"][data-following-scope-value="Queens"]').click()
        page.wait_for_url("**Queens**", timeout=15_000)
        page.locator('[data-personal-watch-list] [data-session-recognized="true"]').wait_for(state="attached")
        page.wait_for_timeout(400)
        after_place = tab_state(page)
        receipt.append({"step": "click-place-queens", **after_place})
        shot(
            page,
            "after-place",
            f"{LABEL}: after Queens place click — tab={after_place['tabLabel']}",
        )

        browser.close()

    (OUT / f"{LABEL}-url-sequence.json").write_text(
        json.dumps({"label": LABEL, "steps": receipt}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {LABEL} frames under {OUT}")
    print(json.dumps(receipt, indent=2))


def shot(page, name: str, caption: str) -> None:
    raw = OUT / f"{LABEL}-{name}-raw.png"
    page.screenshot(path=str(raw), full_page=False)
    annotate(raw, OUT / f"{LABEL}-{name}.png", caption)
    raw.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
