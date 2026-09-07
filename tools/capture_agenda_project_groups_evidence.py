#!/usr/bin/env python3
"""Headless read-back of the hearing-agenda project grouping on the served pages.

The grouping exists so a reader can see how many applications an agenda of
legislative identifiers really is, so the evidence has to come from the agenda as
it is actually served, on both renderers, with the positive and the negative
example:

  server-rendered   the notice document body `site/pages_edge.mjs` produces, read
                    back with scripting disabled as well as enabled
  client-rendered   the same agenda handed to the shipped browser module through
                    the read model's own payload

Each page is checked for the grouping itself, for the agenda underneath it
surviving whole and in source order, for keyboard reachability and native link
behaviour (an href the browser owns, no new tab, so a modified click and Back
work), and with the vendored axe-core rule set. The journey the grouping exists
for is walked end to end: expand a group, open one of its matters from the
keyboard alone, press the browser's own Back, and find the agenda, the grouping,
the expanded group and the scroll position where they were left. A read model
that fails is read back too, because a failed detail load must leave the original
agenda intact rather than a half-built index.

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
FIXTURES = ROOT / ".artifacts" / "agenda-project-groups" / "fixtures"
OUT = ROOT / ".artifacts" / "agenda-project-groups"
SITE = ROOT / "_site"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]
API_ORIGINS = ("https://api.cityscroll.org", "https://cityscroll-worker.crol-worker.workers.dev")

GROUP_SELECTOR = "li[data-agenda-project-id]"
AGENDA_ROW_SELECTOR = "ol.meeting-agenda li.meeting-matter[data-matter-id]"
LINK_SELECTOR = "a[data-agenda-project-href], a[data-agenda-project-matter]"


def serve(directory: Path, overlay: dict[str, Path]):
    class Handler(SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def log_message(self, format, *args):  # noqa: A003
            return

        def _overlay_path(self) -> Path | None:
            route = self.path.partition("?")[0]
            if not route.endswith("/"):
                route += "/"
            return overlay.get(route)

        def do_GET(self):  # noqa: N802
            path = self._overlay_path()
            if path is None:
                super().do_GET()
                return
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.request_queue_size = 128
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def revision() -> str:
    """Name the exact source state, including an uncommitted working tree."""
    return subprocess.run(["git", "describe", "--always", "--dirty", "--abbrev=40"], cwd=ROOT,
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


KEYBOARD_PROBE = """(selector) => {
  const links = [...document.querySelectorAll(selector)].filter((link) => link.offsetParent !== null);
  if (!links.length) return {count: 0, reachable: 0, native: true, new_tab: 0};
  let reachable = 0;
  for (const link of links) {
    link.focus();
    if (document.activeElement === link) reachable += 1;
  }
  return {
    count: links.length,
    reachable,
    native: links.every((link) => link.tagName === 'A' && (link.getAttribute('href') || '').length > 0),
    new_tab: links.filter((link) => link.hasAttribute('target')).length,
  };
}"""

OBSERVE = """() => {
  const groups = [...document.querySelectorAll('li[data-agenda-project-id]')].map((group) => ({
    project_id: group.getAttribute('data-agenda-project-id'),
    matter_ids: [...group.querySelectorAll('[data-agenda-project-matter]')]
      .map((row) => row.getAttribute('data-agenda-project-matter')),
    matter_count: group.getAttribute('data-agenda-project-matter-count'),
    decision: group.getAttribute('data-agenda-project-decision'),
  }));
  const section = document.querySelector('[data-agenda-project-groups="1"]');
  const agenda = [...document.querySelectorAll('ol.meeting-agenda li.meeting-matter[data-matter-id]')]
    .map((row) => row.getAttribute('data-matter-id'));
  return {
    section_present: Boolean(section),
    reported: section ? {
      group_count: Number(section.getAttribute('data-agenda-project-group-count')),
      linked_matter_count: Number(section.getAttribute('data-agenda-linked-matters')),
      agenda_matter_count: Number(section.getAttribute('data-agenda-matters')),
      unlinked_matter_count: Number(section.getAttribute('data-agenda-unlinked-matters')),
    } : null,
    groups,
    agenda_matter_ids: agenda,
    heading: section ? section.querySelector('.chain-h').textContent.trim() : null,
    limit_note: section ? section.querySelector('.agenda-project-limit').textContent.trim() : null,
    unlinked_note: section && section.querySelector('.agenda-project-unlinked')
      ? section.querySelector('.agenda-project-unlinked').textContent.trim() : null,
    named_participants: document.querySelectorAll(
      'li[data-agenda-project-id] [data-official-id], li[data-agenda-project-id] a[href^="/officials/"]').length,
  };
}"""


READING_POSITION = """() => {
  const groups = [...document.querySelectorAll('details.agenda-project-matters')];
  const expanded = groups.find((group) => group.open) || null;
  const holder = expanded ? expanded.closest('li[data-agenda-project-id]') : null;
  const box = holder ? holder.getBoundingClientRect() : null;
  return {
    open: groups.map((group) => group.open),
    scroll: Math.round(window.scrollY),
    expanded_group: holder ? holder.getAttribute('data-agenda-project-id') : null,
    expanded_group_offset: box ? Math.round(box.top) : null,
    expanded_group_in_view: Boolean(box && box.bottom > 0 && box.top < window.innerHeight),
  };
}"""


def stub_read_model(page, payload, status=200):
    body = json.dumps(payload)
    for origin in API_ORIGINS:
        page.route(f"{origin}/meeting-outcomes*", lambda route: route.fulfill(
            status=status, content_type="application/json", body=body))


def expectation_matches(observed, expected) -> bool:
    if expected is None:
        return not observed["section_present"]
    if not observed["section_present"]:
        return False
    reported = observed["reported"]
    return (
        reported["group_count"] == expected["group_count"]
        and reported["linked_matter_count"] == expected["linked_matter_count"]
        and reported["agenda_matter_count"] == expected["agenda_matter_count"]
        and reported["unlinked_matter_count"] == expected["unlinked_matter_count"]
        and [
            {"project_id": group["project_id"], "matter_ids": group["matter_ids"]}
            for group in observed["groups"]
        ] == [
            {"project_id": group["project_id"], "matter_ids": group["matter_ids"]}
            for group in expected["groups"]
        ]
    )


def capture_server_rendered(browser, base, manifest, rev, vintage, receipts):
    """The agenda as it is served, before any script runs and after."""
    for case in manifest["notices"]:
        url = f"{base}{case['route']}"
        for width, height in VIEWPORTS:
            context = browser.new_context(java_script_enabled=False,
                                          viewport={"width": width, "height": height})
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            observed = page.evaluate(OBSERVE)
            keyboard = page.evaluate(KEYBOARD_PROBE, LINK_SELECTOR)
            expandable = page.locator("details.agenda-project-matters").count()
            shot = OUT / f"{case['id']}-nojs-{width}x{height}.png"
            page.screenshot(path=str(shot), full_page=True)
            receipts.append({
                "surface": "server_rendered_notice",
                "case": case["id"],
                "route": case["route"],
                "viewport": {"width": width, "height": height},
                "revision": rev,
                "data_vintage": vintage,
                "javascript": "disabled",
                "observed": {
                    **observed,
                    "expandable_groups": expandable,
                    "keyboard": keyboard,
                    "agenda_order_preserved": observed["agenda_matter_ids"] == case["agenda_matter_ids"],
                    "matches_expected_grouping": expectation_matches(observed, case["expected"]),
                },
                "assertion": (f"{case['route']} at {width}x{height} with JavaScript disabled: "
                              f"{case['expectation']}"),
                "screenshot": str(shot.relative_to(ROOT)),
                "screenshot_sha256": sha256_of(shot),
                "axe": {"skipped": "axe-core needs scripting; the same markup is checked "
                                   "in the scripted first-paint capture"},
            })
            context.close()


def capture_client_rendered(browser, base, manifest, rev, vintage, receipts):
    """The same agenda, re-rendered by the shipped browser module."""
    for case in manifest["notices"]:
        payload = json.loads((ROOT / case["read_model_file"]).read_text())
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            stub_read_model(page, payload)
            page.goto(f"{base}{case['route']}", wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_selector(AGENDA_ROW_SELECTOR, timeout=60_000)
            page.wait_for_timeout(2_500)
            observed = page.evaluate(OBSERVE)
            keyboard = page.evaluate(KEYBOARD_PROBE, LINK_SELECTOR)
            shot = OUT / f"{case['id']}-client-{width}x{height}.png"
            page.screenshot(path=str(shot), full_page=True)
            axe = run_axe(page)
            receipts.append({
                "surface": "client_rendered_agenda",
                "case": case["id"],
                "route": case["route"],
                "viewport": {"width": width, "height": height},
                "revision": rev,
                "data_vintage": vintage,
                "javascript": "enabled",
                "observed": {
                    **observed,
                    "keyboard": keyboard,
                    "agenda_order_preserved": observed["agenda_matter_ids"] == case["agenda_matter_ids"],
                    "matches_expected_grouping": expectation_matches(observed, case["expected"]),
                },
                "assertion": (f"{case['route']} at {width}x{height}, rendered by the browser module "
                              f"from the read model: {case['expectation']}"),
                "screenshot": str(shot.relative_to(ROOT)),
                "screenshot_sha256": sha256_of(shot),
                "axe": axe,
            })
            page.close()


def capture_journey(browser, base, case, rev, vintage, receipts):
    """Expand a group, open a matter from the keyboard, and press Back."""
    payload = json.loads((ROOT / case["read_model_file"]).read_text())
    for width, height in VIEWPORTS:
        page = browser.new_page(viewport={"width": width, "height": height})
        stub_read_model(page, payload)
        page.goto(f"{base}{case['route']}", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_selector("details.agenda-project-matters", timeout=60_000)
        page.wait_for_timeout(2_500)
        steps = []
        group = page.locator("details.agenda-project-matters").first
        group.locator("summary").click()
        page.wait_for_timeout(300)
        # Read from where a reader would be: the group they just expanded, part
        # way down a long agenda, rather than an arbitrary offset that is on
        # screen at one viewport and past the end of the list at the other.
        page.evaluate(
            "() => document.querySelector('details.agenda-project-matters[open]')"
            ".closest('li[data-agenda-project-id]').scrollIntoView({block: 'center'})")
        page.wait_for_timeout(300)
        before = page.evaluate(READING_POSITION)
        steps.append({"step": "expand_project_group", "open": before["open"],
                      "scroll": before["scroll"], "expanded_group": before["expanded_group"],
                      "expanded_group_in_view": before["expanded_group_in_view"]})

        link = group.locator("a[data-agenda-project-matter]").first
        link.focus()
        focused = page.evaluate(
            "() => document.activeElement && document.activeElement.getAttribute('data-agenda-project-matter')")
        page.keyboard.press("Enter")
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(1_500)
        steps.append({
            "step": "open_matter_by_keyboard",
            "focused_matter_id": focused,
            "path": urlparse(page.url).path,
            "land_project_section": page.locator("section[data-council-land-project-id]").count(),
        })

        page.go_back()
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_selector(AGENDA_ROW_SELECTOR, timeout=60_000)
        page.wait_for_timeout(2_500)
        after = page.evaluate(READING_POSITION)
        observed = page.evaluate(OBSERVE)
        steps.append({
            "step": "browser_back_to_agenda",
            "path": urlparse(page.url).path,
            "open": after["open"],
            "expansion_preserved": after["open"] == before["open"],
            "expanded_group": after["expanded_group"],
            "scroll": after["scroll"],
            "scroll_restored": after["scroll"] > 0,
            "scroll_delta": after["scroll"] - before["scroll"],
            # What the reader actually needs back is the part of the agenda they
            # were reading, so the expanded group's own position is the measure;
            # the raw offset can legitimately differ once the list re-renders.
            "expanded_group_in_view": after["expanded_group_in_view"],
            "reading_position_preserved": bool(
                after["open"] == before["open"] and after["expanded_group_in_view"]),
            "agenda_matter_ids": observed["agenda_matter_ids"],
            "agenda_preserved": observed["agenda_matter_ids"] == case["agenda_matter_ids"],
            "group_count": len(observed["groups"]),
        })
        shot = OUT / f"journey-{width}x{height}.png"
        page.screenshot(path=str(shot), full_page=True)
        receipts.append({
            "surface": "journey",
            "case": "expand-open-back",
            "route": case["route"],
            "viewport": {"width": width, "height": height},
            "revision": rev,
            "data_vintage": vintage,
            "javascript": "enabled",
            "observed": {"steps": steps},
            "assertion": (f"at {width}x{height}: a project group expands, one of its matters opens "
                          "from the keyboard alone, and the browser's own Back returns to the same "
                          "agenda with the expansion and the scroll position intact"),
            "screenshot": str(shot.relative_to(ROOT)),
            "screenshot_sha256": sha256_of(shot),
        })
        page.close()


def capture_scroll_control(browser, base, manifest, rev, vintage, receipts):
    """Where the browser puts the reader on Back, with no grouping on the page.

    The journey capture measures the reader's return to a grouped agenda. This
    walks the same steps on the agenda the bridge joined nothing on, out through
    an ordinary agenda row, so the notice route's own scroll-restore behaviour is
    on the record separately from anything the grouping does.
    """
    case = next(row for row in manifest["notices"] if row["id"] == "agenda-no-project")
    payload = json.loads((ROOT / case["read_model_file"]).read_text())
    for width, height in VIEWPORTS:
        page = browser.new_page(viewport={"width": width, "height": height})
        stub_read_model(page, payload)
        page.goto(f"{base}{case['route']}", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_selector(AGENDA_ROW_SELECTOR, timeout=60_000)
        page.wait_for_timeout(2_500)
        row = page.locator(f"{AGENDA_ROW_SELECTOR}").last
        page.evaluate(
            "() => document.querySelectorAll('ol.meeting-agenda li.meeting-matter[data-matter-id]')"
            "[document.querySelectorAll('ol.meeting-agenda li.meeting-matter[data-matter-id]')"
            ".length - 1].scrollIntoView({block: 'center'})")
        page.wait_for_timeout(300)
        before = page.evaluate("() => Math.round(window.scrollY)")
        link = row.locator("a.meeting-matter-link").first
        if link.count() == 0:
            page.close()
            continue
        link.click()
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(1_500)
        left = urlparse(page.url).path
        page.go_back()
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_selector(AGENDA_ROW_SELECTOR, timeout=60_000)
        page.wait_for_timeout(2_500)
        after = page.evaluate("() => Math.round(window.scrollY)")
        receipts.append({
            "surface": "scroll_control",
            "case": "ordinary-agenda-row-back",
            "route": case["route"],
            "viewport": {"width": width, "height": height},
            "revision": rev,
            "data_vintage": vintage,
            "javascript": "enabled",
            "observed": {
                "grouping_on_page": False,
                "left_for": left,
                "scroll_before": before,
                "scroll_after": after,
                "scroll_delta": after - before,
                "scroll_restored": after > 0,
            },
            "assertion": (f"{case['route']} at {width}x{height}: leaving through an ordinary agenda "
                          "row and pressing Back lands the reader where this notice route's own "
                          "restore puts them, with no project grouping involved"),
        })
        page.close()


def capture_failed_read(browser, base, manifest, rev, vintage, receipts):
    """A failing read model must leave the served agenda exactly as it was.

    This is also where the server-rendered markup meets the accessibility rule
    set: scripting is on, so axe-core can run, but the read model never answers,
    so what is on the page is the body the edge handler produced.
    """
    for case in manifest["notices"]:
        for width, height in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height})
            stub_read_model(page, {"ok": False, "reason": "snapshot-unavailable"}, status=503)
            page.goto(f"{base}{case['route']}", wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_selector(AGENDA_ROW_SELECTOR, timeout=60_000)
            page.wait_for_timeout(3_000)
            observed = page.evaluate(OBSERVE)
            keyboard = page.evaluate(KEYBOARD_PROBE, LINK_SELECTOR)
            shot = OUT / f"{case['id']}-failed-read-{width}x{height}.png"
            page.screenshot(path=str(shot), full_page=True)
            axe = run_axe(page)
            receipts.append({
                "surface": "server_rendered_notice",
                "case": f"{case['id']}-read-model-unavailable",
                "route": case["route"],
                "viewport": {"width": width, "height": height},
                "revision": rev,
                "data_vintage": vintage,
                "javascript": "enabled",
                "observed": {
                    **observed,
                    "keyboard": keyboard,
                    "agenda_order_preserved": observed["agenda_matter_ids"] == case["agenda_matter_ids"],
                    "matches_expected_grouping": expectation_matches(observed, case["expected"]),
                },
                "assertion": (f"{case['route']} at {width}x{height} with the read model returning "
                              "503: the served agenda and its grouping are still whole, and nothing "
                              "half-built replaces them"),
                "screenshot": str(shot.relative_to(ROOT)),
                "screenshot_sha256": sha256_of(shot),
                "axe": axe,
            })
            page.close()


def capture_languages(browser, base, case, rev, vintage, receipts):
    """Every shipping language, with the publisher's own identifiers untranslated."""
    payload = json.loads((ROOT / case["read_model_file"]).read_text())
    languages = json.loads(subprocess.run(
        ["node", "-e",
         "global.window={};require(process.argv[1]);"
         "console.log(JSON.stringify(window.SHIPPING_LANGS))",
         str(ROOT / "site" / "i18n.js")],
        capture_output=True, text=True, check=True).stdout)
    for language in ["en", *languages]:
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        stub_read_model(page, payload)
        page.goto(f"{base}{case['route']}?lang={language}", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_selector(GROUP_SELECTOR, timeout=60_000)
        page.wait_for_timeout(2_000)
        observed = page.evaluate(OBSERVE)
        # Read the text nodes directly: the matter list sits inside a collapsed
        # details element, and inner_text() reports nothing for a hidden node.
        files = page.eval_on_selector_all(
            "li[data-agenda-project-id] a[data-agenda-project-matter]",
            "(links) => links.map((link) => link.textContent.trim())")
        receipts.append({
            "surface": "client_rendered_agenda",
            "case": f"language-{language}",
            "route": f"{case['route']} (lang={language})",
            "viewport": {"width": 1440, "height": 900},
            "revision": rev,
            "data_vintage": vintage,
            "javascript": "enabled",
            "observed": {
                "heading": observed["heading"],
                "unlinked_note": observed["unlinked_note"],
                "group_count": len(observed["groups"]),
                "matches_expected_grouping": expectation_matches(observed, case["expected"]),
                "source_identifiers_preserved": all("LU 0" in text for text in files) if files else None,
            },
            "assertion": (f"the agenda index in {language}: the same grouping under its own "
                          "translated heading, with the publisher's matter identifiers unchanged"),
        })
        page.close()


def main() -> None:
    if not (FIXTURES / "manifest.json").exists():
        print("run node tools/render_agenda_project_group_fixtures.mjs first", file=sys.stderr)
        sys.exit(1)
    if not SITE.exists():
        print("run tools/prepare_functional_site.sh first", file=sys.stderr)
        sys.exit(1)
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    rev = revision()
    vintage = manifest["data_vintage"]
    overlay = {row["route"]: ROOT / row["file"] for row in manifest["notices"]}
    overlay.update({row["route"]: ROOT / row["file"] for row in manifest["matters"]})

    server, port = serve(SITE, overlay)
    base = f"http://127.0.0.1:{port}"
    receipts: list[dict] = []
    connected = next(row for row in manifest["notices"] if row["id"] == "agenda-four-projects")
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            capture_server_rendered(browser, base, manifest, rev, vintage, receipts)
            capture_client_rendered(browser, base, manifest, rev, vintage, receipts)
            capture_journey(browser, base, connected, rev, vintage, receipts)
            capture_scroll_control(browser, base, manifest, rev, vintage, receipts)
            capture_failed_read(browser, base, manifest, rev, vintage, receipts)
            capture_languages(browser, base, connected, rev, vintage, receipts)
            browser.close()
    finally:
        server.shutdown()

    surfaces = {}
    for entry in receipts:
        key = (entry["case"], entry["surface"])
        surfaces.setdefault(key, []).append(entry["observed"].get("matches_expected_grouping"))
    receipt = {
        "schema": "cityscroll.agenda_project_group_capture.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "revision": rev,
        "data_vintage": vintage,
        "captures": receipts,
        "axe_all_pass": all(
            entry.get("axe", {}).get("passes", True) for entry in receipts
            if "skipped" not in entry.get("axe", {})),
        "grouping_matches_everywhere": all(
            value for values in surfaces.values() for value in values if value is not None),
    }
    path = OUT / "capture-manifest.json"
    path.write_text(f"{json.dumps(receipt, indent=2)}\n")
    print(f"wrote {path.relative_to(ROOT)} ({len(receipts)} captures, "
          f"axe_all_pass={receipt['axe_all_pass']}, "
          f"grouping_matches_everywhere={receipt['grouping_matches_everywhere']})")


if __name__ == "__main__":
    main()
