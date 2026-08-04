#!/usr/bin/env python3
"""Verify the QR share dialog and capture annotated before/after evidence."""

from __future__ import annotations

import argparse
import functools
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from playwright.sync_api import Browser, Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs" / "screenshots" / "qr-share"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
VIEWPORTS = ((390, 844), (1440, 900))
LAND_HASH = "#land?boro=Queens"
LAND_NOTICE = {
    "project_id": "P2026Q0012",
    "project_name": "Queens neighborhood rezoning",
    "project_brief": "A mixed-use proposal with new homes and ground-floor shops.",
    "primary_applicant": "Neighborhood Development Partners",
    "public_status": "In Public Review",
    "project_status": "Active",
    "borough": "Queens",
    "community_district": "12",
    "actions": "Community Board Review",
    "mih_flag": "true",
    "current_milestone": "Community Board Review",
    "current_milestone_date": "2026-08-12T00:00:00.000",
    "ulurp_numbers": "260012ZMQ",
}
VENDOR_PROFILE = {
    "ok": True,
    "generated": "2026-07-27T20:00:00Z",
    "profile": {
        "stem": "ACME GARDENS",
        "display": "ACME GARDENS LLC",
        "variants": [
            {
                "name": "ACME GARDENS LLC",
                "n": 3,
                "total": 1200000,
                "first": "2024-01-10",
                "last": "2026-06-15",
            }
        ],
        "awardCount": 3,
        "total": 1200000,
        "first": "2024-01-10",
        "last": "2026-06-15",
        "topAgencies": [],
        "recentNotices": [],
        "forecasts": [],
    },
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path):
        public_root = directory / "site" if (directory / "site" / "index.html").is_file() else directory
        handler = functools.partial(QuietHandler, directory=str(public_root))
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
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())
    page.route("https://challenges.cloudflare.com/**", lambda route: route.abort())

    def city_data(route: Route) -> None:
        path = urlparse(route.request.url).path
        json_response(route, [LAND_NOTICE] if path.endswith("/hgx4-8ukb.json") else [])

    def worker_data(route: Route) -> None:
        path = urlparse(route.request.url).path
        json_response(route, VENDOR_PROFILE if path.endswith("/vendor-profile") else {})

    page.route("https://data.cityofnewyork.us/**", city_data)
    page.route("https://api.cityscroll.org/**", worker_data)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker_data)


def seed_presets(page: Page) -> None:
    # Fixture source: the cross-lens replay example in test/search_links_everywhere.test.mjs.
    presets = [{"label": "Sidewalk rules", "hash": "#rules?q=sidewalk"}]  # source: cross-lens replay fixture
    page.add_init_script(
        f"localStorage.setItem('crd_nlq_presets_v1', {json.dumps(json.dumps(presets))});"
    )


def annotate(page: Page, selector: str, label_text: str) -> None:
    page.evaluate(
        """
        ({selector, labelText}) => {
          const target=document.querySelector(selector);
          const rect=target.getBoundingClientRect();
          const left=Math.max(5, rect.left - 7);
          const top=Math.max(52, rect.top - 7);
          const width=Math.min(innerWidth - left - 5, rect.width + 14);
          const height=Math.min(innerHeight - top - 5, rect.height + 14);
          const mark=document.createElement("div");
          Object.assign(mark.style, {
            position:"fixed", left:`${left}px`, top:`${top}px`,
            width:`${width}px`, height:`${height}px`,
            border:"4px solid #d60000", borderRadius:"10px",
            boxSizing:"border-box", zIndex:"99998", pointerEvents:"none"
          });
          const label=document.createElement("div");
          label.textContent=labelText;
          Object.assign(label.style, {
            position:"fixed", left:`${left}px`, top:`${Math.max(5, top - 43)}px`,
            maxWidth:`${Math.min(width, innerWidth - left - 5)}px`,
            background:"#d60000", color:"#fff", padding:"7px 10px",
            borderRadius:"5px", font:"800 12px/1.25 system-ui,sans-serif",
            zIndex:"99999", pointerEvents:"none"
          });
          document.body.append(mark, label);
        }
        """,
        {"selector": selector, "labelText": label_text},
    )


def capture(browser: Browser, tree: Path, state: str, width: int, height: int) -> None:
    with StaticServer(tree) as base_url:
        page = browser.new_page(viewport={"width": width, "height": height})
        # Source: uncaught browser pageerror events observed during this capture.
        errors: list[str] = []  # source: Playwright pageerror events
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        seed_presets(page)
        page.goto(base_url, wait_until="domcontentloaded")
        page.locator("#tab-money .nlbox").wait_for(state="visible")

        if state == "after":
            # Review captures show the real public destination, never the local test server.
            page.evaluate(
                """() => {
                  const old=document.querySelector('#landing-share-actions [data-qr-share]');
                  const button=old.cloneNode(true);
                  old.replaceWith(button);
                  QRShare.bind(button, 'https://cityscroll.org/', qrLabels);
                }"""
            )
            page.locator("#landing-share-actions [data-qr-share]").click()
            selector = "#qr-share-dialog"
            page.locator(selector).wait_for(state="visible")
            label = "AFTER · THE CANONICAL LINK AS A SCANNABLE, DOWNLOADABLE QR CODE"
        else:
            assert page.locator("[data-qr-share]").count() == 0
            selector = "#tab-money .nlbox"
            label = "BEFORE · THE LANDING VIEW HAS NO QR SHARE OPTION"

        raw = OUTPUT / f"{state}-{width}.png"
        page.screenshot(path=str(raw), animations="disabled")
        annotate(page, selector, label)
        annotated = OUTPUT / f"{state}-{width}-annotated.png"
        page.screenshot(path=str(annotated), animations="disabled")
        assert raw.stat().st_size > 10_000
        assert annotated.stat().st_size > 10_000
        assert not errors, errors
        page.close()


def assert_accessible(page: Page) -> None:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate(
        """async () => await axe.run(document, {
          runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']},
          resultTypes: ['violations']
        })"""
    )
    assert not result["violations"], result["violations"]


def assert_copy_matches_qr(page: Page, copy_selector: str, qr_selector: str) -> str:
    page.locator(copy_selector).click()
    copied = page.evaluate("navigator.clipboard.readText()")
    page.locator(qr_selector).click()
    dialog = page.locator("#qr-share-dialog")
    dialog.wait_for(state="visible")
    assert dialog.locator(".qr-destination").text_content() == copied
    assert dialog.locator(".qr-image").get_attribute("data-qr-value") == copied
    assert copied in (dialog.locator(".qr-image").get_attribute("aria-label") or "")
    dialog.locator(".qr-dialog-actions button").last.click()
    return copied


def verify_interactions(browser: Browser) -> None:
    with StaticServer(ROOT / "site") as base_url:
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            permissions=["clipboard-read", "clipboard-write"],
            accept_downloads=True,
        )
        page = context.new_page()
        # Source: uncaught browser pageerror events observed during this interaction run.
        errors: list[str] = []  # source: Playwright pageerror events
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        seed_presets(page)
        page.goto(base_url, wait_until="domcontentloaded")

        copied = assert_copy_matches_qr(
            page,
            "#landing-share-actions [data-landing-copy]",
            "#landing-share-actions [data-qr-share]",
        )
        assert copied == base_url

        trigger = page.locator("#landing-share-actions [data-qr-share]")
        trigger.focus()
        trigger.click()
        dialog = page.locator("#qr-share-dialog")
        svg = dialog.locator(".qr-image")
        # Source: the rendered SVG's own viewBox attribute.
        viewbox = [int(part) for part in (svg.get_attribute("viewBox") or "").split()]  # source: rendered SVG
        matrix_size = page.evaluate("url => QRShare.matrix(url).length", copied)
        # QR's standard quiet zone is four modules per side, hence eight overall.
        assert viewbox == [0, 0, matrix_size + 8, matrix_size + 8]  # source: qr_share.js QUIET_ZONE
        assert_accessible(page)

        # The explicit trap wraps both directions, and Escape restores the opener.
        page.keyboard.press("Tab")
        assert page.locator("#qr-share-dialog").evaluate(
            "dialog => dialog.contains(document.activeElement)"
        )
        page.keyboard.press("Shift+Tab")
        assert page.locator("#qr-share-dialog").evaluate(
            "dialog => dialog.contains(document.activeElement)"
        )
        page.keyboard.press("Escape")
        assert not dialog.is_visible()
        assert page.evaluate("document.activeElement.matches('[data-qr-share]')")

        trigger.click()
        with page.expect_download() as download_info:
            dialog.locator(".qr-dialog-actions button").first.click()
        assert download_info.value.suggested_filename == "crol-list-qr.png"
        dialog.locator(".qr-dialog-actions button").last.click()

        page.select_option("#langSelect", "es")
        page.wait_for_function(
            "() => document.querySelector('#landing-share-actions')?.textContent.includes('Código QR')"
        )
        assert "Código QR" in (page.locator("#landing-share-actions").text_content() or "")

        page.goto(base_url + LAND_HASH, wait_until="domcontentloaded")
        page.locator("#searchactions-land [data-search-copy]").wait_for(state="visible")
        land_url = assert_copy_matches_qr(
            page,
            "#searchactions-land [data-search-copy]",
            "#searchactions-land [data-qr-share]",
        )
        assert land_url == base_url + "?lang=es" + LAND_HASH

        page.locator("#nlpresets-land .nlqpreset-run", has_text="Sidewalk").click()
        page.wait_for_function("location.hash === '#rules?q=sidewalk'")
        page.locator("#searchactions-rules [data-search-copy]").wait_for(state="visible")
        preset_url = assert_copy_matches_qr(
            page,
            "#searchactions-rules [data-search-copy]",
            "#searchactions-rules [data-qr-share]",
        )
        assert preset_url == base_url + "?lang=es#rules?q=sidewalk"

        page.goto(base_url + "#vendor/ACME%20GARDENS", wait_until="domcontentloaded")
        page.locator("#entityview #eqr").wait_for(state="visible")
        vendor_url = assert_copy_matches_qr(page, "#entityview #ecopy", "#entityview #eqr")
        assert vendor_url == base_url + "?lang=es#vendor/ACME%20GARDENS%20LLC"

        assert not errors, errors
        context.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Run browser behavior checks without regenerating committed review captures.",
    )
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            if args.verify_only:
                expected = [  # source: VIEWPORTS and the before/after capture matrix above
                    OUTPUT / f"{state}-{width}{suffix}.png"
                    for state in ("before", "after")
                    for width, _height in VIEWPORTS
                    for suffix in ("", "-annotated")
                ]
                assert all(path.exists() and path.stat().st_size > 10_000 for path in expected)
            else:
                with tempfile.TemporaryDirectory(prefix="crol-qr-share-") as temp:
                    before_tree = Path(temp) / "before"
                    before_tree.mkdir()
                    revision_snapshot("origin/main", before_tree)
                    for width, height in VIEWPORTS:
                        capture(browser, before_tree, "before", width, height)
                        capture(browser, ROOT, "after", width, height)
            verify_interactions(browser)
        finally:
            browser.close()

    print("QR share browser checks passed.")
    for asset in sorted(OUTPUT.glob("*.png")):
        print(f"  {asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
