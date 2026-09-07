#!/usr/bin/env python3
"""Headless read-back of the hearing preparation reading on served pages.

Reads the section back from pages as they are served, at a desktop and a narrow
touch viewport:

  agenda     the board's published segments at their published times, with the
             budget hearing separated from the cannabis hearing that opens the
             same evening and from the regular meeting that follows it
  years      the hearing's fiscal year and the previous cycle's, both stated,
             with the copy that denies the older list is the coming agenda
  example    one request read from the board's own statement passage through
             the published answer, with the inspect control beside it
  documents  the retained documents, including the scanned letter of comment
             that yielded no usable text and is presented as unread
  language   the section in every shipping language, with the publisher's own
             wording left in the source language
  failure    the same board with the retained reading deliberately unreadable,
             which must say so rather than render a board without a hearing

Each page is checked for the section, for keyboard reachability and native link
behaviour on every destination, for horizontal overflow, for the smallest
interactive target, and with the vendored axe-core rule set. Every served page
is read back once more with JavaScript disabled, because the document is
rendered ahead of the reader: with no scripting the inspect control must not be
offered at all, and every fact it would have shown must already be in the row.

One journey walks a request in the district's own list -> the hearing context
-> inspect -> dismiss -> the board's own participation action, and checks that
the reader's scope, the list and the scroll position all survive it, and that
nothing on the page submits anything. Another drives the control by keyboard
only: Tab to it, Enter to open, Escape to dismiss, focus back where it started.

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

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".artifacts" / "hearing-preparation"
FIXTURES = OUT / "fixtures"
SITE = ROOT / "_site"
RECEIPT = ROOT / "docs" / "evidence" / "hearing-preparation" / "manifest.json"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

# A narrow touch viewport first, then a desktop one.
VIEWPORTS = [(390, 844), (1440, 900)]
VIEWPORT_NAMES = {390: "narrow-touch", 1440: "desktop"}
# WCAG 2.5.8 minimum target size.
MIN_TARGET_PX = 24

SECTION = "#board-hearing-preparation"
REQUESTS_SECTION = "#board-budget-requests"
SEGMENT = "li.board-hearing-segment"
BUDGET_SEGMENT = "li.board-hearing-segment[data-hearing-budget-segment]"
DOCUMENT_ROW = "li.board-hearing-document"
UNREAD_DOCUMENT = 'li.board-hearing-document[data-extraction-state="not_extracted"]'
DISAGREEMENT = "li.board-hearing-disagreement"
INSPECT = "button.board-budget-request-inspect"
DIALOG = "#budget-request-inspect"
DIALOG_CLOSE = "#budget-request-inspect [data-budget-request-close]"
REGISTER_LINK = "a.board-hearing-register-link"


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

# Nothing on this surface may collect anything. A form, a field or a submit
# control inside the section would be this site standing between a resident and
# their board, which is exactly what the copy promises it does not do.
SUBMIT_PROBE = """(selector) => {
  const node = document.querySelector(selector);
  if (!node) return null;
  return {
    forms: node.querySelectorAll('form').length,
    fields: node.querySelectorAll('input, textarea, select').length,
    submits: node.querySelectorAll('[type="submit"]').length,
    frames: node.querySelectorAll('iframe').length,
  };
}"""

SEGMENT_PROBE = """(selector) => [...document.querySelectorAll(selector)].map((node) => ({
  start: node.getAttribute('data-hearing-segment-start'),
  kind: node.getAttribute('data-hearing-segment-kind'),
  fiscal_year: node.getAttribute('data-hearing-segment-fiscal-year'),
  budget: node.hasAttribute('data-hearing-budget-segment'),
}))"""


def section_observation(page) -> dict:
    section = page.locator(SECTION)
    present = section.count() > 0
    text = page.evaluate(SECTION_TEXT, SECTION)
    lede = page.locator(f"{SECTION} .board-hearing-previous-lede")
    return {
        "section_present": present,
        "heading": section.locator("h2").inner_text() if present else None,
        "state": section.get_attribute("data-hearing-context-state") if present else None,
        "hearing_date_attribute": section.get_attribute("data-hearing-date") if present else None,
        "hearing_fiscal_year_attribute": section.get_attribute("data-hearing-fiscal-year") if present else None,
        "previous_fiscal_year_attribute": lede.get_attribute("data-previous-fiscal-year") if lede.count() else None,
        "upcoming_fiscal_year_attribute": lede.get_attribute("data-upcoming-fiscal-year") if lede.count() else None,
        "ready_for_inspection": section.get_attribute("data-budget-requests-ready") is not None if present else False,
        "segments": page.evaluate(SEGMENT_PROBE, f"{SECTION} {SEGMENT}"),
        "budget_segments": page.locator(f"{SECTION} {BUDGET_SEGMENT}").count(),
        "document_rows": page.locator(f"{SECTION} {DOCUMENT_ROW}").count(),
        "unread_document_rows": page.locator(f"{SECTION} {UNREAD_DOCUMENT}").count(),
        "disagreement_rows": page.locator(f"{SECTION} {DISAGREEMENT}").count(),
        "registration_link_present": page.locator(f"{SECTION} {REGISTER_LINK}").count() > 0,
        "links": page.evaluate(LINK_PROBE, f"{SECTION} a.ui-constellation-link"),
        "inspect_controls": page.evaluate(BUTTON_PROBE, f"{SECTION} {INSPECT}"),
        "visible_inspect_controls": page.eval_on_selector_all(
            f"{SECTION} {INSPECT}",
            "nodes => nodes.filter((node) => node.getClientRects().length > 0).length",
        ) if present else 0,
        "smallest_target_px": page.evaluate(
            TARGET_PROBE, f"{SECTION} a.ui-constellation-link, {SECTION} {INSPECT}"),
        "collects_nothing": page.evaluate(SUBMIT_PROBE, SECTION),
        "no_horizontal_overflow": page.evaluate(OVERFLOW_PROBE),
        "unresolved_key_rendered": "cbhc_" in text,
    }


def receipt_for(**fields) -> dict:
    return fields


def capture_board(browser, base, rev, vintage, manifest, receipts):
    board = manifest["positive_board"]
    route = f"/community-boards/{board}/"
    for width, height in VIEWPORTS:
        name = VIEWPORT_NAMES[width]
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.goto(f"{base}{route}", wait_until="load")
        observed = section_observation(page)
        text = page.evaluate(SECTION_TEXT, SECTION)
        observed["states_previous_cycle_boundary"] = (
            "None of it is an item on the coming agenda" in text)
        observed["states_identity_join"] = (
            "not by its wording" in text)
        observed["states_submits_nothing"] = (
            "This site takes no registrations and no testimony." in text)
        observed["worked_example_row_present"] = page.locator(
            f'{SECTION} li.board-budget-request[data-tracking-code="{manifest["worked_example"]}"]').count() == 1
        shot = OUT / f"hearing-context-{name}-{width}x{height}.png"
        page.screenshot(path=str(shot), full_page=True)
        axe = run_axe(page, SECTION)
        receipts.append(receipt_for(
            surface="community_board_document",
            case=f"hearing-context-{name}",
            route=route,
            viewport={"width": width, "height": height},
            revision=rev,
            data_vintage=vintage,
            javascript="enabled",
            language="en",
            observed=observed,
            axe=axe,
            assertion=(
                f"{route} at {width}x{height}: the board's published agenda separates the fiscal year "
                f"{manifest['hearing_fiscal_year']} budget hearing from the cannabis hearing that opens "
                "the same evening and the regular meeting that follows it, the previous cycle's fiscal "
                f"year {manifest['previous_fiscal_year']} record is named as previous rather than as the "
                "coming agenda, and the worked example carries the board's own statement passage beside "
                "the answer the agency published"),
            screenshot=str(shot.relative_to(ROOT)),
            screenshot_sha256=sha256_of(shot),
            render_sha256=sha256_text(text),
        ))
        context.close()

    # The document is rendered ahead of the reader, so it must read the same
    # with no scripting at all — and must not offer a control that would not
    # work.
    for width, height in VIEWPORTS:
        name = VIEWPORT_NAMES[width]
        context = browser.new_context(viewport={"width": width, "height": height},
                                      java_script_enabled=False)
        page = context.new_page()
        page.goto(f"{base}{route}", wait_until="load")
        observed = section_observation(page)
        text = page.evaluate(SECTION_TEXT, SECTION)
        observed["agenda_times_present"] = all(
            entry["start"] for entry in observed["segments"])
        observed["statement_passage_present"] = "Cortelyou Road branch" in text
        observed["published_answer_present"] = (
            "brought to the attention of your Elected Officials" in text)
        receipts.append(receipt_for(
            surface="community_board_document",
            case=f"hearing-context-no-javascript-{name}",
            route=route,
            viewport={"width": width, "height": height},
            revision=rev,
            data_vintage=vintage,
            javascript="disabled",
            language="en",
            observed=observed,
            assertion=(
                f"{route} at {width}x{height} with scripting disabled: every agenda time, the board's "
                "own statement passage, the published answer and the board's registration link are "
                "already in the document, and the inspect control is not offered at all"),
            render_sha256=sha256_text(text),
        ))
        context.close()


def capture_documents(browser, base, rev, vintage, manifest, receipts):
    """The retained documents, and the one this site has not read."""
    board = manifest["positive_board"]
    route = f"/community-boards/{board}/"
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    page.goto(f"{base}{route}", wait_until="load")
    observed = section_observation(page)
    text = page.evaluate(SECTION_TEXT, SECTION)
    observed["states_unread_document"] = (
        "so this site has not read it and reports nothing from inside it" in text)
    observed["states_vote_boundary"] = (
        "It is not a record of what the letter says" in text)
    observed["states_two_publishers"] = (
        "Showing one of them would be this site deciding which publisher to believe." in text)
    observed["unread_documents_still_linked"] = page.eval_on_selector_all(
        f"{SECTION} {UNREAD_DOCUMENT} a[href]",
        "nodes => nodes.length")
    receipts.append(receipt_for(
        surface="community_board_document",
        case="hearing-context-documents-desktop",
        route=route,
        viewport={"width": 1440, "height": 900},
        revision=rev,
        data_vintage=vintage,
        javascript="enabled",
        language="en",
        observed=observed,
        assertion=(
            f"{route}: the scanned letter of comment is linked where the board published it and stated "
            "as a document this site has not read, the ratified vote to send it is stated as a vote "
            "rather than as the letter's contents, and the one answer the two publishers print "
            "differently is shown in both of their wordings"),
        render_sha256=sha256_text(text),
    ))
    context.close()


def capture_journey(browser, base, rev, vintage, manifest, receipts):
    """A request in the district's list, then the hearing, then the board's own action."""
    board = manifest["positive_board"]
    route = f"/community-boards/{board}/"
    for width, height in VIEWPORTS:
        name = VIEWPORT_NAMES[width]
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.goto(f"{base}{route}", wait_until="load")

        # Start where a reader starts: an agency chosen in the district's own
        # list, which the page records in its address.
        page.goto(f"{base}{route}#{REQUESTS_SECTION.lstrip('#')}", wait_until="load")
        page.wait_for_selector(f"{SECTION}[data-budget-requests-ready]")
        page.click(f'a[href="#{SECTION.lstrip("#")}"]') if page.locator(
            f'a[href="#{SECTION.lstrip("#")}"]').count() else None
        # Bring the control into view before the offset is recorded. A click
        # scrolls its own target into view, so measuring before that happens
        # would compare two different places and report a move the reader never
        # made.
        page.locator(f"{SECTION} {INSPECT}").scroll_into_view_if_needed()
        scroll_before = page.evaluate("() => Math.round(window.scrollY)")
        rows_before = page.locator(f"{REQUESTS_SECTION} li.board-budget-request").count()
        url_before = page.url

        page.click(f"{SECTION} {INSPECT}")
        page.wait_for_selector(f"{DIALOG}[open]")
        dialog_text = page.locator(DIALOG).inner_text()
        page.click(DIALOG_CLOSE)
        page.wait_for_selector(f"{DIALOG}[open]", state="detached")

        observed = {
            "dialog_named_the_record": manifest["worked_example"] in dialog_text,
            "url_unchanged": page.url == url_before,
            "scroll_preserved": abs(page.evaluate("() => Math.round(window.scrollY)") - scroll_before) <= 2,
            "list_preserved": page.locator(f"{REQUESTS_SECTION} li.board-budget-request").count() == rows_before,
            "focus_returned_to_control": page.evaluate(
                "() => document.activeElement && document.activeElement.className.includes('board-budget-request-inspect')"),
            "registration_is_a_link": page.eval_on_selector(
                f"{SECTION} {REGISTER_LINK}",
                "node => node.tagName === 'A' && node.getAttribute('href').startsWith('https://')"),
            "registration_destination": page.get_attribute(f"{SECTION} {REGISTER_LINK}", "href"),
            "collects_nothing": page.evaluate(SUBMIT_PROBE, SECTION),
            "no_horizontal_overflow": page.evaluate(OVERFLOW_PROBE),
        }
        receipts.append(receipt_for(
            surface="community_board_document",
            case=f"hearing-context-journey-{name}",
            route=route,
            viewport={"width": width, "height": height},
            revision=rev,
            data_vintage=vintage,
            javascript="enabled",
            language="en",
            observed=observed,
            assertion=(
                f"{route} at {width}x{height}: inspecting the worked example and dismissing it leaves "
                "the reader's address, scroll offset and the district's own request list exactly as "
                "they were, returns focus to the control it was opened from, and leaves the board's "
                "registration form as an ordinary outbound link that this page has not submitted "
                "anything to"),
            render_sha256=sha256_text(page.evaluate(SECTION_TEXT, SECTION)),
        ))
        context.close()


def capture_keyboard(browser, base, rev, vintage, manifest, receipts):
    """The whole affordance driven without a pointer."""
    board = manifest["positive_board"]
    route = f"/community-boards/{board}/"
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()
    page.goto(f"{base}{route}", wait_until="load")
    page.wait_for_selector(f"{SECTION}[data-budget-requests-ready]")

    page.focus(f"{SECTION} {INSPECT}")
    focused = page.evaluate(
        "() => document.activeElement.className.includes('board-budget-request-inspect')")
    page.keyboard.press("Enter")
    page.wait_for_selector(f"{DIALOG}[open]")
    inside = page.evaluate("() => document.querySelector('#budget-request-inspect').contains(document.activeElement)")
    page.keyboard.press("Escape")
    page.wait_for_selector(f"{DIALOG}[open]", state="detached")
    returned = page.evaluate(
        "() => document.activeElement.className.includes('board-budget-request-inspect')")

    receipts.append(receipt_for(
        surface="community_board_document",
        case="hearing-context-keyboard-desktop",
        route=route,
        viewport={"width": 1440, "height": 900},
        revision=rev,
        data_vintage=vintage,
        javascript="enabled",
        language="en",
        observed={
            "control_focusable": focused,
            "enter_opened_the_record": True,
            "focus_moved_into_the_record": inside,
            "escape_dismissed_the_record": True,
            "focus_returned_to_control": returned,
        },
        assertion=(
            f"{route}: the worked example's inspect control takes focus, Enter opens the record, focus "
            "moves inside it, Escape dismisses it, and focus returns to the control it was opened "
            "from, with no pointer used at any step"),
        render_sha256=sha256_text(page.evaluate(SECTION_TEXT, SECTION)),
    ))
    context.close()


def capture_fixtures(browser, base, manifest, rev, vintage, receipts):
    for fixture in manifest["fixtures"]:
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.goto(f"{base}/{fixture['file']}", wait_until="load")
        observed = section_observation(page)
        section = page.locator(SECTION)
        text = page.evaluate(SECTION_TEXT, SECTION)
        observed["direction"] = section.get_attribute("dir") if observed["section_present"] else None
        observed["language"] = section.get_attribute("lang") if observed["section_present"] else None
        if fixture["id"] == "hearing-context-failed-load":
            observed["agenda_absent"] = observed["budget_segments"] == 0
            observed["hearing_year_absent"] = str(manifest["hearing_fiscal_year"]) not in text
            assertion = ("the retained reading could not be read: the section says so, offers a retry "
                         "and a route to the board's own page, and shows no agenda time and no fiscal "
                         "year it cannot stand behind")
        else:
            observed["published_agenda_wording_preserved"] = (
                "Public Hearing on Community Budget Recommendations" in text)
            observed["statement_passage_preserved"] = "Cortelyou Road branch" in text
            observed["published_answer_preserved"] = (
                "brought to the attention of your Elected Officials" in text)
            assertion = (f"the section renders in {fixture['lang']} with the board's published agenda "
                         "wording, its own statement passage and the agency's published answer left in "
                         "the source language, and no label left unresolved")
        axe = run_axe(page, SECTION)
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
        print("run node tools/render_hearing_context_fixtures.mjs first", file=sys.stderr)
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
            capture_board(browser, base, rev, vintage, manifest, receipts)
            capture_documents(browser, base, rev, vintage, manifest, receipts)
            capture_journey(browser, base, rev, vintage, manifest, receipts)
            capture_keyboard(browser, base, rev, vintage, manifest, receipts)
            capture_fixtures(browser, f"http://127.0.0.1:{repo_port}", manifest, rev, vintage, receipts)
            browser.close()
    finally:
        site_server.shutdown()
        repo_server.shutdown()

    receipt = {
        "schema": "cityscroll.hearing_context_capture.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "revision": rev,
        "data_vintage": vintage,
        "counts": manifest["counts"],
        "positive_board": manifest["positive_board"],
        "hearing_date": manifest["hearing_date"],
        "hearing_fiscal_year": manifest["hearing_fiscal_year"],
        "previous_fiscal_year": manifest["previous_fiscal_year"],
        "worked_example": manifest["worked_example"],
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
