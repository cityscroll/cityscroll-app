#!/usr/bin/env python3
"""Browser proof that a selected marker is the filtered row, and that the way back works.

LM-06 proved a marker points at the same project a List card points at. Selection is where
that can quietly stop being true, so this drives the whole journey a resident actually makes
-- Map, select, summary, canonical detail, Back, List, Map -- and checks the five things a
source assertion cannot:

  1. Selecting costs no project search. The summary is written from a row already on screen.
  2. Pointer and keyboard reach the same state, and exactly one marker is ever active.
  3. The detail route a selection offers is the route the List card offers, and Back returns
     to the same filtered population with the selection and the focus the resident left.
  4. A selection the filter no longer holds is dropped, and does not come back when the
     filter widens again.
  5. Nothing about the selection reaches the shareable URL.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[2]

BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
MAP_ROUTE = "/browse/zoning/?view=map"
QUEENS_MAP_ROUTE = "/browse/zoning/?boro=Queens&view=map"

# A 25-lot rezoning: on the map, and emphatically not at an address.
ANCHOR_SPECIMEN = "2025K0305"
# A project with no published point. It has no marker to select and stays in the List.
UNMAPPED_SPECIMEN = "2026K0123"
EXPECTED_TOTAL = 40


def install_routes(page) -> None:
    """Keep the run offline and self-contained, exactly as the marker-join proof does."""
    def capability_module(route: Route) -> None:
        name = route.request.url.split("/capabilities/", 1)[1].split("?", 1)[0]
        source = ROOT / "capabilities" / name
        if source.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=source.read_text("utf-8"))
        else:
            route.fulfill(status=404, body="")

    page.route(f"{BASE}/capabilities/*", capability_module)
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="[]"),
    )
    page.route("https://**", lambda route: route.abort())


def new_page(browser, width: int = 1440, height: int = 900):
    page = browser.new_page(viewport={"width": width, "height": height})
    install_routes(page)
    return page


def wait_for_map(page) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=45_000)
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30_000)


def marker(page, project_id: str):
    return page.locator(f'#land-map-panel [role="button"][data-land-map-project="{project_id}"]')


def read_selection(page) -> dict:
    return page.evaluate(
        """() => {
          const panel = document.getElementById('land-map-panel');
          const summary = document.getElementById('land-map-selected');
          const active = [...document.querySelectorAll('#land-map-panel [aria-current="true"]')];
          const focused = document.activeElement;
          return {
            painted: panel ? (panel.dataset.landMapSelected || null) : null,
            population: panel ? Number(panel.dataset.landMapPopulation) : null,
            total: Number((document.getElementById('land-map-summary') || {}).dataset?.landMapTotal),
            markers: document.querySelectorAll('#land-map-panel [role="button"][data-land-map-project]').length,
            active_ids: active.map((el) => el.dataset.landMapProject),
            has_summary: Boolean(summary),
            summary_text: summary ? summary.textContent.trim() : '',
            summary_label: summary ? (summary.getAttribute('aria-label') || '') : '',
            method: summary ? summary.dataset.landMapMethod : null,
            precision: summary ? summary.dataset.landMapPrecision : null,
            vintage: summary ? summary.dataset.landMapSourceVintage : null,
            detail_href: (document.querySelector('.land-map-selected-detail') || {}).href || null,
            remembered: history.state?.cityscrollRoute?.landSelection ?? null,
            url: location.pathname + location.search + location.hash,
            // The selected summary also carries data-land-map-project, so a focus reading has to
            // say which control it landed on or the marker and the summary read the same.
            focus_kind: focused?.getAttribute?.('role') === 'button' && focused?.dataset?.landMapProject
              ? 'marker'
              : (focused?.id === 'land-map-selected' ? 'summary' : (focused?.id || focused?.tagName || null)),
            focus_project: focused?.getAttribute?.('role') === 'button'
              ? (focused?.dataset?.landMapProject || null) : null,
            focus_id: focused?.id || focused?.tagName || null,
            focus_in_panel: Boolean(panel && focused && panel.contains(focused)),
            list_rows: document.querySelectorAll('#llist .row').length,
          };
        }"""
    )


def assert_selection_absent_from_url(state: dict) -> None:
    """The negative rule this card is built around: selection is never shareable state."""
    url = state["url"]
    for token in (ANCHOR_SPECIMEN, "selected", "marker=", "viewport=", "bbox="):
        assert token not in url, f"selection leaked into the shareable route: {url}"


def check_pointer_selection_costs_no_search(page) -> dict:
    requests: list[str] = []
    page.on("request", lambda request: requests.append(request.url))
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)

    before = read_selection(page)
    assert before["has_summary"] is False, "the map opened with a project already selected"
    assert before["active_ids"] == [], "a marker was active before anything was selected"
    assert before["total"] == EXPECTED_TOTAL, before["total"]

    mark = len(requests)
    marker(page, ANCHOR_SPECIMEN).click()
    page.wait_for_selector("#land-map-selected", timeout=15_000)
    page.wait_for_timeout(500)

    # The whole point of reusing the filtered row: activating a marker asks the network
    # for nothing. A project search here would mean the map had built a second lookup.
    during = [url for url in requests[mark:] if url.startswith(BASE)]
    for url in during:
        assert "land" not in url.rsplit("/", 1)[-1] or url.endswith(".png"), (
            f"selecting a marker fetched {url}")
    assert not [u for u in during if "zap-outcomes" in u or "land_projects" in u], (
        f"selecting a marker issued a project search: {during}")

    state = read_selection(page)
    assert state["painted"] == ANCHOR_SPECIMEN, state["painted"]
    assert state["active_ids"] == [ANCHOR_SPECIMEN], state["active_ids"]
    assert state["total"] == EXPECTED_TOTAL, "selecting changed the filtered population"
    assert state["markers"] == before["markers"], "selecting changed the marker layer"
    assert state["focus_kind"] == "summary", (
        f"pointer selection left focus on {state['focus_kind']}, not the summary it produced")
    assert_selection_absent_from_url(state)
    print("pointer-selection:", json.dumps(
        {"selected": state["painted"], "requests": len(during), "total": state["total"]},
        ensure_ascii=False))
    return state


def check_summary_is_honest_about_placement(state: dict) -> None:
    assert state["method"] == "multi_bbl_anchor", state["method"]
    assert state["precision"] == "anchor", state["precision"]
    assert state["vintage"], "the selected summary dropped the projection vintage"
    text = state["summary_text"]
    assert "25" in text, f"a 25-lot anchor does not say 25: {text}"
    assert "not an exact address" in text, f"an anchor claimed exactness: {text}"
    assert ANCHOR_SPECIMEN in (state["detail_href"] or ""), state["detail_href"]
    assert state["summary_label"], "the selected summary has no accessible name"
    print("placement-honesty:", json.dumps(
        {"method": state["method"], "precision": state["precision"], "vintage": state["vintage"]},
        ensure_ascii=False))


def check_exact_point_is_not_hedged(page) -> None:
    exact_id = page.evaluate(
        """() => {
          const el = [...document.querySelectorAll('#land-map-panel [role="button"][data-land-map-project]')]
            .find((node) => node.querySelector('[data-land-map-precision="exact"]'));
          return el ? el.dataset.landMapProject : null;
        }"""
    )
    assert exact_id, "the default filter paints no exact single-lot point to compare against"
    marker(page, exact_id).click()
    page.wait_for_selector(f'#land-map-selected[data-land-map-project="{exact_id}"]', timeout=15_000)
    state = read_selection(page)
    assert state["precision"] == "exact", state["precision"]
    assert "not an exact address" not in state["summary_text"], (
        f"an exact point was hedged: {state['summary_text']}")
    # Selecting a second project replaces the first; it never adds a second active marker.
    assert state["active_ids"] == [exact_id], state["active_ids"]
    print("exact-vs-anchor:", json.dumps({"exact": exact_id, "anchor": ANCHOR_SPECIMEN}))


def check_keyboard_reaches_the_same_state(page) -> None:
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    control = marker(page, ANCHOR_SPECIMEN)
    assert control.get_attribute("tabindex") == "0", "markers are not in the tab order"
    assert control.get_attribute("aria-label"), "a marker has no accessible name"
    control.focus()
    page.keyboard.press("Enter")
    page.wait_for_selector("#land-map-selected", timeout=15_000)
    by_key = read_selection(page)
    assert by_key["painted"] == ANCHOR_SPECIMEN, "Enter did not select the marker"
    # Activation moves focus to the summary it just produced, not to nowhere.
    assert by_key["focus_in_panel"], "keyboard selection dropped focus out of the map"
    assert by_key["focus_kind"] == "summary", by_key["focus_kind"]

    # Space is the other button key, and it selects rather than scrolling the page.
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    cleared = read_selection(page)
    assert cleared["has_summary"] is False, "Escape did not clear the selection"
    assert cleared["focus_in_panel"], "clearing the selection dropped focus out of the map"
    assert cleared["remembered"] is None, "a cleared selection stayed on the history entry"

    control.focus()
    page.keyboard.press(" ")
    page.wait_for_selector("#land-map-selected", timeout=15_000)
    assert read_selection(page)["painted"] == ANCHOR_SPECIMEN, "Space did not select the marker"

    # Duplicate activation is the same state, never a second one.
    marker(page, ANCHOR_SPECIMEN).click()
    page.wait_for_timeout(400)
    duplicated = read_selection(page)
    assert duplicated["active_ids"] == [ANCHOR_SPECIMEN], duplicated["active_ids"]
    assert page.locator("#land-map-selected").count() == 1, "a second summary was rendered"
    print("keyboard-parity:", json.dumps(
        {"enter": True, "space": True, "escape": True, "active": duplicated["active_ids"]}))


def check_detail_and_back_preserve_scope_and_focus(page) -> None:
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    marker(page, ANCHOR_SPECIMEN).click()
    page.wait_for_selector("#land-map-selected", timeout=15_000)

    # The route the summary offers is the route the List card offers. One project, one address.
    selected_href = read_selection(page)["detail_href"]
    list_href = page.evaluate(
        """(id) => {
          const link = [...document.querySelectorAll('#llist a[href*="#land/"]')]
            .find((a) => a.getAttribute('href').includes(`#land/${id}`));
          return link ? new URL(link.getAttribute('href'), location.href).href : null;
        }""",
        ANCHOR_SPECIMEN,
    )
    assert list_href, f"the List has no card linking to {ANCHOR_SPECIMEN}"
    assert selected_href == list_href, (
        f"the selection offers {selected_href} but the List card offers {list_href}")

    page.locator(".land-map-selected-detail").click()
    page.wait_for_function(
        "(id) => location.hash.includes(`#land/${id}`)", arg=ANCHOR_SPECIMEN, timeout=20_000)
    page.wait_for_function(
        "(id) => (document.getElementById('ldetail') || {}).innerHTML?.includes(id)",
        arg=ANCHOR_SPECIMEN, timeout=30_000)
    assert page.evaluate("() => document.getElementById('land-item-card').hidden") is False, (
        "the canonical detail action opened no project record")

    page.go_back()
    wait_for_map(page)
    page.wait_for_selector("#land-map-selected", timeout=20_000)
    returned = read_selection(page)
    assert returned["total"] == EXPECTED_TOTAL, (
        f"Back returned to {returned['total']} rows, not the {EXPECTED_TOTAL} it left")
    assert returned["list_rows"] == EXPECTED_TOTAL, "Back lost the filtered List"
    assert "view=map" in returned["url"], f"Back lost the Map view: {returned['url']}"
    assert returned["painted"] == ANCHOR_SPECIMEN, "Back forgot which project the resident left from"
    assert returned["active_ids"] == [ANCHOR_SPECIMEN], returned["active_ids"]
    # Focus comes back to the marker that sent the resident away, not to the document root.
    assert returned["focus_kind"] == "marker", (
        f"Back put focus on {returned['focus_kind']} instead of the marker it left from")
    assert returned["focus_project"] == ANCHOR_SPECIMEN, (
        f"Back put focus on marker {returned['focus_project']} instead of {ANCHOR_SPECIMEN}")
    assert_selection_absent_from_url(returned)
    print("detail-round-trip:", json.dumps(
        {"href": selected_href, "back_total": returned["total"], "focus": returned["focus_project"]},
        ensure_ascii=False))


def check_list_handoff_finds_the_same_project(page) -> None:
    page.locator("[data-land-map-list-handoff]").click()
    page.wait_for_timeout(1_200)
    handoff = page.evaluate(
        """(id) => {
          const row = document.querySelector('#llist .row.sel');
          const detail = document.getElementById('ldetail');
          return {
            view: document.getElementById('land-results-grid')?.dataset.landView,
            map_mounted: Boolean(document.getElementById('land-map-panel')),
            selected_row: Boolean(row),
            focus_is_row: document.activeElement === row,
            detail_is_project: Boolean(detail && detail.innerHTML.includes(id)),
            rows: document.querySelectorAll('#llist .row').length,
          };
        }""",
        ANCHOR_SPECIMEN,
    )
    assert handoff["view"] == "list", handoff["view"]
    assert handoff["map_mounted"] is False, "an explicit List handoff left the Map mounted"
    assert handoff["selected_row"], "the handoff selected no List row"
    assert handoff["focus_is_row"], "the handoff dropped focus instead of landing on the row"
    assert handoff["detail_is_project"], "the handoff opened a different project than the map had"
    assert handoff["rows"] == EXPECTED_TOTAL, "the handoff rebuilt the result set"
    print("list-handoff:", json.dumps(handoff, ensure_ascii=False))


def check_filtered_out_selection_clears_and_stays_cleared(browser) -> None:
    page = new_page(browser)
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    marker(page, ANCHOR_SPECIMEN).click()
    page.wait_for_selector("#land-map-selected", timeout=15_000)
    assert read_selection(page)["remembered"] == ANCHOR_SPECIMEN

    # A borough filter that does not hold the Brooklyn specimen.
    page.goto(f"{BASE}{QUEENS_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    page.wait_for_timeout(800)
    narrowed = read_selection(page)
    assert narrowed["total"] < EXPECTED_TOTAL, "the borough filter did not narrow the population"
    assert narrowed["painted"] is None, "a filtered-out project stayed selected"
    assert narrowed["has_summary"] is False, "a filtered-out project kept its summary"
    assert narrowed["active_ids"] == [], narrowed["active_ids"]
    assert narrowed["remembered"] is None, "the filtered-out id was still remembered"

    # And widening the filter again must not bring back a selection the resident never re-made.
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    page.wait_for_timeout(800)
    widened = read_selection(page)
    assert widened["total"] == EXPECTED_TOTAL, widened["total"]
    assert widened["painted"] is None, "a filtered-out selection was resurrected"
    assert widened["has_summary"] is False, "a resurrected summary reappeared"
    print("filtered-out:", json.dumps(
        {"narrowed_total": narrowed["total"], "widened_total": widened["total"], "selected": None}))
    page.close()


def check_stale_history_identity_is_refused(browser) -> None:
    """An entry that remembers a project this document cannot show must not paint one."""
    page = new_page(browser)
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    for stale in ("2099Z9999", "not a project id"):
        page.evaluate(
            """(id) => {
              const current = history.state && typeof history.state === 'object' ? history.state : {};
              const route = current.cityscrollRoute && typeof current.cityscrollRoute === 'object'
                ? current.cityscrollRoute : {};
              history.replaceState({...current, cityscrollRoute: {...route, landSelection: id}}, '', location.href);
            }""",
            stale,
        )
        page.reload(wait_until="domcontentloaded", timeout=45_000)
        wait_for_map(page)
        page.wait_for_timeout(800)
        state = read_selection(page)
        assert state["painted"] is None, f"a stale history id ({stale}) painted a selection"
        assert state["has_summary"] is False, f"a stale history id ({stale}) painted a summary"
        assert state["total"] == EXPECTED_TOTAL, "a stale id changed the filtered population"
        assert stale not in state["summary_text"], state["summary_text"]
    print("stale-history:", json.dumps({"refused": ["2099Z9999", "not a project id"]}))
    page.close()


def check_unmapped_project_has_no_marker_to_select(browser) -> None:
    page = new_page(browser)
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    assert marker(page, UNMAPPED_SPECIMEN).count() == 0, "an unplaced project was given a marker"
    # It stays reachable exactly the way the List reaches it.
    page.goto(f"{BASE}/browse/zoning/#land/{UNMAPPED_SPECIMEN}",
              wait_until="domcontentloaded", timeout=45_000)
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.wait_for_function(
        "(id) => (document.getElementById('ldetail') || {}).innerHTML?.includes(id)",
        arg=UNMAPPED_SPECIMEN, timeout=30_000)
    assert page.evaluate("() => document.getElementById('land-item-card').hidden") is False
    print("unmapped-selection:", json.dumps({"id": UNMAPPED_SPECIMEN, "marker": False, "reachable": True}))
    page.close()


def check_narrow_width_keeps_every_control(browser) -> None:
    page = new_page(browser, width=390, height=844)
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    control = marker(page, ANCHOR_SPECIMEN)
    control.focus()
    page.keyboard.press("Enter")
    page.wait_for_selector("#land-map-selected", timeout=15_000)
    narrow = page.evaluate(
        """() => {
          const summary = document.getElementById('land-map-selected');
          const controls = [...summary.querySelectorAll('a, button')];
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            controls: controls.length,
            reachable: controls.every((el) => {
              const box = el.getBoundingClientRect();
              return box.width > 0 && box.height > 0 && box.right <= window.innerWidth + 1;
            }),
            focus: document.activeElement?.id,
          };
        }"""
    )
    assert narrow["overflow"] <= 0, f"the selected summary overflowed at 390px by {narrow['overflow']}px"
    assert narrow["controls"] >= 3, narrow["controls"]
    assert narrow["reachable"], "a selection control was unreachable at 390px"
    assert narrow["focus"] == "land-map-selected", narrow["focus"]
    print("narrow-width:", json.dumps(narrow, ensure_ascii=False))
    page.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = new_page(browser)
        state = check_pointer_selection_costs_no_search(page)
        check_summary_is_honest_about_placement(state)
        check_exact_point_is_not_hedged(page)
        check_keyboard_reaches_the_same_state(page)
        check_detail_and_back_preserve_scope_and_focus(page)
        check_list_handoff_finds_the_same_project(page)
        page.close()
        check_filtered_out_selection_clears_and_stays_cleared(browser)
        check_stale_history_identity_is_refused(browser)
        check_unmapped_project_has_no_marker_to_select(browser)
        check_narrow_width_keeps_every_control(browser)
        browser.close()
    print("land map marker selection OK")


if __name__ == "__main__":
    main()
