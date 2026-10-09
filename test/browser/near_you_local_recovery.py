"""Browser journeys for the ways out of a Near You place scope.

Serves real Near You documents through the same capture server as the
geography navigation release journey and drives them in headless Chromium at
the two binding viewports.

Local recovery: each failure fixture must show the All NYC link for the
current category next to the result state, outside any collapsed disclosure,
reachable without horizontal scrolling and visibly focused by keyboard. The
link must also work as an ordinary anchor without JavaScript, open separately
on a modified click, and let Back return to the local scope.

Collection entry: the unselected root and Near You entry keep the map in
the first viewport. Browse record families, Browse all NYC records and Search
all records sit under the "More ways to choose" disclosure; a real user action
opens that disclosure before the links are asserted visible. Each link is
followed through the server's Pages edge handler and must land on its own
collection document, not the home shell; Contracts, Meetings and Exams then
open a record from that collection. The links stay present and working without
JavaScript, with location denied, without WebGL or map tiles, and when the
local records read fails.

Collection entry under induced failures: location denied, WebGL unavailable,
basemap tiles failing, and the local records hydration failing outright or
partway are each induced alone, beside a control capture of the same page
without that one failure. Both captures must keep the row with all six family
links and the search anchor; the failed capture must also follow a family
link to its collection and resolve the search anchor. The same captures are
repeated with the row cut from the served document and must then fail.

Section isolation: with one section's read made to fail on the server (the
capture server's fault header, so the real handler and loader run), the
sections that loaded stay usable at both viewports. Midwood's records keep
their inspect/dismiss control and native full-record link while the citywide
bucket is unavailable; Retry reloads only the failed section in place,
keeping the loaded sections, focus and scroll; when Midwood's own read fails
the citywide records still load and, without JavaScript, the All NYC Browse
route still works.

Every in-page checker is first run against a control element built to fail
it, so a checker that cannot fail refuses the run. Nothing is written to the
repository; no screenshots are taken.
"""

from __future__ import annotations

import datetime
import json
import re
import struct
import subprocess
import sys
import time
import urllib.parse
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from browser_support import launched_chromium  # noqa: E402
from geography_navigation_release import serve_near_you  # noqa: E402

VIEWPORTS = (("desktop", 1440, 900), ("narrow_touch", 390, 844))
PLACE_PARAMS = ("geo", "boro", "cd", "council", "neighborhood", "scope")
# A well-formed neighborhood key with no published slice: the server answers
# with its records-unavailable document regardless of the data refresh.
FAILED_READ_QUERY = "geo=nta2020%3ABK9999&lens=meetings&q=hearing"
# A published neighborhood whose deferred records read is made to fail in-page.
DEFERRED_FAILURE_QUERY = "geo=nta2020%3AMN0102&lens=meetings&q=hearing&surface=records"
TARGET_SIZE_FLOOR_CSS_PX = 44

INSPECT_JS = """(selector) => {
  const describe = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const hidden = node.closest('[hidden]');
    return {
      inside_details: Boolean(node.closest('details')),
      inside_closed_details: Boolean(node.closest('details:not([open])')),
      hidden: Boolean(hidden) || style.display === 'none' || style.visibility === 'hidden'
        || rect.width === 0 || rect.height === 0,
      left: rect.left + scrollX,
      right: rect.right + scrollX,
      width: rect.width,
      height: rect.height,
      href: node.getAttribute('href'),
      text: (node.textContent || '').trim(),
      focused: document.activeElement === node,
      focus_visible: node.matches(':focus-visible'),
      outline: { style: style.outlineStyle, width: parseFloat(style.outlineWidth) || 0 },
      box_shadow: style.boxShadow,
    };
  };
  return {
    target: describe(document.querySelector(selector)),
    inner_width: innerWidth,
    scroll_x: scrollX,
    overflow_x: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
}"""

CONTROL_JS = """() => {
  const details = document.createElement('details');
  details.innerHTML = '<summary>control</summary><a data-recovery-control href="#control">control</a>';
  document.body.append(details);
}"""


def focus_indicator_visible(observed: dict) -> bool:
    outline = observed["outline"]
    ring = outline["style"] not in ("none", "") and outline["width"] > 0
    shadow = observed["box_shadow"] not in ("none", "")
    return bool(observed["focused"] and observed["focus_visible"] and (ring or shadow))


def placement_ok(snapshot: dict) -> bool:
    target = snapshot["target"]
    return bool(
        target
        and not target["hidden"]
        and not target["inside_details"]
        and target["left"] >= 0
        and target["right"] <= snapshot["inner_width"] + 1
        and snapshot["overflow_x"] <= 1
    )


def tab_to(page, selector: str, *, max_tabs: int = 160) -> int:
    page.evaluate(
        """() => {
          document.activeElement?.blur?.();
          document.body.setAttribute('tabindex', '-1');
          document.body.focus();
        }"""
    )
    for step in range(1, max_tabs + 1):
        page.keyboard.press("Tab")
        if page.evaluate("(selector) => document.activeElement?.matches(selector) === true", selector):
            return step
    raise AssertionError(f"keyboard never reached {selector} within {max_tabs} Tab presses")


def assert_checkers_can_fail(page) -> None:
    """Positive controls: each checker must reject an element built to fail it."""
    page.evaluate(CONTROL_JS)
    control = page.evaluate(INSPECT_JS, "[data-recovery-control]")
    if placement_ok(control):
        raise AssertionError(f"placement checker accepted a link inside collapsed details: {control}")
    if focus_indicator_visible(control["target"]):
        raise AssertionError(f"focus checker accepted an unfocused link: {control}")
    page.evaluate("() => document.querySelector('[data-recovery-control]')?.closest('details')?.remove()")


def assert_all_nyc_href(href: str, *, label: str) -> dict:
    url = urllib.parse.urlsplit(href)
    params = urllib.parse.parse_qs(url.query)
    if url.path != "/browse/meetings/":
        raise AssertionError(f"{label}: All NYC link opens {url.path}, not the Meetings collection")
    leaked = [name for name in PLACE_PARAMS if name in params]
    if leaked:
        raise AssertionError(f"{label}: All NYC link keeps local place parameters {leaked}")
    if params.get("q") != ["hearing"]:
        raise AssertionError(f"{label}: All NYC link dropped the topic: {params}")
    return {"path": url.path, "params": {key: values for key, values in sorted(params.items())}}


def check_recovery(page, *, surface: str, label: str, retry_expected: bool) -> dict:
    scope = f'[data-near-surface-panel="{surface}"]'
    all_nyc = f'{scope} [data-near-recovery="all-nyc"]'
    page.locator(all_nyc).first.wait_for(state="visible", timeout=15_000)
    if page.locator(all_nyc).count() != 1:
        raise AssertionError(f"{label}: expected exactly one All NYC link in the {surface} surface")
    assert_checkers_can_fail(page)
    before = page.evaluate(INSPECT_JS, all_nyc)
    if not placement_ok(before):
        raise AssertionError(f"{label}: All NYC link is hidden, collapsed or off-screen: {before}")
    target = before["target"]
    if min(target["width"], target["height"]) < TARGET_SIZE_FLOOR_CSS_PX:
        raise AssertionError(f"{label}: All NYC link target is below {TARGET_SIZE_FLOOR_CSS_PX}px: {target}")
    if target["text"] != "All NYC meetings":
        raise AssertionError(f"{label}: unexpected All NYC link text {target['text']!r}")
    href = assert_all_nyc_href(target["href"], label=label)
    retry = page.locator(f'{scope} [data-near-recovery="retry"]').count()
    if retry_expected and retry != 1:
        raise AssertionError(f"{label}: transient failure should offer exactly one Retry, found {retry}")
    tabs = tab_to(page, all_nyc)
    focused = page.evaluate(INSPECT_JS, all_nyc)
    if not focus_indicator_visible(focused["target"]):
        raise AssertionError(f"{label}: keyboard focus on the All NYC link is not visible: {focused['target']}")
    if focused["scroll_x"] != 0 or focused["overflow_x"] > 1:
        raise AssertionError(f"{label}: reaching the All NYC link scrolled horizontally: {focused}")
    return {
        "label": label,
        "surface": surface,
        "all_nyc_href": href,
        "retry_links": retry,
        "tabs_to_link": tabs,
        "target_css_px": {"width": round(target["width"], 1), "height": round(target["height"], 1)},
    }


def run(base: str) -> list[dict]:
    results: list[dict] = []
    with launched_chromium() as browser:
        for viewport_name, width, height in VIEWPORTS:
            for surface in ("map", "records"):
                context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 500)
                page = context.new_page()
                try:
                    response = page.goto(
                        f"{base}/near-you/?{FAILED_READ_QUERY}&surface={surface}",
                        wait_until="domcontentloaded",
                        timeout=30_000,
                    )
                    if response is None or response.status != 503:
                        raise AssertionError(f"failed-read fixture answered {response and response.status}, expected 503")
                    results.append(check_recovery(
                        page,
                        surface=surface,
                        label=f"failed-read-{surface}-{viewport_name}",
                        retry_expected=True,
                    ))
                finally:
                    context.close()

            context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 500)
            page = context.new_page()
            try:
                page.route(
                    "**/near-you/deferred.json*",
                    lambda route: route.fulfill(status=503, content_type="application/json", body="{}"),
                )
                page.goto(f"{base}/near-you/?{DEFERRED_FAILURE_QUERY}", wait_until="domcontentloaded", timeout=30_000)
                page.locator('[data-near-deferred="results"][data-near-deferred-state="error"]').wait_for(timeout=15_000)
                results.append(check_recovery(
                    page,
                    surface="records",
                    label=f"deferred-failure-records-{viewport_name}",
                    retry_expected=True,
                ))
            finally:
                context.close()

        # Ordinary anchor navigation without JavaScript, then Back to the local scope.
        context = browser.new_context(viewport={"width": 1440, "height": 900}, java_script_enabled=False)
        page = context.new_page()
        try:
            local = f"{base}/near-you/?{FAILED_READ_QUERY}&surface=records"
            page.goto(local, wait_until="domcontentloaded", timeout=30_000)
            link = page.locator('[data-near-surface-panel="records"] [data-near-recovery="all-nyc"]')
            link.click()
            page.wait_for_url("**/browse/meetings/**", timeout=15_000)
            assert_all_nyc_href(page.url.replace(base, ""), label="no-javascript navigation")
            page.go_back(wait_until="domcontentloaded")
            if urllib.parse.parse_qs(urllib.parse.urlsplit(page.url).query).get("geo") != ["nta2020:BK9999"]:
                raise AssertionError(f"Back did not restore the local scope: {page.url}")
            results.append({"label": "no-javascript-anchor-and-back", "returned_to": page.url.replace(base, "")})
        finally:
            context.close()

        # A modified click opens the broader collection separately and keeps this page.
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        try:
            local = f"{base}/near-you/?{DEFERRED_FAILURE_QUERY}"
            page.route(
                "**/near-you/deferred.json*",
                lambda route: route.fulfill(status=503, content_type="application/json", body="{}"),
            )
            page.goto(local, wait_until="domcontentloaded", timeout=30_000)
            link = page.locator('[data-near-surface-panel="records"] [data-near-recovery="all-nyc"]').first
            link.wait_for(state="visible", timeout=15_000)
            modifier = "Meta" if sys.platform == "darwin" else "Control"
            with context.expect_page(timeout=15_000) as opened:
                link.click(modifiers=[modifier])
            popup = opened.value
            # The new page starts at about:blank; wait for the anchor's navigation to commit.
            popup.wait_for_url("**/browse/meetings/**", timeout=15_000)
            assert_all_nyc_href(popup.url.replace(base, ""), label="modified click")
            if page.url != local:
                raise AssertionError(f"modified click navigated the local page away: {page.url}")
            results.append({"label": "modified-click-new-page", "kept": page.url.replace(base, "")})
        finally:
            context.close()
    return results


# --- Collection entry -------------------------------------------------------

ROOT = Path(__file__).resolve().parents[2]
ENTRY_ROUTES = ("/", "/near-you/")
COLLECTION_ROW = "[data-near-collection-entry]"
COLLECTION_DISCLOSURE = "details.near-entry-secondary"
COLLECTION_DISCLOSURE_SUMMARY = "details.near-entry-secondary > summary"
MAP_REGION = ".near-geo-workspace"
MINIMUM_VISIBLE_MAP_HEIGHT = 240
# The expected links come from the canonical Browse taxonomy, not a copy of it.
EXPECTED_COLLECTIONS_JS = """
import { BROWSE_FACETS, BROWSE_GROUPS, browseGroupEntryRoute } from './site/browse_view.mjs';
import { browseSurfaceContractForRoute } from './site/browse_surface_contracts.mjs';
const families = BROWSE_GROUPS.map((group) => {
  const route = browseGroupEntryRoute(group);
  const marker = group.primaryFacet
    ? `data-browse-facet="${group.primaryFacet}"`
    : `data-browse-surface="${browseSurfaceContractForRoute(route).surfaceId}"`;
  return { kind: 'family', id: group.id, label: group.label, route, marker };
});
console.log(JSON.stringify({
  collections: [
    ...families,
    { kind: 'browse-all', id: 'browse-all', label: 'Browse all NYC records', route: '/browse/', marker: 'data-build-rendered="browse-landing"' },
    { kind: 'search', id: 'search', label: 'Search all records', route: '/search/', marker: 'data-search-document' },
  ],
  collection_data_paths: Object.values(BROWSE_FACETS).map((facet) => facet.dataPath),
}));
"""
# Record journeys: the record link prefix each collection lists, and the
# snapshot whose own day pins the browser clock so the collection's freshness
# rules read that snapshot as current.
RECORD_JOURNEYS = (
    ("money", "/notices/", "site/data/money_default_open.json", "open_as_of"),
    ("meetings-decisions", "/meetings/", "site/data/shared_meeting_read_model.json", "generated_at"),
    ("exams", "/exams/", "site/data/staffing_exams.json", "generated_at"),
)
NOTICE_ROWS_PATH = "site/data/money_default_open.json"

ENTRY_LAYOUT_JS = """(rowSelector) => {
  const box = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
      width: rect.width, height: rect.height,
      hidden: Boolean(node.closest('[hidden]')) || style.display === 'none' || style.visibility === 'hidden'
        || rect.width === 0 || rect.height === 0,
      collapsed: Boolean(node.closest('details:not([open])')),
    };
  };
  const row = document.querySelector(rowSelector);
  return {
    inner_width: innerWidth,
    inner_height: innerHeight,
    overflow_x: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    search: box(document.querySelector('#near-geo-search-input')),
    location: box(document.querySelector('[data-use-location]')),
    row: box(row),
    links: [...(row?.querySelectorAll('a[href]') || [])].map((node) => ({
      kind: node.dataset.nearCollection,
      family: node.dataset.browseFamily || null,
      label: (node.textContent || '').trim(),
      href: node.getAttribute('href'),
      box: box(node),
    })),
    map: box(document.querySelector('.near-geo-workspace .near-map-wrap')),
  };
}"""


def expected_collections() -> dict:
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", EXPECTED_COLLECTIONS_JS],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    expected = json.loads(completed.stdout)
    if sum(1 for row in expected["collections"] if row["kind"] == "family") != 6:
        raise AssertionError(f"canonical Browse taxonomy no longer names six families: {expected}")
    return expected


def collection_reads(paths: list[str], expected: dict) -> list[str]:
    """Requests that would load a collection: its data file, or a Browse or search document."""
    data_paths = set(expected["collection_data_paths"])
    routes = {row["route"] for row in expected["collections"]}
    return [path for path in paths if path in data_paths or path in routes]


def check_entry_reads(browser, base: str, expected: dict) -> dict:
    """The row is links only: loading the entry fetches no collection before a click."""
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    paths: list[str] = []
    page.on("request", lambda request: paths.append(urllib.parse.urlsplit(request.url).path)
            if request.url.startswith(base) else None)
    try:
        page.goto(f"{base}/", wait_until="load", timeout=30_000)
        open_collection_ways(page)
        page.locator(COLLECTION_ROW).wait_for(state="visible", timeout=15_000)
        page.wait_for_load_state("networkidle", timeout=30_000)
        reads = collection_reads(paths, expected)
        if reads:
            raise AssertionError(f"the unselected entry loaded collections before any click: {reads}")
        # Positive control: an actual collection data read is caught.
        page.evaluate("(path) => fetch(path).then((response) => response.status)", expected["collection_data_paths"][0])
        page.wait_for_load_state("networkidle", timeout=30_000)
        if not collection_reads(paths, expected):
            raise AssertionError("collection-read checker missed a fetch of a collection data file")
        return {"label": "entry-reads", "same_origin_requests": len(paths) - 1, "collection_reads": 0}
    finally:
        context.close()


def snapshot_day(path: str, field: str) -> str:
    value = json.loads((ROOT / path).read_text(encoding="utf-8")).get(field)
    if not isinstance(value, str) or len(value) < 10:
        raise AssertionError(f"{path} has no {field} day to pin the record journey clock to")
    return value[:10]


def served_document_ok(status: int, path: str, body: str, expected: dict) -> bool:
    """A link landed on its collection: 200, its route, its marker, not the home shell."""
    return bool(
        status == 200
        and path == expected["route"]
        and expected["marker"] in body
        and "data-near-you-root" not in body
    )


def layout_precedes(first: dict | None, second: dict | None) -> bool:
    return bool(first and second and first["bottom"] <= second["top"] + 1)


def visible_unscrolled(box: dict | None, snapshot: dict) -> bool:
    return bool(
        box
        and not box["hidden"]
        and not box["collapsed"]
        and box["left"] >= 0
        and box["right"] <= snapshot["inner_width"] + 1
        and box["bottom"] <= snapshot["inner_height"]
    )



def open_collection_ways(page) -> None:
    """Open the More ways to choose disclosure so collection links are reachable.

    Native <details> works without JavaScript, so the same click covers the
    no-JS matrix. Idempotent when the disclosure is already open or absent.
    """
    details = page.locator(COLLECTION_DISCLOSURE)
    if details.count() == 0:
        return
    if page.evaluate("(sel) => document.querySelector(sel)?.open === true", COLLECTION_DISCLOSURE):
        return
    summary = page.locator(COLLECTION_DISCLOSURE_SUMMARY).first
    summary.wait_for(state="visible", timeout=15_000)
    summary.click()
    page.wait_for_function(
        "(sel) => document.querySelector(sel)?.open === true",
        arg=COLLECTION_DISCLOSURE,
        timeout=5_000,
    )


def tab_order(page, selectors: list[str], *, max_tabs: int = 120) -> dict[str, int]:
    """Tab from the top of the document and record when each selector first takes focus."""
    page.evaluate(
        """() => {
          document.activeElement?.blur?.();
          document.body.setAttribute('tabindex', '-1');
          document.body.focus();
        }"""
    )
    reached: dict[str, int] = {}
    for step in range(1, max_tabs + 1):
        page.keyboard.press("Tab")
        for selector in selectors:
            if selector not in reached and page.evaluate(
                "(selector) => document.activeElement?.matches(selector) === true", selector
            ):
                reached[selector] = step
        if len(reached) == len(selectors):
            break
    return reached


def assert_entry_checkers_can_fail(page, expected: list[dict]) -> None:
    """Positive controls for the layout, ordering, overflow and served-document checkers."""
    snapshot = page.evaluate(ENTRY_LAYOUT_JS, COLLECTION_ROW)
    # Map-first: the live page may keep the map above the disclosure row. Prove
    # the ordering helper still rejects a synthetic row that sits above the map.
    if snapshot["map"] and snapshot["row"] and layout_precedes(snapshot["row"], snapshot["map"]):
        fake_row_above = dict(
            snapshot["row"],
            top=snapshot["map"]["top"] - 80,
            bottom=snapshot["map"]["top"] - 10,
        )
        if not layout_precedes(fake_row_above, snapshot["map"]):
            raise AssertionError("ordering checker cannot detect a row placed above the map")
    elif snapshot["map"] and snapshot["row"]:
        # Live map already precedes the row; that is the accepted layout.
        if not layout_precedes(snapshot["map"], snapshot["row"]):
            raise AssertionError("ordering checker lost map-before-row detection")
    hidden = dict(snapshot["row"], hidden=True)
    if visible_unscrolled(hidden, snapshot):
        raise AssertionError("visibility checker accepted a hidden row")
    below = dict(snapshot["row"], top=snapshot["inner_height"] + 10, bottom=snapshot["inner_height"] + 40)
    if visible_unscrolled(below, snapshot):
        raise AssertionError("visibility checker accepted a row below the first viewport")
    page.evaluate("() => { const wide = document.createElement('div'); wide.id = 'overflow-control'; wide.style.width = '4000px'; wide.style.height = '1px'; document.body.append(wide); }")
    widened = page.evaluate(ENTRY_LAYOUT_JS, COLLECTION_ROW)
    page.evaluate("() => document.getElementById('overflow-control')?.remove()")
    if widened["overflow_x"] <= 1:
        raise AssertionError("overflow checker did not see a 4000px element")
    home = page.content()
    if served_document_ok(200, expected[0]["route"], home, expected[0]):
        raise AssertionError("served-document checker accepted the Near You shell as a collection")


def check_entry_layout(page, *, route: str, viewport_name: str, expected: list[dict]) -> dict:
    label = f"entry-{route}-{viewport_name}"
    page.locator("[data-use-location]:not([hidden])").wait_for(state="visible", timeout=15_000)
    page.locator("#near-geo-search-input").wait_for(state="visible", timeout=15_000)
    # Map-first: with the secondary disclosure collapsed, the map must already
    # be visible in the first viewport with adequate height.
    before = page.evaluate(ENTRY_LAYOUT_JS, COLLECTION_ROW)
    if before["overflow_x"] > 1:
        raise AssertionError(f"{label}: horizontal overflow {before['overflow_x']}px")
    for name in ("search", "location"):
        if not visible_unscrolled(before[name], before):
            raise AssertionError(f"{label}: {name} is not visible in the first viewport before opening More ways: {before[name]}")
    if not before["map"] or before["map"]["hidden"]:
        raise AssertionError(f"{label}: map is missing before opening More ways: {before['map']}")
    # The map may extend past the fold; it must start in the first viewport.
    # Desktop keeps the 240px visible floor; narrow keeps a positive slice while
    # entry chrome (recovery actions) varies.
    map_visible_height = max(
        0,
        min(before["inner_height"], before["map"]["bottom"]) - max(0, before["map"]["top"]),
    )
    if before["map"]["top"] >= before["inner_height"] or before["map"]["top"] < 0:
        raise AssertionError(f"{label}: map is outside the first viewport: {before['map']}")
    if map_visible_height <= 0:
        raise AssertionError(f"{label}: map has no first-viewport height: {before['map']}")
    if before["map"]["height"] < MINIMUM_VISIBLE_MAP_HEIGHT:
        raise AssertionError(
            f"{label}: map geometry height {before['map']['height']}px is below the {MINIMUM_VISIBLE_MAP_HEIGHT}px floor: {before['map']}"
        )
    if before["inner_width"] >= 1440 and map_visible_height < MINIMUM_VISIBLE_MAP_HEIGHT:
        raise AssertionError(
            f"{label}: map visible height {map_visible_height}px is below the {MINIMUM_VISIBLE_MAP_HEIGHT}px desktop floor: {before['map']}"
        )
    open_collection_ways(page)
    page.locator(COLLECTION_ROW).wait_for(state="visible", timeout=15_000)
    assert_entry_checkers_can_fail(page, expected)
    snapshot = page.evaluate(ENTRY_LAYOUT_JS, COLLECTION_ROW)
    observed = [(link["kind"], link["label"], urllib.parse.urlsplit(link["href"]).path) for link in snapshot["links"]]
    wanted = [(row["kind"], row["label"], row["route"]) for row in expected]
    if observed != wanted:
        raise AssertionError(f"{label}: collection links {observed} do not match the Browse taxonomy {wanted}")
    if snapshot["overflow_x"] > 1:
        raise AssertionError(f"{label}: horizontal overflow {snapshot['overflow_x']}px")
    if not snapshot["row"] or snapshot["row"]["hidden"] or snapshot["row"]["collapsed"]:
        raise AssertionError(f"{label}: collection row stays hidden after opening More ways: {snapshot['row']}")
    for link in snapshot["links"]:
        box = link["box"]
        if not box or box["hidden"] or box["collapsed"]:
            raise AssertionError(f"{label}: {link['label']} stays hidden after opening More ways: {box}")
    # Accepted order: place search and location stay above the disclosure; the
    # map remains the first-viewport primary and may precede the opened row.
    if not layout_precedes(snapshot["search"], snapshot["row"]) or not layout_precedes(snapshot["location"], snapshot["row"]):
        raise AssertionError(f"{label}: the collection row does not follow search and location: {snapshot}")
    if not (layout_precedes(snapshot["map"], snapshot["row"]) or layout_precedes(snapshot["row"], snapshot["map"])):
        raise AssertionError(f"{label}: map and collection row have no vertical order: {snapshot['row']} {snapshot['map']}")
    # Keyboard reachability: primary controls, the disclosure summary, then the
    # opened collection links. Map chrome may precede or follow the opened row.
    stops = [
        "#near-geo-search-input",
        "[data-use-location]",
        COLLECTION_DISCLOSURE_SUMMARY,
        *[
            f'{COLLECTION_ROW} a[data-near-collection="{row["kind"]}"]'
            + (f'[data-browse-family="{row["id"]}"]' if row["kind"] == "family" else "")
            for row in expected
        ],
    ]
    reached = tab_order(page, stops)
    missing = [stop for stop in stops if stop not in reached]
    if missing:
        raise AssertionError(f"{label}: keyboard never reached {missing}")
    return {
        "label": label,
        "links": len(snapshot["links"]),
        "row_css_px": {"top": round(snapshot["row"]["top"]), "height": round(snapshot["row"]["height"])},
        "map_top_css_px": round(snapshot["map"]["top"]),
        "map_visible_height_css_px": round(map_visible_height),
        "tabs_to_collections": max(reached[stop] for stop in stops[3:]),
    }


def follow_collection_link(page, row: dict, *, label: str) -> str:
    open_collection_ways(page)
    selector = f'{COLLECTION_ROW} a[data-near-collection="{row["kind"]}"]'
    if row["kind"] == "family":
        selector += f'[data-browse-family="{row["id"]}"]'
    link = page.locator(selector)
    if link.count() != 1:
        raise AssertionError(f"{label}: expected one {row['label']} link, found {link.count()}")
    with page.expect_navigation(timeout=30_000) as navigation:
        link.click()
    response = navigation.value
    body = response.text() if response else ""
    path = urllib.parse.urlsplit(page.url).path
    if not served_document_ok(response.status if response else 0, path, body, row):
        raise AssertionError(
            f"{label}: {row['label']} served {response and response.status} at {path}, "
            f"not the collection marked {row['marker']}"
        )
    return path


def check_collections_reached(browser, base: str, expected: list[dict]) -> list[dict]:
    results = []
    for route in ENTRY_ROUTES:
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        try:
            for row in expected:
                page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=30_000)
                follow_collection_link(page, row, label=f"reach-{route}")
            # Back returns to the unselected entry with the row intact.
            page.go_back(wait_until="domcontentloaded")
            if urllib.parse.urlsplit(page.url).path != route or page.locator(COLLECTION_ROW).count() != 1:
                raise AssertionError(f"Back from a collection did not restore {route}: {page.url}")
            results.append({"label": f"reach-from-{route}", "collections": [row["route"] for row in expected]})
        finally:
            context.close()
    return results


def install_notice_read_model(page, base: str) -> None:
    """Answer the Worker notice read endpoint from the fixture server; refuse every other remote request."""
    def handle(route):
        url = urllib.parse.urlsplit(route.request.url)
        if route.request.url.startswith(base):
            route.continue_()
        elif url.hostname == "api.cityscroll.org" and url.path == "/notice":
            route.fulfill(response=page.request.get(f"{base}/__fixture/notice?{url.query}"))
        else:
            route.abort()
    page.route("**/*", handle)


def check_record_journeys(browser, base: str, expected: list[dict]) -> list[dict]:
    by_id = {row["id"]: row for row in expected}
    notices = {
        str(row["request_id"]): row
        for row in json.loads((ROOT / NOTICE_ROWS_PATH).read_text(encoding="utf-8"))["notices"]
    }
    results = []
    for family, prefix, data_path, field in RECORD_JOURNEYS:
        day = snapshot_day(data_path, field)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        try:
            page.clock.install(time=datetime.datetime.fromisoformat(f"{day}T12:00:00-04:00"))
            install_notice_read_model(page, base)
            page.goto(f"{base}/", wait_until="domcontentloaded", timeout=30_000)
            follow_collection_link(page, by_id[family], label=f"record-{family}")
            record_link = page.locator(f'a[href^="{prefix}"]').first
            try:
                record_link.wait_for(state="visible", timeout=20_000)
            except Exception as error:
                raise AssertionError(f"record-{family}: the collection lists no {prefix} record to open") from error
            href = record_link.get_attribute("href") or ""
            # Browse may disambiguate visible headings for uniqueness while
            # preserving the publisher title on data-source-title.
            source_title = record_link.evaluate(
                """(el) => {
                  const article = el.closest('article[data-source-title], article.browse-static-record');
                  return (article?.getAttribute('data-source-title') || '').trim();
                }"""
            )
            listed = " ".join((record_link.inner_text() or "").replace("◆", " ").split())
            title = source_title or listed
            with page.expect_navigation(timeout=30_000) as navigation:
                record_link.click()
            response = navigation.value
            if response is None or response.status != 200:
                raise AssertionError(f"record-{family}: {href} answered {response and response.status}")
            if urllib.parse.urlsplit(page.url).path.rstrip("/") != urllib.parse.urlsplit(href).path.rstrip("/"):
                raise AssertionError(f"record-{family}: opened {page.url}, not {href}")
            if family == "money":
                record_id = urllib.parse.unquote(href.rsplit("/", 1)[-1])
                if record_id not in notices:
                    raise AssertionError(f"record-{family}: {record_id} is not in the open-contracts snapshot")
                page.wait_for_function(
                    "(title) => (document.querySelector('#noticeview')?.innerText || '').toLowerCase().includes(title)",
                    arg=str(notices[record_id]["short_title"]).lower(),
                    timeout=20_000,
                )
            else:
                heading = " ".join(page.locator("main h1").first.inner_text().split())
                if heading != title:
                    raise AssertionError(f"record-{family}: record page heading {heading!r} is not the listed {title!r}")
            results.append({
                "label": f"record-{family}",
                "clock_day": day,
                "record": href,
                "title": title,
                "listed_heading": listed,
            })
        finally:
            context.close()
    return results


def assert_row_link_works(page, expected: list[dict], family: str, *, label: str) -> None:
    open_collection_ways(page)
    row = next(item for item in expected if item["id"] == family)
    snapshot = page.evaluate(ENTRY_LAYOUT_JS, COLLECTION_ROW)
    links = [(link["label"], urllib.parse.urlsplit(link["href"]).path) for link in snapshot["links"]]
    if links != [(item["label"], item["route"]) for item in expected]:
        raise AssertionError(f"{label}: collection links changed under failure: {links}")
    if not snapshot["row"] or snapshot["row"]["hidden"] or snapshot["row"]["collapsed"]:
        raise AssertionError(f"{label}: collection row is hidden or collapsed: {snapshot['row']}")
    follow_collection_link(page, row, label=label)


def check_entry_failures(browser, base: str, expected: list[dict]) -> list[dict]:
    results = []
    # No JavaScript: plain anchors from both entry routes.
    context = browser.new_context(viewport={"width": 390, "height": 844}, java_script_enabled=False)
    page = context.new_page()
    try:
        for route in ENTRY_ROUTES:
            page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=30_000)
            assert_row_link_works(page, expected, "money", label=f"no-javascript-{route}")
        results.append({"label": "no-javascript", "routes": list(ENTRY_ROUTES)})
    finally:
        context.close()

    # Location denied: the explicit request fails and the collections still work.
    context = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True)
    page = context.new_page()
    try:
        page.goto(f"{base}/", wait_until="domcontentloaded", timeout=30_000)
        location = page.locator("[data-use-location]:not([hidden])")
        location.wait_for(state="visible", timeout=15_000)
        location.click()
        page.wait_for_function(
            "() => /not granted|not available/i.test(document.querySelector('[data-map-status]')?.textContent || '')",
            timeout=15_000,
        )
        assert_row_link_works(page, expected, "rules-mandates", label="geolocation-denied")
        results.append({"label": "geolocation-denied", "status": "denied message shown"})
    finally:
        context.close()

    # No WebGL and no map tiles: the map controller never mounts.
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    try:
        page.add_init_script(
            """(() => {
              const original = HTMLCanvasElement.prototype.getContext;
              HTMLCanvasElement.prototype.getContext = function(type, ...args) {
                if (String(type).toLowerCase().includes('webgl')) return null;
                return original.call(this, type, ...args);
              };
            })()"""
        )
        page.route("**/*", lambda route: route.continue_() if route.request.url.startswith(base) else route.abort())
        page.goto(f"{base}/", wait_until="load", timeout=30_000)
        runtime = page.evaluate("() => document.querySelector('[data-near-you-root]')?.dataset.nearMapRuntime || 'server-svg'")
        if runtime == "maplibre":
            raise AssertionError("WebGL failure fixture still mounted the enhanced map")
        assert_row_link_works(page, expected, "land-property", label="map-unavailable")
        results.append({"label": "map-unavailable", "map_runtime": runtime})
    finally:
        context.close()

    # The local records read fails: the collections do not depend on it.
    context = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True)
    page = context.new_page()
    try:
        page.route(
            "**/near-you/deferred.json*",
            lambda route: route.fulfill(status=503, content_type="application/json", body="{}"),
        )
        page.goto(f"{base}/near-you/", wait_until="domcontentloaded", timeout=30_000)
        page.locator('[data-near-deferred][data-near-deferred-state="error"]').first.wait_for(state="attached", timeout=15_000)
        assert_row_link_works(page, expected, "exams", label="records-unavailable")
        results.append({"label": "records-unavailable", "deferred_state": "error"})
    finally:
        context.close()
    return results


# --- Collection entry under induced failures ---------------------------------
#
# Each failure is induced alone. Its control is the same route at the same
# viewport under the same network policy, differing only in that failure, and
# each capture's signal must match its own side and reject the other side, so
# the observed difference is attributable to the induced condition.

TILE_HOST_SUFFIX = ".basemaps.cartocdn.com"
DEFERRED_PATH = "/near-you/deferred.json"
ROW_MARKUP = re.compile(r'<nav class="near-collection-entry"[\s\S]*?</nav>')
ROW_LINKS_MARKUP = re.compile(r'(<ul class="near-collection-links">)[\s\S]*?(</ul>)')
# Software WebGL, so the controls mount the enhanced map on a GPU-less runner
# as well; Playwright enables this fallback by default on macOS only.
SOFTWARE_WEBGL_ARGS = ("--enable-unsafe-swiftshader",)
EMPTY_SHELL = "<!doctype html><html><head><title></title></head><body></body></html>"
# Location granted at a point outside the city: the explicit request succeeds
# and the entry stays unselected, so the page is comparable to the denied one.
OUTSIDE_CITY_POINT = {"latitude": 39.9526, "longitude": -75.1652}
WEBGL_UNAVAILABLE_JS = """(() => {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    if (String(type).toLowerCase().includes('webgl')) return null;
    return original.call(this, type, ...args);
  };
})()"""
ENTRY_SIGNAL_JS = """() => {
  const root = document.querySelector('[data-near-you-root]');
  return {
    map_runtime: root?.dataset.nearMapRuntime || null,
    map_runtime_reason: root?.dataset.nearMapRuntimeReason || null,
    map_state: root?.dataset.nearGeographyMapState || null,
    deferred_state: root?.dataset.nearDeferredState || null,
    deferred_hosts: document.querySelectorAll('[data-near-deferred]').length,
    location_status: (document.querySelector('[data-map-status]')?.textContent || '').trim(),
  };
}"""
# Page script has finished its work: the records hydration and the map
# controller have each reached a terminal state.
SCRIPTS_SETTLED_JS = """() => {
  const root = document.querySelector('[data-near-you-root]');
  return ['ready', 'error'].includes(root?.dataset.nearDeferredState)
    && ['ready', 'failed'].includes(root?.dataset.nearGeographyMapState);
}"""


class CollectionRowMissing(AssertionError):
    """The collection row, one of its links, or its search anchor is gone."""


def blank_tile_png(size: int = 256) -> bytes:
    """A plain white raster tile built in memory, so the control's basemap loads offline."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    rows = b"".join(b"\x00" + b"\xff\xff\xff" * size for _ in range(size))
    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


BLANK_TILE = blank_tile_png()


def mutate_row(body: str, mutation: str) -> str:
    if mutation == "removed":
        return ROW_MARKUP.sub("", body, count=1)
    return ROW_MARKUP.sub(lambda row: ROW_LINKS_MARKUP.sub(r"\1\2", row.group(0), count=1), body, count=1)


def install_entry_network(page, base: str, *, tiles: str = "served", hydration: str = "real",
                          row_mutation: str | None = None, entry_route: str = "/") -> dict:
    """Same-origin requests reach the capture server; basemap tiles are answered
    locally; every other remote request is refused. One argument changes one
    condition: failing tiles, a failing or truncated records hydration, or the
    collection row removed from, or emptied in, the served entry document."""
    counters = {"tiles_served": 0, "tiles_failed": 0, "hydration_answers": 0, "rows_cut": 0, "uncut_documents": 0}

    def handle(route):
        request = route.request
        url = urllib.parse.urlsplit(request.url)
        if request.url.startswith(base):
            if url.path == DEFERRED_PATH and hydration != "real":
                counters["hydration_answers"] += 1
                if hydration == "unavailable":
                    route.fulfill(status=503, content_type="application/json", body="{}")
                    return
                payload = route.fetch().text()
                route.fulfill(status=200, content_type="application/json", body=payload[: len(payload) // 2])
                return
            if row_mutation and url.path == entry_route and request.resource_type == "document":
                response = route.fetch()
                body = response.text()
                cut = mutate_row(body, row_mutation)
                counters["rows_cut" if cut != body else "uncut_documents"] += 1
                route.fulfill(response=response, body=cut)
                return
            route.continue_()
        elif (url.hostname or "").endswith(TILE_HOST_SUFFIX):
            if tiles == "failed":
                counters["tiles_failed"] += 1
                route.fulfill(status=503, content_type="text/plain", body="")
            else:
                counters["tiles_served"] += 1
                route.fulfill(status=200, content_type="image/png", body=BLANK_TILE)
        else:
            route.abort()

    page.route("**/*", handle)
    return counters


def settle_entry_scripts(page, *, label: str) -> None:
    try:
        page.wait_for_function(SCRIPTS_SETTLED_JS, timeout=30_000)
    except Exception as error:
        raise AssertionError(f"{label}: page script never settled: {page.evaluate(ENTRY_SIGNAL_JS)}") from error


def settle_geolocation(page, *, label: str) -> None:
    location = page.locator("[data-use-location]:not([hidden])")
    location.wait_for(state="visible", timeout=15_000)
    location.click()
    try:
        page.wait_for_function(
            "() => /not granted|blocked|outside/i.test(document.querySelector('[data-map-status]')?.textContent || '')",
            timeout=20_000,
        )
    except Exception as error:
        raise AssertionError(f"{label}: the location request never resolved: {page.evaluate(ENTRY_SIGNAL_JS)}") from error


def settle_tiles(counters: dict, key: str, *, label: str) -> None:
    deadline = time.monotonic() + 20
    while counters[key] == 0 and time.monotonic() < deadline:
        time.sleep(0.25)
    if counters[key] == 0:
        raise AssertionError(f"{label}: the map requested no basemap tile: {counters}")


def run_geolocation(page, counters, *, induced: bool, label: str) -> None:
    settle_entry_scripts(page, label=label)
    settle_geolocation(page, label=label)


def run_settled(page, counters, *, induced: bool, label: str) -> None:
    settle_entry_scripts(page, label=label)


def run_tiles(page, counters, *, induced: bool, label: str) -> None:
    settle_entry_scripts(page, label=label)
    settle_tiles(counters, "tiles_failed" if induced else "tiles_served", label=label)


# Each case: its label, how the induced side differs from its control, how to
# drive the page to a settled state, and the signal each side must show.
ENTRY_FAILURE_CASES = (
    {
        "name": "geolocation-denied",
        "context": lambda induced: {"permissions": []} if induced
        else {"permissions": ["geolocation"], "geolocation": OUTSIDE_CITY_POINT},
        "network": lambda induced: {},
        "init_script": lambda induced: None,
        "drive": run_geolocation,
        "control_ok": lambda signal, counters: "outside" in signal["location_status"].lower(),
        # An empty grant list refuses location in the browser itself, which the
        # page reports as a block with the way to allow it.
        "induced_ok": lambda signal, counters: (
            "blocked" in signal["location_status"].lower()
            and "allow" in signal["location_status"].lower()
        ),
    },
    {
        "name": "webgl-unavailable",
        "context": lambda induced: {},
        "network": lambda induced: {},
        "init_script": lambda induced: WEBGL_UNAVAILABLE_JS if induced else None,
        "drive": run_settled,
        "control_ok": lambda signal, counters: signal["map_runtime"] == "maplibre" and signal["map_state"] == "ready",
        "induced_ok": lambda signal, counters: signal["map_runtime"] == "failed"
        and signal["map_runtime_reason"] == "webgl_unsupported" and signal["map_state"] == "failed",
    },
    {
        "name": "map-tiles-failed",
        "context": lambda induced: {},
        "network": lambda induced: {"tiles": "failed" if induced else "served"},
        "init_script": lambda induced: None,
        "drive": run_tiles,
        "control_ok": lambda signal, counters: signal["map_runtime"] == "maplibre"
        and counters["tiles_served"] > 0 and counters["tiles_failed"] == 0,
        "induced_ok": lambda signal, counters: signal["map_runtime"] == "maplibre"
        and counters["tiles_failed"] > 0 and counters["tiles_served"] == 0,
    },
    {
        "name": "records-hydration-failed",
        "context": lambda induced: {},
        "network": lambda induced: {"hydration": "unavailable"} if induced else {},
        "init_script": lambda induced: None,
        "drive": run_settled,
        # The control is the completed hydration: every deferred shell replaced.
        "control_ok": lambda signal, counters: signal["deferred_state"] == "ready" and signal["deferred_hosts"] == 0
        and counters["hydration_answers"] == 0,
        "induced_ok": lambda signal, counters: signal["deferred_state"] == "error" and counters["hydration_answers"] > 0,
    },
    {
        "name": "records-hydration-truncated",
        "context": lambda induced: {},
        "network": lambda induced: {"hydration": "truncated"} if induced else {},
        "init_script": lambda induced: None,
        "drive": run_settled,
        "control_ok": lambda signal, counters: signal["deferred_state"] == "ready" and signal["deferred_hosts"] == 0
        and counters["hydration_answers"] == 0,
        "induced_ok": lambda signal, counters: signal["deferred_state"] == "error" and counters["hydration_answers"] > 0,
    },
)
# Desktop reads the root entry, the narrow touch viewport the Near You entry.
FAILURE_VIEWPORT_ROUTES = (("desktop", 1440, 900, "/"), ("narrow_touch", 390, 844, "/near-you/"))


def assert_row_intact(page, expected: list[dict], *, label: str) -> dict:
    """The row is present, visible, carries every family link and the search
    anchor with their canonical routes, and the place search is still there."""
    open_collection_ways(page)
    snapshot = page.evaluate(ENTRY_LAYOUT_JS, COLLECTION_ROW)
    row = snapshot["row"]
    if page.locator(COLLECTION_ROW).count() != 1 or not row or row["hidden"] or row["collapsed"]:
        raise CollectionRowMissing(f"{label}: collection row is missing, hidden or collapsed: {row}")
    observed = [
        (link["kind"], link["family"], link["label"], urllib.parse.urlsplit(link["href"] or "").path)
        for link in snapshot["links"]
    ]
    wanted = [(item["kind"], item["id"] if item["kind"] == "family" else None, item["label"], item["route"]) for item in expected]
    if observed != wanted:
        raise CollectionRowMissing(f"{label}: collection links {observed} are not the canonical {wanted}")
    families = [link for link in snapshot["links"] if link["kind"] == "family"]
    if len(families) != 6 or any(not link["box"] or link["box"]["hidden"] for link in families):
        raise CollectionRowMissing(f"{label}: expected six visible family links: {families}")
    search = [link for link in snapshot["links"] if link["kind"] == "search"]
    if len(search) != 1 or not search[0]["box"] or search[0]["box"]["hidden"]:
        raise CollectionRowMissing(f"{label}: the search anchor is missing or hidden: {search}")
    if not snapshot["search"] or snapshot["search"]["hidden"]:
        raise CollectionRowMissing(f"{label}: the place search is missing or hidden: {snapshot['search']}")
    return {"family_links": len(families), "links": len(snapshot["links"]), "search_anchor": search[0]["href"]}


def assert_row_links_resolve(page, base: str, expected: list[dict], family: str, *, label: str) -> dict:
    """Resolve the search anchor and follow one family link through the capture
    server, after proving the landing checker rejects the home shell and an empty shell."""
    family_row = next(item for item in expected if item["id"] == family)
    search_row = next(item for item in expected if item["kind"] == "search")
    home_shell = page.content()
    for control_label, body in (("home shell", home_shell), ("empty shell", EMPTY_SHELL)):
        for row in (family_row, search_row):
            if served_document_ok(200, row["route"], body, row):
                raise AssertionError(f"{label}: landing checker accepted the {control_label} as {row['label']}")
    href = page.locator(f'{COLLECTION_ROW} a[data-near-collection="search"]').get_attribute("href") or ""
    response = page.request.get(urllib.parse.urljoin(f"{base}/", href))
    if not served_document_ok(response.status, urllib.parse.urlsplit(response.url).path, response.text(), search_row):
        raise AssertionError(f"{label}: the search anchor {href} answered {response.status}, not the search document")
    landed = follow_collection_link(page, family_row, label=label)
    return {"followed": landed, "search_anchor_resolved": urllib.parse.urlsplit(href).path}


def capture_entry_case(browser, base: str, expected: list[dict], case: dict, *, induced: bool, viewport: tuple,
                       row_mutation: str | None = None, follow_family: str | None = None) -> dict:
    viewport_name, width, height, route = viewport
    side = "induced" if induced else "control"
    label = f"{case['name']}-{side}-{viewport_name}{f'-row-{row_mutation}' if row_mutation else ''}"
    context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 500,
                                  **case["context"](induced))
    page = context.new_page()
    try:
        init_script = case["init_script"](induced)
        if init_script:
            page.add_init_script(init_script)
        counters = install_entry_network(page, base, row_mutation=row_mutation, entry_route=route,
                                         **case["network"](induced))
        response = page.goto(f"{base}{route}", wait_until="load", timeout=30_000)
        if response is None or response.status != 200:
            raise AssertionError(f"{label}: {route} answered {response and response.status}")
        if row_mutation and (counters["rows_cut"] != 1 or counters["uncut_documents"]):
            raise AssertionError(f"{label}: the served entry document carried no row to mutate: {counters}")
        case["drive"](page, counters, induced=induced, label=label)
        signal = page.evaluate(ENTRY_SIGNAL_JS)
        # Attribution: this side's signal holds and the other side's checker rejects it.
        own, other = ("induced_ok", "control_ok") if induced else ("control_ok", "induced_ok")
        if not case[own](signal, counters):
            raise AssertionError(f"{label}: the {side} capture does not show its condition: {signal} {counters}")
        if case[other](signal, counters):
            raise AssertionError(f"{label}: the {side} capture also satisfies the opposite condition: {signal} {counters}")
        result = {"label": label, "route": route, "signal": signal,
                  "tiles": {key: counters[key] for key in ("tiles_served", "tiles_failed")}}
        result["row"] = assert_row_intact(page, expected, label=label)
        if follow_family:
            result.update(assert_row_links_resolve(page, base, expected, follow_family, label=label))
        return result
    finally:
        context.close()


def check_entry_failure_pairs(browser, base: str, expected: list[dict]) -> list[dict]:
    families = [item["id"] for item in expected if item["kind"] == "family"]
    results = []
    step = 0
    for case in ENTRY_FAILURE_CASES:
        for viewport in FAILURE_VIEWPORT_ROUTES:
            control = capture_entry_case(browser, base, expected, case, induced=False, viewport=viewport)
            # Rotate the followed family so every family is followed somewhere in the matrix.
            family = families[step % len(families)]
            step += 1
            induced = capture_entry_case(browser, base, expected, case, induced=True, viewport=viewport,
                                         follow_family=family)
            results.append({"label": f"{case['name']}-{viewport[0]}", "control": control, "induced": induced})
    followed = {item["induced"]["followed"] for item in results}
    if len(followed) < len(families):
        raise AssertionError(f"the failure matrix followed only {sorted(followed)} of the six families")
    return results


def check_entry_failure_mutations(browser, base: str, expected: list[dict]) -> list[dict]:
    """Mutation control: with the row removed from the served document, or
    left with no links, every induced capture must fail on the row itself
    while its induced failure still shows."""
    results = []
    viewport = FAILURE_VIEWPORT_ROUTES[0]
    for case in ENTRY_FAILURE_CASES:
        for mutation in ("removed", "emptied"):
            try:
                capture_entry_case(browser, base, expected, case, induced=True, viewport=viewport, row_mutation=mutation)
            except CollectionRowMissing as error:
                results.append({"label": f"{case['name']}-row-{mutation}", "failed_on": str(error).split(":", 1)[1].strip()[:80]})
                continue
            raise AssertionError(f"{case['name']}: the induced capture passed with the collection row {mutation}")
    return results


def run_entry_failure_matrix(browser, base: str) -> list[dict]:
    expected = expected_collections()["collections"]
    return [
        *check_entry_failure_pairs(browser, base, expected),
        *check_entry_failure_mutations(browser, base, expected),
    ]


LEGACY_TARGETS_JS = """
import { migrateLegacyUrl } from './site/route_migration.mjs';
const hashes = JSON.parse(process.argv[1]);
console.log(JSON.stringify(Object.fromEntries(hashes.map((hash) => {
  const mapped = migrateLegacyUrl(`https://cityscroll.org/${hash}`);
  return [hash, mapped.migrated ? mapped.target : null];
}))));
"""


def check_legacy_root_hashes(browser, base: str) -> dict:
    """Root hashes still resolve where route migration sends them; a retained one stays on the entry."""
    first_notice = json.loads((ROOT / NOTICE_ROWS_PATH).read_text(encoding="utf-8"))["notices"][0]["request_id"]
    hashes = ["#land", f"#notice/{first_notice}", "#search"]
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", LEGACY_TARGETS_JS, json.dumps(hashes)],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    targets = json.loads(completed.stdout)
    if targets["#land"] is None or targets[f"#notice/{first_notice}"] is None or targets["#search"] is not None:
        raise AssertionError(f"route migration no longer classifies the legacy root hashes as expected: {targets}")
    observed = {}
    for hash_route in hashes:
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.route("**/*", lambda route: route.continue_() if route.request.url.startswith(base) else route.abort())
        try:
            page.goto(f"{base}/{hash_route}", wait_until="domcontentloaded", timeout=30_000)
            target = targets[hash_route]
            if target:
                page.wait_for_url(f"{base}{target}", timeout=15_000)
            else:
                open_collection_ways(page)
                page.locator(COLLECTION_ROW).wait_for(state="visible", timeout=15_000)
                if page.url != f"{base}/{hash_route}":
                    raise AssertionError(f"retained legacy hash {hash_route} left the entry: {page.url}")
            observed[hash_route] = page.url.replace(base, "")
        finally:
            context.close()
    return {"label": "legacy-root-hashes", "observed": observed}


def check_selected_place_keeps_context(browser, base: str) -> dict:
    """Converse control: a selected neighborhood keeps its contextual escape, not the entry row."""
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    try:
        page.goto(f"{base}/near-you/?geo=nta2020%3AMN0102&lens=meetings", wait_until="domcontentloaded", timeout=30_000)
        page.locator(".near-hero h1").wait_for(state="visible", timeout=15_000)
        if page.locator(COLLECTION_ROW).count() != 0:
            raise AssertionError("selected place repeats the collection row")
        return {"label": "selected-place-no-entry-row", "heading": page.locator(".near-hero h1").inner_text()}
    finally:
        context.close()


def run_collection_entry(browser, base: str) -> list[dict]:
    canonical = expected_collections()
    expected = canonical["collections"]
    results: list[dict] = [check_entry_reads(browser, base, canonical)]
    for viewport_name, width, height in VIEWPORTS:
        for route in ENTRY_ROUTES:
            context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 500)
            page = context.new_page()
            try:
                page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=30_000)
                results.append(check_entry_layout(page, route=route, viewport_name=viewport_name, expected=expected))
            finally:
                context.close()
    results.extend(check_collections_reached(browser, base, expected))
    results.extend(check_record_journeys(browser, base, expected))
    results.extend(check_entry_failures(browser, base, expected))
    results.append(check_selected_place_keeps_context(browser, base))
    results.append(check_legacy_root_hashes(browser, base))
    return results


# --- Section isolation -------------------------------------------------------

FAULT_HEADER = "x-near-you-fixture-fail"
MIDWOOD_QUERY = "geo=nta2020%3ABK1403&lens=meetings&surface=records"
CITYWIDE_FAULT = "citywide:meetings=reject"
MIDWOOD_FAULT = "geography:nta2020:BK1403:meetings=reject"
SECTIONS_JS = """() => {
  const ids = (nodes) => [...nodes].map((node) => node.dataset.recordId).sort();
  const local = [...document.querySelectorAll('.near-results li.near-record')]
    .filter((node) => !node.closest('.near-broader-districts'));
  const bag = (kind) => {
    const node = document.querySelector(`[data-bag="${kind}"]`);
    return node ? {
      state: node.getAttribute('data-near-section-state') || 'ready',
      ids: ids(node.querySelectorAll('li.near-record')),
      count_label: (node.querySelector(':scope > h2 > [aria-label], :scope > [aria-label]')?.getAttribute('aria-label')
        || node.querySelector(':scope > h2 > strong, :scope > strong')?.textContent || '').trim(),
    } : null;
  };
  const results = document.querySelector('.near-results');
  return {
    deferred_state: document.querySelector('[data-near-you-root]')?.dataset.nearDeferredState || null,
    local_state: results?.getAttribute('data-near-section-state') || (results?.hasAttribute('data-near-deferred') ? 'shell' : 'ready'),
    local: ids(local),
    citywide: bag('citywide'),
    virtual: bag('virtual'),
    unlocated: bag('unlocated'),
    scroll_y: scrollY,
    overflow_x: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
}"""
MARK_JS = """(selector) => {
  const node = document.querySelector(selector);
  if (node) node.__sectionIdentity = 'kept';
  return Boolean(node);
}"""
KEPT_JS = "(selector) => document.querySelector(selector)?.__sectionIdentity === 'kept'"
DIALOG_OPEN_JS = "() => document.getElementById('near-you-record-inspection')?.open === true"


def fault_deferred_once(page, fault: str) -> list[str]:
    """Fail one section on the first deferred read only; later reads (Retry) pass."""
    seen: list[str] = []

    def handle(route):
        seen.append(route.request.url)
        headers = dict(route.request.headers)
        if len(seen) == 1:
            headers[FAULT_HEADER] = fault
        route.continue_(headers=headers)

    page.route("**/near-you/deferred.json*", handle)
    return seen


def wait_deferred(page, state: str) -> dict:
    page.wait_for_function(
        "(state) => document.querySelector('[data-near-you-root]')?.dataset.nearDeferredState === state",
        arg=state,
        timeout=20_000,
    )
    return page.evaluate(SECTIONS_JS)


def assert_section_checkers_can_fail(page) -> None:
    """Positive controls for the node-identity and dialog checkers."""
    page.evaluate("() => { const control = document.createElement('p'); control.id = 'identity-control'; document.body.append(control); }")
    if page.evaluate(KEPT_JS, "#identity-control"):
        raise AssertionError("identity checker accepted an unmarked node")
    page.evaluate("() => document.getElementById('identity-control')?.remove()")
    if page.evaluate(DIALOG_OPEN_JS):
        raise AssertionError("dialog checker reports an inspection open before any click")


def inspect_and_dismiss(page, *, label: str) -> dict:
    inspect = page.locator(".near-results li.near-record .near-record-inspect").first
    inspect.wait_for(state="visible", timeout=15_000)
    inspect.click()
    page.wait_for_function(DIALOG_OPEN_JS, timeout=10_000)
    page.keyboard.press("Escape")
    page.wait_for_function(f"() => !({DIALOG_OPEN_JS})()", timeout=10_000)
    returned = page.evaluate("() => document.activeElement?.classList.contains('near-record-inspect') === true")
    if not returned:
        raise AssertionError(f"{label}: dismissing the inspection did not return focus to its control")
    return {"inspected": True, "focus_returned": returned}


def open_full_record_and_back(page, base: str, *, label: str) -> str:
    link = page.locator(".near-results li.near-record .near-record-full-record").first
    link.wait_for(state="visible", timeout=15_000)
    href = link.get_attribute("href") or ""
    with page.expect_navigation(timeout=30_000) as navigation:
        link.click()
    response = navigation.value
    if response is None or response.status != 200 or "/meetings/" not in page.url:
        raise AssertionError(f"{label}: full-record link {href} answered {response and response.status} at {page.url}")
    page.go_back(wait_until="domcontentloaded")
    if urllib.parse.parse_qs(urllib.parse.urlsplit(page.url).query).get("geo") != ["nta2020:BK1403"]:
        raise AssertionError(f"{label}: Back did not return to Midwood: {page.url}")
    return href.replace(base, "")


def check_bucket_failure(browser, base: str, *, viewport_name: str, width: int, height: int, control: dict) -> dict:
    label = f"citywide-unavailable-{viewport_name}"
    context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 500)
    page = context.new_page()
    try:
        reads = fault_deferred_once(page, CITYWIDE_FAULT)
        page.goto(f"{base}/near-you/?{MIDWOOD_QUERY}", wait_until="domcontentloaded", timeout=30_000)
        failed = wait_deferred(page, "partial")
        assert_section_checkers_can_fail(page)
        if failed["local"] != control["local"] or not failed["local"]:
            raise AssertionError(f"{label}: Midwood records changed under a citywide failure: {failed['local']} != {control['local']}")
        if failed["citywide"]["state"] != "unavailable" or failed["citywide"]["ids"]:
            raise AssertionError(f"{label}: citywide is not an explicit unavailable section: {failed['citywide']}")
        if failed["citywide"]["count_label"] != "Count unavailable":
            raise AssertionError(f"{label}: citywide count reads {failed['citywide']['count_label']!r}, not unavailable")
        for bucket in ("virtual", "unlocated"):
            if failed[bucket]["count_label"] != control[bucket]["count_label"] or not control[bucket]["count_label"].isdigit():
                raise AssertionError(f"{label}: {bucket} collection changed under a citywide failure: {failed[bucket]}")
        if failed["overflow_x"] > 1:
            raise AssertionError(f"{label}: horizontal overflow {failed['overflow_x']}px")
        inspection = inspect_and_dismiss(page, label=label)

        # Retry in place: the failed citywide preview carries its own Retry.
        page.evaluate(MARK_JS, ".near-results")
        page.evaluate(MARK_JS, '[data-bag="virtual"]')
        retry = page.locator('[data-bag="citywide"] [data-near-recovery="retry"]')
        retry.scroll_into_view_if_needed()
        retry.wait_for(state="visible", timeout=10_000)
        before = page.evaluate(SECTIONS_JS)
        url_before = page.url
        retry.click()
        page.wait_for_function(
            "() => { const bag = document.querySelector('[data-bag=\"citywide\"]'); return bag && !bag.hasAttribute('data-near-section-state'); }",
            timeout=20_000,
        )
        after = wait_deferred(page, "ready")
        if after["citywide"]["ids"] != control["citywide"]["ids"] or not after["citywide"]["ids"]:
            raise AssertionError(f"{label}: Retry did not restore the citywide records: {after['citywide']}")
        if not page.evaluate(KEPT_JS, ".near-results") or not page.evaluate(KEPT_JS, '[data-bag="virtual"]'):
            raise AssertionError(f"{label}: Retry replaced a section that had loaded")
        if after["local"] != control["local"]:
            raise AssertionError(f"{label}: Retry changed the Midwood records")
        if page.url != url_before or len(reads) != 2:
            raise AssertionError(f"{label}: Retry navigated or read more than once: {page.url} {len(reads)} reads")
        focused = page.evaluate("() => document.activeElement?.closest('[data-bag]')?.dataset.bag || null")
        if focused != "citywide":
            raise AssertionError(f"{label}: focus left the retried section: {focused}")
        drift = abs(after["scroll_y"] - before["scroll_y"])
        if drift > 1:
            raise AssertionError(f"{label}: Retry moved the page by {drift}px")
        deferred_reads = len(reads)
        record = open_full_record_and_back(page, base, label=label)
        return {
            "label": label,
            "local_records": len(failed["local"]),
            "citywide_after_retry": len(after["citywide"]["ids"]),
            "deferred_reads": deferred_reads,
            "scroll_drift_css_px": drift,
            "full_record": record,
            **inspection,
        }
    finally:
        context.close()


def check_requested_failure(browser, base: str, *, viewport_name: str, width: int, height: int, control: dict) -> dict:
    label = f"midwood-unavailable-{viewport_name}"
    context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 500)
    page = context.new_page()
    try:
        faulted = {"on": True}

        def handle(route):
            headers = dict(route.request.headers)
            if faulted["on"]:
                headers[FAULT_HEADER] = MIDWOOD_FAULT
            route.continue_(headers=headers)

        page.route("**/near-you/**", handle)
        response = page.goto(f"{base}/near-you/?{MIDWOOD_QUERY}", wait_until="domcontentloaded", timeout=30_000)
        if response is None or response.status != 503:
            raise AssertionError(f"{label}: requested failure answered {response and response.status}, expected 503")
        failed = wait_deferred(page, "partial")
        if failed["local_state"] != "unavailable" or failed["local"]:
            raise AssertionError(f"{label}: Midwood is not an explicit failure: {failed['local_state']} {failed['local']}")
        if failed["citywide"]["ids"] != control["citywide"]["ids"] or not failed["citywide"]["ids"]:
            raise AssertionError(f"{label}: citywide records did not load beside the failed local read")
        if page.locator('.near-results [data-near-recovery="all-nyc"]').count() != 1:
            raise AssertionError(f"{label}: the failed local section lost its All NYC route")
        # Retry the requested section in place once the read recovers.
        faulted["on"] = False
        page.evaluate(MARK_JS, ".near-bags")
        page.locator('.near-results [data-near-recovery="retry"]').click()
        after = wait_deferred(page, "ready")
        if after["local"] != control["local"]:
            raise AssertionError(f"{label}: Retry did not restore Midwood's records: {after['local']}")
        if not page.evaluate(KEPT_JS, ".near-bags"):
            raise AssertionError(f"{label}: Retry replaced the loaded citywide sections")
        return {"label": label, "status": response.status, "citywide_records": len(failed["citywide"]["ids"]),
                "local_after_retry": len(after["local"])}
    finally:
        context.close()


def check_requested_failure_without_javascript(browser, base: str) -> dict:
    context = browser.new_context(
        viewport={"width": 390, "height": 844},
        java_script_enabled=False,
        extra_http_headers={FAULT_HEADER: MIDWOOD_FAULT},
    )
    page = context.new_page()
    try:
        page.goto(f"{base}/near-you/?{MIDWOOD_QUERY}", wait_until="domcontentloaded", timeout=30_000)
        link = page.locator('[data-near-surface-panel="records"] [data-near-recovery="all-nyc"]')
        if link.count() != 1:
            raise AssertionError("no-javascript requested failure lost its All NYC route")
        with page.expect_navigation(timeout=30_000) as navigation:
            link.click()
        landed = navigation.value
        if landed is None or landed.status != 200 or urllib.parse.urlsplit(page.url).path != "/browse/meetings/":
            raise AssertionError(f"no-javascript All NYC route answered {landed and landed.status} at {page.url}")
        return {"label": "requested-failure-no-javascript", "browse": urllib.parse.urlsplit(page.url).path}
    finally:
        context.close()


def run_section_isolation(browser, base: str) -> list[dict]:
    results: list[dict] = []
    for viewport_name, width, height in VIEWPORTS:
        context = browser.new_context(viewport={"width": width, "height": height}, has_touch=width < 500)
        page = context.new_page()
        try:
            page.goto(f"{base}/near-you/?{MIDWOOD_QUERY}", wait_until="domcontentloaded", timeout=30_000)
            control = wait_deferred(page, "ready")
        finally:
            context.close()
        if not control["local"] or not control["citywide"]["ids"]:
            raise AssertionError(f"control Midwood load has no local or citywide records: {control}")
        results.append({"label": f"control-{viewport_name}", "local_records": len(control["local"]),
                        "citywide_records": len(control["citywide"]["ids"])})
        results.append(check_bucket_failure(browser, base, viewport_name=viewport_name, width=width, height=height, control=control))
        results.append(check_requested_failure(browser, base, viewport_name=viewport_name, width=width, height=height, control=control))
    results.append(check_requested_failure_without_javascript(browser, base))
    return results


def main() -> int:
    process, base = serve_near_you()
    try:
        results = run(base)
        with launched_chromium() as browser:
            entry = run_collection_entry(browser, base)
            sections = run_section_isolation(browser, base)
        with launched_chromium(args=SOFTWARE_WEBGL_ARGS) as browser:
            failures = run_entry_failure_matrix(browser, base)
    finally:
        process.terminate()
        process.wait(timeout=10)
    print(json.dumps({
        "near_you_local_recovery": results,
        "near_you_collection_entry": entry,
        "near_you_collection_entry_failures": failures,
        "near_you_section_isolation": sections,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
