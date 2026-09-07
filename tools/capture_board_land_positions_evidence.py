#!/usr/bin/env python3
"""Headless read-back of a board's recorded land use positions on served pages.

Reads the section back from pages as they are served, at a desktop and a narrow
touch viewport, with the positive case and both negative ones:

  positive   a board with recorded positions, including two applications the
             board recorded on one date with one identical tally, which must
             stay two rows with two destinations
  waiver     a board whose record includes a waiver and a null tally
  absent     a board this source records no position for, which must render a
             sentence about the source rather than nothing
  failure    the same positive board with its artifact deliberately unreadable,
             which must say so and keep its published source reachable

Each page is checked for the section, for keyboard reachability and native link
behaviour on every project link, for horizontal overflow, for the smallest
interactive target, and with the vendored axe-core rule set. Every page is read
back once more with JavaScript disabled, because the board document is
server-rendered: with no scripting the inspect control must not be offered at
all and every fact it would have shown must already be in the row.

One journey walks board -> inspect -> dismiss -> open the project -> browser
Back -> continue, and checks that the reader's scroll position, the board's own
Month/List calendar and the rest of the page survive it. Another drives the
control by keyboard only: Tab to it, Enter to open, Escape to dismiss, focus
back on the control it was opened from.

Screenshots stay under an ignored path. The receipt is the evidence: route,
viewport, revision, data vintage, assertion, the sha256 of each capture, and the
sha256 of the section's own rendered content the assertion was made against.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".artifacts" / "board-land-positions"
FIXTURES = OUT / "fixtures"
SITE = ROOT / "_site"
RECEIPT = ROOT / "docs" / "evidence" / "board-land-positions" / "manifest.json"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]
# WCAG 2.5.8 minimum target size.
MIN_TARGET_PX = 24

SECTION = "#board-land-positions"
PROJECT_LINK = "#board-land-positions a.board-land-position-link"
INSPECT = "#board-land-positions button.board-land-position-inspect"
DIALOG = "#board-land-position-inspect"
DIALOG_CLOSE = "#board-land-position-inspect [data-board-land-position-close]"
DIALOG_OPEN = "#board-land-position-inspect .board-land-position-dialog-open"

# The named cases, addressed by the publisher's own board and project
# identifiers so a failure says which record moved.
POSITIVE_BOARD = "manhattan-cb-04"
POSITIVE_PROJECT = "2024M0244"
SIBLING_PROJECT = "2023M0213"
WAIVER_BOARD = "staten-island-cb-01"
WAIVER_PROJECT = "2026R0127"

CASES = [
    (POSITIVE_BOARD, "board-land-positions-shared-date",
     "Two applications this board recorded on one date with one identical tally render as two "
     "rows with two project destinations and two source records, and the copy states that they "
     "are two applications rather than two meetings."),
    (WAIVER_BOARD, "board-land-positions-waiver",
     "A waiver of recommendation keeps its own published label and its absent tally, and the copy "
     "says it is neither support nor opposition."),
]


class SiteHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


class RepoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


class QuietServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):  # noqa: D102
        return


def serve(handler):
    server = QuietServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def revision() -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT,
                          capture_output=True, text=True, check=True).stdout.strip()


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def run_axe(page, scope: str | None = SECTION) -> dict:
    """Axe over the section this change owns, plus the page it sits in.

    The gate is the scoped result: a finding elsewhere on the board document is
    reported alongside it as page context rather than folded into this
    section's verdict, and never silently swallowed either.
    """
    page.add_script_tag(path=str(AXE))
    wcag22 = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    page_result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    page_gate = failing_violations(page_result["violations"], wcag22)
    scoped_gate = page_gate
    if scope and page.locator(scope).count():
        scoped = page.evaluate(
            "async (selector) => await axe.run({include: [[selector]]}, {resultTypes:['violations']})",
            scope)
        scoped_gate = failing_violations(scoped["violations"], wcag22)
    return {
        "scope": scope if scope and page.locator(scope).count() else "document",
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in scoped_gate],
        "passes": len(scoped_gate) == 0,
        "page_failing_violations": [
            {"id": v["id"], "impact": v.get("impact"),
             "targets": [target for node in v["nodes"] for target in node["target"]][:4]}
            for v in page_gate
        ],
        "page_passes": len(page_gate) == 0,
    }


# Keyboard reachability is measured over the controls a reader can actually see.
LINK_PROBE = """(selector) => {
  const all = [...document.querySelectorAll(selector)];
  const visible = all.filter((node) => node.getClientRects().length > 0);
  let reachable = 0;
  for (const node of visible) {
    node.focus();
    if (document.activeElement === node) reachable += 1;
  }
  return {
    count: all.length,
    visible: visible.length,
    reachable,
    native: all.every((node) => node.tagName === 'A' && (node.getAttribute('href') || '').length > 0),
    new_tab: all.filter((node) => node.hasAttribute('target')).length,
    scripted: all.filter((node) => [...node.attributes].some((a) => a.name.startsWith('on'))).length,
  };
}"""

BUTTON_PROBE = """(selector) => {
  const all = [...document.querySelectorAll(selector)];
  const visible = all.filter((node) => node.getClientRects().length > 0);
  return {
    count: all.length,
    visible: visible.length,
    native: all.every((node) => node.tagName === 'BUTTON' && node.getAttribute('type') === 'button'),
    labelled: all.every((node) => (node.getAttribute('aria-label') || '').length > 0),
    nested_in_link: all.filter((node) => node.closest('a')).length,
  };
}"""

TARGET_PROBE = """(selector) => {
  const sizes = [...document.querySelectorAll(selector)].map((node) => {
    const rect = node.getBoundingClientRect();
    return Math.round(Math.min(rect.width, rect.height));
  }).filter((size) => size > 0);
  return sizes.length ? Math.min(...sizes) : null;
}"""

OVERFLOW_PROBE = """() => Math.round(document.documentElement.scrollWidth)
  <= Math.round(document.documentElement.clientWidth) + 1"""

SECTION_TEXT = """(selector) => {
  const node = document.querySelector(selector);
  return node ? node.innerText.replace(/\\s+/g, ' ').trim() : '';
}"""


def section_observation(page) -> dict:
    section = page.locator(SECTION)
    present = section.count() > 0
    rows = page.locator(f"{SECTION} li.board-land-position")
    dates = page.eval_on_selector_all(
        f"{SECTION} li.board-land-position",
        "nodes => [...new Set(nodes.map((node) => node.getAttribute('data-recorded-on')))]",
    ) if present else []
    hrefs = page.eval_on_selector_all(
        PROJECT_LINK, "nodes => nodes.map((node) => node.getAttribute('href'))",
    ) if present else []
    return {
        "section_present": present,
        "heading": section.locator("h2").inner_text() if present else None,
        "state": section.get_attribute("data-land-positions-state") if present else None,
        "position_count_attribute": section.get_attribute("data-position-count") if present else None,
        "project_count_attribute": section.get_attribute("data-project-count") if present else None,
        "recorded_date_count_attribute": section.get_attribute("data-recorded-date-count") if present else None,
        "ready_for_inspection": section.get_attribute("data-board-land-positions-ready") is not None if present else None,
        "rendered_rows": rows.count() if present else 0,
        "distinct_recorded_dates": sorted(value for value in dates if value),
        "project_hrefs": hrefs,
        "distinct_project_hrefs": len(set(hrefs)),
        "no_horizontal_overflow": page.evaluate(OVERFLOW_PROBE),
        "calendar_present": page.locator('[data-board-proceedings-view="1"]').count() > 0,
        "committee_links": page.locator(
            '[data-community-board-constellation-category="committees"] a').count(),
    }


def capture_boards(browser, base, rev, vintage, receipts):
    for body_id, case, assertion in CASES:
        route = f"/community-boards/{body_id}/"
        for width, height in VIEWPORTS:
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()
            page.goto(f"{base}{route}", wait_until="load")
            observed = section_observation(page)
            observed["links"] = page.evaluate(LINK_PROBE, PROJECT_LINK)
            observed["inspect_controls"] = page.evaluate(BUTTON_PROBE, INSPECT)
            observed["smallest_target_px"] = page.evaluate(TARGET_PROBE, f"{PROJECT_LINK}, {INSPECT}")
            text = page.evaluate(SECTION_TEXT, SECTION)
            shot = OUT / f"{case}-{width}x{height}.png"
            page.screenshot(path=str(shot), full_page=True)
            axe = run_axe(page)
            receipts.append({
                "surface": "community_board_document",
                "case": case,
                "route": route,
                "viewport": {"width": width, "height": height},
                "revision": rev,
                "data_vintage": vintage,
                "javascript": "enabled",
                "observed": observed,
                "axe": axe,
                "assertion": f"{route} at {width}x{height}: {assertion}",
                "screenshot": str(shot.relative_to(ROOT)),
                "screenshot_sha256": sha256_of(shot),
                "render_sha256": sha256_text(text),
            })
            context.close()

        # The document is server-rendered, so it must read the same with no
        # scripting at all — and must not offer a control that would not work.
        context = browser.new_context(viewport={"width": 1440, "height": 900},
                                      java_script_enabled=False)
        page = context.new_page()
        page.goto(f"{base}{route}", wait_until="load")
        observed = section_observation(page)
        observed["links"] = page.evaluate(LINK_PROBE, PROJECT_LINK)
        observed["inspect_controls"] = page.evaluate(BUTTON_PROBE, INSPECT) \
            if observed["section_present"] else None
        text = page.evaluate(SECTION_TEXT, SECTION)
        receipts.append({
            "surface": "community_board_document",
            "case": f"{case}-no-javascript",
            "route": route,
            "viewport": {"width": 1440, "height": 900},
            "revision": rev,
            "data_vintage": vintage,
            "javascript": "disabled",
            "observed": observed,
            "assertion": (f"{route} with scripting disabled: every project link works and every recorded "
                          "fact is already in the row, while the inspect control is not offered at all"),
            "render_sha256": sha256_text(text),
        })
        context.close()


def capture_inspect_journey(browser, base, rev, vintage, receipts):
    """Inspect, dismiss, open the full record, Back, and continue."""
    route = f"/community-boards/{POSITIVE_BOARD}/"
    for width, height in VIEWPORTS:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.goto(f"{base}{route}", wait_until="load")
        button = page.locator(f'{INSPECT}[data-board-land-position-id="{POSITIVE_PROJECT}"]')
        button.scroll_into_view_if_needed()
        scrolled = page.evaluate("() => Math.round(window.scrollY)")
        calendar_before = page.locator('[data-board-proceedings-panel="list"]').count()
        rows_before = page.locator(f"{SECTION} li.board-land-position").count()

        button.click()
        page.wait_for_timeout(150)
        dialog = page.locator(DIALOG)
        dialog_text = dialog.inner_text().replace("\n", " ")
        observed = {
            "dialog_open": dialog.evaluate("node => node.open"),
            "dialog_labelled_by": dialog.get_attribute("aria-labelledby"),
            "dialog_title": page.locator("#board-land-position-inspect-title").inner_text(),
            "focus_inside_dialog": page.evaluate(
                "() => !!document.activeElement.closest('#board-land-position-inspect')"),
            "scroll_while_open": page.evaluate("() => Math.round(window.scrollY)"),
            "url_unchanged_by_inspection": urlparse(page.url).fragment == "",
            "dialog_states_advisory": "advisory" in dialog_text,
            "dialog_states_tally_meaning": "recommendation motion" in dialog_text,
            "dialog_states_other_body": "Borough President" in dialog_text,
            "dialog_states_missing_vote_date": "no vote date" in dialog_text,
            "dialog_open_href": page.locator(DIALOG_OPEN).get_attribute("href"),
        }

        page.keyboard.press("Escape")
        page.wait_for_timeout(150)
        observed["dialog_closed_by_escape"] = not dialog.evaluate("node => node.open")
        observed["focus_returned_to_control"] = page.evaluate(
            '(id) => document.activeElement?.getAttribute("data-board-land-position-id") === id',
            POSITIVE_PROJECT)
        observed["scroll_after_dismiss"] = page.evaluate("() => Math.round(window.scrollY)")
        observed["rows_after_dismiss"] = page.locator(f"{SECTION} li.board-land-position").count()

        link = page.locator(f'{SECTION} a[href="/browse/zoning/#land/{POSITIVE_PROJECT}"]').first
        link.scroll_into_view_if_needed()
        before_leaving = page.evaluate("() => Math.round(window.scrollY)")
        link.click()
        page.wait_for_load_state("load")
        left_for = urlparse(page.url)
        page.go_back()
        page.wait_for_load_state("load")
        page.wait_for_timeout(500)
        observed.update({
            "scrolled_to": scrolled,
            "scroll_before_leaving": before_leaving,
            "left_for_path": left_for.path,
            "left_for_hash": left_for.fragment,
            "returned_path": urlparse(page.url).path,
            "scroll_on_return": page.evaluate("() => Math.round(window.scrollY)"),
            "rows_on_return": page.locator(f"{SECTION} li.board-land-position").count(),
            "rows_before": rows_before,
            "calendar_panels_before": calendar_before,
            "calendar_panels_on_return": page.locator('[data-board-proceedings-panel="list"]').count(),
            "ready_on_return": page.locator(SECTION).get_attribute(
                "data-board-land-positions-ready") is not None,
        })
        observed["scroll_preserved_through_inspection"] = (
            observed["scroll_while_open"] == scrolled
            and observed["scroll_after_dismiss"] == scrolled)
        observed["scroll_restored"] = observed["scroll_on_return"] == before_leaving
        observed["list_undisturbed"] = observed["rows_on_return"] == rows_before
        observed["calendar_undisturbed"] = (
            observed["calendar_panels_before"] == observed["calendar_panels_on_return"])

        text = page.evaluate(SECTION_TEXT, SECTION)
        shot = OUT / f"board-position-inspect-journey-{width}x{height}.png"
        page.screenshot(path=str(shot), full_page=True)
        receipts.append({
            "surface": "journey",
            "case": "board-position-inspect-journey",
            "route": route,
            "viewport": {"width": width, "height": height},
            "revision": rev,
            "data_vintage": vintage,
            "javascript": "enabled",
            "observed": observed,
            "assertion": (f"{route} at {width}x{height}: a reader inspects one recorded position in "
                          "place, dismisses it with Escape and gets focus back on the control, then "
                          "opens the project and returns with the browser's own Back to the board "
                          "with their scroll position, the list and the board calendar as they left them"),
            "screenshot": str(shot.relative_to(ROOT)),
            "screenshot_sha256": sha256_of(shot),
            "render_sha256": sha256_text(text),
        })
        context.close()


def capture_keyboard(browser, base, rev, vintage, receipts):
    """The whole affordance driven by the keyboard alone."""
    route = f"/community-boards/{POSITIVE_BOARD}/"
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    page.goto(f"{base}{route}", wait_until="load")
    button = page.locator(f'{INSPECT}[data-board-land-position-id="{SIBLING_PROJECT}"]')
    button.scroll_into_view_if_needed()
    button.focus()
    observed = {"control_focusable": page.evaluate(
        '(id) => document.activeElement?.getAttribute("data-board-land-position-id") === id',
        SIBLING_PROJECT)}
    page.keyboard.press("Enter")
    page.wait_for_timeout(150)
    dialog = page.locator(DIALOG)
    observed["opened_by_enter"] = dialog.evaluate("node => node.open")
    observed["focus_on_dismiss_control"] = page.evaluate(
        "() => document.activeElement?.hasAttribute('data-board-land-position-close')")
    page.keyboard.press("Tab")
    observed["tab_stays_inside"] = page.evaluate(
        "() => !!document.activeElement.closest('#board-land-position-inspect')")
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    observed["closed_by_escape"] = not dialog.evaluate("node => node.open")
    observed["focus_returned"] = page.evaluate(
        '(id) => document.activeElement?.getAttribute("data-board-land-position-id") === id',
        SIBLING_PROJECT)
    text = page.evaluate(SECTION_TEXT, SECTION)
    shot = OUT / "board-position-keyboard-1440x900.png"
    page.screenshot(path=str(shot), full_page=True)
    axe = run_axe(page)
    receipts.append({
        "surface": "keyboard",
        "case": "board-position-keyboard",
        "route": route,
        "viewport": {"width": 1440, "height": 900},
        "revision": rev,
        "data_vintage": vintage,
        "javascript": "enabled",
        "observed": observed,
        "axe": axe,
        "assertion": (f"{route} by keyboard alone: Tab reaches the inspect control, Enter opens the "
                      "record with focus inside it, Tab stays inside, and Escape dismisses it and "
                      "returns focus to the control it was opened from"),
        "screenshot": str(shot.relative_to(ROOT)),
        "screenshot_sha256": sha256_of(shot),
        "render_sha256": sha256_text(text),
    })
    context.close()


def capture_fixtures(browser, base, manifest, rev, vintage, receipts):
    for fixture in manifest["fixtures"]:
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.goto(f"{base}/{fixture['file']}", wait_until="load")
        section = page.locator(SECTION)
        present = section.count() > 0
        text = page.evaluate(SECTION_TEXT, SECTION)
        observed = {
            "section_present": present,
            "state": section.get_attribute("data-land-positions-state") if present else None,
            "heading": section.locator("h2").inner_text() if present else None,
            "direction": section.get_attribute("dir") if present else None,
            "language": section.get_attribute("lang") if present else None,
            "project_links": page.locator(PROJECT_LINK).count(),
            "no_horizontal_overflow": page.evaluate(OVERFLOW_PROBE),
            "unresolved_key_rendered": "cblp_" in text,
        }
        if fixture["id"] == "board-positions-unavailable":
            observed["source_link"] = page.locator(
                f"{SECTION} a.board-land-position-source").count()
            assertion = ("the recorded positions could not be read: the section says so, offers a "
                         "retry, keeps its published source reachable, and lists no position")
        elif fixture["id"] == "board-no-recorded-position":
            observed["retained_project_count"] = section.get_attribute("data-retained-project-count")
            assertion = ("this source records no position for this board: the section says so about "
                         "the source and names the population it was measured over, rather than "
                         "rendering nothing or claiming the board has never voted")
        else:
            observed["published_title_preserved"] = "Dewitt Clinton Park North" in text
            observed["published_position_preserved"] = "Conditional Unfavorable" in text
            assertion = (f"the section renders in {fixture['lang']} with the publisher's own project "
                         "names and recorded position labels left in the source language")
        axe = run_axe(page)
        receipts.append({
            "surface": "community_board_document",
            "case": fixture["id"],
            "route": fixture["route"],
            "viewport": {"width": 1440, "height": 900},
            "revision": rev,
            "data_vintage": vintage,
            "javascript": "enabled",
            "observed": observed,
            "axe": axe,
            "assertion": assertion,
            "render_sha256": sha256_text(text),
        })
        context.close()


def main() -> int:
    if not SITE.exists():
        print("run tools/prepare_functional_site.sh first", file=sys.stderr)
        return 1
    if not (FIXTURES / "manifest.json").exists():
        print("run node tools/render_board_land_position_fixtures.mjs first", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    rev = revision()
    vintage = manifest["data_vintage"]

    site_server, site_port = serve(SiteHandler)
    repo_server, repo_port = serve(RepoHandler)
    receipts: list[dict] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            base = f"http://127.0.0.1:{site_port}"
            capture_boards(browser, base, rev, vintage, receipts)
            capture_inspect_journey(browser, base, rev, vintage, receipts)
            capture_keyboard(browser, base, rev, vintage, receipts)
            capture_fixtures(browser, f"http://127.0.0.1:{repo_port}", manifest, rev, vintage, receipts)
            browser.close()
    finally:
        site_server.shutdown()
        repo_server.shutdown()

    receipt = {
        "schema": "cityscroll.board_land_position_capture.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "revision": rev,
        "data_vintage": vintage,
        "counts": manifest["counts"],
        "positive_board": manifest["positive_board"],
        "empty_board": manifest["empty_board"],
        "min_target_px": MIN_TARGET_PX,
        "captures": receipts,
        "axe_all_pass": all(entry.get("axe", {}).get("passes", True) for entry in receipts),
    }
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(f"{json.dumps(receipt, indent=2)}\n")
    print(f"wrote {RECEIPT.relative_to(ROOT)} ({len(receipts)} captures, "
          f"axe_all_pass={receipt['axe_all_pass']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
