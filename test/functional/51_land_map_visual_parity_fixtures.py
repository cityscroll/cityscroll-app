#!/usr/bin/env python3
"""Paired List/Map visual-parity fixtures and a machine-authoritative receipt (lm-13).

LM-08 through LM-12 each proved one behavior of the Land Map -- filter parity, boundary
context, narrow-screen usability, keyboard/screen-reader access, and typed cost/failure
states -- but none of them left a single bounded capture set a reviewer can open to see
List and Map agree across the states that matter: the default population, a positive and
an anchor placement side by side, an honestly all-unmapped scope, a selected project, a
sourced boundary, a single-result filter, a zero-result filter, a 320px phone width, and
a blocked map dependency.

A screenshot alone cannot prove any of that -- it can look identical while the result set
underneath quietly drifted. So every fixture here is read from the DOM the same way the
sibling Land Map proofs already do (canonical ids, published counts, method and precision
labels, boundary state, failure kind), and the receipt is what a reviewer is meant to
trust; the screenshots are the paired visual evidence beside it, never the check itself.
The fixture manifest that names the nine states, their routes, viewports, and expectations
lives in test/fixtures/land_map_visual_parity_fixtures/manifest.v1.json and is validated on
its own, without a browser, in test/land_map_visual_parity_fixtures.test.mjs.

Screenshots are retained owner-side only: they write to the gitignored .artifacts/ tree,
never to a committed path, and are reproducible on demand from this script. The committed
proof is the receipt at docs/evidence/land-map-visual-parity-fixtures.json -- route,
viewport, revision, data vintage, expected/actual ids, counts, and assertions, plus each
screenshot's byte count and sha256 so a reader can verify a locally regenerated image
against what this run actually captured without an image binary ever entering history.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
MANIFEST_PATH = ROOT / "test" / "fixtures" / "land_map_visual_parity_fixtures" / "manifest.v1.json"
OUT = ROOT / ".artifacts" / "land-map-visual-parity-fixtures" / "screenshots"
RECEIPT = ROOT / "docs" / "evidence" / "land-map-visual-parity-fixtures.json"
PROJECTION = "data/land_project_map_points.json"

MANIFEST = json.loads(MANIFEST_PATH.read_text("utf-8"))
VIEWPORTS = MANIFEST["viewports"]


def install_routes(page: Page, *, block_projection: bool = False) -> None:
    """Offline and self-contained, exactly as the sibling Land Map proofs are."""

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
    page.route(
        "https://data.cityofnewyork.us/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body="[]"),
    )
    page.route("https://**", lambda route: route.abort())


def new_page(browser, viewport_name: str, *, block_projection: bool = False):
    width, height = VIEWPORTS[viewport_name]
    context = browser.new_context(viewport={"width": width, "height": height}, has_touch=True)
    page = context.new_page()
    install_routes(page, block_projection=block_projection)
    return context, page


def wait_for_list(page: Page) -> None:
    page.wait_for_function("() => document.body.dataset.appReady === 'true'", timeout=45_000)
    page.wait_for_function(
        "() => document.querySelectorAll('#llist .row').length > 0 || !!document.querySelector('.land-empty-state')",
        timeout=45_000,
    )


def wait_for_map_settled(page: Page, *, expect_failed: bool = False) -> None:
    wait_for_list(page)
    state = "failed" if expect_failed else "ready"
    page.wait_for_selector(f'#land-map-panel[data-land-map-state="{state}"]', timeout=30_000)
    page.wait_for_timeout(400)


READ_MAP_STATE = """() => {
  const panel = document.getElementById('land-map-panel');
  const summary = document.getElementById('land-map-summary');
  const selected = document.getElementById('land-map-selected');
  return {
    url: location.pathname + location.search + location.hash,
    map_state: panel ? (panel.dataset.landMapState || null) : null,
    failure_kind: panel ? (panel.dataset.landMapFailureKind || null) : null,
    boundary_state: panel ? (panel.dataset.landMapBoundaryState || null) : null,
    boundary_evidence_present: !!document.querySelector('.land-map-boundary-evidence'),
    counts: summary ? {
      total: Number(summary.dataset.landMapTotal),
      mapped: Number(summary.dataset.landMapMapped),
      unmapped: Number(summary.dataset.landMapUnmapped),
    } : null,
    unmapped_note: (document.querySelector('.land-map-unmapped') || {}).textContent || '',
    summary_text: summary ? summary.textContent.trim() : '',
    list_empty: !!document.querySelector('.land-empty-state'),
    list_rows: document.querySelectorAll('#llist .row').length,
    list_ids: [...document.querySelectorAll('#llist a[href*="#land/"]')]
      .map((a) => decodeURIComponent(a.getAttribute('href').split('#land/')[1] || ''))
      .filter(Boolean),
    marker_ids: [...document.querySelectorAll('#land-map-panel [data-land-map-project][role="button"]')]
      .map((m) => m.dataset.landMapProject),
    marker_precisions: [...new Set(
      [...document.querySelectorAll('#land-map-panel [data-land-map-precision]')].map((m) => m.dataset.landMapPrecision)
    )],
    marker_labels_all_present: [...document.querySelectorAll('#land-map-panel [data-land-map-project][role="button"]')]
      .every((m) => (m.getAttribute('aria-label') || '').trim().length > 0),
    selected: panel ? (panel.dataset.landMapSelected || null) : null,
    selected_method: selected ? (selected.dataset.landMapMethod || null) : null,
    selected_precision: selected ? (selected.dataset.landMapPrecision || null) : null,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    retry_present: !!document.querySelector('[data-land-map-retry]'),
    dismiss_present: !!document.querySelector('[data-land-map-dismiss]'),
  };
}"""


def panel_no_overflow(page: Page) -> dict:
    """Scoped to the Land Map's own controls, not the whole document.

    A pre-existing, unrelated overflow in the Land detail's outcomes matrix (rendered off
    the default auto-selected row, nothing this card touches) already breaks a document-wide
    scrollWidth comparison at narrow widths. Scoping to the panel's own controls -- exactly
    the reasoning 49_land_map_accessibility.py already applies to its axe scope -- keeps that
    unrelated finding from failing a card whose compatibility impact is the Land Map alone.
    """
    return page.evaluate(
        """() => {
          const inViewport = (el) => {
            if (!el) return true;
            const box = el.getBoundingClientRect();
            return box.width === 0 || box.right <= window.innerWidth + 1;
          };
          const nodes = [
            document.getElementById('land-map-panel'),
            document.getElementById('land-map-summary'),
            document.querySelector('.land-map-list-link'),
            document.getElementById('land-map-selected'),
            document.querySelector('#land-view-switch'),
          ];
          return nodes.every(inViewport);
        }"""
    )


def visit(page: Page, route: str, *, expect_failed: bool = False) -> dict:
    page.goto(f"{BASE}{route}", wait_until="domcontentloaded", timeout=45_000)
    wait_for_map_settled(page, expect_failed=expect_failed)
    return page.evaluate(READ_MAP_STATE)


def select_marker(page: Page, project_id: str) -> None:
    """Every context here is created with has_touch=True, so a tap exercises the same
    touch-selection contract LM-10 established at every one of these viewports, desktop
    included -- never a hover, which the map's selection controls do not depend on."""
    control = page.locator(f'#land-map-panel [role="button"][data-land-map-project="{project_id}"]')
    control.first.tap()
    page.wait_for_selector("#land-map-selected", timeout=15_000)
    page.wait_for_timeout(300)


def run_axe(page: Page, state_name: str, failures: list[tuple[str, str]]) -> None:
    """Scoped to the Land Map panel -- the card's own compatibility surface."""
    page.add_script_tag(path=str(AXE))
    result = page.evaluate(
        "async () => await axe.run(document.getElementById('land-map-panel'), {resultTypes:['violations']})"
    )
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map((rule) => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22_rules)
    for violation in gate:
        nodes = "; ".join(node["target"][0] for node in violation["nodes"][:3])
        print(f"FAIL axe[{state_name}]: {violation['id']} ({violation['impact']}) -> {violation['help']} @ {nodes}")
        failures.append((state_name, violation["id"]))
    if not gate:
        print(f"OK axe[{state_name}]: no critical/serious violation")


def evidence_clip(page: Page) -> dict:
    """Frame the resultbar through the Map panel (or the List rows, absent one) -- the
    same bounded clip LM-10's capture uses -- rather than a full-page screenshot of a
    40-row List plus an unrelated auto-selected detail card below it."""
    return page.evaluate(
        """() => {
          const pane = document.getElementById('tab-land');
          const bar = pane ? pane.querySelector('#land-resultbar') : null;
          const panel = document.getElementById('land-map-panel') || document.getElementById('llist') || bar;
          const top = bar ? bar.getBoundingClientRect().top + scrollY : 0;
          const bottom = panel ? panel.getBoundingClientRect().bottom + scrollY : top + 700;
          return {
            x: 0,
            y: Math.max(0, top - 8),
            width: document.documentElement.clientWidth,
            height: Math.min(2200, Math.max(280, bottom - top + 24)),
          };
        }"""
    )


def shoot(page: Page, path: Path) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path), animations="disabled", full_page=True, clip=evidence_clip(page))
    data = path.read_bytes()
    return {"path": str(path.relative_to(ROOT)), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def assert_id_set_partition(fixture_id: str, state: dict, failures: list[str]) -> None:
    """The A1/A2 invariant: List ids equal Map(mapped) union Map(unmapped), as sets.

    Never satisfied by a marker count alone (the negative rule) -- every id is compared.
    """
    counts = state["counts"]
    if counts is None:
        failures.append(f"{fixture_id}: the Map published no counts")
        return
    list_ids = state["list_ids"]
    markers = state["marker_ids"]
    if len(set(markers)) != len(markers):
        failures.append(f"{fixture_id}: a project was marked twice")
    if not set(markers) <= set(list_ids):
        failures.append(f"{fixture_id}: markers outside the List: {sorted(set(markers) - set(list_ids))}")
    derived_unmapped = [pid for pid in list_ids if pid not in set(markers)]
    if len(derived_unmapped) != counts["unmapped"]:
        failures.append(
            f"{fixture_id}: {len(derived_unmapped)} projects have no marker but the panel says {counts['unmapped']}"
        )
    if len(markers) != counts["mapped"]:
        failures.append(f"{fixture_id}: {len(markers)} markers for a published mapped count of {counts['mapped']}")
    if counts["mapped"] + counts["unmapped"] != counts["total"]:
        failures.append(f"{fixture_id}: counts do not sum ({counts})")
    if counts["total"] != len(set(list_ids)):
        failures.append(f"{fixture_id}: the Map reports {counts['total']} but the List painted {len(set(list_ids))}")


def check_expectations(fixture: dict, state: dict, failures: list[str]) -> None:
    fid = fixture["id"]
    expects = fixture["expects"]
    if expects.get("list_map_partition"):
        assert_id_set_partition(fid, state, failures)
    if "total" in expects and state["counts"] and state["counts"]["total"] != expects["total"]:
        failures.append(f"{fid}: expected total {expects['total']}, measured {state['counts']['total']}")
    if "mapped" in expects and state["counts"] and state["counts"]["mapped"] != expects["mapped"]:
        failures.append(f"{fid}: expected mapped {expects['mapped']}, measured {state['counts']['mapped']}")
    if "unmapped" in expects and state["counts"] and state["counts"]["unmapped"] != expects["unmapped"]:
        failures.append(f"{fid}: expected unmapped {expects['unmapped']}, measured {state['counts']['unmapped']}")
    if "total_at_least" in expects and state["counts"] and state["counts"]["total"] < expects["total_at_least"]:
        failures.append(f"{fid}: expected at least {expects['total_at_least']} results, measured {state['counts']['total']}")
    if expects.get("has_mapped") and not (state["counts"] and state["counts"]["mapped"] > 0):
        failures.append(f"{fid}: expected at least one mapped project")
    if expects.get("has_unmapped") and not (state["counts"] and state["counts"]["unmapped"] > 0):
        failures.append(f"{fid}: expected at least one unmapped project")
    for pid in expects.get("contains_ids", []):
        if pid not in state["list_ids"]:
            failures.append(f"{fid}: specimen {pid} missing from the List")
    if expects.get("marker_methods_labeled") and not state["marker_labels_all_present"]:
        failures.append(f"{fid}: a marker has no accessible label naming its method/precision")
    for precision in expects.get("contains_precisions", []):
        if precision not in state["marker_precisions"]:
            failures.append(f"{fid}: no marker carries precision {precision}")
    if "selected_id" in expects and state["selected"] != expects["selected_id"]:
        failures.append(f"{fid}: expected selection {expects['selected_id']}, measured {state['selected']}")
    if "selected_method" in expects and state["selected_method"] != expects["selected_method"]:
        failures.append(f"{fid}: expected selected method {expects['selected_method']}, measured {state['selected_method']}")
    if "selected_precision" in expects and state["selected_precision"] != expects["selected_precision"]:
        failures.append(
            f"{fid}: expected selected precision {expects['selected_precision']}, measured {state['selected_precision']}"
        )
    if "boundary_state" in expects and state["boundary_state"] != expects["boundary_state"]:
        failures.append(f"{fid}: expected boundary state {expects['boundary_state']}, measured {state['boundary_state']}")
    if expects.get("boundary_evidence_present") and not state["boundary_evidence_present"]:
        failures.append(f"{fid}: boundary evidence disclosure is missing")
    if expects.get("unmapped_note_present") and not state["unmapped_note"].strip():
        failures.append(f"{fid}: an unmapped population was never mentioned to the resident")
    if "map_state" in expects and state["map_state"] != expects["map_state"]:
        failures.append(f"{fid}: expected map_state {expects['map_state']}, measured {state['map_state']}")
    if expects.get("list_empty") and not state["list_empty"]:
        failures.append(f"{fid}: expected the List's own empty state")
    if expects.get("retry_present") and not state["retry_present"]:
        failures.append(f"{fid}: the failed Map offered no retry control")
    if expects.get("dismiss_present") and not state["dismiss_present"]:
        failures.append(f"{fid}: the failed Map offered no dismiss control")
    if expects.get("panel_no_overflow") and not state["panel_no_overflow"]:
        failures.append(f"{fid}: a Land Map control overflowed its viewport")


def default_total(browser) -> int:
    """The complete List's own row count, measured once, healthy, unfiltered.

    A dependency-failure fixture is honest only if the List it kept is the same List a
    resident would have seen on a successful load -- not merely "some rows".
    """
    context, page = new_page(browser, "wide")
    try:
        state = visit(page, "/browse/zoning/?view=map")
        return state["counts"]["total"]
    finally:
        context.close()


def capture_fixture(browser, fixture: dict, baseline_total: int, failures: list[str]) -> dict:
    fid = fixture["id"]
    block = fixture["dependency_scenario"] == "projection-blocked"
    files: list[dict] = []
    readings: dict = {}
    for viewport_name in fixture["viewports"]:
        # The paired List capture: the same route, rendered as List, unaffected by
        # whatever the Map side of this fixture is exercising.
        list_context, list_page = new_page(browser, viewport_name)
        try:
            list_page.goto(f"{BASE}{fixture['list_route']}", wait_until="domcontentloaded", timeout=45_000)
            wait_for_list(list_page)
            list_page.wait_for_timeout(300)
            files.append(shoot(list_page, OUT / f"{fid}-list-{viewport_name}.png"))
            list_rows = list_page.evaluate("() => document.querySelectorAll('#llist .row').length")
        finally:
            list_context.close()

        map_context, map_page = new_page(browser, viewport_name, block_projection=block)
        try:
            state = visit(map_page, fixture["map_route"], expect_failed=block)
            if fixture.get("select_project_id") and not block:
                select_marker(map_page, fixture["select_project_id"])
                state = map_page.evaluate(READ_MAP_STATE)
            state["panel_no_overflow"] = panel_no_overflow(map_page)
            state["list_route_rows"] = list_rows
            if fixture["expects"].get("axe"):
                run_axe(map_page, f"{fid}@{viewport_name}", failures)
            files.append(shoot(map_page, OUT / f"{fid}-map-{viewport_name}.png"))
        finally:
            map_context.close()

        if block and state["counts"] and state["counts"]["total"] != baseline_total:
            failures.append(
                f"{fid}@{viewport_name}: a blocked map dependency changed the List total "
                f"({state['counts']['total']} vs the healthy {baseline_total})"
            )
        if fixture["expects"].get("list_total_matches_default") and state["list_rows"] != baseline_total:
            failures.append(
                f"{fid}@{viewport_name}: List rows ({state['list_rows']}) do not match the healthy default total ({baseline_total})"
            )
        check_expectations(fixture, state, failures)
        readings[viewport_name] = {"state": state, "files": [f["path"] for f in files if viewport_name in f["path"]]}
    return {"id": fid, "title": fixture["title"], "dependency_scenario": fixture["dependency_scenario"], "readings": readings, "files": files}


def app_provenance() -> dict:
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    default_snapshot = json.loads((ROOT / "site" / "data" / "land_default_ulurp.json").read_text("utf-8"))
    points_receipt = json.loads((ROOT / "site" / "data" / "land_project_map_points_receipt.json").read_text("utf-8"))
    points_payload = json.loads((ROOT / "site" / "data" / "land_project_map_points.json").read_text("utf-8"))
    return {
        "app_commit": revision,
        "default_snapshot_schema": default_snapshot.get("schema_version"),
        "default_snapshot_count": default_snapshot.get("count"),
        "point_projection_schema": points_payload.get("schema"),
        "point_projection_resolver_version": points_receipt.get("resolver_version"),
        "point_projection_join_version": points_receipt.get("join_version"),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        baseline_total = default_total(browser)
        fixtures = [capture_fixture(browser, fixture, baseline_total, failures) for fixture in MANIFEST["fixtures"]]
        browser.close()

    receipt = {
        "schema": "cityscroll.land-map-visual-parity-fixtures-receipt.v1",
        "card": MANIFEST["card"],
        "manifest": str(MANIFEST_PATH.relative_to(ROOT)),
        "browser_mode": "headless chromium (playwright), remote hosts blocked",
        "provenance": app_provenance(),
        "baseline_default_total": baseline_total,
        "fixtures": fixtures,
        "checks_failed": failures,
    }
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {RECEIPT.relative_to(ROOT)}")
    for line in failures:
        print("FAIL:", line)
    assert not failures, f"{len(failures)} visual-parity fixture check(s) failed: {failures}"
    print(f"land map visual parity fixtures OK: {len(fixtures)} fixtures, baseline total {baseline_total}")


if __name__ == "__main__":
    main()
