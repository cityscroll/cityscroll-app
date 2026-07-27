#!/usr/bin/env python3
"""Capture and verify cross-lens search links at the two review widths.

The current checkout is the after state. The foundation commit is archived as the
before state by default:

    python3 test/functional/capture_search_links_everywhere.py
"""

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

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs" / "screenshots" / "search-links-everywhere"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
LAND_HASH = "#land?boro=Queens"
VIEWPORTS = ((390, 844), (1440, 900))
PRESETS = [
    {
        "label": "Large construction awards",
        "hash": "#money?mode=award&q=construction&min=500000",
    },
    {"label": "Sidewalk rules", "hash": "#rules?q=sidewalk"},
]
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


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_routes(page: Page) -> None:
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())

    def city_data(route: Route) -> None:
        path = urlparse(route.request.url).path
        if path.endswith("/hgx4-8ukb.json"):
            json_response(route, [LAND_NOTICE])
        else:
            json_response(route, [])

    page.route("https://data.cityofnewyork.us/**", city_data)
    page.route("https://api.crol-list.org/**", lambda route: json_response(route, {}))
    page.route(
        "https://crol-worker.crol-worker.workers.dev/**",
        lambda route: json_response(route, {}),
    )
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())


def seed_presets(page: Page) -> None:
    page.add_init_script(
        f"localStorage.setItem('crd_nlq_presets_v1', {json.dumps(json.dumps(PRESETS))});"
    )


def position_capture(page: Page, selector: str) -> None:
    page.locator(selector).scroll_into_view_if_needed()
    page.evaluate(
        """
        selector => {
          const box=document.querySelector(selector);
          window.scrollTo(0, Math.max(0, box.getBoundingClientRect().top + scrollY - 90));
        }
        """,
        selector,
    )
    page.wait_for_timeout(100)


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
            border:"4px solid #d60000", borderRadius:"8px",
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


def wait_for_land(page: Page) -> None:
    page.locator("#llist .row").first.wait_for(state="visible")


def assert_wcag22_targets(page: Page, width: int) -> None:
    page.add_script_tag(path=str(AXE))
    wcag22_rules = page.evaluate(
        "() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"
    )
    assert "target-size" in wcag22_rules, wcag22_rules
    result = page.evaluate(
        """async () => await axe.run(document, {
          runOnly: {type: 'rule', values: ['target-size']},
          resultTypes: ['violations']
        })"""
    )
    violations = result["violations"]
    assert not violations, f"{width}px search controls fail target-size: {violations}"


def capture_state(browser, tree: Path, state: str, width: int, height: int) -> None:
    with StaticServer(tree) as base_url:
        page = browser.new_page(viewport={"width": width, "height": height})
        errors: list[str] = list()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        seed_presets(page)
        page.goto(base_url + LAND_HASH, wait_until="domcontentloaded")
        wait_for_land(page)

        selector = "#tab-land .nlbox"
        if state == "after":
            row = page.locator("#searchstate-land .searchactive")
            row.wait_for(state="visible")
            text = row.text_content() or ""
            assert "Queens" in text
            assert "Clear filters" in text
            actions = page.locator("#searchactions-land .nlqactions")
            actions.wait_for(state="visible")
            assert "Copy search link" in (actions.text_content() or "")
            preset_text = page.locator("#nlpresets-land").text_content() or ""
            assert "Contracts" in preset_text
            assert "Rules" in preset_text
            assert_wcag22_targets(page, width)
            label = "AFTER · FILTERS, LINK CONTROLS, AND LENS-LABELED PRESETS"
        else:
            assert page.locator("[data-search-state]").count() == 0
            assert page.locator("#tab-land .nlqactions").count() == 0
            label = "BEFORE · THE LAND LINK REPLAYS, BUT HAS NO SHARE OR SAVE CONTROLS"

        position_capture(page, selector)
        raw = OUTPUT / f"{state}-{width}.png"
        page.screenshot(path=str(raw), animations="disabled")
        annotate(page, selector, label)
        annotated = OUTPUT / f"{state}-{width}-annotated.png"
        page.screenshot(path=str(annotated), animations="disabled")

        assert raw.stat().st_size > 10_000
        assert annotated.stat().st_size > 10_000
        assert not errors, errors
        page.close()


def verify_interactions(browser) -> None:
    with StaticServer(ROOT) as base_url:
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            permissions=["clipboard-read", "clipboard-write"],
        )
        page = context.new_page()
        errors: list[str] = list()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        seed_presets(page)

        page.goto(base_url + LAND_HASH, wait_until="domcontentloaded")
        wait_for_land(page)
        page.locator("#searchstate-land .searchactive").wait_for(state="visible")
        share = page.locator("#searchactions-land [data-search-share]")
        assert share.get_attribute("href") == base_url + LAND_HASH
        page.locator("#searchactions-land [data-search-copy]").click()
        assert page.evaluate("navigator.clipboard.readText()") == base_url + LAND_HASH

        page.locator('.lang-btn[data-lang="es"]').click()
        page.wait_for_function(
            "() => document.querySelector('#searchstate-land')?.textContent.includes('Distrito')"
        )
        assert "Distrito" in (page.locator("#searchstate-land").text_content() or "")
        assert "Abrir búsqueda para compartir" in (
            page.locator("#searchactions-land").text_content() or ""
        )
        assert "Contratos" in (page.locator("#nlpresets-land").text_content() or "")
        page.locator('.lang-btn[data-lang="en"]').click()
        page.wait_for_function("document.documentElement.lang === 'en'")

        page.locator("#searchactions-land [data-search-save]").click()
        assert "Land" in (page.locator("#nlpresets-land").text_content() or "")

        page.evaluate("location.hash='#people?mode=person&q=rodriguez'")
        page.locator("#searchstate-people .searchactive").wait_for(state="visible")
        assert "rodriguez" in (
            page.locator("#searchstate-people").text_content() or ""
        ).lower()
        page.locator("#nlpresets-people .nlqpreset-run", has_text="Queens").click()
        page.wait_for_function("location.hash === '#land?boro=Queens'")
        page.locator("#searchstate-land .searchactive").wait_for(state="visible")

        page.evaluate("location.hash='#rules?q=sidewalk'")
        page.locator("#searchstate-rules .searchactive").wait_for(state="visible")
        assert "sidewalk" in (
            page.locator("#searchstate-rules").text_content() or ""
        ).lower()

        page.goto(base_url + "#land", wait_until="domcontentloaded")
        wait_for_land(page)
        page.locator("#nlq-land").fill("rezonings in Queens")
        page.locator("#nlgo-land").click()
        ask_share = page.locator("#searchactions-land [data-search-share]")
        ask_share.wait_for(state="visible")
        assert ask_share.get_attribute("href") == base_url + LAND_HASH
        assert page.url == base_url + LAND_HASH

        assert not errors, errors
        context.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--before",
        default="HEAD^",
        help="revision immediately before the cross-lens link change",
    )
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="crol-search-links-") as temp:
        before_tree = Path(temp) / "before"
        before_tree.mkdir()
        revision_snapshot(args.before, before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height in VIEWPORTS:
                    capture_state(browser, before_tree, "before", width, height)
                    capture_state(browser, ROOT, "after", width, height)
                verify_interactions(browser)
            finally:
                browser.close()

    print("Cross-lens search-link browser checks passed.")
    for asset in sorted(OUTPUT.glob("*.png")):
        print(f"  {asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
