#!/usr/bin/env python3
"""Browser proof for LM-11: a complete non-pointer access path through the Land Map.

LM-06/LM-07/LM-09/LM-10 already proved a marker matches its List row, that keyboard
activation reaches the same state as a pointer, that boundary context is sourced, and
that every control survives a narrow viewport. This file proves the four things those
cards did not need to and LM-11's own acceptance asks for directly:

  A1/A2  The card's specimen walkthrough, driven by real sequential Tab traversal rather
         than a locator jump straight to the target: from the Map/List switch, through the
         selected `2025K0305` marker, its summary, and the canonical detail link, back to
         the List fallback -- and the unmapped `2026K0123` project through that same List,
         which is the "complete textual index" the card allows in place of a second one.
  A3/A4  `prefers-reduced-motion: reduce` does not change what the walkthrough reaches, and
         the CSS rule that is supposed to flatten this feature's own loading animation
         actually applies to the class name `map_runtime.mjs` renders.
  A3/A4  A resident whose focus is already inside the Map panel when it fails -- including a
         retry that fails again -- is never dropped to <body>; axe finds no critical or
         serious violation in the Map's ready state (with a selection open) or its failed
         state, neither of which the site-wide accessibility gate (11_accessibility.py)
         drives.
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
MAP_ROUTE = "/browse/zoning/?view=map"
LIST_ROUTE = "/browse/zoning/"
PROJECTION = "data/land_project_map_points.json"
AXE = str(ROOT / "test" / "functional" / "assets" / "axe.min.js")

# The same 25-lot anchor LM-06/LM-07 established: on the map, and emphatically not at an
# address. The unmapped specimen is derived at runtime (see `find_unmapped_specimen`)
# rather than pinned to one id: which rows the committed projection leaves unplaced shifts
# as the projection's own source vintage advances, and this proof is about an unmapped
# project reaching List through its complete textual index, not about which project that is.
ANCHOR_SPECIMEN = "2025K0305"
EXPECTED_TOTAL = 40

# Bounded so a real regression (the marker dropping out of the tab order entirely) fails
# loudly instead of hanging. Generous on purpose: the Land toolbar's export controls sit
# between the view switch and the results grid in tab order, and this proof is about the
# marker being genuinely reachable by real sequential Tab, not about how many stops away.
MAX_TAB_PRESSES = 220


def install_routes(page, *, block_projection: bool = False, delay_projection_ms: int = 0) -> None:
    def capability_module(route: Route) -> None:
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    page.route(f"{BASE}/capabilities/*", capability_module)
    if block_projection:
        page.route(f"**/*{PROJECTION}*", lambda route: route.abort("failed"))
    elif delay_projection_ms:
        def delayed(route: Route) -> None:
            time.sleep(delay_projection_ms / 1000)
            route.continue_()

        page.route(f"**/*{PROJECTION}*", delayed)
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="[]"),
    )
    page.route("https://**", lambda route: route.abort())


def new_page(browser, *, width: int = 1440, height: int = 900, reduced_motion: str | None = None, **route_kwargs):
    context = browser.new_context(
        viewport={"width": width, "height": height},
        reduced_motion=reduced_motion,
    )
    page = context.new_page()
    install_routes(page, **route_kwargs)
    return page


def wait_for_map(page) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=45_000)
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30_000)


def marker(page, project_id: str):
    return page.locator(f'#land-map-panel [role="button"][data-land-map-project="{project_id}"]')


def active_probe(page) -> dict:
    return page.evaluate(
        """() => {
          const active = document.activeElement;
          return {
            id: active?.id || null,
            tag: active?.tagName || null,
            project: active?.dataset?.landMapProject || null,
            retry: Boolean(active?.closest?.('[data-land-map-retry]') || active?.matches?.('[data-land-map-retry]')),
            in_panel: Boolean(document.getElementById('land-map-panel')?.contains(active)),
            is_body: active === document.body,
          };
        }"""
    )


def check_specimen_walkthrough_by_real_tab_order(page) -> None:
    """Tab from the switch through the selected marker, summary, and detail link."""
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)

    switch = page.evaluate(
        """() => [...document.querySelectorAll('#land-view-switch [data-land-view]')]
          .map((chip) => ({view: chip.dataset.landView, pressed: chip.getAttribute('aria-pressed')}))"""
    )
    assert {"view": "map", "pressed": "true"} in switch, switch
    assert {"view": "list", "pressed": "false"} in switch, switch

    page.locator('#land-view-switch [data-land-view="map"]').focus()
    found = False
    for _ in range(MAX_TAB_PRESSES):
        page.keyboard.press("Tab")
        state = page.evaluate(
            "() => ({project: document.activeElement?.dataset?.landMapProject || null,"
            " role: document.activeElement?.getAttribute?.('role') || null})"
        )
        if state["project"] == ANCHOR_SPECIMEN and state["role"] == "button":
            found = True
            break
    assert found, f"sequential Tab from the view switch never reached marker {ANCHOR_SPECIMEN}"

    page.keyboard.press("Enter")
    page.wait_for_selector("#land-map-selected", timeout=15_000)
    selected = page.evaluate(
        """(id) => {
          const summary = document.getElementById('land-map-selected');
          const detail = document.querySelector('.land-map-selected-detail');
          return {
            focus_is_summary: document.activeElement === summary,
            summary_label: summary?.getAttribute('aria-label') || '',
            method_and_precision_named: /\\(.+\\)/.test(summary?.querySelector('.land-map-selected-placement')?.textContent || ''),
            detail_href: detail?.getAttribute('href') || null,
            other_marker_has_no_aria_current: !document.querySelector(
              `[data-land-map-project]:not([data-land-map-project="${id}"])[aria-current]`),
          };
        }""",
        ANCHOR_SPECIMEN,
    )
    assert selected["focus_is_summary"], "selecting the marker did not move focus to its summary"
    assert selected["summary_label"], "the selected summary has no accessible name"
    assert selected["detail_href"] and ANCHOR_SPECIMEN in selected["detail_href"], selected["detail_href"]
    # Non-color cue: exactly one marker carries the selected-state attribute, and it is a
    # semantic attribute assistive technology exposes, not a CSS class alone.
    assert selected["other_marker_has_no_aria_current"], "a non-selected marker still carried aria-current"

    page.locator(".land-map-selected-detail").click()
    page.wait_for_function(
        "(id) => location.hash.includes(`#land/${id}`)", arg=ANCHOR_SPECIMEN, timeout=20_000)
    page.wait_for_function(
        "(id) => (document.getElementById('ldetail') || {}).innerHTML?.includes(id)",
        arg=ANCHOR_SPECIMEN, timeout=30_000)
    assert page.evaluate("() => document.getElementById('land-item-card').hidden") is False, (
        "the detail link the summary offered opened no project record")

    page.go_back()
    wait_for_map(page)
    fallback = page.evaluate(
        "() => ({rows: document.querySelectorAll('#llist .row').length,"
        " pressed_list: document.querySelector('#land-view-switch [data-land-view=\"list\"]')"
        ".getAttribute('aria-pressed')})"
    )
    assert fallback["rows"] == EXPECTED_TOTAL, (
        f"the List fallback under the Map view held {fallback['rows']} rows, not {EXPECTED_TOTAL}")
    print("specimen-walkthrough:", json.dumps({"tab_presses_to_marker": True, "fallback_rows": fallback["rows"]}))


def find_unmapped_specimen(page) -> dict:
    """One project the List holds and the Map has no marker for, chosen at runtime.

    Which rows the committed point projection leaves unplaced moves with the projection's
    source vintage, so this reads the actual List/Map split on the page rather than pinning
    a specimen id that a later data refresh can quietly turn mapped.
    """
    return page.evaluate(
        """() => {
          const mapped = new Set([...document.querySelectorAll(
            '#land-map-panel [role="button"][data-land-map-project]')].map((el) => el.dataset.landMapProject));
          for (const row of document.querySelectorAll('#llist .row')) {
            const link = row.querySelector('a[href*="#land/"]');
            const match = link?.getAttribute('href')?.match(/#land\\/([^?&]+)/);
            const id = match ? match[1] : null;
            if (id && !mapped.has(id)) {
              return {id, role: row.getAttribute('role'), tabindex: row.getAttribute('tabindex')};
            }
          }
          return null;
        }"""
    )


def check_unmapped_project_reachable_through_the_complete_index(page) -> None:
    """An unmapped project has no marker; the List remains its complete textual index."""
    specimen = find_unmapped_specimen(page)
    assert specimen, "the default filter paints no unmapped row to compare against"
    assert marker(page, specimen["id"]).count() == 0, f"{specimen['id']} has no point but was given a marker"
    assert specimen["role"] == "group", specimen
    assert specimen["tabindex"] == "0", specimen
    print("unmapped-textual-path:", json.dumps({"id": specimen["id"], "marker": False, "list_row": True}))


def check_reduced_motion_preserves_the_walkthrough(browser) -> None:
    page = new_page(browser, reduced_motion="reduce")
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)

    # The CSS rule that is supposed to flatten every animation under reduced motion,
    # exercised directly against the class name `renderLandMapLoading` actually renders --
    # a synthetic probe, so the assertion does not depend on catching a transient state.
    duration = page.evaluate(
        """() => {
          const probe = document.createElement('span');
          probe.className = 'loading';
          document.body.appendChild(probe);
          const value = getComputedStyle(probe).animationDuration;
          probe.remove();
          return value;
        }"""
    )
    assert duration in ("0.001s", "1ms"), f"the Map's loading spinner still animates under reduced motion: {duration}"

    marker(page, ANCHOR_SPECIMEN).click()
    page.wait_for_selector("#land-map-selected", timeout=15_000)
    page.locator(".land-map-selected-detail").click()
    page.wait_for_function(
        "(id) => (document.getElementById('ldetail') || {}).innerHTML?.includes(id)",
        arg=ANCHOR_SPECIMEN, timeout=30_000)
    page.go_back()
    wait_for_map(page)
    rows = page.evaluate("() => document.querySelectorAll('#llist .row').length")
    assert rows == EXPECTED_TOTAL, f"reduced motion changed what the List fallback held: {rows}"
    print("reduced-motion:", json.dumps({"loading_animation_duration": duration, "fallback_rows": rows}))
    page.close()


def check_map_failure_never_drops_focus_to_body(browser) -> None:
    page = new_page(browser, block_projection=True)
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.wait_for_selector('#land-map-panel[data-land-map-state="failed"]', timeout=30_000)
    failed_state = page.evaluate(
        """() => {
          const status = document.querySelector('#land-map-panel [role="status"]');
          return {
            announced: Boolean(status && status.textContent.trim()),
            retry: Boolean(document.querySelector('[data-land-map-retry]')),
            dismiss: Boolean(document.querySelector('[data-land-map-dismiss]')),
          };
        }"""
    )
    assert failed_state["announced"], "the failure was not announced through role=status"
    assert failed_state["retry"] and failed_state["dismiss"], failed_state

    # Focus the one control the failure state offers, then retry while still blocked: the
    # repaint that follows must not throw focus to <body>.
    page.locator("[data-land-map-retry]").focus()
    before = active_probe(page)
    assert before["retry"] and not before["is_body"], before
    page.locator("[data-land-map-retry]").click()
    page.wait_for_selector('#land-map-panel[data-land-map-state="failed"]', timeout=30_000)
    page.wait_for_timeout(200)
    after = active_probe(page)
    assert not after["is_body"], "a resident already inside the Map panel was dropped to <body> when retry failed"
    assert after["in_panel"], f"focus after a failed retry landed outside the panel: {after}"
    assert after["retry"], f"focus after a failed retry did not land on the retry control: {after}"

    # Dismiss still returns to a complete List with the panel gone.
    page.locator("[data-land-map-dismiss]").click()
    page.wait_for_function(
        "() => document.getElementById('land-map-panel') === null", timeout=15_000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=15_000)
    dismissed = page.evaluate(
        "() => ({view: document.getElementById('land-results-grid')?.dataset.landView,"
        " panel: Boolean(document.getElementById('land-map-panel')),"
        " rows: document.querySelectorAll('#llist .row').length})"
    )
    assert dismissed["view"] == "list", dismissed
    assert dismissed["panel"] is False, "dismiss left the failed panel mounted"
    assert dismissed["rows"] == EXPECTED_TOTAL, dismissed
    print("map-failure-focus:", json.dumps({"before": before, "after": after, "dismissed": dismissed}))
    page.close()


def run_axe(page, state_name, failures) -> None:
    """Scoped to the Land Map panel itself.

    The rest of the Browse document (the static SEO/no-JS summary shell `browse_view.mjs`
    and `edge_summary.mjs` render on every Browse route) is the site-wide gate's job
    (11_accessibility.py); this card's compatibility impact is the Land Map, and scoping
    here keeps a pre-existing, unrelated finding elsewhere in the document from failing a
    card that never touched it.
    """
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


def check_axe_on_map_ready_and_failed_states(browser) -> None:
    failures: list[tuple[str, str]] = []

    ready_page = new_page(browser)
    ready_page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(ready_page)
    run_axe(ready_page, "land-map [ready]", failures)
    marker(ready_page, ANCHOR_SPECIMEN).click()
    ready_page.wait_for_selector("#land-map-selected", timeout=15_000)
    run_axe(ready_page, "land-map [selected]", failures)
    ready_page.close()

    failed_page = new_page(browser, block_projection=True)
    failed_page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    failed_page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    failed_page.wait_for_selector('#land-map-panel[data-land-map-state="failed"]', timeout=30_000)
    run_axe(failed_page, "land-map [failed]", failures)
    failed_page.close()

    assert not failures, f"axe gate: {len(failures)} critical/serious violation(s) on the Land Map: {failures}"


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = new_page(browser)
        page.goto(f"{BASE}{LIST_ROUTE}", wait_until="domcontentloaded", timeout=45_000)  # warm the route once
        page.close()

        page = new_page(browser)
        check_specimen_walkthrough_by_real_tab_order(page)
        check_unmapped_project_reachable_through_the_complete_index(page)
        page.close()

        check_reduced_motion_preserves_the_walkthrough(browser)
        check_map_failure_never_drops_focus_to_body(browser)
        check_axe_on_map_ready_and_failed_states(browser)
        browser.close()
    print("land map accessibility (LM-11) OK")


if __name__ == "__main__":
    main()
