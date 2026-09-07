#!/usr/bin/env python3
"""Headless read-back of the capital project a budget request names.

Reads the relation back from pages as they are served, at a desktop and a
narrow touch viewport:

  present    the request whose published answer names a capital project, with
             the project's own record beside it and every figure carrying the
             capital record it was read from
  difference the district whose answer says its own segment was taken out of
             that project, where the relationship has to expose the difference
  absent     the same board with no materialization at all, which must read
             exactly as it did before this relation existed
  failure    the same board with the register unreadable, which must say so and
             add no project block to a list it could not read
  language   the section in every shipping language, with the publisher's own
             wording and the project's published record left in the source
             language

Each page is checked for the block, for keyboard reachability and native link
behaviour on every destination, for horizontal overflow, for the smallest
interactive target, and with the vendored axe-core rule set. Every served page
is read back once more with JavaScript disabled: the block is written into the
document, so all of it and every destination must already be there.

One journey walks board -> choose an agency -> inspect -> dismiss -> open the
agency that manages the project -> browser Back -> continue, and checks that the
chosen agency, the reader's scroll position and the list all survive it. Another
drives the affordance by keyboard alone.

Screenshots stay under an ignored path. The receipt is the evidence: route,
viewport, revision, data vintage, assertion, the sha256 of each capture, and the
sha256 of the block's own rendered content the assertion was made against.
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
OUT = ROOT / ".artifacts" / "board-request-project-links"
FIXTURES = OUT / "fixtures"
SITE = ROOT / "_site"
RECEIPT = ROOT / "docs" / "evidence" / "board-request-project-links" / "manifest.json"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

# A narrow touch viewport first, then a desktop one.
VIEWPORTS = [(390, 844), (1440, 900)]
VIEWPORT_NAMES = {390: "narrow-touch", 1440: "desktop"}
# WCAG 2.5.8 minimum target size.
MIN_TARGET_PX = 24

BOARD_SECTION = "#board-budget-requests"
ROW = "li.board-budget-request"
PROJECT = "div.board-request-project"
PROJECT_ACTION = "a.board-request-project-action"
INSPECT = "button.board-budget-request-inspect"
DIALOG = "#budget-request-inspect"

# The named records, addressed by the publishers' own identifiers so a failure
# says which record moved rather than which number did.
POSITIVE_BOARD = "bronx-cb-03"
POSITIVE_REQUEST = "103202717C"
POSITIVE_PROJECT = "HWX100SBC"
# The request sits under this agency's group, which is how a reader reaches it.
POSITIVE_AGENCY = "transportation"
# The agency that manages the project, and therefore the destination the journey
# leaves for and comes back from.
MANAGING_AGENCY = "design-and-construction"
SCOPE_DIFFERENCE_BOARD = "queens-cb-05"
SCOPE_DIFFERENCE_REQUEST = "405202716C"

BOUNDARY = ("The request and the project are separate records with separate dates. "
            "Naming a project is not funding, a commitment, delivery, or a statement "
            "that this request is inside that project's scope.")
OBSERVATION = "from the capital record"


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


def run_axe(page, scope: str) -> dict:
    """Axe over the section this change renders into, plus the page it sits in."""
    page.add_script_tag(path=str(AXE))
    wcag22 = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    page_result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    page_gate = failing_violations(page_result["violations"], wcag22)
    scoped_gate = page_gate
    scoped_scope = "document"
    if page.locator(scope).count():
        scoped = page.evaluate(
            "async (selector) => await axe.run({include: [[selector]]}, {resultTypes:['violations']})",
            scope)
        scoped_gate = failing_violations(scoped["violations"], wcag22)
        scoped_scope = scope
    return {
        "scope": scoped_scope,
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in scoped_gate],
        "passes": len(scoped_gate) == 0,
        "page_failing_violations": [
            {"id": v["id"], "impact": v.get("impact"),
             "targets": [target for node in v["nodes"] for target in node["target"]][:4]}
            for v in page_gate
        ],
        "page_passes": len(page_gate) == 0,
    }


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
    destinations: all.map((node) => node.getAttribute('href')),
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

BLOCK_FIT_PROBE = """(selector) => [...document.querySelectorAll(selector)].every((node) => (
  Math.round(node.scrollWidth) <= Math.round(node.clientWidth) + 1
  && Math.round(node.getBoundingClientRect().width) <= Math.round(node.parentElement.clientWidth) + 1
))"""

# Rows wider than the viewport, and how many of them carry no project block at
# all. A page that already scrolled sideways on rows this change never touched
# is reported as exactly that rather than as a finding about the block.
ROW_OVERFLOW_PROBE = """(selectors) => {
  const width = document.documentElement.clientWidth;
  const rows = [...document.querySelectorAll(selectors.row)];
  const over = rows.filter((row) => Math.round(row.getBoundingClientRect().right) > width + 1);
  return {
    rows: rows.length,
    overflowing: over.length,
    overflowing_without_a_project_block: over.filter((row) => !row.querySelector(selectors.block)).length,
  };
}"""

BLOCK_TEXT = """(selector) => [...document.querySelectorAll(selector)]
  .map((node) => node.innerText.replace(/\\s+/g, ' ').trim()).join(' | ')"""

SECTION_TEXT = """(selector) => {
  const node = document.querySelector(selector);
  return node ? node.innerText.replace(/\\s+/g, ' ').trim() : '';
}"""


def block_observation(page, boundary: str = BOUNDARY) -> dict:
    """What the rendered relation says, read off the served page.

    The boundary is checked as the sentence in the page's own language, so a
    block rendered without it, or with it left untranslated, fails rather than
    passing on the presence of markup.
    """
    blocks = page.locator(PROJECT)
    present = blocks.count() > 0
    text = page.evaluate(BLOCK_TEXT, PROJECT)
    section_text = page.evaluate(SECTION_TEXT, BOARD_SECTION)
    return {
        "section_present": page.locator(BOARD_SECTION).count() > 0,
        "project_blocks": blocks.count(),
        "rendered_rows": page.locator(f"{BOARD_SECTION} {ROW}").count(),
        "project_codes": page.eval_on_selector_all(
            PROJECT, "nodes => nodes.map((node) => node.getAttribute('data-project-code'))"),
        "states_boundary": boundary in text,
        "boundary_on_every_block": present and text.count(boundary) == blocks.count(),
        # One dated statement per reading the capital record carries. Counting
        # elements rather than an English phrase keeps this the same check in
        # every language.
        "observation_lines": page.locator("li.board-request-project-observation").count(),
        "states_published_wording": "Published wording:" in text,
        "claims_fulfilment": any(claim in text.lower() for claim in
                                 ("this request is funded", "has been delivered", "request was completed")),
        "destinations": page.evaluate(LINK_PROBE, PROJECT_ACTION),
        "smallest_target_px": page.evaluate(TARGET_PROBE, PROJECT_ACTION),
        # This block's own fit, reported apart from the page's: a document that
        # already scrolled sideways before this change did is page context, and
        # folding the two together would hide which one is being measured.
        "project_block_fits_its_row": page.evaluate(BLOCK_FIT_PROBE, PROJECT),
        "row_overflow": page.evaluate(ROW_OVERFLOW_PROBE, {"row": f"{BOARD_SECTION} {ROW}", "block": PROJECT}),
        "no_horizontal_overflow": page.evaluate(OVERFLOW_PROBE),
        "unresolved_key_rendered": "crpl_" in section_text,
        "ready_for_inspection": page.locator(BOARD_SECTION).get_attribute("data-budget-requests-ready") is not None
        if page.locator(BOARD_SECTION).count() else False,
        "visible_inspect_controls": page.eval_on_selector_all(
            f"{BOARD_SECTION} {INSPECT}",
            "nodes => nodes.filter((node) => node.getClientRects().length > 0).length",
        ) if page.locator(BOARD_SECTION).count() else 0,
    }


def open_group(page, agency_id: str) -> None:
    """Reach a request the way a reader does: through its agency's own address."""
    link = page.locator(f'{BOARD_SECTION} a[href="#board-budget-requests-{agency_id}"]')
    if link.count():
        link.first.click()
        page.wait_for_timeout(150)


def receipt_for(**fields) -> dict:
    return fields


def capture_board(browser, base, rev, vintage, receipts):
    route = f"/community-boards/{POSITIVE_BOARD}/"
    for javascript in (True, False):
        for width, height in VIEWPORTS:
            name = VIEWPORT_NAMES[width]
            context = browser.new_context(viewport={"width": width, "height": height},
                                          java_script_enabled=javascript)
            page = context.new_page()
            page.goto(f"{base}{route}#board-budget-requests-{POSITIVE_AGENCY}", wait_until="load")
            observed = block_observation(page)
            text = page.evaluate(BLOCK_TEXT, PROJECT)
            observed["names_the_project"] = POSITIVE_PROJECT in text
            observed["states_phase_and_period"] = "Phase Construction, from the capital record for May 2026." in text
            observed["states_money_with_its_own_date"] = (
                "Project budget $57,611,798" in text
                and "recorded project spending $8,931,746" in text
                and "from the capital record dated May 18, 2026." in text)
            observed["states_project_scope"] = "Project scope, as the city published it:" in text
            observed["quotes_the_answer_on_scope"] = "What the published answer says about this:" in text
            observed["rows_without_a_project"] = observed["rendered_rows"] - observed["project_blocks"]
            case = f"board-request-project-{name}" if javascript else f"board-request-project-no-javascript-{name}"
            entry = receipt_for(
                surface="community_board_document",
                case=case,
                route=route,
                viewport={"width": width, "height": height},
                revision=rev,
                data_vintage=vintage,
                javascript="enabled" if javascript else "disabled",
                language="en",
                observed=observed,
                assertion=(
                    f"{route} at {width}x{height}"
                    + ("" if javascript else " with scripting disabled")
                    + ": the request whose answer names a capital project carries that project's "
                      "published record, each figure with the capital record it was read from, the "
                      "published wording that names it, and the boundary that a named project is "
                      "not this request's fulfilment; every destination is an ordinary anchor and "
                      "the requests that name no project carry no block at all"),
                render_sha256=sha256_text(text),
            )
            if javascript:
                shot = OUT / f"board-request-project-{name}-{width}x{height}.png"
                page.screenshot(path=str(shot), full_page=True)
                entry["axe"] = run_axe(page, BOARD_SECTION)
                entry["screenshot"] = str(shot.relative_to(ROOT))
                entry["screenshot_sha256"] = sha256_of(shot)
            receipts.append(entry)
            context.close()


def capture_scope_difference(browser, base, rev, vintage, receipts):
    route = f"/community-boards/{SCOPE_DIFFERENCE_BOARD}/"
    for width, height in VIEWPORTS:
        name = VIEWPORT_NAMES[width]
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.goto(f"{base}{route}#board-budget-requests-{POSITIVE_AGENCY}", wait_until="load")
        observed = block_observation(page)
        text = page.evaluate(BLOCK_TEXT, PROJECT)
        observed["states_named_by_the_board"] = (
            "Named in the board's own submission. The published answer does not name it." in text)
        observed["states_published_spelling"] = (
            "The passage spells it HWK 876. The city publishes the project as HWK876." in text)
        observed["states_scope_difference"] = (
            "the Queens segment was removed and improved via in-house resurfacing" in text)
        observed["states_project_phase"] = "Phase Design, from the capital record for May 2026." in text
        shot = OUT / f"board-request-project-scope-difference-{name}.png"
        page.screenshot(path=str(shot), full_page=True)
        receipts.append(receipt_for(
            surface="community_board_document",
            case=f"board-request-project-scope-difference-{name}",
            route=route,
            viewport={"width": width, "height": height},
            revision=rev,
            data_vintage=vintage,
            javascript="enabled",
            language="en",
            observed=observed,
            axe=run_axe(page, BOARD_SECTION),
            assertion=(
                f"{route} at {width}x{height}: the district whose street the project no longer covers "
                "reaches the project record, and the relationship states in the answer's own words "
                "that this district's segment was removed from it and resurfaced in house, beside a "
                "capital observation carrying its own separate date"),
            screenshot=str(shot.relative_to(ROOT)),
            screenshot_sha256=sha256_of(shot),
            render_sha256=sha256_text(text),
        ))
        context.close()


def capture_journey(browser, base, rev, vintage, receipts):
    """Choose an agency, inspect, dismiss, open the project's agency, come back."""
    route = f"/community-boards/{POSITIVE_BOARD}/"
    for width, height in VIEWPORTS:
        name = VIEWPORT_NAMES[width]
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.goto(f"{base}{route}", wait_until="load")
        open_group(page, POSITIVE_AGENCY)
        scope_before = urlparse(page.url).fragment
        rows_before = page.locator(f"{BOARD_SECTION} {ROW}").count()
        blocks_before = page.locator(PROJECT).count()
        button = page.locator(f'{BOARD_SECTION} {ROW}[data-tracking-code="{POSITIVE_REQUEST}"] {INSPECT}')
        button.scroll_into_view_if_needed()
        scroll_before = page.evaluate("() => Math.round(window.scrollY)")

        button.click()
        page.wait_for_timeout(150)
        dialog = page.locator(DIALOG)
        dialog_text = dialog.inner_text().replace("\n", " ")
        observed = {
            "scope_before": scope_before,
            "scroll_before": scroll_before,
            "rows_before": rows_before,
            "project_blocks_before": blocks_before,
            "dialog_open": dialog.evaluate("node => node.open"),
            "focus_inside_dialog": page.evaluate(
                "() => !!document.activeElement.closest('#budget-request-inspect')"),
            "dialog_carries_the_project": POSITIVE_PROJECT in dialog_text,
            "dialog_carries_the_boundary": BOUNDARY in dialog_text,
            "dialog_carries_observation_dates": dialog_text.count(OBSERVATION) >= 2,
            "dialog_destinations": page.eval_on_selector_all(
                f"{DIALOG} a[href]", "nodes => nodes.map((node) => node.getAttribute('href'))"),
            "scroll_while_open": page.evaluate("() => Math.round(window.scrollY)"),
            "scope_unchanged_by_inspection": urlparse(page.url).fragment == scope_before,
        }
        page.keyboard.press("Escape")
        page.wait_for_timeout(150)
        observed["dialog_dismissed"] = not dialog.evaluate("node => node.open")
        observed["scroll_after_dismiss"] = page.evaluate("() => Math.round(window.scrollY)")

        link = page.locator(
            f'{BOARD_SECTION} {ROW}[data-tracking-code="{POSITIVE_REQUEST}"] a[href="/agencies/{MANAGING_AGENCY}/"]')
        link.scroll_into_view_if_needed()
        scroll_before_leaving = page.evaluate("() => Math.round(window.scrollY)")
        link.first.click()
        page.wait_for_load_state("load")
        left_for = urlparse(page.url)
        page.go_back()
        page.wait_for_load_state("load")
        page.wait_for_timeout(500)
        observed.update({
            "left_for_path": left_for.path,
            "returned_path": urlparse(page.url).path,
            "returned_by_history": urlparse(page.url).path == route,
            "scope_after": urlparse(page.url).fragment,
            "scroll_before_leaving": scroll_before_leaving,
            "scroll_after": page.evaluate("() => Math.round(window.scrollY)"),
            "rows_after": page.locator(f"{BOARD_SECTION} {ROW}").count(),
            "project_blocks_after": page.locator(PROJECT).count(),
            "ready_on_return": page.locator(BOARD_SECTION).get_attribute(
                "data-budget-requests-ready") is not None,
        })
        observed["scroll_preserved_through_inspection"] = (
            observed["scroll_while_open"] == scroll_before
            and observed["scroll_after_dismiss"] == scroll_before)
        observed["scroll_restored"] = observed["scroll_after"] == observed["scroll_before_leaving"]
        observed["scroll_before"] = observed["scroll_before_leaving"]

        text = page.evaluate(BLOCK_TEXT, PROJECT)
        shot = OUT / f"board-request-project-journey-{name}.png"
        page.screenshot(path=str(shot), full_page=True)
        receipts.append(receipt_for(
            surface="journey",
            case=f"board-request-project-journey-{name}",
            route=route,
            viewport={"width": width, "height": height},
            revision=rev,
            data_vintage=vintage,
            javascript="enabled",
            language="en",
            observed=observed,
            assertion=(
                f"{route} at {width}x{height}: a reader chooses an agency, inspects the request that "
                "names a capital project, dismisses it, opens the agency that manages the project and "
                "returns with the browser's own Back to the same chosen agency, the same list and the "
                "same scroll position they left from"),
            screenshot=str(shot.relative_to(ROOT)),
            screenshot_sha256=sha256_of(shot),
            render_sha256=sha256_text(text),
        ))
        context.close()


def capture_keyboard(browser, base, rev, vintage, receipts):
    route = f"/community-boards/{POSITIVE_BOARD}/"
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    page.goto(f"{base}{route}#board-budget-requests-{POSITIVE_AGENCY}", wait_until="load")
    # The reachability probe moves focus onto each destination in turn, so it
    # runs before the control is focused rather than after: pressing Enter with
    # focus left on a link would navigate instead of opening the record.
    observed = {
        "group_opened_by_address": page.evaluate(
            "(id) => document.getElementById(id)?.matches(':target') === true",
            f"board-budget-requests-{POSITIVE_AGENCY}"),
        "smallest_target_px": page.evaluate(
            TARGET_PROBE, f"{BOARD_SECTION} {INSPECT}, {PROJECT_ACTION}"),
        "destinations_reachable": page.evaluate(LINK_PROBE, PROJECT_ACTION),
    }
    button = page.locator(f'{BOARD_SECTION} {ROW}[data-tracking-code="{POSITIVE_REQUEST}"] {INSPECT}')
    button.scroll_into_view_if_needed()
    button.focus()
    observed["control_focusable"] = page.evaluate(
        "() => document.activeElement?.classList.contains('board-budget-request-inspect')")
    page.keyboard.press("Enter")
    page.wait_for_timeout(150)
    dialog = page.locator(DIALOG)
    observed["opened_with_keyboard"] = dialog.evaluate("node => node.open")
    observed["focus_on_dismiss_control"] = page.evaluate(
        "() => document.activeElement?.hasAttribute('data-budget-request-close')")
    page.keyboard.press("Tab")
    observed["tab_stays_inside"] = page.evaluate(
        "() => !!document.activeElement.closest('#budget-request-inspect')")
    dialog_text = dialog.inner_text().replace("\n", " ")
    observed["dialog_carries_the_project"] = POSITIVE_PROJECT in dialog_text
    observed["dialog_carries_the_boundary"] = BOUNDARY in dialog_text
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    observed["dismissed_with_escape"] = not dialog.evaluate("node => node.open")
    observed["focus_returned_to_control"] = page.evaluate(
        "() => document.activeElement?.classList.contains('board-budget-request-inspect')")
    text = page.evaluate(BLOCK_TEXT, PROJECT)
    shot = OUT / "board-request-project-keyboard-1440x900.png"
    page.screenshot(path=str(shot), full_page=True)
    receipts.append(receipt_for(
        surface="keyboard",
        case="board-request-project-keyboard",
        route=route,
        viewport={"width": 1440, "height": 900},
        revision=rev,
        data_vintage=vintage,
        javascript="enabled",
        language="en",
        observed=observed,
        axe=run_axe(page, BOARD_SECTION),
        assertion=(
            f"{route} by keyboard alone: every project destination is focusable, Tab reaches the "
            "inspect control, Enter opens the record with the project and its boundary inside it, "
            "Tab stays inside, and Escape dismisses it and returns focus to the control it was "
            "opened from"),
        screenshot=str(shot.relative_to(ROOT)),
        screenshot_sha256=sha256_of(shot),
        render_sha256=sha256_text(text),
    ))
    context.close()


def capture_fixtures(browser, base, manifest, rev, vintage, receipts):
    for fixture in manifest["fixtures"]:
        viewport = fixture.get("viewport") or {"width": 1440, "height": 900}
        context = browser.new_context(viewport=viewport)
        page = context.new_page()
        page.goto(f"{base}/{fixture['file']}#board-budget-requests-{POSITIVE_AGENCY}", wait_until="load")
        observed = block_observation(page, fixture["boundary"])
        text = page.evaluate(BLOCK_TEXT, PROJECT)
        section = page.locator(BOARD_SECTION)
        observed["direction"] = section.get_attribute("dir") if observed["section_present"] else None
        observed["language"] = section.get_attribute("lang") if observed["section_present"] else None
        observed["state_attribute"] = section.get_attribute("data-budget-requests-state") \
            if observed["section_present"] else None
        if fixture["state"] == "unavailable":
            assertion = ("the register could not be read: the section says so, lists no request, and "
                         "adds no capital project block to a list it could not read")
        elif fixture["state"] == "absent":
            assertion = ("no relation materialization at all: every request renders exactly as it did "
                         "before this relation existed, with no heading, no empty panel and no "
                         "sentence about a project that was never named"
                         + (f", measured at {viewport['width']}x{viewport['height']} so a page that "
                            "already scrolled sideways there is on record as doing so without this "
                            "block" if viewport["width"] < 1440 else ""))
        elif fixture["id"] == "board-request-project-scope-difference":
            observed["states_scope_difference"] = (
                "the Queens segment was removed and improved via in-house resurfacing" in text)
            assertion = ("the relationship exposes, in the published answer's own words, that this "
                         "district's segment was removed from the project it names")
        else:
            observed["published_wording_preserved"] = "capital project HWX100SBC in 2026." in text
            observed["published_project_name_preserved"] = "South Bronx East-West Crosstown SBS" in text
            assertion = (f"the block renders in {fixture['lang']} with the publisher's own passage, "
                         "project name and scope left in the source language, the boundary stated in "
                         "the reader's language, and no label left unresolved")
        receipts.append(receipt_for(
            surface="community_board_document",
            case=fixture["id"],
            route=fixture["route"],
            viewport=viewport,
            revision=rev,
            data_vintage=vintage,
            javascript="enabled",
            language=fixture["lang"],
            observed=observed,
            axe=run_axe(page, BOARD_SECTION),
            assertion=assertion,
            render_sha256=sha256_text(text),
        ))
        context.close()


def main() -> int:
    if not SITE.exists():
        print("run tools/prepare_functional_site.sh first", file=sys.stderr)
        return 1
    if not (FIXTURES / "manifest.json").exists():
        print("run node tools/render_board_request_project_fixtures.mjs first", file=sys.stderr)
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
            capture_board(browser, base, rev, vintage, receipts)
            capture_scope_difference(browser, base, rev, vintage, receipts)
            capture_journey(browser, base, rev, vintage, receipts)
            capture_keyboard(browser, base, rev, vintage, receipts)
            capture_fixtures(browser, f"http://127.0.0.1:{repo_port}", manifest, rev, vintage, receipts)
            browser.close()
    finally:
        site_server.shutdown()
        repo_server.shutdown()

    receipt = {
        "schema": "cityscroll.board_request_project_capture.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "revision": rev,
        "data_vintage": vintage,
        "counts": manifest["counts"],
        "positive_board": manifest["positive_board"],
        "positive_request": POSITIVE_REQUEST,
        "positive_project": POSITIVE_PROJECT,
        "scope_difference_board": manifest["scope_difference_board"],
        "scope_difference_request": SCOPE_DIFFERENCE_REQUEST,
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
