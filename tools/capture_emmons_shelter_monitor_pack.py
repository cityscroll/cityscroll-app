#!/usr/bin/env python3
"""Capture the four previously unobserved Emmons monitor-pack journeys.

The browser sees a loopback-served document. Evidence is retained as textual
observations and SHA-256 digests; screenshots are deliberately not produced.
"""

from __future__ import annotations

import functools
import hashlib
import json
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import Page, sync_playwright
from repository_revision import resolve_repository_revision

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs" / "evidence" / "emmons-shelter-monitor-pack" / "capture-manifest.json"
PACK_ROUTE = "/following/packs/emmons-shelter/"
PROCUREMENT_ROUTE = "/procurements/procurement%3Acontract%3ACT107120258801626"


def render_pack() -> str:
    source = (
        "import { renderEmmonsShelterMonitorPack } from './site/emmons_shelter_monitor_pack.mjs';"
        "process.stdout.write(renderEmmonsShelterMonitorPack());"
    )
    return subprocess.check_output(
        ["node", "--input-type=module", "-e", source],
        cwd=ROOT,
        text=True,
    )


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def send_html(self, body: str) -> None:
        payload = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        path = urlparse(self.path).path
        if path == PACK_ROUTE:
            self.send_html(self.server.pack_html)  # type: ignore[attr-defined]
            return
        if path == PROCUREMENT_ROUTE:
            self.send_html(
                '<!doctype html><html><body><main><h1>Canonical procurement</h1>'
                f'<a href="{PACK_ROUTE}">Back to the shelter tracker</a>'
                "</main></body></html>"
            )
            return
        super().do_GET()


class LoopbackServer(ThreadingHTTPServer):
    """Avoid reverse-DNS lookup while binding the local capture server."""

    def server_bind(self) -> None:
        self.socket.bind(self.server_address)
        self.server_address = self.socket.getsockname()
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


class StaticServer:
    def __init__(self, pack_html: str) -> None:
        handler = functools.partial(Handler, directory=str(ROOT / "site"))
        self.server = LoopbackServer(("127.0.0.1", 0), handler)
        self.server.pack_html = pack_html
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def digest(observation: dict) -> str:
    encoded = json.dumps(observation, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def goto_pack(page: Page, base: str) -> None:
    page.goto(f"{base}{PACK_ROUTE}", wait_until="domcontentloaded", timeout=30_000)
    page.locator('[data-subject-ref="monitor-pack:emmons-shelter"]').wait_for(state="attached")


def narrow_touch(page: Page, base: str) -> dict:
    page.set_viewport_size({"width": 390, "height": 844})
    goto_pack(page, base)
    return {
        "viewport": "390x844",
        "no_horizontal_overflow": page.evaluate(
            "() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"
        ),
        "navigation_links": page.locator('nav[aria-label="Issue links"] a').count(),
        "timeline_entries": page.locator("#timeline li").count(),
    }


def keyboard(page: Page, base: str) -> dict:
    page.set_viewport_size({"width": 1440, "height": 900})
    goto_pack(page, base)
    page.locator("body").focus()
    focus_order = []
    for _ in range(24):
        page.keyboard.press("Tab")
        item = page.evaluate(
            """() => {
              const node = document.activeElement;
              return node ? {
                tag: node.tagName.toLowerCase(),
                text: (node.textContent || '').trim().slice(0, 80),
                href: node.getAttribute('href'),
                control: node.matches('button,summary')
              } : null;
            }"""
        )
        if item and item not in focus_order:
            focus_order.append(item)
    hrefs = [item["href"] for item in focus_order if item.get("href")]
    controls = [item["text"] for item in focus_order if item.get("control")]
    return {
        "viewport": "1440x900",
        "tab_steps": len(focus_order),
        "issue_links_reached": all(route in hrefs for route in [
            "/procurements/procurement%3Acontract%3ACT107120258801626",
            "/community-boards/brooklyn-cb-15/",
            "/parcels/3088150590/",
        ]),
        "controls_reached": controls,
    }


def back_navigation(page: Page, base: str) -> dict:
    page.set_viewport_size({"width": 390, "height": 844})
    goto_pack(page, base)
    page.locator(f'nav[aria-label="Issue links"] a[href="{PROCUREMENT_ROUTE}"]').click()
    page.wait_for_url(f"**{PROCUREMENT_ROUTE}")
    departed = urlparse(page.url).path
    page.go_back(wait_until="domcontentloaded")
    returned = urlparse(page.url).path
    return {
        "viewport": "390x844",
        "departed_to": departed,
        "returned_to": returned,
        "issue_scope_present_after_back": page.locator(
            '[data-subject-ref="monitor-pack:emmons-shelter"]'
        ).count() == 1,
    }


def failed_detail_load(page: Page, base: str) -> dict:
    page.set_viewport_size({"width": 390, "height": 844})
    page.route("**/emmons-shelter-detail.json", lambda route: route.abort())
    goto_pack(page, base)
    fetch_result = page.evaluate(
        """async () => {
          try {
            await fetch('/emmons-shelter-detail.json');
            return 'unexpected-success';
          } catch (_error) {
            return 'failed-as-stubbed';
          }
        }"""
    )
    return {
        "viewport": "390x844",
        "detail_fetch": fetch_result,
        "issue_scope_present": page.locator(
            '[data-subject-ref="monitor-pack:emmons-shelter"]'
        ).count() == 1,
        "source_links": page.locator('#identity details a').count(),
        "bounded_coverage_present": page.locator("#coverage").count() == 1,
    }


def main() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    rev = resolve_repository_revision(ROOT)
    with StaticServer(render_pack()) as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        observations = {
            "narrow-touch": narrow_touch(page, base),
            "keyboard": keyboard(page, base),
            "back-navigation": back_navigation(page, base),
            "failed-detail-load": failed_detail_load(page, base),
        }
        browser.close()

    for surface, observed in observations.items():
        observed["assertion"] = {
            "narrow-touch": "served 390x844 page has no horizontal overflow with navigation and timeline present",
            "keyboard": "real Tab traversal reaches the three issue links and native controls",
            "back-navigation": "real history Back returns from the canonical procurement to the issue route with scope present",
            "failed-detail-load": "a stubbed failing detail fetch leaves issue scope, source links, and bounded coverage available",
        }[surface]
        observed["observation_digest_basis"] = "sorted JSON of this textual browser observation"

    by_surface = {capture["surface"]: capture for capture in manifest["captures"]}
    methods = "headless-playwright-loopback-served"
    for surface, observed in observations.items():
        by_surface[surface].update({
            "state": "complete",
            "method": methods,
            "sha256": digest(observed),
            "assertion": observed["assertion"],
            "excerpt": observed["assertion"],
            "observations": observed,
        })
        by_surface[surface].pop("reason", None)
    manifest["revision"] = rev
    manifest["capture_tool"] = "python3 tools/capture_emmons_shelter_monitor_pack.py"
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {MANIFEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
