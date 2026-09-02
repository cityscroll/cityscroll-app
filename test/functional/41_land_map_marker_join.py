#!/usr/bin/env python3
"""Browser proof that Map markers are a rendering of the filtered List, not a second database.

Four things a source assertion cannot prove:

  1. The three counts agree in the live document: the map draws fewer projects than the List
     holds, and says so, rather than letting the marker count stand in for the total.
  2. A marker leads to the same project a List card leads to -- same id, same href, same
     detail -- so the two views never diverge on identity. Since LM-07 the marker is a
     selection control that carries that route and hands it to the selected summary, so the
     path is marker -> selection -> canonical detail; the identity asserted is unchanged.
  3. A marker says how it was placed, so a 25-lot anchor cannot read as an exact address.
  4. A project with no published point gets no marker anywhere on the canvas, and stays
     reachable through the List.
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
PROJECTION = "data/land_project_map_points.json"

MAPPED_SPECIMEN = "2025K0305"
UNMAPPED_SPECIMEN = "2026K0123"
EXPECTED = {"total": 40, "mapped": 29, "unmapped": 11}


def install_routes(page) -> None:
    """Keep the run offline and self-contained.

    `capabilities/` is served from the repository root rather than from `site/`, and the
    remote analytics and open-data origins are not part of what this proves, so they are
    stubbed rather than reached.
    """
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


def new_page(browser):
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    install_routes(page)
    return page


def wait_for_map(page) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.locator("#llist .row").first.wait_for(state="visible", timeout=45_000)
    page.wait_for_selector('#land-map-panel[data-land-map-state="ready"]', timeout=30_000)


def read_map(page) -> dict:
    return page.evaluate(
        """() => {
          const summary = document.getElementById('land-map-summary');
          const markers = [...document.querySelectorAll('#land-map-panel .land-map-marker')];
          const links = [...document.querySelectorAll('#land-map-panel .land-map-marker-control')];
          return {
            counts: summary ? {
              total: Number(summary.dataset.landMapTotal),
              mapped: Number(summary.dataset.landMapMapped),
              unmapped: Number(summary.dataset.landMapUnmapped),
            } : null,
            summary_text: summary ? summary.textContent.trim() : '',
            unmapped_note: (document.querySelector('.land-map-unmapped') || {}).textContent || '',
            marker_count: markers.length,
            marker_ids: markers.map((m) => m.dataset.landMapProject),
            methods: markers.map((m) => m.dataset.landMapMethod),
            precisions: markers.map((m) => m.dataset.landMapPrecision),
            links: links.map((a) => ({
              id: a.dataset.landMapProject,
              href: a.dataset.landMapHref,
              resolved: new URL(a.dataset.landMapHref, location.href).href,
              label: a.getAttribute('aria-label') || '',
            })),
            list_ids: [...document.querySelectorAll('#llist a[href*="#land/"]')]
              .map((a) => decodeURIComponent(a.getAttribute('href').split('#land/')[1] || ''))
              .filter(Boolean),
            list_rows: document.querySelectorAll('#llist .row').length,
          };
        }"""
    )


def check_three_counts_agree(page) -> dict:
    page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    state = read_map(page)

    assert state["counts"] == EXPECTED, f"counts were {state['counts']}, expected {EXPECTED}"
    assert state["counts"]["mapped"] + state["counts"]["unmapped"] == state["counts"]["total"]
    # The failure this card exists to prevent.
    assert state["marker_count"] == EXPECTED["mapped"], (
        f"{state['marker_count']} markers for {EXPECTED['mapped']} mapped rows")
    assert state["marker_count"] != state["counts"]["total"], "the marker count stood in for the total"
    assert state["unmapped_note"].strip(), "the 11 unmapped projects were never mentioned"
    assert "11" in state["unmapped_note"], state["unmapped_note"]
    assert state["list_rows"] == EXPECTED["total"], "the List no longer holds all 40 rows"
    print("three-counts:", json.dumps(
        {"counts": state["counts"], "markers": state["marker_count"], "list_rows": state["list_rows"]},
        ensure_ascii=False))
    return state


def check_marker_and_list_share_one_identity(page, state: dict) -> None:
    assert len(state["links"]) == state["marker_count"], "a marker was drawn with no way into its project"
    ids = [link["id"] for link in state["links"]]
    assert len(set(ids)) == len(ids), "a project was marked twice"
    for link in state["links"]:
        assert f"#land/{link['id']}" in link["href"], f"{link['href']} is not the canonical project route"

    specimen = next(link for link in state["links"] if link["id"] == MAPPED_SPECIMEN)
    # The same href the List card for this project offers.
    list_href = page.evaluate(
        """(id) => {
          const link = [...document.querySelectorAll('#llist a[href*="#land/"]')]
            .find((a) => a.getAttribute('href').includes(`#land/${id}`));
          return link ? new URL(link.getAttribute('href'), location.href).href : null;
        }""",
        MAPPED_SPECIMEN,
    )
    assert list_href, f"the List has no card linking to {MAPPED_SPECIMEN}"
    assert specimen["resolved"] == list_href, (
        f"marker links to {specimen['resolved']} but the List card links to {list_href}")

    # Follow the marker to the project. LM-07 made activation select the marker first, so the
    # route is reached through the selected summary's canonical detail action -- the same href
    # asserted above, and the same one the List card carries.
    page.locator(f'.land-map-marker-control[data-land-map-project="{MAPPED_SPECIMEN}"]').click()
    page.wait_for_selector("#land-map-selected", timeout=15_000)
    page.locator(".land-map-selected-detail").click()
    page.wait_for_function(
        "(id) => location.hash.includes(`#land/${id}`)", arg=MAPPED_SPECIMEN, timeout=20_000)
    page.wait_for_function(
        "(id) => (document.getElementById('ldetail') || {}).innerHTML?.includes(id)",
        arg=MAPPED_SPECIMEN, timeout=30_000)
    detail = page.evaluate(
        """() => {
          const el = document.getElementById('ldetail');
          const card = document.getElementById('land-item-card');
          return {
            hash: location.hash,
            hidden: card ? card.hidden : true,
            text: el ? el.textContent : '',
            html: el ? el.innerHTML : '',
          };
        }"""
    )
    assert MAPPED_SPECIMEN in detail["hash"], detail["hash"]
    assert detail["hidden"] is False, "following a marker opened no project detail"
    # Same identity twice over: the id the detail's own source links carry, and the display
    # name the marker announced.
    assert MAPPED_SPECIMEN in detail["html"], "the project detail is not this project's record"
    assert specimen["label"].split(".")[0] in detail["text"], (
        "the detail names a different project than the marker claimed")
    print("marker-identity:", json.dumps(
        {"id": MAPPED_SPECIMEN, "href": specimen["href"], "list_href": list_href, "hash": detail["hash"]},
        ensure_ascii=False))


def check_labels_name_method_and_precision(state: dict) -> None:
    assert set(state["methods"]) == {"multi_bbl_anchor", "single_bbl_centroid"}, set(state["methods"])
    assert set(state["precisions"]) == {"anchor", "exact"}, set(state["precisions"])
    assert len(state["methods"]) == state["marker_count"], "a marker was drawn with no method"

    specimen = next(link for link in state["links"] if link["id"] == MAPPED_SPECIMEN)
    label = specimen["label"]
    assert label.strip(), "the specimen marker has no accessible name"
    assert "25" in label, f"a 25-lot anchor does not say 25: {label}"
    assert "not an exact address" in label, f"an anchor claimed exactness: {label}"

    # An exact single-lot centroid must not carry the anchor's disclaimer.
    exact_id = next(link["id"] for link, precision
                    in zip(state["links"], state["precisions"]) if precision == "exact")
    exact_label = next(link["label"] for link in state["links"] if link["id"] == exact_id)
    assert "not an exact address" not in exact_label, f"an exact point was hedged: {exact_label}"
    print("labels:", json.dumps({"anchor": label, "exact": exact_label}, ensure_ascii=False))


def check_unmapped_project_is_listed_never_drawn(page, state: dict) -> None:
    assert UNMAPPED_SPECIMEN not in state["marker_ids"], "an unplaced project was given a point"
    canvas = page.evaluate(
        "() => (document.querySelector('#land-map-panel .land-map-canvas') || {}).outerHTML || ''")
    assert UNMAPPED_SPECIMEN not in canvas, "an unplaced project reached the canvas"
    if state["list_ids"]:
        assert UNMAPPED_SPECIMEN in state["list_ids"], "the unmapped project fell out of the List"
    # It is still reachable the way the List reaches it.
    page.goto(f"{BASE}/browse/zoning/#land/{UNMAPPED_SPECIMEN}", wait_until="domcontentloaded", timeout=45_000)
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.wait_for_timeout(800)
    page.wait_for_function(
        "(id) => (document.getElementById('ldetail') || {}).innerHTML?.includes(id)",
        arg=UNMAPPED_SPECIMEN, timeout=30_000)
    hidden = page.evaluate("() => (document.getElementById('land-item-card') || {}).hidden")
    assert hidden is False, "the unmapped project opens no detail of its own"
    print("unmapped-handoff:", json.dumps({"id": UNMAPPED_SPECIMEN, "drawn": False, "reachable": True}))


def check_filtered_map_is_a_subset(browser) -> None:
    page = new_page(browser)
    requests: list[str] = []  # accumulator (not a measured table)
    page.on("request", lambda request: requests.append(request.url))
    page.goto(f"{BASE}{QUEENS_MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map(page)
    state = read_map(page)

    assert state["counts"]["total"] < EXPECTED["total"], "the borough filter did not narrow the population"
    assert state["marker_count"] <= state["counts"]["mapped"] < EXPECTED["mapped"], (
        "a filtered map painted the whole projection")
    assert state["counts"]["mapped"] + state["counts"]["unmapped"] == state["counts"]["total"]
    if state["list_ids"]:
        assert set(state["marker_ids"]) <= set(state["list_ids"]), "a marker sits outside the filtered rows"

    # The map is a rendering, not a publisher: one same-origin projection and nothing else.
    same_origin = [url for url in requests if url.startswith(BASE) and PROJECTION in url]
    assert same_origin, "the projection was never requested"
    for url in requests:
        assert "geosearch" not in url and "nominatim" not in url, f"runtime geocoding: {url}"
    print("filtered-subset:", json.dumps(
        {"counts": state["counts"], "markers": state["marker_count"]}, ensure_ascii=False))
    page.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = new_page(browser)
        state = check_three_counts_agree(page)
        check_labels_name_method_and_precision(state)
        check_marker_and_list_share_one_identity(page, state)
        page.goto(f"{BASE}{MAP_ROUTE}", wait_until="domcontentloaded", timeout=45_000)
        wait_for_map(page)
        check_unmapped_project_is_listed_never_drawn(page, read_map(page))
        page.close()
        check_filtered_map_is_a_subset(browser)
        browser.close()
    print("land map marker join OK")


if __name__ == "__main__":
    main()
