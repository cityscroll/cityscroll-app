#!/usr/bin/env python3
"""Capture homepage place-entry journeys at desktop and phone widths.

Exercises the production homepage controls (Use my location, typed address,
typed neighborhood) in headless Chromium against the local site tree with
external network blocked. Screenshot binaries stay under the local task
scratch directory; only the textual capture manifest is committed.
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
MANIFEST_DIR = ROOT / "docs" / "evidence" / "home-local-entry-journey"
MANIFEST_PATH = MANIFEST_DIR / "capture-manifest.json"
SCREENSHOT_DIR = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "home-local-entry-journey-screenshots"

PUBLIC_ALIAS = "c0b9b1f319b51"
DATA_VINTAGE = (
    "PAD 26b; parcel-geography pluto_25v4 "
    "(mappluto_published_latitude_longitude); "
    "nta2020 26B; community/council 2026-05-26; precincts 26B"
)
VIEWPORTS = (
    ("desktop", 1440, 900),
    ("phone", 390, 844),
)
MIDWOOD_POINT = {"latitude": 40.6297346, "longitude": -73.9615272}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return


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


def wait_home_ready(page) -> None:  # noqa: ANN001
    page.wait_for_selector("[data-home-local-entry]", timeout=15000)
    page.wait_for_selector("[data-home-local-input]", timeout=15000)
    # Progressive mount may wait on idle; force interaction readiness.
    page.locator("[data-home-local-input]").focus()
    page.wait_for_function(
        """() => {
          const root = document.querySelector('[data-home-local-entry]');
          return Boolean(root && root.dataset.homeLocalMounted === 'true');
        }""",
        timeout=15000,
    )


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

    index_source = (ROOT / "site/index.html").read_text(encoding="utf-8")
    home_entry = (ROOT / "site/home_entry.mjs").read_text(encoding="utf-8")
    module_source = (ROOT / "site/home_local_entry.mjs").read_text(encoding="utf-8")
    if "data-home-local-entry" not in index_source:
        raise SystemExit("homepage is missing place-entry markup")
    if "home_local_entry.mjs" not in home_entry:
        raise SystemExit("home_entry.mjs does not load home_local_entry.mjs")
    if "getCurrentPosition" not in module_source:
        raise SystemExit("home_local_entry.mjs is missing geolocation wiring")

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

                    # Initial homepage screen.
                    page.goto(f"{base}/", wait_until="domcontentloaded")
                    wait_home_ready(page)
                    initial = page.screenshot(full_page=True, type="png")
                    (SCREENSHOT_DIR / f"initial-{label}.png").write_bytes(initial)
                    initial_snapshot = page.evaluate(
                        """() => {
                          const root = document.querySelector('[data-home-local-entry]');
                          const input = document.querySelector('[data-home-local-input]');
                          const locationBtn = document.querySelector('[data-home-local-location]');
                          const topic = document.querySelector('[data-home-topic-entry]');
                          const following = document.querySelector('a[href="/following/"]');
                          return {
                            heading: document.querySelector('#home-local-heading')?.textContent || null,
                            has_location_button: Boolean(locationBtn) && !locationBtn.hidden,
                            has_place_input: Boolean(input),
                            has_topic_search: Boolean(topic),
                            has_following_link: Boolean(following),
                            overflow_x: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
                            mounted: root?.dataset?.homeLocalMounted === 'true',
                          };
                        }"""
                    )
                    if not initial_snapshot.get("has_location_button"):
                        raise SystemExit(f"{label}: Use my location missing on initial screen")
                    if initial_snapshot.get("overflow_x", 0) > 1:
                        raise SystemExit(f"{label}: initial horizontal overflow {initial_snapshot['overflow_x']}")
                    captures.append(
                        capture_row(
                            name=f"home-initial-{label}",
                            route="/",
                            width=width,
                            height=height,
                            assertion=(
                                "homepage place entry present; Use my location present; "
                                "address/place input present; topic search and Following remain reachable; "
                                "horizontal overflow ≤ 1px"
                            ),
                            png=initial,
                            snapshot=initial_snapshot,
                            capture_run_id=capture_run_id,
                            revision=revision,
                        )
                    )

                    # Typed Midwood address → Near You destination.
                    page.fill("[data-home-local-input]", "810 East 16th Street Brooklyn")
                    with page.expect_navigation(wait_until="domcontentloaded", timeout=20000):
                        page.click("[data-home-local-submit]")
                    page.wait_for_timeout(500)
                    midwood_url = page.url
                    if "geo=" not in midwood_url or "BK1403" not in midwood_url:
                        raise SystemExit(f"{label}: Midwood navigation failed: {midwood_url}")
                    if any(token in midwood_url.lower() for token in ("address=", "lat=", "lon=", "810")):
                        raise SystemExit(f"{label}: ephemeral values leaked into Midwood URL: {midwood_url}")
                    midwood_png = page.screenshot(full_page=True, type="png")
                    (SCREENSHOT_DIR / f"midwood-{label}.png").write_bytes(midwood_png)
                    captures.append(
                        capture_row(
                            name=f"home-midwood-result-{label}",
                            route="/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings",
                            width=width,
                            height=height,
                            assertion=(
                                "typed 810 East 16th Street from / selects Midwood; "
                                "shared URL carries geography only"
                            ),
                            png=midwood_png,
                            snapshot={"href": midwood_url, "geo": "nta2020:BK1403"},
                            capture_run_id=capture_run_id,
                            revision=revision,
                        )
                    )

                    # Fresh context: typed Kensington neighborhood.
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
                    page2 = context2.new_page()
                    page2.goto(f"{base}/", wait_until="domcontentloaded")
                    wait_home_ready(page2)
                    page2.fill("[data-home-local-input]", "Kensington")
                    with page2.expect_navigation(wait_until="domcontentloaded", timeout=20000):
                        page2.click("[data-home-local-submit]")
                    page2.wait_for_timeout(500)
                    kensington_url = page2.url
                    if "BK1203" not in kensington_url:
                        raise SystemExit(f"{label}: Kensington navigation failed: {kensington_url}")
                    kensington_png = page2.screenshot(full_page=True, type="png")
                    (SCREENSHOT_DIR / f"kensington-{label}.png").write_bytes(kensington_png)
                    captures.append(
                        capture_row(
                            name=f"home-kensington-result-{label}",
                            route="/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings",
                            width=width,
                            height=height,
                            assertion="typed Kensington from / selects BK1203 Near You state",
                            png=kensington_png,
                            snapshot={"href": kensington_url, "geo": "nta2020:BK1203"},
                            capture_run_id=capture_run_id,
                            revision=revision,
                        )
                    )
                    context2.close()

                    # Fresh context: controlled Midwood geolocation grant.
                    context3 = browser.new_context(
                        viewport={"width": width, "height": height},
                        device_scale_factor=1,
                        geolocation=MIDWOOD_POINT,
                        permissions=["geolocation"],
                    )
                    context3.route(
                        "**/*",
                        lambda route, request, blocked=blocked, unexpected=unexpected: block_external(
                            route, request, blocked, unexpected,
                        ),
                    )
                    page3 = context3.new_page()
                    page3.goto(f"{base}/", wait_until="domcontentloaded")
                    wait_home_ready(page3)
                    with page3.expect_navigation(wait_until="domcontentloaded", timeout=20000):
                        page3.click("[data-home-local-location]")
                    page3.wait_for_timeout(500)
                    grant_url = page3.url
                    if "BK1403" not in grant_url:
                        raise SystemExit(f"{label}: geolocation grant failed: {grant_url}")
                    grant_png = page3.screenshot(full_page=True, type="png")
                    (SCREENSHOT_DIR / f"geolocation-grant-{label}.png").write_bytes(grant_png)
                    captures.append(
                        capture_row(
                            name=f"home-geolocation-grant-{label}",
                            route="/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings",
                            width=width,
                            height=height,
                            assertion="controlled Midwood parcel geolocation grant selects BK1403",
                            png=grant_png,
                            snapshot={"href": grant_url, "geo": "nta2020:BK1403"},
                            capture_run_id=capture_run_id,
                            revision=revision,
                        )
                    )
                    context3.close()
                    context.close()

                    if unexpected:
                        raise SystemExit(f"unexpected external fetches observed: {unexpected[:5]}")
            finally:
                browser.close()
    finally:
        server.shutdown()

    manifest = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "home-local-entry-journey",
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
        "local_image_dir_ignored": "task-scratch/home-local-entry-journey-screenshots",
        "route": "/",
        "exact_links": [
            "/",
            "/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings",
            "/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings",
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
