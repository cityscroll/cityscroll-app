#!/usr/bin/env python3
"""Headless read-back of the district land-project list on served board pages.

Reads the list back from pages as they are served, at a desktop and a narrow
viewport, with the positive and the negative example:

  positive   a board whose district records more projects than the visible bound,
             so the bounded list and its exact overflow disclosure are both read
  short      a board whose whole list fits, so no disclosure is offered
  negative   a board whose district records no project, which must render no
             section, no heading and no empty panel
  failure    the same positive board with its list artifact deliberately
             unreadable, which must say so and keep its published source

Each page is checked for the list itself, for keyboard reachability and native
link behaviour on every project link, for horizontal overflow, for the smallest
interactive target, and with the vendored axe-core rule set. Every page is read
back once more with JavaScript disabled, because the board document is
server-rendered and must not depend on it. One journey walks board -> project ->
browser Back and checks that the reader's scroll position and their opened
disclosure survive, and that the board's own Month/List calendar is untouched.
Every shipping language is read back for translated copy with the publisher's
own titles, applicant labels and statuses left in the source language.

Screenshots stay under an ignored path. The receipt is the evidence: route,
viewport, revision, data vintage, assertion, and the sha256 of each capture.
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
OUT = ROOT / ".artifacts" / "board-district-projects"
FIXTURES = OUT / "fixtures"
SITE = ROOT / "_site"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]
# WCAG 2.5.8 minimum target size.
MIN_TARGET_PX = 24

SECTION = "#district-land-projects"
PROJECT_LINK = "#district-land-projects a.board-district-project-link"
OVERFLOW = "#district-land-projects-more"
MORE_LINK = "a.board-district-projects-more"
LESS_LINK = "a.board-district-projects-less"

# The named cases, addressed by the publisher's own board and project
# identifiers so a failure says which record moved.
POSITIVE_BOARD = "brooklyn-cb-01"
POSITIVE_PROJECT = "2024K0358"
SHORT_BOARD = "manhattan-cb-06"
EMPTY_BOARD = "brooklyn-cb-08"
# A board that carries both an overflowing list and the Month/List proceedings
# calendar, so the journey can show the calendar is left exactly as it was.
CALENDAR_BOARD = "manhattan-cb-04"
CALENDAR_BOARD_PROJECT = "2023M0213"

CASES = [
    (POSITIVE_BOARD, "board-district-projects-overflow",
     "A district recording more projects than the visible bound: the bounded list renders and the "
     "remainder are reachable behind a disclosure that states their exact number."),
    (SHORT_BOARD, "board-district-projects-short",
     "A district whose whole list fits inside the visible bound: every project renders and no "
     "disclosure is offered."),
    (EMPTY_BOARD, "board-district-projects-absent",
     "A district recording no project: no section, no heading and no empty panel render, and the "
     "board keeps everything it already carried."),
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


def run_axe(page) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22 = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22)
    return {"failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in gate],
            "passes": len(gate) == 0}


# Keyboard reachability is measured over the links a reader can actually see.
# A project still behind the collapsed disclosure is deliberately out of the
# tab order, which is the same thing a native disclosure does.
LINK_PROBE = """(selector) => {
  const all = [...document.querySelectorAll(selector)];
  const links = all.filter((l) => l.getClientRects().length > 0);
  let reachable = 0;
  for (const link of links) {
    link.focus();
    if (document.activeElement === link) reachable += 1;
  }
  return {
    count: all.length,
    visible: links.length,
    reachable,
    native: all.every((l) => l.tagName === 'A' && (l.getAttribute('href') || '').length > 0),
    new_tab: all.filter((l) => l.hasAttribute('target')).length,
    scripted: all.filter((l) => [...l.attributes].some((a) => a.name.startsWith('on'))).length,
  };
}"""

TARGET_PROBE = """(selector) => {
  const nodes = [...document.querySelectorAll(selector)];
  const sizes = nodes.map((n) => {
    const r = n.getBoundingClientRect();
    return Math.round(Math.min(r.width, r.height));
  }).filter((n) => n > 0);
  return sizes.length ? Math.min(...sizes) : null;
}"""

OVERFLOW_PROBE = """() => Math.round(document.documentElement.scrollWidth)
  <= Math.round(document.documentElement.clientWidth) + 1"""


def board_observation(page) -> dict:
    section = page.locator(SECTION)
    present = section.count() > 0
    overflow = page.locator(OVERFLOW)
    return {
        "section_present": present,
        "heading": section.locator("h2").inner_text() if present else None,
        "project_count_attribute": section.get_attribute("data-project-count") if present else None,
        "district": section.get_attribute("data-district-id") if present else None,
        "state": section.get_attribute("data-district-projects-state") if present else None,
        "project_links": page.locator(PROJECT_LINK).count(),
        "overflow_disclosure": overflow.count(),
        "overflow_label": overflow.locator(MORE_LINK).inner_text() if overflow.count() else None,
        "overflow_hidden_before_expansion": (
            not page.locator(f"{OVERFLOW} li").first.is_visible() if overflow.count() else None),
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
            page.goto(f"{base}{route}", wait_until="domcontentloaded")
            observed = board_observation(page)
            observed["links_collapsed"] = page.evaluate(LINK_PROBE, PROJECT_LINK)
            observed["smallest_target_px"] = page.evaluate(
                TARGET_PROBE, f"{PROJECT_LINK}, {OVERFLOW} {MORE_LINK}")
            if observed["overflow_disclosure"]:
                page.locator(f"{OVERFLOW} {MORE_LINK}").click()
                page.wait_for_timeout(150)
                observed["overflow_visible_after_expansion"] = page.locator(
                    f"{OVERFLOW} li").first.is_visible()
                observed["links_expanded"] = page.evaluate(LINK_PROBE, PROJECT_LINK)
                page.locator(f"{OVERFLOW} {LESS_LINK}").click()
                page.wait_for_timeout(150)
                observed["collapses_again"] = not page.locator(f"{OVERFLOW} li").first.is_visible()
                page.locator(f"{OVERFLOW} {MORE_LINK}").click()
                page.wait_for_timeout(150)
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
            })
            context.close()

        # The document is server-rendered, so it must read the same with no
        # scripting at all.
        context = browser.new_context(viewport={"width": 1440, "height": 900},
                                      java_script_enabled=False)
        page = context.new_page()
        page.goto(f"{base}{route}", wait_until="domcontentloaded")
        section = page.locator(SECTION)
        overflow = page.locator(OVERFLOW)
        no_script_expansion = None
        if overflow.count():
            no_script_expansion = {
                "hidden_before": not page.locator(f"{OVERFLOW} li").first.is_visible(),
            }
            page.locator(f"{OVERFLOW} {MORE_LINK}").click()
            page.wait_for_timeout(150)
            no_script_expansion["visible_after"] = page.locator(f"{OVERFLOW} li").first.is_visible()
        receipts.append({
            "surface": "community_board_document",
            "case": f"{case}-no-javascript",
            "route": route,
            "viewport": {"width": 1440, "height": 900},
            "revision": rev,
            "data_vintage": vintage,
            "javascript": "disabled",
            "observed": {
                "section_present": section.count() > 0,
                "project_links": page.locator(PROJECT_LINK).count(),
                "overflow_disclosure": overflow.count(),
                "expansion_without_javascript": no_script_expansion,
            },
            "assertion": f"{route} with scripting disabled: {assertion}",
        })
        context.close()


def capture_journey(browser, base, rev, vintage, receipts, body_id, project_id, case):
    route = f"/community-boards/{body_id}/"
    for width, height in VIEWPORTS:
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.goto(f"{base}{route}", wait_until="domcontentloaded")
        hidden_before = not page.locator(f"{OVERFLOW} li").first.is_visible()
        page.locator(f"{OVERFLOW} {MORE_LINK}").click()
        page.wait_for_timeout(150)
        expanded_before = page.locator(f"{OVERFLOW} li").first.is_visible()
        calendar_before = page.locator('[data-board-proceedings-panel="list"]').count()
        link = page.locator(f'{SECTION} a[href="/browse/zoning/#land/{project_id}"]').first
        link.scroll_into_view_if_needed()
        scrolled = page.evaluate("() => Math.round(window.scrollY)")
        link.click()
        page.wait_for_load_state("domcontentloaded")
        left_for = urlparse(page.url)
        page.go_back()
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(500)
        observed = {
            "overflow_hidden_before_expansion": hidden_before,
            "left_for_path": left_for.path,
            "left_for_hash": left_for.fragment,
            "returned_path": urlparse(page.url).path,
            "expanded_before_leaving": expanded_before,
            "scrolled_to": scrolled,
            "scroll_on_return": page.evaluate("() => Math.round(window.scrollY)"),
            "expansion_on_return": page.locator(f"{OVERFLOW} li").first.is_visible(),
            "calendar_panels_before": calendar_before,
            "calendar_panels_on_return": page.locator('[data-board-proceedings-panel="list"]').count(),
        }
        observed["scroll_restored"] = observed["scroll_on_return"] == scrolled
        observed["calendar_undisturbed"] = (
            observed["calendar_panels_before"] == observed["calendar_panels_on_return"])
        shot = OUT / f"{case}-{width}x{height}.png"
        page.screenshot(path=str(shot), full_page=True)
        receipts.append({
            "surface": "journey",
            "case": case,
            "route": route,
            "viewport": {"width": width, "height": height},
            "revision": rev,
            "data_vintage": vintage,
            "javascript": "enabled",
            "observed": observed,
            "assertion": (f"{route} at {width}x{height}: the board opens a project and the browser's "
                          "own Back returns to the board with the reader's scroll position, their "
                          "opened list and the board calendar as they left them"),
            "screenshot": str(shot.relative_to(ROOT)),
            "screenshot_sha256": sha256_of(shot),
        })
        context.close()


def capture_fixtures(browser, base, manifest, rev, vintage, receipts):
    for fixture in manifest["fixtures"]:
        url = f"{base}/{fixture['file']}"
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded")
        section = page.locator(SECTION)
        present = section.count() > 0
        text = section.inner_text() if present else ""
        observed = {
            "section_present": present,
            "state": section.get_attribute("data-district-projects-state") if present else None,
            "heading": section.locator("h2").inner_text() if present else None,
            "direction": section.get_attribute("dir") if present else None,
            "project_links": page.locator(PROJECT_LINK).count(),
            "no_horizontal_overflow": page.evaluate(OVERFLOW_PROBE),
            "published_title_preserved": "Monitor Point" in text,
            "published_applicant_preserved": "GO Quay LLC" in text,
            "recorded_status_preserved": "In Public Review" in text,
            "unresolved_key_rendered": "cbdp_" in text,
        }
        if fixture["id"] == "board-list-unavailable":
            observed["source_link"] = page.locator(
                f'{SECTION} a.board-district-project-source').count()
            assertion = ("the district project list could not be read: the section says so, offers a "
                         "retry, keeps its published source reachable, and lists no project")
        else:
            assertion = (f"the section renders in {fixture['lang']} with the publisher's own titles, "
                         "applicant labels and recorded statuses left in the source language")
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
        })
        context.close()


def main() -> int:
    if not SITE.exists():
        print("run tools/prepare_functional_site.sh first", file=sys.stderr)
        return 1
    if not (FIXTURES / "manifest.json").exists():
        print("run node tools/render_board_district_project_fixtures.mjs first", file=sys.stderr)
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
            capture_journey(browser, base, rev, vintage, receipts,
                            POSITIVE_BOARD, POSITIVE_PROJECT, "board-project-back")
            capture_journey(browser, base, rev, vintage, receipts,
                            CALENDAR_BOARD, CALENDAR_BOARD_PROJECT, "board-project-back-with-calendar")
            capture_fixtures(browser, f"http://127.0.0.1:{repo_port}", manifest, rev, vintage, receipts)
            browser.close()
    finally:
        site_server.shutdown()
        repo_server.shutdown()

    receipt = {
        "schema": "cityscroll.board_district_project_capture.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "revision": rev,
        "data_vintage": vintage,
        "counts": manifest["counts"],
        "min_target_px": MIN_TARGET_PX,
        "captures": receipts,
        "axe_all_pass": all(entry.get("axe", {}).get("passes", True) for entry in receipts),
    }
    path = OUT / "capture-manifest.json"
    path.write_text(f"{json.dumps(receipt, indent=2)}\n")
    print(f"wrote {path.relative_to(ROOT)} ({len(receipts)} captures, "
          f"axe_all_pass={receipt['axe_all_pass']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
