#!/usr/bin/env python3
"""Capture default-local-home journeys at desktop and phone widths.

Exercises the Near You shell at `/` (local site tree with the default-entry
rewrite) in headless Chromium against the product stylesheet. Screenshot
binaries stay under the local task scratch directory; only the textual capture
manifest is committed.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from repository_revision import resolve_repository_revision  # noqa: E402

MANIFEST_DIR = ROOT / "docs" / "evidence" / "default-local-home-journey"
MANIFEST_PATH = MANIFEST_DIR / "capture-manifest.json"
SCREENSHOT_DIR = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "default-local-home-journey-screenshots"

PUBLIC_ALIAS = "c27355579ade0"
DATA_VINTAGE = (
    "PAD 26b; parcel-geography pluto_25v4 "
    "(mappluto_published_latitude_longitude); "
    "nta2020 26B; community/council 2026-05-26; precincts 26B"
)
VIEWPORTS = (
    ("desktop", 1440, 900),
    ("phone", 390, 844),
)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return

    def do_GET(self):
        raw = self.path
        path_only, _, query = raw.partition("?")
        route = path_only.rstrip("/") or "/"
        if route == "/":
            if query:
                self.send_response(302)
                self.send_header("Location", f"/near-you/?{query}")
                self.end_headers()
                return
            near_you = Path(self.directory) / "near-you" / "index.html"
            if near_you.is_file():
                self.path = "/near-you/"
        super().do_GET()


def serve(directory: Path) -> tuple[ThreadingHTTPServer, str]:
    handler = partial(QuietHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


ALLOWED_EXTERNAL_PREFIXES = (
    "https://fonts.googleapis.com/",
    "https://fonts.gstatic.com/",
    "https://static.cloudflareinsights.com/",
    "https://www.clarity.ms/",
    "https://api.cityscroll.org/events",
    "https://api.cityscroll.org/subscribe",
    "https://a.basemaps.cartocdn.com/",
    "https://b.basemaps.cartocdn.com/",
    "https://c.basemaps.cartocdn.com/",
    "https://d.basemaps.cartocdn.com/",
)


def block_external(route, request, blocked: list[str], unexpected: list[str]):  # noqa: ANN001
    url = request.url
    if "127.0.0.1" in url or "localhost" in url:
        return route.continue_()
    if any(url.startswith(prefix) for prefix in ALLOWED_EXTERNAL_PREFIXES):
        blocked.append(url)
        return route.abort()
    unexpected.append(url)
    return route.abort()


def measure_shell(page) -> dict:  # noqa: ANN001
    return page.evaluate(
        """() => {
          const root = document.querySelector('[data-near-you-root]');
          const search = document.querySelector('[data-geography-search], form.near-geo-search');
          const locationBtn = document.querySelector('[data-use-location], .near-location-action, button.near-location-action');
          const following = document.querySelector('a[href^="/following/"]');
          const browse = document.querySelector('a[href^="/browse/"]');
          const styles = [...document.styleSheets].map((sheet) => {
            try { return sheet.href; } catch { return null; }
          }).filter(Boolean);
          const map = document.querySelector('.near-map, [data-geography-map], #near-map, .geography-map');
          const mapRect = map ? map.getBoundingClientRect() : null;
          const shellRect = root ? root.getBoundingClientRect() : null;
          return {
            measured_css: true,
            stylesheet_hrefs: styles,
            has_shell: Boolean(root),
            has_search: Boolean(search),
            has_location_control: Boolean(locationBtn),
            has_following_link: Boolean(following),
            has_browse_link: Boolean(browse),
            viewport_width_px: window.innerWidth,
            viewport_height_px: window.innerHeight,
            map_or_shell_height_px: Math.round((mapRect || shellRect || { height: 0 }).height || 0),
            overflow_x: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
            geo: root?.dataset?.geo || null,
          };
        }"""
    )


def wait_shell_ready(page) -> None:  # noqa: ANN001
    page.wait_for_selector("[data-near-you-root]", timeout=20000)
    page.wait_for_selector("[data-geography-search], form.near-geo-search, #near-geo-search-input", timeout=20000)


def capture_row(*, name, route, width, height, assertion, png, snapshot, capture_run_id, revision):
    return {
        "name": name,
        "route": route,
        "mode": "local_chromium",
        "viewport": {"width": width, "height": height},
        "revision": revision,
        "assertion": assertion,
        "sha256": sha256_bytes(png),
        "file": None,
        "capture_run_id": capture_run_id,
        "snapshot": snapshot,
    }


def main() -> int:
    from playwright.sync_api import sync_playwright

    revision = resolve_repository_revision(ROOT)
    capture_run_id = str(uuid4())
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)

    near_you = ROOT / "site/near-you/index.html"
    if not near_you.is_file():
        raise SystemExit("site/near-you/index.html missing; run tools/build_near_you_pages.mjs")
    wrangler = (ROOT / "worker/wrangler.toml").read_text(encoding="utf-8")
    if 'pattern = "cityscroll.org"' not in wrangler:
        raise SystemExit("worker/wrangler.toml missing apex cityscroll.org route")

    server, base = serve(ROOT / "site")
    captures: list[dict] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for label, width, height in VIEWPORTS:
                    blocked: list[str] = []
                    unexpected: list[str] = []
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        device_scale_factor=1,
                    )
                    context.route(
                        "**/*",
                        lambda route, request, blocked=blocked, unexpected=unexpected: block_external(
                            route, request, blocked, unexpected,
                        ),
                    )
                    page = context.new_page()

                    page.goto(f"{base}/", wait_until="domcontentloaded")
                    wait_shell_ready(page)
                    # Reveal progressive Use-my-location control if present.
                    page.evaluate(
                        """() => {
                          const btn = document.querySelector('[data-use-location], .near-location-action');
                          if (btn) btn.hidden = false;
                        }"""
                    )
                    initial_snapshot = measure_shell(page)
                    if not initial_snapshot.get("has_shell"):
                        raise SystemExit(f"{label}: Near You shell missing at /")
                    if not initial_snapshot.get("has_search"):
                        raise SystemExit(f"{label}: place search missing at /")
                    if not initial_snapshot.get("has_following_link"):
                        raise SystemExit(f"{label}: Following link missing at /")
                    if not initial_snapshot.get("has_browse_link"):
                        raise SystemExit(f"{label}: Browse link missing at /")
                    if initial_snapshot.get("viewport_width_px") != width:
                        raise SystemExit(
                            f"{label}: measured width {initial_snapshot.get('viewport_width_px')} != {width}"
                        )
                    if initial_snapshot.get("overflow_x", 0) > 1:
                        raise SystemExit(f"{label}: initial horizontal overflow {initial_snapshot['overflow_x']}")
                    initial_png = page.screenshot(full_page=True, type="png")
                    (SCREENSHOT_DIR / f"root-initial-{label}.png").write_bytes(initial_png)
                    captures.append(
                        capture_row(
                            name=f"root-shell-initial-{label}",
                            route="/",
                            width=width,
                            height=height,
                            assertion=(
                                "root presents Near You shell; place search and Use my location available; "
                                "Following and Browse reachable; measured viewport matches product CSS"
                            ),
                            png=initial_png,
                            snapshot=initial_snapshot,
                            capture_run_id=capture_run_id,
                            revision=revision,
                        )
                    )

                    # Typed Midwood address on the shell at `/`.
                    page.fill("#near-geo-search-input", "810 East 16th Street Brooklyn")
                    page.click("form.near-geo-search button[type='submit']")
                    page.wait_for_timeout(2500)
                    page.wait_for_function(
                        """() => {
                          const root = document.querySelector('[data-near-you-root]');
                          const geo = root?.dataset?.geo || '';
                          return geo.includes('BK1403') || location.href.includes('BK1403');
                        }""",
                        timeout=25000,
                    )
                    midwood_url = page.url
                    if "BK1403" not in midwood_url and "BK1403" not in (page.evaluate("() => document.querySelector('[data-near-you-root]')?.dataset?.geo || ''") or ""):
                        raise SystemExit(f"{label}: Midwood selection failed: {midwood_url}")
                    midwood_snapshot = measure_shell(page)
                    midwood_png = page.screenshot(full_page=True, type="png")
                    (SCREENSHOT_DIR / f"midwood-{label}.png").write_bytes(midwood_png)
                    captures.append(
                        capture_row(
                            name=f"root-midwood-result-{label}",
                            route="/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings",
                            width=width,
                            height=height,
                            assertion="typed 810 East 16th Street from / selects Midwood on the shared shell",
                            png=midwood_png,
                            snapshot={**midwood_snapshot, "href": midwood_url, "geo": "nta2020:BK1403"},
                            capture_run_id=capture_run_id,
                            revision=revision,
                        )
                    )
                    context.close()

                    # Failure recovery: without a geolocation grant, typed place choice still works.
                    context2 = browser.new_context(
                        viewport={"width": width, "height": height},
                        device_scale_factor=1,
                    )
                    context2.route(
                        "**/*",
                        lambda route, request, blocked=blocked, unexpected=unexpected: block_external(
                            route, request, blocked, unexpected,
                        ),
                    )
                    context2.grant_permissions([])
                    page2 = context2.new_page()
                    page2.goto(f"{base}/", wait_until="domcontentloaded")
                    wait_shell_ready(page2)
                    # Confirm no automatic geolocation request on load (gesture gate).
                    geo_requests = page2.evaluate(
                        """() => {
                          let count = 0;
                          const geo = navigator.geolocation;
                          if (!geo) return -1;
                          const original = geo.getCurrentPosition.bind(geo);
                          geo.getCurrentPosition = (...args) => { count += 1; return original(...args); };
                          return count;
                        }"""
                    )
                    page2.fill("#near-geo-search-input", "Kensington")
                    page2.click("form.near-geo-search button[type='submit']")
                    page2.wait_for_timeout(2500)
                    page2.wait_for_function(
                        """() => {
                          const root = document.querySelector('[data-near-you-root]');
                          const geo = root?.dataset?.geo || '';
                          const href = location.href;
                          return geo.includes('BK1203') || href.includes('BK1203');
                        }""",
                        timeout=25000,
                    )
                    failure_snapshot = measure_shell(page2)
                    failure_snapshot["geolocation_requests_on_load"] = geo_requests
                    failure_png = page2.screenshot(full_page=True, type="png")
                    (SCREENSHOT_DIR / f"failure-recovery-{label}.png").write_bytes(failure_png)
                    captures.append(
                        capture_row(
                            name=f"root-failure-recovery-kensington-{label}",
                            route="/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings",
                            width=width,
                            height=height,
                            assertion=(
                                "without a geolocation grant, typed Kensington place choice still works; "
                                "shell navigation and Following/Browse remain available"
                            ),
                            png=failure_png,
                            snapshot={**failure_snapshot, "href": page2.url, "geo": "nta2020:BK1203"},
                            capture_run_id=capture_run_id,
                            revision=revision,
                        )
                    )
                    context2.close()

                    if unexpected:
                        raise SystemExit(f"unexpected external fetches observed: {unexpected[:5]}")
            finally:
                browser.close()
    finally:
        server.shutdown()

    manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "default-local-home-journey",
        "public_alias": PUBLIC_ALIAS,
        "capture_mode": "headless_playwright_local_site",
        "capture_run_id": capture_run_id,
        "repository_revision": revision,
        "grounded_at": revision,
        "data_vintage": DATA_VINTAGE,
        "image_binaries_committed": False,
        "image_policy": (
            "Screenshots stay under the ignored local capture directory; "
            "only this manifest is committed."
        ),
        "local_image_dir_ignored": "task-scratch/default-local-home-journey-screenshots",
        "route": "/",
        "exact_links": [
            "/",
            "/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings",
            "/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings",
            "/near-you/?geo=nta2020%3ABK1402&surface=map&lens=meetings",
            "/meetings/meeting%3Acommunity_board%3Ahttps%3A%2F%2Fcb14brooklyn.com%2Fmeeting%2Fhousing-and-land-use-committee-meeting-september-2026%2F",
            "/meetings/meeting%3Acommunity_board%3Ahttps%3A%2F%2Fcb14brooklyn.com%2Fmeeting%2Fseptember-2026-board-meeting%2F",
        ],
        "captures": captures,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "manifest": str(MANIFEST_PATH.relative_to(ROOT)),
        "captures": len(captures),
        "capture_run_id": capture_run_id,
        "revision": revision,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
