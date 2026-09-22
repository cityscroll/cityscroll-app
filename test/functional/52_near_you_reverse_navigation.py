#!/usr/bin/env python3
"""Served Near You proof for K15 reverse navigation and scope preservation."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

from playwright.sync_api import sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000").rstrip("/")
ROUTE = "/near-you/?" + urlencode(
    {
        "v": "0",
        "lens": "meetings",
        "boro": "Brooklyn",
        "cd": "K15",
        "level": "community_district",
        "id": "K15",
        "parent": "Brooklyn",
        "agency": "Transportation",
        "when": "month",
        "facet": json.dumps({"fiscal_year": "2026"}, separators=(",", ":")),
    }
)
MANIFEST = Path(__file__).resolve().parents[2] / "docs/evidence/community-district-relationships/capture-manifest.json"
USE_SERVED_ROUTE = os.environ.get("CROL_USE_SERVED_ROUTE") == "1"


def scope(url: str) -> dict[str, list[str]]:
    return dict(parse_qsl(urlsplit(url).query, keep_blank_values=True))


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def stable_url(url: str) -> str:
    parsed = urlsplit(url)
    return parsed._replace(scheme="", netloc="").geturl()


def local_route_html() -> str:
    script = r'''
import { readFileSync } from "node:fs";
import { scopeFromNearYouUrl } from "./site/near_you_scope_runtime.mjs";
import { buildNearYouViewModel, renderNearYouDocument } from "./site/near_you_view.mjs";
const scope = scopeFromNearYouUrl(new URL(process.env.ROUTE_URL));
const activity = JSON.parse(readFileSync("site/data/district_activity.json", "utf8"));
const boundaries = JSON.parse(readFileSync("worker/src/data/district_boundaries.json", "utf8"));
const geography = JSON.parse(readFileSync("site/data/community_board_geography_lookup.json", "utf8"));
const nta = JSON.parse(readFileSync("site/data/geography/layers/nta2020/26B.json", "utf8"));
const view = buildNearYouViewModel(scope, activity, boundaries, {
  canonicalBase: "https://cityscroll.org/near-you",
  communityGeography: geography,
  navigationLayerDoc: nta,
  navigationLayerType: "nta2020",
});
process.stdout.write(renderNearYouDocument(view, { assetPrefix: "/" }));
'''
    return subprocess.run(
        ["node", "--input-type=module", "-e", script],
        env={**os.environ, "ROUTE_URL": BASE + ROUTE},
        check=True, capture_output=True, text=True,
    ).stdout


def install_local_route(page, html: str) -> None:
    if USE_SERVED_ROUTE or ("127.0.0.1" not in BASE and "localhost" not in BASE):
        return
    page.route("**/near-you**", lambda route: route.fulfill(status=200, content_type="text/html", body=html))


def assert_route_parameters(url: str, expected: dict[str, list[str]]) -> None:
    actual = scope(url)
    for key in ("lens", "agency", "when", "facet"):
        assert actual.get(key) == expected.get(key), f"{key} changed: {actual.get(key)!r} != {expected.get(key)!r}"


def navigation_url_matches(url: str, expected_href: str) -> bool:
    actual = urlsplit(url)
    actual_query = [(key, value) for key, value in parse_qsl(actual.query, keep_blank_values=True) if key != "walk"]
    normalized_actual = actual._replace(scheme="", netloc="", query=urlencode(actual_query)).geturl()
    return normalized_actual == stable_url(expected_href)


def wait_for_navigation_scope(page, expected_href: str) -> None:
    for _ in range(300):
        if navigation_url_matches(page.url, expected_href):
            return
        page.wait_for_timeout(100)
    raise AssertionError(f"Enter did not preserve scope while navigating to {expected_href}")


def no_script_capture(browser, html: str):
    context = browser.new_context(viewport={"width": 1440, "height": 900}, java_script_enabled=False)
    page = context.new_page()
    install_local_route(page, html)
    page.goto(BASE + ROUTE, wait_until="domcontentloaded", timeout=30000)
    links = page.locator("[data-local-constellation='1'] a.local-constellation-node-link")
    assert links.count() >= 2, "K15 reverse-navigation links are missing from served markup"
    hrefs = links.evaluate_all("nodes => nodes.map(node => node.href)")
    assert all(urlsplit(href).scheme in {"http", "https"} and urlsplit(href).netloc for href in hrefs)
    assert any("cd=K15" in href for href in hrefs)
    assert any("council=" in href for href in hrefs)
    expected = scope(page.url)
    for href in hrefs:
        assert_route_parameters(href, expected)
    assert any(scope(href).get("boro") == "Brooklyn" and scope(href).get("cd") == "K15" for href in hrefs)
    assert all(scope(href).get("council") for href in hrefs if "council=" in href)
    for href in hrefs:
        response = page.goto(href, wait_until="domcontentloaded", timeout=30000)
        assert response.ok, f"reverse destination is not resolvable: {href} ({response.status})"
        page.goto(BASE + ROUTE, wait_until="domcontentloaded", timeout=30000)
    result = {"route": ROUTE, "links": sorted(stable_url(href) for href in hrefs), "text": links.locator("..").all_inner_texts()}
    return digest(result)


def open_selected_place_context(page) -> None:
    """Reveal reverse-navigation links kept under the selected-place disclosure."""
    disclosure = page.locator(".near-selected-context > summary")
    if disclosure.count() == 0:
        return
    details = page.locator(".near-selected-context")
    if details.count() > 0 and details.first.get_attribute("open") is not None:
        return
    disclosure.first.click()


def keyboard_capture(browser, html: str):
    context = browser.new_context(viewport={"width": 390, "height": 844})
    page = context.new_page()
    install_local_route(page, html)
    page.goto(BASE + ROUTE, wait_until="domcontentloaded", timeout=30000)
    expected = scope(page.url)
    open_selected_place_context(page)
    selector = "[data-local-constellation='1'] a.local-constellation-node-link"
    links = page.locator(selector)
    assert links.count() >= 2
    observations = []
    hrefs = links.evaluate_all("nodes => nodes.map(node => node.href)")
    for expected_href in hrefs:
        # Reload resets focus and makes each activation an independent keyboard journey.
        page.goto(BASE + ROUTE, wait_until="domcontentloaded", timeout=30000)
        open_selected_place_context(page)
        for _ in range(120):
            page.keyboard.press("Tab")
            if page.evaluate("expected => document.activeElement?.href === expected", expected_href):
                break
        else:
            raise AssertionError(f"Tab never reached {expected_href}")
        assert page.evaluate("document.activeElement?.tagName") == "A"
        label = page.evaluate("document.activeElement?.textContent.trim()")
        page.keyboard.press("Enter")
        wait_for_navigation_scope(page, expected_href)
        observations.append({"label": label, "active": "A", "url": stable_url(page.url)})
        assert_route_parameters(page.url, expected)
    return digest(observations)


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        html = local_route_html() if not USE_SERVED_ROUTE and ("127.0.0.1" in BASE or "localhost" in BASE) else ""
        no_script = no_script_capture(browser, html)
        keyboard = keyboard_capture(browser, html)
        browser.close()

    manifest = json.loads(MANIFEST.read_text())
    captures = {capture["mode"]: capture for capture in manifest["captures"]}
    print(f"digests: no-javascript={no_script} keyboard={keyboard}")
    assert captures["no-javascript"]["sha256"] == no_script, "no-JavaScript capture manifest is stale"
    assert captures["keyboard"]["sha256"] == keyboard, "keyboard capture manifest is stale"
    print(f"PASS: K15 served reverse navigation (no-JavaScript {no_script}; keyboard {keyboard})")


if __name__ == "__main__":
    main()
