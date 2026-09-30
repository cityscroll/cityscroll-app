#!/usr/bin/env python3
"""A selected place keeps its map inside the useful viewport.

After a place is chosen, the map's top must sit at least MIN_VISIBLE_MAP_CSS_PX
above the bottom of the measured viewport, at 390x844 and 1440x900. This is the
same rule the post-deploy live smoke (54_neighborhood_map_journey.py) applies to
the served site; this check applies it to every pull request, over the same
retained route read models, so a regression fails before it is served.

Each viewport exercises:

* Composition: the unselected entry carries the collection row, the citywide
  preview and the neighborhood suggestions together, and choosing a place in
  the page removes all three and keeps the map in view.
* Deploy skew: the Worker renders Near You documents and deploys ahead of the
  Pages-served client, so a newer document can carry a root region this client
  has never listed. The entry document here carries one such named region,
  tall enough to push the map out of view if it survives the selection.
* A direct load of the selected place.
* A positive control: a block injected above the map must fail the measurement.

Every Near You root region in the entry and selected documents must also be
adoptable: listed by the adoption module or named by its region attribute,
apart from one pinned exception described at PIECEMEAL_REGIONS.
Nothing is written to the repository and no screenshots are taken.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from route_response_text import fetch_uncompressed, fulfill_with_text, response_text  # noqa: E402
VIEWPORTS = ((390, 844), (1440, 900))
# The live smoke's rule: at least this much of the map shows on the first screen.
MIN_VISIBLE_MAP_CSS_PX = 160
PLACE_NAME = "Tribeca-Civic Center"
PLACE_GEO = "nta2020%3AMN0102"
SELECTED_MAP_ROUTE = f"/near-you/?geo={PLACE_GEO}&lens=meetings&surface=map"
SELECTED_RECORDS_ROUTE = f"/near-you/?geo={PLACE_GEO}&lens=meetings&surface=records"
# Known exception, pinned so it cannot rot: the selected-place context wrapper
# is not itself listed; its listed .near-scope child is adopted on its own. The
# check fails once the wrapper becomes adoptable, so the entry is then removed.
PIECEMEAL_REGIONS = frozenset({"details.near-selected-context"})
NEWER_REGION = (
    '<nav class="near-newer-document-row" data-near-scope-region="newer-document-row"'
    ' aria-label="Newer document row" style="display:block;block-size:100vh">'
    "<p>A row only a newer document renders</p></nav>"
)

MAP_POSITION_JS = """(minVisible) => {
  window.scrollTo(0, 0);
  const host = document.querySelector('#near-map-enhanced');
  const box = host && !host.hidden ? host.getBoundingClientRect() : null;
  const viewport = window.innerHeight;
  const top = box ? box.top + window.scrollY : null;
  const root = document.querySelector('[data-near-you-root]');
  return {
    top,
    viewport,
    limit: viewport - minVisible,
    within: Boolean(box && box.height > 0 && top < viewport - minVisible),
    above: root ? [...root.children]
      .map((node) => ({name: `${node.tagName.toLowerCase()}.${String(node.className).trim().split(/\\s+/).join('.')}`,
        top: Math.round(node.getBoundingClientRect().top + window.scrollY),
        height: Math.round(node.getBoundingClientRect().height)}))
      .filter((node) => node.height > 0 && top != null && node.top < top)
      .sort((a, b) => a.top - b.top) : [],
  };
}"""

ENTRY_COMPOSITION_JS = """() => ({
  collection: document.querySelectorAll('.near-collection-entry a').length,
  citywide: document.querySelectorAll('.near-special-records[data-near-special-records="entry"] li.near-record').length,
  suggestions: document.querySelectorAll('.near-place-suggestions a[data-near-place-suggestion]').length,
  newer: document.querySelectorAll('.near-newer-document-row').length,
})"""

REGION_COVERAGE_JS = """async (routes) => {
  const adoption = await import('/near_you_scope_adoption.mjs');
  const out = {};
  for (const route of routes) {
    const html = await (await fetch(route, {cache: 'no-store'})).text();
    const root = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-near-you-root]');
    out[route] = root ? [...root.children]
      .filter((node) => !node.hasAttribute(adoption.NEAR_YOU_SCOPE_REGION_ATTRIBUTE)
        && !adoption.NEAR_YOU_SCOPE_REGION_SELECTORS.some((selector) => node.matches(selector)))
      .map((node) => `${node.tagName.toLowerCase()}.${String(node.className).trim()}`) : ['no root'];
  }
  return out;
}"""


def wait_for_map(page: Page) -> None:
    page.wait_for_function(
        "() => { const host = document.querySelector('#near-map-enhanced'); return Boolean(host && !host.hidden && host.getBoundingClientRect().height > 0); }",
        timeout=30_000,
    )
    page.wait_for_function(
        "() => ['ready', 'error'].includes(document.querySelector('[data-near-you-root]')?.dataset.nearDeferredState)",
        timeout=30_000,
    )


def map_position(page: Page) -> dict:
    return page.evaluate(MAP_POSITION_JS, MIN_VISIBLE_MAP_CSS_PX)


def assert_map_within(page: Page, label: str) -> dict:
    position = map_position(page)
    assert position["within"], f"{label}: map is below the useful viewport: {position}"
    return position


def assert_measurement_can_fail(page: Page, label: str) -> None:
    """Positive control: a block above the map must push it out of the useful viewport."""
    page.evaluate("""() => {
      const block = document.createElement('div');
      block.id = 'map-position-control';
      block.style.blockSize = '100vh';
      document.querySelector('[data-near-you-root]').prepend(block);
    }""")
    assert not map_position(page)["within"], f"{label}: an injected block above the map did not fail the check"
    page.evaluate("() => document.getElementById('map-position-control')?.remove()")
    assert map_position(page)["within"], f"{label}: removing the control block did not restore the map"


def newer_document(route: Route) -> None:
    response = fetch_uncompressed(route)
    body = response_text(response)
    marker = '<div class="near-geo-workspace"'
    assert marker in body, "entry document has no map workspace to precede"
    fulfill_with_text(route, response, body.replace(marker, NEWER_REGION + marker, 1))


def select_in_page(page: Page) -> None:
    """Typed entry opens the place's Records in the same document; the Map switch returns to the map."""
    page.evaluate("window.__sameDocument = true")
    search = page.locator('[data-geography-search] input[name="neighborhood"]')
    search.fill(PLACE_NAME)
    search.press("Enter")
    page.wait_for_url(f"**geo={PLACE_GEO}**surface=records**", timeout=30_000)
    page.locator('[data-near-surface-switch] [data-near-surface="map"]').first.click()
    page.wait_for_function(
        "() => document.querySelector('[data-near-you-root]')?.dataset.nearSurface === 'map'",
        timeout=30_000,
    )
    wait_for_map(page)
    assert page.evaluate("window.__sameDocument === true"), "selection reloaded the document"


def check_viewport(browser, base: str, width: int, height: int) -> list[str]:
    name = f"{width}x{height}"
    results = []
    context = browser.new_context(viewport={"width": width, "height": height})
    try:
        # Composition: all entry content that precedes the map, then an in-page selection.
        page = context.new_page()
        page.goto(f"{base}/near-you/", wait_until="domcontentloaded")
        wait_for_map(page)
        entry = page.evaluate(ENTRY_COMPOSITION_JS)
        assert entry["collection"] > 0 and entry["citywide"] > 0 and entry["suggestions"] > 0, (name, entry)
        select_in_page(page)
        position = assert_map_within(page, f"{name} in-page selection")
        left = page.evaluate(ENTRY_COMPOSITION_JS)
        assert left["citywide"] == 0 and left["suggestions"] == 0, (name, left)
        assert_measurement_can_fail(page, f"{name} in-page selection")
        results.append(f"{name} in-page top={position['top']:.1f} limit={position['limit']}")
        page.close()

        # Deploy skew: the entry document carries a named region this client never listed.
        page = context.new_page()
        page.route(f"{base}/near-you/", newer_document)
        page.goto(f"{base}/near-you/", wait_until="domcontentloaded")
        wait_for_map(page)
        assert page.evaluate(ENTRY_COMPOSITION_JS)["newer"] == 1, f"{name}: the newer-document row was not served"
        select_in_page(page)
        assert page.evaluate(ENTRY_COMPOSITION_JS)["newer"] == 0, f"{name}: a newer document's row survived the selection"
        position = assert_map_within(page, f"{name} newer-document selection")
        results.append(f"{name} newer-document top={position['top']:.1f} limit={position['limit']}")
        page.close()

        # Direct load of the selected place.
        page = context.new_page()
        page.goto(f"{base}{SELECTED_MAP_ROUTE}", wait_until="domcontentloaded")
        wait_for_map(page)
        position = assert_map_within(page, f"{name} direct load")
        assert_measurement_can_fail(page, f"{name} direct load")
        uncovered = page.evaluate(REGION_COVERAGE_JS, ["/near-you/", SELECTED_MAP_ROUTE, SELECTED_RECORDS_ROUTE])
        unexpected = {route: [node for node in nodes if node not in PIECEMEAL_REGIONS] for route, nodes in uncovered.items()}
        assert not any(unexpected.values()), f"root regions the adoption cannot replace: {unexpected}"
        seen = {node for nodes in uncovered.values() for node in nodes}
        assert seen == PIECEMEAL_REGIONS, f"the known piecemeal exceptions changed; update PIECEMEAL_REGIONS: {seen}"
        results.append(f"{name} direct top={position['top']:.1f} limit={position['limit']}")
        page.close()
    finally:
        context.close()
    return results


def main() -> None:
    server = subprocess.Popen(
        ["node", "tools/serve_near_you_capture.mjs"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert server.stdout is not None
    base = server.stdout.readline().strip().rstrip("/")
    if not base:
        server.kill()
        raise RuntimeError("Near You renderer did not announce a base URL")
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                results = [line for width, height in VIEWPORTS for line in check_viewport(browser, base, width, height)]
            finally:
                browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
    for line in results:
        print(line)
    print("PASS: a selected place keeps its map in the useful viewport at 390x844 and 1440x900")


if __name__ == "__main__":
    main()
