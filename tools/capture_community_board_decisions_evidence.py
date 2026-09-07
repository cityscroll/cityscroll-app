#!/usr/bin/env python3
"""Headless read-back of published board decisions on the served board pages.

The decisions exist so a reader can see what a board actually decided and which
tally belongs to it, so the evidence has to come from the pages as they are
served, on both viewports, with scripting on and off, and along the journey the
section exists for: inspect the exact words, open the published document, press
the browser's own Back, and find the expansion and the scroll position where
they were left.

The section holds its passage and its excluded tallies behind fragments rather
than `<details>` elements precisely so that journey works, so the walk is the
point of the capture rather than a nicety. Two degraded loads are read back as
well: scripting disabled, and the stylesheet blocked, because a reader on a
failed load must still get the decision and the source rather than a control
that no longer opens.

The translated renders are read from the module that produces them, since the
board documents are built in English; every shipping language is checked for
resolved copy, declared direction, and publisher text that stayed in its own
language.

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

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".artifacts" / "community-board-decisions"
SITE = ROOT / "_site"
EVIDENCE = ROOT / "docs" / "evidence" / "community-board-decisions"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]
SECTION = '[data-community-board-decisions]'
ROUTES = [
    ("manhattan-cb-03", "/community-boards/manhattan-cb-03/"),
    ("brooklyn-cb-15", "/community-boards/brooklyn-cb-15/"),
]
CONTROL_ROUTE = ("queens-cb-01", "/community-boards/queens-cb-01/")


def serve(directory: Path):
    class Handler(SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def log_message(self, format, *args):  # noqa: A003
            return

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


def render_sha256(page) -> str:
    """Bind the manifest to the rendered section, not just to an image file."""
    text = page.evaluate(
        "(sel) => { const el = document.querySelector(sel); return el ? el.outerHTML : ''; }", SECTION)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


IN_SECTION = """(args) => {
  const section = document.querySelector(args.sel);
  if (!section) return false;
  return args.targets.some((target) => {
    const selector = Array.isArray(target) ? target[target.length - 1] : target;
    let node = null;
    try { node = document.querySelector(selector); } catch { return false; }
    return Boolean(node && section.contains(node));
  });
}"""


def run_axe(page) -> dict:
    """Whole-page axe, gated on the violations this section is responsible for.

    The board pages carry one violation that predates this section and appears
    on boards outside the pilot too -- a definition list on the money card. It
    stays in the receipt, named and attributed, rather than being filtered out
    of sight or silently adopted as this change's failure.
    """
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22 = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22)
    rows = []
    for violation in gate:
        targets = [node.get("target") for node in violation.get("nodes", [])]
        inside = page.evaluate(IN_SECTION, {"sel": SECTION, "targets": targets})
        rows.append({
            "id": violation["id"],
            "impact": violation.get("impact"),
            "in_decisions_section": bool(inside),
            "nodes": [node.get("html", "")[:160] for node in violation.get("nodes", [])][:3],
        })
    owned = [row for row in rows if row["in_decisions_section"]]
    return {
        "failing_violations": rows,
        "owned_by_this_section": owned,
        "passes": len(owned) == 0,
    }


OBSERVE = """(sel) => {
  const section = document.querySelector(sel);
  if (!section) return {section_present: false};
  const decisions = [...section.querySelectorAll('.board-decision')];
  return {
    section_present: true,
    decision_count: Number(section.getAttribute('data-community-board-decisions')),
    decisions: decisions.map((row) => ({
      id: row.getAttribute('data-board-decision'),
      position: row.getAttribute('data-decision-position'),
      votes: [...row.querySelectorAll('.board-decision-vote')].map((vote) => ({
        stage: vote.getAttribute('data-vote-stage'),
        ownership: vote.getAttribute('data-vote-ownership'),
        text: vote.textContent.trim(),
      })),
      excluded: [...row.querySelectorAll('.board-decision-excluded-vote')].map((vote) => ({
        reason: vote.getAttribute('data-exclusion-reason'),
        text: vote.textContent.trim(),
      })),
      quotes: [...row.querySelectorAll('blockquote.board-decision-quote')]
        .map((quote) => quote.textContent.trim()),
      source_href: row.querySelector('.board-decision-source-link')
        ? row.querySelector('.board-decision-source-link').getAttribute('href') : null,
    })),
    controls: [...section.querySelectorAll('.board-decision-more, .board-decision-less')].map((el) => ({
      tag: el.tagName,
      href: el.getAttribute('href'),
      target: el.getAttribute('target'),
    })),
    details_elements: section.querySelectorAll('details').length,
    buttons: section.querySelectorAll('button').length,
    horizontal_overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
}"""

KEYBOARD_PROBE = """(sel) => {
  const section = document.querySelector(sel);
  if (!section) return {count: 0, reachable: 0, native: true, new_tab: 0, smallest_target_css_px: null};
  const links = [...section.querySelectorAll('a[href]')].filter((a) => a.offsetParent !== null);
  let reachable = 0;
  let smallest = null;
  for (const link of links) {
    link.focus();
    if (document.activeElement === link) reachable += 1;
    const box = link.getBoundingClientRect();
    const size = Math.min(box.width, box.height);
    if (smallest === null || size < smallest) smallest = Math.round(size);
  }
  return {
    count: links.length,
    reachable,
    native: links.every((a) => a.tagName === 'A' && (a.getAttribute('href') || '').length > 0),
    new_tab: links.filter((a) => a.hasAttribute('target')).length,
    smallest_target_css_px: smallest,
  };
}"""

READING_POSITION = """() => ({
  fragment: location.hash,
  scroll: Math.round(window.scrollY),
  open_fragment_targets: [...document.querySelectorAll('.board-decision-passage, .board-decision-excluded')]
    .filter((el) => el.id && location.hash === '#' + el.id).map((el) => el.id),
  passage_body_visible: [...document.querySelectorAll('.board-decision-passage-body')]
    .filter((el) => el.getBoundingClientRect().height > 0).length,
  excluded_body_visible: [...document.querySelectorAll('.board-decision-excluded-body')]
    .filter((el) => el.getBoundingClientRect().height > 0).length,
})"""


def observe(page, viewport, route, rev, vintage, name, assertion, scripting, styled, receipts,
            *, axe=None, extra=None):
    shot = OUT / f"{name}-{viewport[0]}x{viewport[1]}.png"
    page.screenshot(path=str(shot), full_page=True)
    receipts.append({
        "name": name,
        "route": route,
        "viewport": list(viewport),
        "revision": rev,
        "data_vintage": vintage,
        "scripting": scripting,
        "stylesheet": styled,
        "assertion": assertion,
        "observed": page.evaluate(OBSERVE, SECTION),
        **({"keyboard": page.evaluate(KEYBOARD_PROBE, SECTION)} if scripting else {}),
        **({"axe": axe} if axe else {}),
        **(extra or {}),
        "image": shot.name,
        "image_sha256": sha256_of(shot),
        "render_content_sha256": render_sha256(page),
    })


def walk_the_journey(browser, base, board, route, rev, vintage, receipts):
    """Inspect, open the published document, come back, and continue reading."""
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector(SECTION, timeout=60_000)
    page.evaluate("() => window.scrollTo(0, document.body.scrollHeight / 3)")
    before_scroll = page.evaluate("() => Math.round(window.scrollY)")

    # Inspect the exact words, from the keyboard, through a same-page fragment.
    page.focus(".board-decision-passage > .board-decision-more")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    opened_passage = page.evaluate(READING_POSITION)

    # Escape leaves the reader where they are rather than losing the page.
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    after_escape = page.evaluate(READING_POSITION)

    # Open the full record, then use the browser's own Back.
    source_href = page.get_attribute(".board-decision-source-link", "href")
    page.goto(f"{base}/", wait_until="domcontentloaded", timeout=60_000)
    page.go_back(wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector(SECTION, timeout=60_000)
    page.wait_for_timeout(300)
    returned = page.evaluate(READING_POSITION)

    # Dismiss: the close control returns to the decision without navigating away.
    page.click(".board-decision-passage > .board-decision-less")
    page.wait_for_timeout(200)
    dismissed = page.evaluate(READING_POSITION)

    # The second inspection: the tallies that are not this decision.
    excluded_control = page.locator(".board-decision-excluded > .board-decision-more")
    opened_excluded = None
    if excluded_control.count():
        excluded_control.first.click()
        page.wait_for_timeout(200)
        opened_excluded = page.evaluate(READING_POSITION)

    observe(page, (390, 844), route, rev, vintage, f"{board}-journey",
            ("Inspect the passage from the keyboard, press Escape, leave for another page, press "
             "the browser's own Back, and the expansion and reading position return; dismissing "
             "closes the passage without leaving the decision; the excluded tallies inspect the "
             "same way."),
            True, "loaded", receipts,
            axe=run_axe(page),
            extra={"journey": {
                "scroll_before_inspect": before_scroll,
                "opened_passage": opened_passage,
                "after_escape": after_escape,
                "returned_after_back": returned,
                "after_dismiss": dismissed,
                "opened_excluded": opened_excluded,
                "passage_opened": opened_passage["passage_body_visible"] == 1,
                "expansion_survived_back": (
                    returned["open_fragment_targets"] == opened_passage["open_fragment_targets"]
                    and returned["passage_body_visible"] == opened_passage["passage_body_visible"]
                ),
                "scroll_survived_back": returned["scroll"] == opened_passage["scroll"],
                "escape_kept_the_page": after_escape["fragment"] == opened_passage["fragment"],
                "dismiss_closed_the_passage": dismissed["passage_body_visible"] == 0,
                "dismiss_stayed_on_the_decision": dismissed["fragment"].startswith("#board-decisions"),
                "excluded_inspected": bool(opened_excluded and opened_excluded["excluded_body_visible"] == 1),
                "published_document_href": source_href,
            }})
    page.close()


def translated_renders() -> list[dict]:
    """Every shipping language, read from the module that produces the section."""
    script = ROOT / "tools" / "capture_community_board_decisions_translations.mjs"
    result = subprocess.run(["node", str(script)], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    if not (SITE / "community-boards" / ROUTES[0][0] / "index.html").exists():
        print("run tools/prepare_functional_site.sh first", file=sys.stderr)
        return 1
    pilot = json.loads((ROOT / "site/data/community_board_resolution_pilot.json").read_text())
    rev = revision()
    vintage = pilot["reviewed_on"]
    receipts: list[dict] = []
    server, port = serve(SITE)
    base = f"http://127.0.0.1:{port}"
    try:
        with sync_playwright() as play:
            browser = play.chromium.launch()
            for board, route in ROUTES:
                for viewport in VIEWPORTS:
                    # Scripted, fully loaded.
                    page = browser.new_page(viewport={"width": viewport[0], "height": viewport[1]})
                    page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=60_000)
                    page.wait_for_selector(SECTION, timeout=60_000)
                    observe(page, viewport, route, rev, vintage, f"{board}-loaded",
                            ("The decisions, their owning tallies, the tallies that are not the "
                             "decision and the published document all render; no control opens a "
                             "new tab and the page does not scroll horizontally."),
                            True, "loaded", receipts, axe=run_axe(page))
                    page.close()

                    # No JavaScript at all.
                    context = browser.new_context(java_script_enabled=False,
                                                  viewport={"width": viewport[0], "height": viewport[1]})
                    page = context.new_page()
                    page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=60_000)
                    observe(page, viewport, route, rev, vintage, f"{board}-no-script",
                            ("With JavaScript disabled the decision, every tally, the quoted passage "
                             "and the link to the published document are all present in the served "
                             "document."),
                            False, "loaded", receipts)
                    context.close()

                    # A failed stylesheet load: the reader still gets everything.
                    page = browser.new_page(viewport={"width": viewport[0], "height": viewport[1]})
                    page.route("**/*.css", lambda route_: route_.abort())
                    page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=60_000)
                    page.wait_for_selector(SECTION, timeout=60_000)
                    observe(page, viewport, route, rev, vintage, f"{board}-no-stylesheet",
                            ("With the stylesheet failing to load the passage and the excluded "
                             "tallies render open rather than behind a control that can no longer "
                             "be styled shut."),
                            True, "blocked", receipts, axe=run_axe(page))
                    page.close()

                walk_the_journey(browser, base, board, route, rev, vintage, receipts)

            # A board outside the pilot carries no section at all, rather than an
            # empty one that would read as "this board decided nothing".
            board, route = CONTROL_ROUTE
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.goto(f"{base}{route}", wait_until="domcontentloaded", timeout=60_000)
            observe(page, (1440, 900), route, rev, vintage, f"{board}-outside-the-pilot",
                    "A board outside the reviewed documents renders no decisions section at all.",
                    True, "loaded", receipts)
            page.close()
            browser.close()
    finally:
        server.shutdown()

    manifest = {
        "schema": "cityscroll.community_board_decisions_render_manifest.v1",
        "evidence_class": "isolated-consumer-render",
        "capture_mode": "headless-playwright-loopback-static-render",
        "captured_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "revision": rev,
        "data_vintage": vintage,
        "image_directory": str(OUT.relative_to(ROOT)),
        "image_policy": ("Capture images remain ignored and are not committed. Their SHA-256 values "
                         "bind this textual manifest to the reviewed render."),
        "production_scope": "These captures are isolated render evidence and are not labeled as live.",
        "coverage": pilot["coverage"],
        "captures": receipts,
        "translated_renders": translated_renders(),
    }
    (EVIDENCE / "capture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    failures = [row for row in receipts if row.get("axe") and not row["axe"]["passes"]]
    inherited = sorted({
        violation["id"]
        for row in receipts
        for violation in (row.get("axe") or {}).get("failing_violations", [])
        if not violation["in_decisions_section"]
    })
    print(f"wrote {EVIDENCE / 'capture-manifest.json'} ({len(receipts)} captures, "
          f"{len(failures)} owned axe failures, inherited: {', '.join(inherited) or 'none'})")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
