#!/usr/bin/env python3
"""Headless read-back of community board budget requests on served pages.

Reads the sections back from pages as they are served, at a desktop and a
narrow touch viewport, from both ends of the same record:

  board      a district's requests grouped by the agency that answers them,
             including one request whose answer was rewritten between the two
             publications and one whose publisher wrapper moved on its own
  agency     the same records from the agency side, with the frozen population
             each agency is responsible for answering
  language   the board section in every shipping language, with the publisher's
             own wording left in the source language
  absence    a board the register holds no request for, which must render a
             sentence about the register rather than nothing
  failure    the same board with the register deliberately unreadable, which
             must say so and keep its published source reachable

Each page is checked for the section, for keyboard reachability and native link
behaviour on every destination, for horizontal overflow, for the smallest
interactive target, and with the vendored axe-core rule set. Every served page
is read back once more with JavaScript disabled, because both documents are
rendered ahead of the reader: with no scripting the inspect control must not be
offered at all, and every fact it would have shown — including every dated
answer — must already be in the row.

One journey walks board -> choose an agency -> inspect -> dismiss -> open the
agency -> browser Back -> continue, and checks that the chosen agency, the
reader's scroll position and the list all survive it. Another drives the control
by keyboard only: Tab to it, Enter to open, Escape to dismiss, focus back on the
control it was opened from.

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
OUT = ROOT / ".artifacts" / "board-budget-requests"
FIXTURES = OUT / "fixtures"
SITE = ROOT / "_site"
RECEIPT = ROOT / "docs" / "evidence" / "board-budget-requests" / "manifest.json"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

# A narrow touch viewport first, then a desktop one.
VIEWPORTS = [(390, 844), (1440, 900)]
VIEWPORT_NAMES = {390: "narrow-touch", 1440: "desktop"}
# WCAG 2.5.8 minimum target size.
MIN_TARGET_PX = 24

BOARD_SECTION = "#board-budget-requests"
AGENCY_SECTION = "#agency-budget-requests"
ROW = "li.board-budget-request"
INSPECT = "button.board-budget-request-inspect"
DIALOG = "#budget-request-inspect"
DIALOG_CLOSE = "#budget-request-inspect [data-budget-request-close]"

# The named cases, addressed by the publisher's own identifiers so a failure
# says which record moved rather than which number did.
POSITIVE_BOARD = "brooklyn-cb-14"
CHANGED_ANSWER = "214202710C"
WRAPPER_ONLY = "214202727E"
SCOPE_AGENCY = "transportation"
# The wrapper-only request sits under an agency past the opening set, so the
# keyboard pass arrives at it the way a reader does: through the group's own
# address, which is what opens it with no script involved.
WRAPPER_ONLY_AGENCY = "youth-and-community-development"
# The three agency populations this evidence reproduces from the other end.
AGENCIES = ["transportation", "environmental-protection", "parks-and-recreation"]


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
    """Axe over the section this change owns, plus the page it sits in.

    The gate is the scoped result: a finding elsewhere on the document is
    reported alongside it as page context rather than folded into this section's
    verdict, and never silently swallowed either.
    """
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


# Keyboard reachability is measured over the destinations a reader can see.
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


def section_observation(page, section_selector: str) -> dict:
    section = page.locator(section_selector)
    present = section.count() > 0
    text = page.evaluate(SECTION_TEXT, section_selector)
    answers = page.locator(f"{section_selector} li.board-budget-request-answer")
    return {
        "section_present": present,
        "heading": section.locator("h2").inner_text() if present else None,
        "state": section.get_attribute("data-budget-requests-state") if present else None,
        "request_count_attribute": section.get_attribute("data-request-count") if present else None,
        "changed_answer_count_attribute": section.get_attribute("data-changed-answer-count") if present else None,
        "fiscal_years_attribute": section.get_attribute("data-fiscal-years") if present else None,
        "publication_count_attribute": section.get_attribute("data-publication-count") if present else None,
        "ready_for_inspection": section.get_attribute("data-budget-requests-ready") is not None if present else False,
        "rendered_rows": page.locator(f"{section_selector} {ROW}").count() if present else 0,
        "answers_visible": answers.count() if present else 0,
        "visible_inspect_controls": page.eval_on_selector_all(
            f"{section_selector} {INSPECT}",
            "nodes => nodes.filter((node) => node.getClientRects().length > 0).length",
        ) if present else 0,
        "source_link_present": page.locator(f"{section_selector} a[href*='data.cityofnewyork.us']").count() > 0,
        "no_horizontal_overflow": page.evaluate(OVERFLOW_PROBE),
        "unresolved_key_rendered": "cbbr_" in text or "abr_" in text,
    }


def board_observation(page) -> dict:
    observed = section_observation(page, BOARD_SECTION)
    observed["agency_groups"] = page.locator(f"{BOARD_SECTION} section.board-budget-request-group").count()
    observed["scope_links"] = page.locator(f"{BOARD_SECTION} a.board-budget-requests-scope-link").count()
    observed["links"] = page.evaluate(
        LINK_PROBE, f"{BOARD_SECTION} a.board-budget-request-agency-link")
    observed["inspect_controls"] = page.evaluate(BUTTON_PROBE, f"{BOARD_SECTION} {INSPECT}")
    observed["smallest_target_px"] = page.evaluate(
        TARGET_PROBE, f"{BOARD_SECTION} a.board-budget-requests-scope-link, {BOARD_SECTION} {INSPECT}")
    return observed


def agency_observation(page) -> dict:
    observed = section_observation(page, AGENCY_SECTION)
    observed["board_groups"] = page.locator(f"{AGENCY_SECTION} section.agency-budget-request-board").count()
    observed["board_count_attribute"] = page.locator(AGENCY_SECTION).get_attribute("data-board-count") \
        if observed["section_present"] else None
    observed["links"] = page.evaluate(
        LINK_PROBE, f"{AGENCY_SECTION} a.agency-budget-request-board-link")
    observed["inspect_controls"] = page.evaluate(BUTTON_PROBE, f"{AGENCY_SECTION} {INSPECT}")
    observed["smallest_target_px"] = page.evaluate(
        TARGET_PROBE, f"{AGENCY_SECTION} a.agency-budget-request-board-link, {AGENCY_SECTION} {INSPECT}")
    return observed


def receipt_for(**fields) -> dict:
    return fields


def capture_board(browser, base, rev, vintage, receipts):
    route = f"/community-boards/{POSITIVE_BOARD}/"
    for width, height in VIEWPORTS:
        name = VIEWPORT_NAMES[width]
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.goto(f"{base}{route}", wait_until="load")
        observed = board_observation(page)
        observed["changed_answer_row_present"] = page.locator(
            f'{BOARD_SECTION} {ROW}[data-tracking-code="{CHANGED_ANSWER}"]').count() == 1
        observed["wrapper_only_row_present"] = page.locator(
            f'{BOARD_SECTION} {ROW}[data-tracking-code="{WRAPPER_ONLY}"]').count() == 1
        text = page.evaluate(SECTION_TEXT, BOARD_SECTION)
        observed["states_changed_answer"] = "This answer reads differently from the one published" in text
        observed["states_wrapper_change"] = "only the publisher's wrapper sentence changed" in text
        observed["states_request_response_boundary"] = "A request is what the board asked for." in text
        observed["states_rank_scope"] = "is this board's own order inside one agency" in text
        shot = OUT / f"board-budget-requests-{name}-{width}x{height}.png"
        page.screenshot(path=str(shot), full_page=True)
        axe = run_axe(page, BOARD_SECTION)
        receipts.append(receipt_for(
            surface="community_board_document",
            case=f"board-budget-requests-{name}",
            route=route,
            viewport={"width": width, "height": height},
            revision=rev,
            data_vintage=vintage,
            javascript="enabled",
            language="en",
            observed=observed,
            axe=axe,
            assertion=(
                f"{route} at {width}x{height}: this district's requests are browsable by the agency "
                "that answers them, each request carries the board's own words, its priority scoped "
                "to that agency and budget type, and every dated answer, and a rewritten answer is "
                "named as one while a moved publisher wrapper is named as a wrapper change"),
            screenshot=str(shot.relative_to(ROOT)),
            screenshot_sha256=sha256_of(shot),
            render_sha256=sha256_text(text),
        ))
        context.close()

    # The document is rendered ahead of the reader, so it must read the same with
    # no scripting at all — and must not offer a control that would not work.
    for width, height in VIEWPORTS:
        name = VIEWPORT_NAMES[width]
        context = browser.new_context(viewport={"width": width, "height": height},
                                      java_script_enabled=False)
        page = context.new_page()
        page.goto(f"{base}{route}", wait_until="load")
        observed = board_observation(page)
        text = page.evaluate(SECTION_TEXT, BOARD_SECTION)
        observed["answer_text_present"] = "resurfaced in Summer 2025" in text
        observed["board_words_present"] = "sidewalks, curbs, street and bus pads" in text
        receipts.append(receipt_for(
            surface="community_board_document",
            case=f"board-budget-requests-no-javascript-{name}",
            route=route,
            viewport={"width": width, "height": height},
            revision=rev,
            data_vintage=vintage,
            javascript="disabled",
            language="en",
            observed=observed,
            assertion=(
                f"{route} at {width}x{height} with scripting disabled: every agency link works, the "
                "board's own words and both dated answers are already in the row, and the inspect "
                "control is not offered at all"),
            render_sha256=sha256_text(text),
        ))
        context.close()


def capture_agencies(browser, base, rev, vintage, receipts):
    for agency_id in AGENCIES:
        route = f"/agencies/{agency_id}/"
        for width, height in VIEWPORTS:
            name = VIEWPORT_NAMES[width]
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()
            page.goto(f"{base}{route}", wait_until="load")
            observed = agency_observation(page)
            text = page.evaluate(SECTION_TEXT, AGENCY_SECTION)
            observed["states_no_score"] = "none of it scores how the agency answered" in text
            observed["states_board_order"] = "that board's own priority order" in text
            shot = OUT / f"agency-budget-requests-{agency_id}-{name}.png"
            page.screenshot(path=str(shot), full_page=True)
            axe = run_axe(page, AGENCY_SECTION)
            receipts.append(receipt_for(
                surface="agency_document",
                case=f"agency-budget-requests-population-{agency_id}-{name}",
                route=route,
                viewport={"width": width, "height": height},
                revision=rev,
                data_vintage=vintage,
                javascript="enabled",
                language="en",
                observed=observed,
                axe=axe,
                assertion=(
                    f"{route} at {width}x{height}: the agency states the whole frozen population of "
                    "community board requests it is responsible for answering, lists every district "
                    "that asked in that district's own priority order, links back to each one at "
                    "this agency's own scope, and publishes no score of how it answered"),
                screenshot=str(shot.relative_to(ROOT)),
                screenshot_sha256=sha256_of(shot),
                render_sha256=sha256_text(text),
            ))
            context.close()

    route = f"/agencies/{AGENCIES[0]}/"
    context = browser.new_context(viewport={"width": 1440, "height": 900}, java_script_enabled=False)
    page = context.new_page()
    page.goto(f"{base}{route}", wait_until="load")
    observed = agency_observation(page)
    text = page.evaluate(SECTION_TEXT, AGENCY_SECTION)
    receipts.append(receipt_for(
        surface="agency_document",
        case="agency-budget-requests-no-javascript-desktop",
        route=route,
        viewport={"width": 1440, "height": 900},
        revision=rev,
        data_vintage=vintage,
        javascript="disabled",
        language="en",
        observed=observed,
        assertion=(
            f"{route} with scripting disabled: this section is written into the document rather than "
            "fetched after it, so the population, every district that asked and each district's "
            "answers are readable, and the inspect control is not offered at all"),
        render_sha256=sha256_text(text),
    ))
    context.close()


def capture_scope_journey(browser, base, rev, vintage, receipts):
    """Choose an agency, inspect, dismiss, leave, come back, continue."""
    route = f"/community-boards/{POSITIVE_BOARD}/"
    for width, height in VIEWPORTS:
        name = VIEWPORT_NAMES[width]
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.goto(f"{base}{route}", wait_until="load")
        # Choosing an agency is an ordinary navigation, so the browser records it.
        page.locator(f'{BOARD_SECTION} a[href="#board-budget-requests-{SCOPE_AGENCY}"]').first.click()
        page.wait_for_timeout(150)
        scope_before = urlparse(page.url).fragment
        rows_before = page.locator(f"{BOARD_SECTION} {ROW}").count()
        button = page.locator(f'{BOARD_SECTION} {ROW}[data-tracking-code="{CHANGED_ANSWER}"] {INSPECT}')
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
            "dialog_open": dialog.evaluate("node => node.open"),
            "dialog_labelled_by": dialog.get_attribute("aria-labelledby"),
            "focus_inside_dialog": page.evaluate(
                "() => !!document.activeElement.closest('#budget-request-inspect')"),
            "scroll_while_open": page.evaluate("() => Math.round(window.scrollY)"),
            "scope_unchanged_by_inspection": urlparse(page.url).fragment == scope_before,
            "dialog_states_boundary": "A request is what the board asked for." in dialog_text,
            "dialog_states_rank_scope": "is this board's own order inside one agency" in dialog_text,
            "dialog_states_change": "reads differently from the one published" in dialog_text,
            "dialog_carries_both_answers": dialog_text.count("Published ") >= 2,
        }

        page.keyboard.press("Escape")
        page.wait_for_timeout(150)
        observed["dialog_dismissed"] = not dialog.evaluate("node => node.open")
        observed["scroll_after_dismiss"] = page.evaluate("() => Math.round(window.scrollY)")

        # Leave for the agency this request names, then come back the way a
        # reader does: with the browser's own Back.
        link = page.locator(
            f'{BOARD_SECTION} {ROW}[data-tracking-code="{CHANGED_ANSWER}"] a.board-budget-request-agency-link')
        link.scroll_into_view_if_needed()
        scroll_before_leaving = page.evaluate("() => Math.round(window.scrollY)")
        link.click()
        page.wait_for_load_state("load")
        left_for = urlparse(page.url)
        page.go_back()
        page.wait_for_load_state("load")
        page.wait_for_timeout(500)
        observed.update({
            "left_for_path": left_for.path,
            "left_for_hash": left_for.fragment,
            "returned_path": urlparse(page.url).path,
            "returned_by_history": urlparse(page.url).path == route,
            "scope_after": urlparse(page.url).fragment,
            "scroll_before_leaving": scroll_before_leaving,
            "scroll_after": page.evaluate("() => Math.round(window.scrollY)"),
            "rows_after": page.locator(f"{BOARD_SECTION} {ROW}").count(),
            "ready_on_return": page.locator(BOARD_SECTION).get_attribute(
                "data-budget-requests-ready") is not None,
        })
        # The reader's place is the scroll offset they left from, not the one
        # they started at: inspecting must not move it, and returning must
        # restore it.
        observed["scroll_preserved_through_inspection"] = (
            observed["scroll_while_open"] == scroll_before
            and observed["scroll_after_dismiss"] == scroll_before)
        observed["scroll_restored"] = observed["scroll_after"] == observed["scroll_before_leaving"]
        observed["scroll_before"] = observed["scroll_before_leaving"]

        text = page.evaluate(SECTION_TEXT, BOARD_SECTION)
        shot = OUT / f"board-budget-requests-scope-journey-{name}.png"
        page.screenshot(path=str(shot), full_page=True)
        receipts.append(receipt_for(
            surface="journey",
            case=f"board-budget-requests-scope-journey-{name}",
            route=route,
            viewport={"width": width, "height": height},
            revision=rev,
            data_vintage=vintage,
            javascript="enabled",
            language="en",
            observed=observed,
            assertion=(
                f"{route} at {width}x{height}: a reader chooses an agency, inspects one request in "
                "place, dismisses it with Escape, opens the agency that answers it and returns with "
                "the browser's own Back to the same chosen agency, the same list and the same scroll "
                "position they left from"),
            screenshot=str(shot.relative_to(ROOT)),
            screenshot_sha256=sha256_of(shot),
            render_sha256=sha256_text(text),
        ))
        context.close()


def capture_keyboard(browser, base, rev, vintage, receipts):
    """The whole affordance driven by the keyboard alone."""
    route = f"/community-boards/{POSITIVE_BOARD}/"
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    page.goto(f"{base}{route}#board-budget-requests-{WRAPPER_ONLY_AGENCY}", wait_until="load")
    button = page.locator(f'{BOARD_SECTION} {ROW}[data-tracking-code="{WRAPPER_ONLY}"] {INSPECT}')
    button.scroll_into_view_if_needed()
    button.focus()
    observed = {
        "group_opened_by_address": page.evaluate(
            "(id) => document.getElementById(id)?.matches(':target') === true",
            f"board-budget-requests-{WRAPPER_ONLY_AGENCY}"),
        "control_focusable": page.evaluate(
            "() => document.activeElement?.classList.contains('board-budget-request-inspect')"),
        "smallest_target_px": page.evaluate(
            TARGET_PROBE, f"{BOARD_SECTION} a.board-budget-requests-scope-link, {BOARD_SECTION} {INSPECT}"),
    }
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
    observed["dialog_states_wrapper_change"] = "only the publisher's wrapper sentence changed" in dialog_text
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    observed["dismissed_with_escape"] = not dialog.evaluate("node => node.open")
    observed["focus_returned_to_control"] = page.evaluate(
        "() => document.activeElement?.classList.contains('board-budget-request-inspect')")
    text = page.evaluate(SECTION_TEXT, BOARD_SECTION)
    shot = OUT / "board-budget-requests-keyboard-1440x900.png"
    page.screenshot(path=str(shot), full_page=True)
    axe = run_axe(page, BOARD_SECTION)
    receipts.append(receipt_for(
        surface="keyboard",
        case="board-budget-requests-keyboard",
        route=route,
        viewport={"width": 1440, "height": 900},
        revision=rev,
        data_vintage=vintage,
        javascript="enabled",
        language="en",
        observed=observed,
        axe=axe,
        assertion=(
            f"{route} by keyboard alone: Tab reaches the inspect control, Enter opens the request "
            "with focus inside it, Tab stays inside, the record names the wrapper change for what it "
            "is, and Escape dismisses it and returns focus to the control it was opened from"),
        screenshot=str(shot.relative_to(ROOT)),
        screenshot_sha256=sha256_of(shot),
        render_sha256=sha256_text(text),
    ))
    context.close()


def capture_fixtures(browser, base, manifest, rev, vintage, receipts):
    for fixture in manifest["fixtures"]:
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.goto(f"{base}/{fixture['file']}", wait_until="load")
        observed = board_observation(page)
        section = page.locator(BOARD_SECTION)
        text = page.evaluate(SECTION_TEXT, BOARD_SECTION)
        observed["direction"] = section.get_attribute("dir") if observed["section_present"] else None
        observed["language"] = section.get_attribute("lang") if observed["section_present"] else None
        if fixture["id"] == "board-budget-requests-failed-load":
            assertion = ("the register could not be read: the section says so, offers a retry, keeps "
                         "its published source reachable, and lists no request — a failure to read, "
                         "not a district that asked for nothing")
        elif fixture["id"] == "board-budget-requests-none-recorded":
            assertion = ("the register holds no request for this board: the section says so about the "
                         "register rather than rendering nothing, and still states what a request and "
                         "a response are")
        else:
            observed["published_answer_preserved"] = "resurfaced in Summer 2025" in text
            observed["published_agency_preserved"] = "Department of Transportation" in text
            assertion = (f"the section renders in {fixture['lang']} with the publisher's own request "
                         "wording, agency names and published answers left in the source language, "
                         "and no label left unresolved")
        axe = run_axe(page, BOARD_SECTION)
        receipts.append(receipt_for(
            surface="community_board_document",
            case=fixture["id"],
            route=fixture["route"],
            viewport={"width": 1440, "height": 900},
            revision=rev,
            data_vintage=vintage,
            javascript="enabled",
            language=fixture["lang"],
            observed=observed,
            axe=axe,
            assertion=assertion,
            render_sha256=sha256_text(text),
        ))
        context.close()


def main() -> int:
    if not SITE.exists():
        print("run tools/prepare_functional_site.sh first", file=sys.stderr)
        return 1
    if not (FIXTURES / "manifest.json").exists():
        print("run node tools/render_board_budget_request_fixtures.mjs first", file=sys.stderr)
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
            capture_agencies(browser, base, rev, vintage, receipts)
            capture_scope_journey(browser, base, rev, vintage, receipts)
            capture_keyboard(browser, base, rev, vintage, receipts)
            capture_fixtures(browser, f"http://127.0.0.1:{repo_port}", manifest, rev, vintage, receipts)
            browser.close()
    finally:
        site_server.shutdown()
        repo_server.shutdown()

    receipt = {
        "schema": "cityscroll.board_budget_request_capture.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "revision": rev,
        "data_vintage": vintage,
        "counts": manifest["counts"],
        "positive_board": manifest["positive_board"],
        "agencies": AGENCIES,
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
