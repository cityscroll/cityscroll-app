#!/usr/bin/env python3
"""Browser proof that the Land Map is a sibling of the List, not a dependency of it.

Four things a source assertion cannot prove:

  1. List first paint happens with no map asset requested before it.
  2. The List route still paints in full with every map dependency blocked outright.
  3. Map activation requests exactly the committed point projection, and nothing else, and
     mounts beside the List rather than in place of it.
  4. A blocked projection leaves the same filtered rows, count, filters, and controls, plus a
     retry and a direct return to List.
"""

from __future__ import annotations

import json
import os

from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
LIST_ROUTE = "/browse/zoning/?boro=Queens&stage=public_review"
PROJECTION = "data/land_project_map_points.json"
# Everything List must never wait on. `map_runtime.mjs` is not here: it is a same-origin
# module with no assets of its own, and the List auto-selects its first row, so the selected
# project's unchanged detail map may start fetching it in the same frame the rows paint.
BLOCKING_MAP_DEPENDENCIES = ("leaflet", "cartocdn", PROJECTION)

# Stamp first paint in the page's own clock so "before first paint" is an ordering fact and
# not a race between this harness and the browser. The init script runs before the parser
# creates <html>, so the observer watches the document node itself.
FIRST_PAINT_PROBE = """
window.__landFirstRowAt = null;
const observer = new MutationObserver(() => {
  if (window.__landFirstRowAt === null && document.querySelector('#llist .row')) {
    window.__landFirstRowAt = performance.now();
    observer.disconnect();
  }
});
observer.observe(document, { childList: true, subtree: true });
"""


def wait_for_land(page) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=45_000)


def observe(page) -> dict:
    return page.evaluate(
        """() => {
          const chips = [...document.querySelectorAll('#land-view-switch [data-land-view]')];
          const note = document.getElementById('land-view-note');
          const panel = document.getElementById('land-map-panel');
          const params = new URLSearchParams((location.hash.split('?')[1]) || location.search);
          return {
            semantic: [...params.entries()].filter(([key]) => key !== 'view')
              .map(([key, value]) => `${key}=${value}`).sort(),
            pressed: Object.fromEntries(chips.map((chip) => [
              chip.dataset.landView, chip.getAttribute('aria-pressed') === 'true',
            ])),
            note: note && !note.hidden ? note.textContent.trim() : '',
            rows: document.querySelectorAll('#llist .row').length,
            count: (document.getElementById('lrescount') || {}).textContent || '',
            filters: {
              stage: (document.getElementById('lstage') || {}).value || '',
              keyword: (document.getElementById('lkw') || {}).value || '',
              procedure: (document.getElementById('lprocedure') || {}).value || '',
            },
            map_state: panel ? (panel.dataset.landMapState || '') : 'absent',
            markers: document.querySelectorAll('#land-map-panel .land-map-marker').length,
            retry: !!document.querySelector('[data-land-map-retry]'),
            dismiss: !!document.querySelector('[data-land-map-dismiss]'),
            list_owns_its_panel: !!document.querySelector('#land-results-grid .land-list-panel #llist'),
          };
        }"""
    )


def new_page(browser, *, block: tuple[str, ...] = ()):
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.add_init_script(FIRST_PAINT_PROBE)
    for marker in block:
        page.route(f"**/*{marker}*", lambda route: route.abort("failed"))
    requests: list[str] = []  # accumulator (not a measured table)
    page.on("request", lambda request: requests.append(request.url))
    return page, requests


def check_first_paint_is_map_free(browser) -> None:
    page, _ = new_page(browser)
    page.goto(f"{BASE}{LIST_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_land(page)
    ordering = page.evaluate(
        """(markers) => {
          const at = window.__landFirstRowAt;
          return {
            first_row_at_ms: at,
            waited_on: performance.getEntriesByType('resource')
              .filter((entry) => at !== null && entry.startTime <= at)
              .map((entry) => entry.name)
              .filter((name) => markers.some((marker) => name.includes(marker))),
          };
        }""",
        list(BLOCKING_MAP_DEPENDENCIES),
    )
    assert ordering["first_row_at_ms"] is not None, "the first result row was never observed"
    assert ordering["waited_on"] == [], f"List first paint waited on {ordering['waited_on']}"
    state = observe(page)
    assert state["rows"] > 0, "List painted no rows"
    assert state["map_state"] == "absent", "a map mounted without anyone asking for one"
    assert state["pressed"]["list"] is True and state["pressed"]["map"] is False
    print("first-paint:", json.dumps(ordering, ensure_ascii=False))
    page.close()


def check_list_paints_with_maps_blocked(browser) -> dict:
    page, _ = new_page(browser, block=BLOCKING_MAP_DEPENDENCIES)
    page.goto(f"{BASE}{LIST_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_land(page)
    page.wait_for_timeout(1_000)
    state = observe(page)
    assert state["rows"] > 0, "List did not paint with map assets blocked"
    assert state["count"], "the result count is missing with map assets blocked"
    assert state["semantic"] == ["boro=Queens", "stage=public_review"], state["semantic"]
    assert state["filters"]["stage"] == "public_review"
    print("maps-blocked-list:", json.dumps(state, ensure_ascii=False))
    page.close()
    return state


def check_activation_requests_only_the_projection(browser) -> dict:
    page, requests = new_page(browser)
    page.goto(f"{BASE}{LIST_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_land(page)
    page.wait_for_timeout(1_500)
    before = observe(page)
    mark = len(requests)

    page.locator('#land-view-switch [data-land-view="map"]').click()
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30_000)
    page.wait_for_timeout(400)
    after = observe(page)

    activation = [url for url in requests[mark:] if url.startswith(BASE)]
    assert activation == [f"{BASE}/{PROJECTION}"], f"activation requested {activation}"
    assert after["markers"] > 0, "activation painted no markers"
    assert after["map_state"] == "ready"
    # Map is a way of looking at the same scope, never a new search.
    assert after["rows"] == before["rows"], "activation changed the result count"
    assert after["semantic"] == before["semantic"], "activation changed the semantic filters"
    assert after["list_owns_its_panel"], "the map replaced the List panel"
    assert "view=map" in page.url

    # And back to List, reversibly, without re-running the search.
    page.locator('#land-view-switch [data-land-view="list"]').click()
    page.wait_for_timeout(400)
    back = observe(page)
    assert back["map_state"] == "absent", "leaving Map left its panel behind"
    assert back["rows"] == before["rows"]
    assert back["semantic"] == before["semantic"]
    print("activation:", json.dumps({"requests": activation, "after": after}, ensure_ascii=False))
    page.close()
    return after


def check_blocked_projection_keeps_the_list(browser, expected: dict) -> None:
    page, _ = new_page(browser, block=(PROJECTION,))
    page.goto(f"{BASE}{LIST_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_land(page)
    before = observe(page)
    page.locator('#land-view-switch [data-land-view="map"]').click()
    page.wait_for_selector('#land-map-panel[data-land-map-state="failed"]', timeout=30_000)
    page.wait_for_timeout(400)
    state = observe(page)

    assert state["rows"] == before["rows"] == expected["rows"], "the failure changed the result set"
    assert state["count"] == before["count"], "the failure changed the result count"
    assert state["semantic"] == before["semantic"], "the failure changed the semantic filters"
    assert state["filters"] == before["filters"], "the failure changed the applied filters"
    assert state["list_owns_its_panel"], "the failure hid the List"
    assert state["retry"], "no retry control after a failed map"
    assert state["dismiss"], "no direct return to List after a failed map"
    assert state["pressed"]["list"] is True, "the control claims a map is on screen"
    assert state["note"], "the resident was not told what happened"
    print("blocked-projection:", json.dumps(state, ensure_ascii=False))
    page.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        check_first_paint_is_map_free(browser)
        check_list_paints_with_maps_blocked(browser)
        activated = check_activation_requests_only_the_projection(browser)
        check_blocked_projection_keeps_the_list(browser, activated)
        browser.close()
    print("land map activation boundary OK")


if __name__ == "__main__":
    main()
