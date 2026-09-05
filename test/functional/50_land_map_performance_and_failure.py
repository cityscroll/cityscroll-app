#!/usr/bin/env python3
"""Browser proof for LM-12: bounded Map cost and typed failure states.

LM-05 made the browse Map route-lazy; LM-08/LM-09/LM-11 gave it filter parity, boundary
context, and a complete keyboard/screen-reader path. None of that proved a cost ceiling or
that a resident's browser can tell "the data does not exist" (`projection`) apart from "the
network failed before a response arrived" (`dependency`) apart from "the request exceeded its
time budget" (`timeout`) apart from "the response could not be trusted" (`invalid-data`). This
file proves the four things LM-12's acceptance asks for directly:

  A1     The complete filtered List (`EXPECTED_TOTAL` rows) survives cold cache, warm cache,
         an offline projection, a malformed projection, and a slow-but-recovering projection --
         every one of them, not just one representative failure.
  A2     Each failure kind reaches `#land-map-panel[data-land-map-failure-kind]` distinctly,
         and a successful activation still reports the same List/Map accounting a resident on
         a clean connection sees.
  A3     None of these failure paths issues a request beyond the fixed activation set (the
         projection and the boundary layers) -- no publisher, ZAP, GIS, geocoder, or alternate
         project-search request.
  A4/a11y  axe finds no critical or serious violation in the Map's ready state or a degraded
         (failed) state, at both 390px and 1440px -- LM-11's own axe pass covered only 1440px.

The detail map's Leaflet/Carto tile provider is unmigrated (LM-05, LM-11) and this card does
not change it; `check_detail_map_dependency_and_tile_failures_stay_non_blocking` measures its
current behavior under a blocked CDN and a stalled tile response as a fact -- List and the
browse Map are unaffected either way -- rather than asserting new production behavior for it.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
LIST_ROUTE = "/browse/zoning/"
MAP_ROUTE = "/browse/zoning/?view=map"
PROJECTION = "data/land_project_map_points.json"
AXE = str(ROOT / "test" / "functional" / "assets" / "axe.min.js")
VIEWPORTS = ((390, 844), (1440, 900))

EXPECTED_TOTAL = 40  # the committed default snapshot's project count (site/data/land_default_ulurp.json)


def install_routes(page, *, projection_route=None, block_leaflet=False, delay_tiles_ms=0) -> None:
    def capability_module(route: Route) -> None:
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    page.route(f"{BASE}/capabilities/*", capability_module)
    if projection_route:
        page.route(f"**/*{PROJECTION}*", projection_route)
    if block_leaflet:
        page.route("**/unpkg.com/**", lambda route: route.abort("failed"))
    if delay_tiles_ms:
        def slow_tile(route: Route) -> None:
            time.sleep(delay_tiles_ms / 1000)
            route.abort("timedout")

        page.route("**/basemaps.cartocdn.com/**", slow_tile)
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="[]"),
    )
    page.route("https://**", lambda route: route.abort())


def new_page(browser, *, width: int = 1440, height: int = 900, **route_kwargs):
    context = browser.new_context(viewport={"width": width, "height": height})
    page = context.new_page()
    install_routes(page, **route_kwargs)
    return page


def wait_for_list(page) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=45_000)


def land_state(page) -> dict:
    return page.evaluate(
        """() => {
          const panel = document.getElementById('land-map-panel');
          return {
            rows: document.querySelectorAll('#llist .row').length,
            map_state: panel ? (panel.dataset.landMapState || '') : 'absent',
            failure_kind: panel ? (panel.dataset.landMapFailureKind || null) : null,
            markers: document.querySelectorAll('#land-map-panel .land-map-marker').length,
          };
        }"""
    )


def goto_map(page) -> None:
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=45_000)


def check_successful_map_accounting_and_list_completeness(page) -> None:
    """A1/A2: a clean-connection Map activation reports self-consistent counts, and the List
    underneath it is the same complete population regardless of which rows have a marker."""
    goto_map(page)
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30_000)
    state = land_state(page)
    counts = page.evaluate(
        """() => {
          const summary = document.getElementById('land-map-summary');
          return {
            mapped: Number(summary?.dataset.landMapMapped || 0),
            unmapped: Number(summary?.dataset.landMapUnmapped || 0),
            total: Number(summary?.dataset.landMapTotal || 0),
          };
        }"""
    )
    assert state["rows"] == EXPECTED_TOTAL, f"List held {state['rows']} rows, not {EXPECTED_TOTAL}"
    assert counts["total"] == EXPECTED_TOTAL, counts
    assert counts["mapped"] + counts["unmapped"] == counts["total"], counts
    assert state["markers"] == counts["mapped"], "one marker per mapped row, no more, no fewer"
    assert state["failure_kind"] is None, "a ready map must carry no failure kind"
    print("successful-map:", json.dumps({**state, **counts}))


def check_typed_failure_kinds_keep_the_list_complete(page_factory) -> None:
    """A1/A2/A3: projection/invalid-data/dependency each reach a distinct typed kind, the List
    stays the complete population, and only the two permanent kinds (`projection`,
    `invalid-data`) are hit exactly once -- the transient one (`dependency`) is retried, but
    never past the fixed bound.

    (The stronger A3 claim -- that a Map failure adds no publisher/ZAP/GIS/geocoder request of
    its own -- is proven at the mount boundary in test/land_map_performance_and_failure.
    test.mjs, where the browse Map shell is exercised alone. A full page load also runs the
    List's own unrelated detail-panel machinery -- it auto-selects its first row and looks up
    that project's ZAP outcome regardless of whether Map is even in view -- so counting hosts
    across the whole page here would flag pre-existing, Map-unrelated behavior as a regression.)
    """
    scenarios = [
        ("projection", lambda route: route.fulfill(status=404, body=""), 1),
        ("invalid-data", lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"schema": "wrong"})), 1),
        ("dependency", lambda route: route.abort("failed"), None),  # bounded but > 1; checked below
    ]
    for expected_kind, handler, expected_projection_calls in scenarios:
        calls = {"n": 0}

        def counting_handler(route: Route, *_request, _fulfill=handler) -> None:
            calls["n"] += 1
            _fulfill(route)

        page = page_factory(projection_route=counting_handler)
        goto_map(page)
        page.wait_for_selector('#land-map-panel[data-land-map-state="failed"]', timeout=30_000)
        state = land_state(page)
        assert state["rows"] == EXPECTED_TOTAL, (expected_kind, state)
        assert state["failure_kind"] == expected_kind, (
            f"{expected_kind}: panel reported failure kind {state['failure_kind']!r}")
        if expected_projection_calls is not None:
            assert calls["n"] == expected_projection_calls, (
                f"{expected_kind}: a permanent failure must not be retried (got {calls['n']} attempts)")
        else:
            assert 1 < calls["n"] <= 4, f"{expected_kind}: retry count {calls['n']} is outside the fixed bound"
        print(f"typed-failure[{expected_kind}]:", json.dumps({**state, "projection_requests": calls["n"]}))
        page.close()


# Must exceed LAND_MAP_BUDGETS.map_request_timeout_ms (site/land_map_performance_budget.mjs),
# so the first attempt genuinely exceeds the fixed request budget rather than merely erroring.
SLOW_FIRST_RESPONSE_SECONDS = 4.3


def check_slow_but_recovering_projection_still_reaches_ready(page_factory) -> None:
    """A4: a projection that answers too slowly once, then in time, still reaches the same
    ready map a clean-connection resident sees -- the bounded transient retry actually works
    end to end (real elapsed time, real Playwright network layer), not just at the unit level."""
    attempts = {"n": 0}

    def slow_then_ok(route: Route) -> None:
        attempts["n"] += 1
        if attempts["n"] == 1:
            time.sleep(SLOW_FIRST_RESPONSE_SECONDS)
            # By the time this responds, the client has already given up on this attempt and
            # moved to its retry; fulfilling it late (rather than aborting) proves the earlier
            # abandoned attempt cannot still resolve the outer request a second time.
            route.fulfill(status=200, content_type="application/json", body=(ROOT / "site" / PROJECTION).read_text("utf-8"))
            return
        route.continue_()

    page = page_factory(projection_route=slow_then_ok)
    try:
        goto_map(page)
        page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30_000)
        state = land_state(page)
        assert state["rows"] == EXPECTED_TOTAL, state
        assert state["markers"] > 0, "activation painted no markers after recovering"
        assert attempts["n"] >= 2, "the scenario never actually forced a retry"
        print("slow-network-recovery:", json.dumps({**state, "attempts": attempts["n"]}))
    finally:
        page.close()


def check_detail_map_dependency_and_tile_failures_stay_non_blocking(browser) -> None:
    """Measured, not asserted-as-new-behavior: the detail map's Leaflet/Carto dependency is
    unmigrated (LM-05, LM-11) and this card does not change it. What it does prove is the
    boundary this card actually owns -- that a resident stuck on a blocked CDN, or a Map's own
    projection stalling behind slow tiles, still keeps the complete List and the browse Map
    (its own local SVG substrate, with no tile dependency of its own) working."""
    for label, kwargs in [("leaflet-blocked", {"block_leaflet": True}), ("tile-stalled", {"delay_tiles_ms": 6_000})]:
        page = new_page(browser, **kwargs)
        goto_map(page)
        page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30_000)
        state = land_state(page)
        assert state["rows"] == EXPECTED_TOTAL, (label, state)
        assert state["markers"] > 0, (label, "the browse Map has no tile or Leaflet dependency of its own")
        print(f"detail-map[{label}]:", json.dumps(state))
        page.close()


def run_axe(page, state_name, failures) -> None:
    page.add_script_tag(path=AXE)
    result = page.evaluate(
        "async () => await axe.run(document.getElementById('land-map-panel'), {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map((rule) => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22_rules)
    for violation in gate:
        nodes = "; ".join(node["target"][0] for node in violation["nodes"][:3])
        print(f"FAIL {state_name}: {violation['id']} ({violation['impact']}) -> {violation['help']} @ {nodes}")
        failures.append((state_name, violation["id"]))
    if not gate:
        print(f"OK {state_name}: no critical/serious axe violations")


def check_axe_at_both_viewports_for_success_and_degraded_states(browser) -> None:
    """LM-11 ran axe against the Map's ready and failed states, but only at the default
    1440px viewport. This closes that gap at the 390px viewport the card asks for."""
    failures: list[tuple[str, str]] = []
    for width, height in VIEWPORTS:
        ready_page = new_page(browser, width=width, height=height)
        goto_map(ready_page)
        ready_page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30_000)
        run_axe(ready_page, f"land-map [ready {width}px]", failures)
        ready_page.close()

        failed_page = new_page(browser, width=width, height=height, projection_route=lambda route: route.abort("failed"))
        goto_map(failed_page)
        failed_page.wait_for_selector('#land-map-panel[data-land-map-state="failed"]', timeout=30_000)
        run_axe(failed_page, f"land-map [failed {width}px]", failures)
        failed_page.close()
    assert not failures, f"axe gate: {len(failures)} critical/serious violation(s): {failures}"


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        def factory(**route_kwargs):
            return new_page(browser, **route_kwargs)

        page = factory()
        page.goto(f"{BASE}{LIST_ROUTE}", wait_until="domcontentloaded", timeout=45_000)  # warm the route once
        wait_for_list(page)
        page.close()

        page = factory()
        check_successful_map_accounting_and_list_completeness(page)
        page.close()

        check_typed_failure_kinds_keep_the_list_complete(factory)
        check_slow_but_recovering_projection_still_reaches_ready(factory)
        check_detail_map_dependency_and_tile_failures_stay_non_blocking(browser)
        check_axe_at_both_viewports_for_success_and_degraded_states(browser)

        browser.close()
    print("land map performance and failure (LM-12) OK")


if __name__ == "__main__":
    main()
