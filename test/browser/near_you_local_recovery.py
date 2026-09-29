"""Browser journeys for the ways out of a Near You place scope.

Serves real Near You documents through the same capture server as the
geography navigation release journey and drives them in headless Chromium at
the two binding viewports.

Local recovery: each failure fixture must show the All NYC link for the
current category next to the result state, outside any collapsed disclosure,
reachable without horizontal scrolling and visibly focused by keyboard. The
link must also work as an ordinary anchor without JavaScript, open separately
on a modified click, and let Back return to the local scope.

Collection entry: the unselected root and Near You entry list every Browse
record family, Browse all NYC records and Search all records ahead of the map.
Each link is followed through the server's Pages edge handler and must land on
its own collection document, not the home shell; Contracts, Meetings and Exams
then open a record from that collection. The links stay present and working
without JavaScript, with location denied, without WebGL or map tiles, and when
the local records read fails.

Every in-page checker is first run against a control element built to fail
it, so a checker that cannot fail refuses the run. Nothing is written to the
repository; no screenshots are taken.
"""

from __future__ import annotations

import datetime
import json
import subprocess
import sys
import urllib.parse
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
MAP_REGION = ".near-geo-workspace"
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
    if layout_precedes(snapshot["map"], snapshot["row"]):
        raise AssertionError("ordering checker accepted the map ahead of the collection row")
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
    page.locator(COLLECTION_ROW).wait_for(state="visible", timeout=15_000)
    page.locator("[data-use-location]:not([hidden])").wait_for(state="visible", timeout=15_000)
    assert_entry_checkers_can_fail(page, expected)
    snapshot = page.evaluate(ENTRY_LAYOUT_JS, COLLECTION_ROW)
    observed = [(link["kind"], link["label"], urllib.parse.urlsplit(link["href"]).path) for link in snapshot["links"]]
    wanted = [(row["kind"], row["label"], row["route"]) for row in expected]
    if observed != wanted:
        raise AssertionError(f"{label}: collection links {observed} do not match the Browse taxonomy {wanted}")
    if snapshot["overflow_x"] > 1:
        raise AssertionError(f"{label}: horizontal overflow {snapshot['overflow_x']}px")
    for name in ("search", "location", "row"):
        if not visible_unscrolled(snapshot[name], snapshot):
            raise AssertionError(f"{label}: {name} is not visible in the first viewport: {snapshot[name]}")
    for link in snapshot["links"]:
        if not visible_unscrolled(link["box"], snapshot):
            raise AssertionError(f"{label}: {link['label']} is not visible in the first viewport: {link['box']}")
    # Visual order: place entry, then the collection row, then the map.
    if not layout_precedes(snapshot["search"], snapshot["row"]) or not layout_precedes(snapshot["location"], snapshot["row"]):
        raise AssertionError(f"{label}: the collection row does not follow search and location: {snapshot}")
    if not layout_precedes(snapshot["row"], snapshot["map"]):
        raise AssertionError(f"{label}: the map starts above the collection row: {snapshot['row']} {snapshot['map']}")
    # Keyboard order: the same controls precede everything inside the map region.
    stops = ["#near-geo-search-input", "[data-use-location]", *[
        f'{COLLECTION_ROW} a[data-near-collection="{row["kind"]}"]' + (f'[data-browse-family="{row["id"]}"]' if row["kind"] == "family" else "")
        for row in expected
    ], f"{MAP_REGION} a[href], {MAP_REGION} button:not([hidden]), {MAP_REGION} summary, {MAP_REGION} [tabindex]:not([tabindex='-1'])"]
    reached = tab_order(page, stops)
    missing = [stop for stop in stops if stop not in reached]
    if missing:
        raise AssertionError(f"{label}: keyboard never reached {missing}")
    map_step = reached[stops[-1]]
    late = [stop for stop in stops[:-1] if reached[stop] >= map_step]
    if late:
        raise AssertionError(f"{label}: keyboard reaches the map before {late}")
    return {
        "label": label,
        "links": len(snapshot["links"]),
        "row_css_px": {"top": round(snapshot["row"]["top"]), "height": round(snapshot["row"]["height"])},
        "map_top_css_px": round(snapshot["map"]["top"]),
        "tabs_to_map": map_step,
    }


def follow_collection_link(page, row: dict, *, label: str) -> str:
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
            title = " ".join((record_link.inner_text() or "").replace("◆", " ").split())
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
            results.append({"label": f"record-{family}", "clock_day": day, "record": href, "title": title})
        finally:
            context.close()
    return results


def assert_row_link_works(page, expected: list[dict], family: str, *, label: str) -> None:
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


def main() -> int:
    process, base = serve_near_you()
    try:
        results = run(base)
        with launched_chromium() as browser:
            entry = run_collection_entry(browser, base)
    finally:
        process.terminate()
        process.wait(timeout=10)
    print(json.dumps({"near_you_local_recovery": results, "near_you_collection_entry": entry}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
