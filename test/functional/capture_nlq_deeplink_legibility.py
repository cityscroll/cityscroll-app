#!/usr/bin/env python3
"""Capture and verify NLQ deep-link legibility at the two review widths.

The current checkout is the after state. The parent commit is archived as the before
state by default:

    python3 test/functional/capture_nlq_deeplink_legibility.py
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
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs" / "screenshots" / "nlq-deeplink-legibility"
PINNED_HASH = (
    "#money?mode=award&min=500000&category="
    "Construction%2FConstruction+Services"
)
VIEWPORTS = ((390, 844), (1440, 900))
NOTICE = {
    "request_id": "20260727001",
    "start_date": "2026-07-27T00:00:00.000",
    "agency_name": "Department of Design and Construction",
    "type_of_notice_description": "Award",
    "category_description": "Construction/Construction Services",
    "short_title": "Neighborhood public-building construction services",
    "pin": "DDC2026NLQ01",
    "contract_amount": "825000",
    "vendor_name": "Fixture Builders Inc.",
    "selection_method_description": "Competitive Sealed Bidding",
    "additional_description_1": "Construction services for public facilities.",
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
        query = {
            key: values[0]
            for key, values in parse_qs(urlparse(route.request.url).query).items()
        }
        select = query.get("$select", "")
        if select.startswith("request_id,start_date,agency_name"):
            json_response(route, [NOTICE])
        elif "min(start_date) as a" in select:
            json_response(
                route,
                [{"a": "2003-01-01T00:00:00.000", "b": "2026-07-27T00:00:00.000"}],
            )
        else:
            json_response(route, [])

    page.route("https://data.cityofnewyork.us/**", city_data)
    page.route("https://api.cityscroll.org/**", lambda route: json_response(route, {}))
    page.route(
        "https://crol-worker.crol-worker.workers.dev/**",
        lambda route: json_response(route, {}),
    )
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())


def wait_for_results(page: Page) -> None:
    page.locator("#list .row").first.wait_for(state="visible")
    page.wait_for_function("document.querySelector('#rescount').textContent !== ''")


def position_capture(page: Page, selector: str) -> None:
    page.locator(selector).scroll_into_view_if_needed()
    page.evaluate(
        """
        selector => {
          const box=document.querySelector(selector);
          window.scrollTo(0, Math.max(0, box.getBoundingClientRect().top + scrollY - 150));
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
          const top=Math.max(48, rect.top - 7);
          const width=Math.min(innerWidth - left - 5, rect.width + 14);
          const height=rect.height + 14;

          const mark=document.createElement("div");
          mark.className="nlq-review-annotation";
          Object.assign(mark.style, {
            position:"fixed", left:`${left}px`, top:`${top}px`,
            width:`${width}px`, height:`${height}px`,
            border:"4px solid #d60000", borderRadius:"8px",
            boxSizing:"border-box", zIndex:"99998", pointerEvents:"none"
          });

          const label=document.createElement("div");
          label.className="nlq-review-annotation";
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


def capture_state(
    browser,
    tree: Path,
    state: str,
    width: int,
    height: int,
) -> None:
    with StaticServer(tree) as base_url:
        page = browser.new_page(viewport={"width": width, "height": height})
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        page.goto(base_url + PINNED_HASH, wait_until="domcontentloaded")
        wait_for_results(page)

        if state == "after":
            assert page.locator("#reshead").text_content() == "Recent Awards"
            selector = "#moneyactivefilters .moneyactive"
            row = page.locator(selector)
            row.wait_for(state="visible")
            text = row.text_content() or ""
            for expected in (
                "Award",
                "Construction-Construction Services",
                "Value ≥",
                "$500K",
                "Clear filters",
            ):
                assert expected in text, (expected, text)
            label = "AFTER · ACTIVE FILTERS ARE NAMED AND CLEARABLE"
        else:
            assert page.locator("#moneyactivefilters").count() == 0
            selector = "#tab-money .nlbox"
            label = "BEFORE · RESULTS LOAD, BUT THE FILTERED VIEW IS UNNAMED"

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


def assert_interpreted_row(page: Page, url: str, expected: tuple[str, ...]) -> None:
    page.goto(url, wait_until="domcontentloaded")
    wait_for_results(page)
    row = page.locator("#moneyactivefilters .moneyactive")
    row.wait_for(state="visible")
    text = row.text_content() or ""
    for value in expected:
        assert value in text, (value, text)


def verify_interactions(browser) -> None:
    with StaticServer(ROOT) as base_url:
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            permissions=["clipboard-read", "clipboard-write"],
        )
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)

        assert_interpreted_row(
            page,
            base_url + PINNED_HASH,
            ("Award", "Construction-Construction Services", "Value ≥", "$500K"),
        )
        assert_interpreted_row(
            page,
            base_url + "#money?category=Goods+and+Services",
            ("Open RFP", "Goods and Services"),
        )
        assert_interpreted_row(
            page,
            base_url + "#money?max=750000&months=3",
            ("Value ≤", "$750K", "Due within 3 mo"),
        )
        assert_interpreted_row(
            page,
            base_url + "#money?standard=1",
            ("Standard methods only",),
        )

        page.goto(base_url + "#money?mode=award&min=500000", wait_until="domcontentloaded")
        wait_for_results(page)
        assert page.locator("#moneyactivefilters .moneyactive").count() == 0

        page.goto(base_url + PINNED_HASH, wait_until="domcontentloaded")
        wait_for_results(page)
        page.locator("#moneyactiveclear").click()
        page.wait_for_function("location.hash === '#money'")
        assert page.locator("#moneyactivefilters .moneyactive").count() == 0
        assert page.locator("#mode").input_value() == "open"
        assert page.locator("#minamt").input_value() == ""

        page.evaluate("location.hash='#money?category=Goods+and+Services'")
        page.wait_for_function(
            "document.querySelector('#moneyactivefilters').textContent.includes('Goods and Services')"
        )
        page.evaluate("location.hash='#money?standard=1'")
        page.wait_for_function(
            "document.querySelector('#moneyactivefilters').textContent.includes('Standard methods only')"
        )
        page.go_back()
        page.wait_for_function(
            "document.querySelector('#moneyactivefilters').textContent.includes('Goods and Services')"
        )
        page.go_forward()
        page.wait_for_function(
            "document.querySelector('#moneyactivefilters').textContent.includes('Standard methods only')"
        )

        page.goto(base_url, wait_until="domcontentloaded")
        page.locator("#nlq").fill("construction contracts over $500k")
        page.locator("#nlgo").click()
        share = page.locator("#nlqshare")
        share.wait_for(state="visible")
        expected_url = share.get_attribute("href")
        assert expected_url == page.url
        assert share.get_attribute("target") == "_blank"
        assert share.get_attribute("rel") == "noopener noreferrer"
        with page.expect_popup() as popup_info:
            share.click()
        popup = popup_info.value
        popup.wait_for_load_state("domcontentloaded")
        assert popup.url == expected_url
        popup.close()

        page.locator('.lang-btn[data-lang="es"]').click()
        page.wait_for_function("document.documentElement.lang === 'es'")
        page.wait_for_function(
            "document.querySelector('#moneyactivefilters').textContent.includes('Borrar filtros')"
        )
        assert "Esto es lo que entendimos:" in page.locator(
            "#moneyactivefilters"
        ).text_content()

        assert not errors, errors
        context.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--before",
        default="HEAD^",
        help="revision immediately before the legibility change",
    )
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="crol-nlq-legibility-") as temp:
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

    print("NLQ deep-link legibility browser checks passed.")
    for asset in sorted(OUTPUT.glob("*.png")):
        print(f"  {asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
