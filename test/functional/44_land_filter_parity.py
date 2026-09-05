#!/usr/bin/env python3
"""Browser proof that every Land filter reaches List and Map as one population (lm-08).

The pure suite (test/land_filter_parity.test.mjs) proves the contract across every filter
dimension the canonical query has. This proves the two rendered surfaces actually obey it on the
data the page really loads -- which is the merged warehouse + default snapshot, not the fixture
corpus, so the counts here are measured rather than asserted from the receipt.

What a source assertion cannot show, and this does:

  1. For each scope, the ids the List painted and the ids the Map painted are one population:
     markers and unmapped partition the List exactly, and the three published counts agree.
  2. Switching renderer changes `view` and nothing else -- same filters, same count, same rows,
     same shareable URL apart from the one presentation key.
  3. Selecting a marker changes no membership, and a filter that drops the selected project
     clears it without disturbing the new result set.
  4. An empty Map explains that no projects matched, and is not the map-failed state.
  5. An all-unmapped Map draws nothing, invents no coordinate, and still points at the List.
  6. A view switch runs no second project search.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import Route, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")

# Explicit scopes rather than the bare default, so each one names the population it exercises.
FULL = "status=all&stage=any"
SCOPES = (
    ("full", FULL, "The whole filtered population: both sides of the partition are large."),
    ("combined", f"{FULL}&boro=Queens&family=rezoning", "Borough and family together."),
    ("community-district", f"{FULL}&cd=M05", "A mixed scope: some results placed, some not."),
    ("mapped-and-unmapped", f"{FULL}&q=Westshore", "A small scope holding one of each."),
    ("unmapped-only", f"{FULL}&cd=Q07", "Every result lacks a published location."),
    ("all-unmapped", "status=all&stage=completed", "A larger scope the map cannot draw at all."),
    ("empty", f"{FULL}&q=zzzznotathing", "No project matches."),
    ("legacy-status", "status=public:In Public Review", "A legacy URL spelling still browsable."),
)
# The project the parity fixtures name: a 25-lot rezoning that is on the map.
MAPPED_SPECIMEN = "2025K0305"

READ_STATE = """() => {
  const summary = document.getElementById('land-map-summary');
  const panel = document.getElementById('land-map-panel');
  const markers = [...document.querySelectorAll('#land-map-panel [data-land-map-project][role="button"]')];
  return {
    counts: summary ? {
      total: Number(summary.dataset.landMapTotal),
      mapped: Number(summary.dataset.landMapMapped),
      unmapped: Number(summary.dataset.landMapUnmapped),
    } : null,
    summary_text: summary ? summary.textContent.trim() : '',
    unmapped_note: (document.querySelector('.land-map-unmapped') || {}).textContent || '',
    panel_state: panel ? panel.dataset.landMapState : null,
    failed: !!document.querySelector('.land-map-failed'),
    marker_ids: markers.map((m) => m.dataset.landMapProject),
    marker_labels: markers.map((m) => m.getAttribute('aria-label') || ''),
    selected: panel ? (panel.dataset.landMapSelected || null) : null,
    list_ids: [...document.querySelectorAll('#llist a[href*="#land/"]')]
      .map((a) => decodeURIComponent(a.getAttribute('href').split('#land/')[1] || ''))
      .filter(Boolean),
    list_rows: document.querySelectorAll('#llist .row').length,
    list_empty: !!document.querySelector('.land-empty-state'),
    result_count: (document.getElementById('lrescount') || {}).textContent || '',
    filters: {
      status: (document.getElementById('lstatus') || {}).value,
      stage: (document.getElementById('lstage') || {}).value,
      future: (document.getElementById('lfuture') || {}).value,
      procedure: (document.getElementById('lprocedure') || {}).value,
      family: (document.getElementById('lfamily') || {}).value,
      effect: (document.getElementById('leffect') || {}).value,
      keyword: (document.getElementById('lkw') || {}).value,
    },
    url: location.pathname + location.search + location.hash,
    view: (document.getElementById('land-results-grid') || {}).dataset?.landView || null,
  };
}"""


def install_routes(page) -> None:
    """Keep the run offline and self-contained, exactly as the sibling Land proofs do."""
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


def settle(page, *, expect_map: bool) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    # Either rows or the List's own empty state; both mean the search returned.
    page.wait_for_function(
        "() => document.querySelectorAll('#llist .row').length > 0"
        " || !!document.querySelector('.land-empty-state')",
        timeout=45_000,
    )
    if expect_map:
        page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30_000)
    # The Map repaints when the search returns; let the last paint settle before reading it.
    page.wait_for_timeout(900)


def visit(page, query: str, *, view: str) -> dict:
    suffix = f"{query}&view=map" if view == "map" else query
    page.goto(f"{BASE}/browse/zoning/?{suffix}", wait_until="domcontentloaded", timeout=45_000)
    settle(page, expect_map=view == "map")
    return page.evaluate(READ_STATE)


def distinct(values: list[str]) -> list[str]:
    """First occurrence wins, so the order is the order the List painted."""
    seen: set[str] = set()
    return [value for value in values if not (value in seen or seen.add(value))]


def assert_partition(label: str, state: dict, *, rows_are_projects: bool = True) -> None:
    """The one claim: markers and unmapped partition the List's projects exactly.

    `rows_are_projects` is False for the hearings scope, where a List row is one hearing and a
    project can hold several. The Map's unit is still the project and it says so, so the
    partition is compared against the distinct projects the List painted rather than its rows.
    """
    counts = state["counts"]
    assert counts is not None, f"{label}: the Map published no counts"
    list_ids = distinct(state["list_ids"])
    markers = state["marker_ids"]

    assert len(set(markers)) == len(markers), f"{label}: a project was marked twice"
    if rows_are_projects:
        assert len(set(state["list_ids"])) == len(state["list_ids"]), (
            f"{label}: a project was listed twice")
    # Every marker is a project the List holds. Nothing is minted from the point artifact.
    assert set(markers) <= set(list_ids), (
        f"{label}: markers outside the List: {sorted(set(markers) - set(list_ids))}")
    derived_unmapped = [pid for pid in list_ids if pid not in set(markers)]
    # Disjoint by construction above; the arithmetic is what the panel publishes.
    assert len(derived_unmapped) == counts["unmapped"], (
        f"{label}: {len(derived_unmapped)} projects have no marker but the panel says {counts['unmapped']}")
    assert len(markers) == counts["mapped"], (
        f"{label}: {len(markers)} markers for a published mapped count of {counts['mapped']}")
    assert counts["mapped"] + counts["unmapped"] == counts["total"], f"{label}: counts do not sum"
    assert counts["total"] == len(list_ids), (
        f"{label}: the Map reports {counts['total']} projects but the List painted {len(list_ids)}")
    if rows_are_projects:
        assert counts["total"] == state["list_rows"], (
            f"{label}: the Map reports {counts['total']} but the List painted {state['list_rows']} rows")
    # Marker order follows the List order rather than being sorted independently.
    assert markers == [pid for pid in list_ids if pid in set(markers)], (
        f"{label}: the Map reordered the population it was handed")
    # Every marker says how it was placed.
    assert all(label_text.strip() for label_text in state["marker_labels"]), (
        f"{label}: a marker has no accessible name")


def check_every_scope_partitions(page) -> list[dict]:
    measured = []
    for name, query, proves in SCOPES:
        state = visit(page, query, view="map")
        assert_partition(name, state)
        measured.append({
            "scope": name,
            "query": query,
            "proves": proves,
            "counts": state["counts"],
            "markers": len(state["marker_ids"]),
            "list_rows": state["list_rows"],
        })
        print(f"parity[{name}]:", json.dumps(
            {"counts": state["counts"], "markers": len(state["marker_ids"]),
             "list_rows": state["list_rows"]}, ensure_ascii=False))
    return measured


def check_view_switch_changes_only_presentation(page) -> None:
    for name, query, _proves in SCOPES:
        as_list = visit(page, query, view="list")
        as_map = visit(page, query, view="map")

        assert as_list["list_ids"] == as_map["list_ids"], (
            f"{name}: switching renderer changed which projects the List holds")
        assert as_list["list_rows"] == as_map["list_rows"], f"{name}: the result count changed"
        assert as_list["result_count"] == as_map["result_count"], (
            f"{name}: the summary count reads differently in the two views")
        assert as_list["filters"] == as_map["filters"], (
            f"{name}: a filter control changed value across the switch")
        assert as_list["view"] == "list" and as_map["view"] == "map", name
        # The shareable URL differs by exactly the presentation key.
        assert "view=map" in as_map["url"], as_map["url"]
        assert "view=map" not in as_list["url"], as_list["url"]
        assert as_map["url"].replace("&view=map", "").replace("?view=map", "?") \
            .rstrip("?") == as_list["url"].rstrip("?"), (
            f"{name}: switching renderer rewrote a semantic key\n  list={as_list['url']}\n  map={as_map['url']}")
    print("view-switch: presentation only")


def check_switching_runs_no_second_search(page) -> None:
    page.goto(f"{BASE}/browse/zoning/?{FULL}", wait_until="domcontentloaded", timeout=45_000)
    settle(page, expect_map=False)
    before = page.evaluate(READ_STATE)

    requests: list[str] = []
    page.on("request", lambda request: requests.append(request.url))
    # Switch in place with the control the resident uses.
    page.locator('#land-view-switch [data-land-view="map"]').click()
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30_000)
    page.wait_for_timeout(900)
    after = page.evaluate(READ_STATE)

    assert after["list_ids"] == before["list_ids"], "the switch re-ran the search and changed the rows"
    assert_partition("switch", after)
    projects = [url for url in requests if "land_default_ulurp" in url or "zap-projects" in url]
    assert not projects, f"switching renderer fetched the project population again: {projects}"
    for url in requests:
        assert "geosearch" not in url and "nominatim" not in url, f"runtime geocoding: {url}"
    print("switch-cost:", json.dumps({"project_requests": len(projects), "rows": len(after["list_ids"])}))


def check_selection_is_not_membership(page) -> None:
    state = visit(page, FULL, view="map")
    assert MAPPED_SPECIMEN in state["marker_ids"], "the specimen is not on the default map"

    page.locator(f'[data-land-map-project="{MAPPED_SPECIMEN}"][role="button"]').click()
    page.wait_for_selector("#land-map-selected", timeout=15_000)
    selected = page.evaluate(READ_STATE)
    assert selected["selected"] == MAPPED_SPECIMEN, selected["selected"]
    assert selected["list_ids"] == state["list_ids"], "selecting a marker changed the population"
    assert selected["counts"] == state["counts"], "selecting a marker changed the counts"
    assert_partition("selected", selected)
    # Selection stays out of the shareable URL.
    assert MAPPED_SPECIMEN not in selected["url"], selected["url"]

    # Keyboard reaches the same state, and focus lands on something inside the panel.
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    page.locator(f'[data-land-map-project="{MAPPED_SPECIMEN}"][role="button"]').focus()
    page.keyboard.press("Enter")
    page.wait_for_selector("#land-map-selected", timeout=15_000)
    focused_in_panel = page.evaluate(
        "() => !!document.getElementById('land-map-panel')?.contains(document.activeElement)")
    assert focused_in_panel, "keyboard selection left focus outside the map panel"
    print("selection:", json.dumps({"id": MAPPED_SPECIMEN, "in_url": False, "keyboard": True}))


def check_filter_change_clears_a_dropped_selection(page) -> None:
    visit(page, FULL, view="map")
    page.locator(f'[data-land-map-project="{MAPPED_SPECIMEN}"][role="button"]').click()
    page.wait_for_selector("#land-map-selected", timeout=15_000)
    assert page.evaluate(READ_STATE)["selected"] == MAPPED_SPECIMEN

    # A borough the selected project is not in.
    page.locator("#lstatus").evaluate("el => { el.value = 'all'; }")
    page.goto(f"{BASE}/browse/zoning/?{FULL}&boro=Manhattan&view=map",
              wait_until="domcontentloaded", timeout=45_000)
    settle(page, expect_map=True)
    narrowed = page.evaluate(READ_STATE)

    assert MAPPED_SPECIMEN not in narrowed["list_ids"], "the narrower filter still holds the project"
    assert narrowed["selected"] is None, "a filtered-out project stayed selected"
    assert_partition("selection-cleared", narrowed)

    # And the new result set is what the new filter produces, not one narrowed by the selection.
    reference = visit(page, f"{FULL}&boro=Manhattan", view="map")
    assert reference["list_ids"] == narrowed["list_ids"], (
        "clearing the selection changed the population it was cleared from")
    print("selection-cleared:", json.dumps({"rows": len(narrowed["list_ids"])}))


def check_empty_map_explains_itself(page) -> None:
    state = visit(page, f"{FULL}&q=zzzznotathing", view="map")
    assert state["counts"] == {"total": 0, "mapped": 0, "unmapped": 0}, state["counts"]
    assert state["marker_ids"] == [], "an empty result drew a marker"
    assert state["panel_state"] == "ready", "an empty result was reported as a map that did not load"
    assert state["failed"] is False, "an empty result rendered the map-failed state"
    text = state["summary_text"].lower()
    assert "match" in text, f"the empty Map does not say nothing matched: {state['summary_text']}"
    assert "0 of 0" not in state["summary_text"], (
        f"the empty Map still reads as a count rather than an explanation: {state['summary_text']}")
    # The List keeps the recovery, so the Map does not duplicate it.
    assert state["list_empty"], "the List lost its own empty state"
    print("empty-map:", json.dumps({"summary": state["summary_text"]}, ensure_ascii=False))


def check_unmapped_only_points_at_the_list(page) -> None:
    for name, query in (("unmapped-only", f"{FULL}&cd=Q07"), ("all-unmapped", "status=all&stage=completed")):
        state = visit(page, query, view="map")
        assert state["counts"]["mapped"] == 0, f"{name}: expected nothing on the map"
        assert state["counts"]["total"] > 0, f"{name}: expected results the map cannot draw"
        assert state["marker_ids"] == [], f"{name}: a coordinate was invented"
        assert state["failed"] is False, f"{name}: an unmappable population read as a map failure"
        note = state["unmapped_note"].strip()
        assert note, f"{name}: the unplaced projects were never mentioned"
        assert "list" in note.lower(), f"{name}: the note does not point at the List: {note}"
        assert str(state["counts"]["unmapped"]) in note, f"{name}: the note miscounts: {note}"
        # The rows are still results, and still reachable.
        assert state["list_rows"] == state["counts"]["total"], f"{name}: the List lost rows"
        assert_partition(name, state)
        print(f"unmapped-only[{name}]:", json.dumps(
            {"counts": state["counts"], "note": note}, ensure_ascii=False))


def check_hearings_scope_repaints_the_map(page) -> None:
    """The hearings scope paints through its own search, and the Map has to follow it.

    `landSearch` rewrites the route -- which repaints the Map -- before the hearings search has
    returned, so without an explicit repaint afterwards the Map keeps rendering whatever the
    previous filter produced while the List shows hearings. That is two renderers answering
    different questions, which is the drift this card exists to catch.

    A List row here is one hearing and a project can hold several, so the population the Map
    partitions is the distinct projects the List painted. The panel says "projects", not "rows".
    """
    state = visit(page, "status=all&future=hearing", view="map")
    assert state["list_rows"] > 0, "the hearings scope painted no rows"
    projects = distinct(state["list_ids"])
    assert projects, "the hearings rows carry no project identity"
    assert_partition("hearings", state, rows_are_projects=False)
    assert state["counts"]["total"] == len(projects), (
        f"the Map reports {state['counts']['total']} projects for {len(projects)} the List painted")
    assert state["list_rows"] >= len(projects), "more projects than hearing rows"
    print("hearings-repaint:", json.dumps(
        {"counts": state["counts"], "hearing_rows": state["list_rows"],
         "distinct_projects": len(projects)}, ensure_ascii=False))


def check_mobile_parity(browser) -> None:
    page = new_page(browser, 390, 844)
    for name, query, _proves in SCOPES:
        state = visit(page, query, view="map")
        assert_partition(f"390px {name}", state)
    print("mobile-parity: 390px partitions hold")
    page.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = new_page(browser)
        check_every_scope_partitions(page)
        check_view_switch_changes_only_presentation(page)
        check_switching_runs_no_second_search(page)
        check_selection_is_not_membership(page)
        check_filter_change_clears_a_dropped_selection(page)
        check_empty_map_explains_itself(page)
        check_unmapped_only_points_at_the_list(page)
        check_hearings_scope_repaints_the_map(page)
        page.close()
        check_mobile_parity(browser)
        browser.close()
    print("land filter parity OK")


if __name__ == "__main__":
    main()
