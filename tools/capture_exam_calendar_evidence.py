#!/usr/bin/env python3
"""Headless evidence capture for exam application-bundle calendars (CBICS-08).

Renders the committed fixtures in test/fixtures/exam_calendar_fixtures.mjs
into real exam documents (via tools/render_exam_calendar_fixtures.mjs, into a
gitignored staging directory), serves them next to the real site stylesheets,
and for each case x viewport records a screenshot, runs the vendored axe-core
accessibility gate (the same rule set and pass/fail classification as
test/functional/11_accessibility.py), and asserts the contract the unit suite
pins: the qualifying three-date bundle renders the shared month component
below the official actions and above the process spine, and the ordinary
two-date, rolling-filing, and predicted-exclusion cases render no calendar at
all while keeping their compact application range.

The receipt names the route, viewport, git revision, fixture date/source
state, and the assertion for every capture. Capture routes are test-only
(`/__capture__/...`); no public route is created.
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
STAGING = ROOT / ".artifacts" / "exam-calendar-capture"
OUT = ROOT / "docs" / "screenshots" / "exam-application-calendar"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

VIEWPORTS = [(390, 844), (1440, 900)]
CAPTURE_PREFIX = "/__capture__/exam-calendar/"
TIMEZONE = "America/New_York"


class Handler(SimpleHTTPRequestHandler):
    """Serve the real site tree, with staged fixture documents mounted under
    the test-only capture prefix."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

    def translate_path(self, path):
        if path.startswith(CAPTURE_PREFIX):
            return str(STAGING / path[len(CAPTURE_PREFIX):])
        return super().translate_path(path)

    def log_message(self, format, *args):  # noqa: A003
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def stage_fixtures() -> dict:
    subprocess.run(
        ["node", "tools/render_exam_calendar_fixtures.mjs", "--out", str(STAGING)],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return json.loads((STAGING / "manifest.json").read_text())


def run_axe(page) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    gate = failing_violations(result["violations"], wcag22_rules)
    return {
        "violations_total": len(result["violations"]),
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in gate],
        "passes": len(gate) == 0,
    }


def page_observations(page) -> dict:
    return page.evaluate(
        """() => {
          const grid = document.querySelector('.compact-month-grid');
          const calendar = document.getElementById('exam-calendar-heading');
          const process = document.getElementById('exam-process-heading');
          const apply = document.querySelector('[data-exam-action="apply"]');
          const notice = document.querySelector('[data-exam-action="source"]');
          const before = (a, b) => Boolean(a && b)
            && Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
          const statusRow = document.querySelector('.exam-status-row');
          const shown = (el) => Boolean(el)
            && getComputedStyle(el).display !== 'none'
            && getComputedStyle(el).visibility !== 'hidden';
          const agenda = document.querySelector('.compact-month-agenda');
          return {
            gridPresent: Boolean(grid),
            gridVisible: shown(grid),
            agendaVisible: shown(agenda),
            noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
            calendarSectionPresent: Boolean(calendar),
            compactRangeKept: Boolean(statusRow && statusRow.textContent.includes('Application window:')),
            applyBeforeCalendar: before(apply, calendar),
            noticeBeforeCalendar: before(notice, calendar),
            calendarBeforeProcess: before(calendar, process),
            fullProcessLink: Boolean(document.querySelector('.compact-month-full-list a[href="#exam-process-heading"]')),
          };
        }"""
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = stage_fixtures()
    today = manifest["today"]
    revision = git_revision()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    failures = []
    captures = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for case in manifest["cases"]:
            for width, height in VIEWPORTS:
                context = browser.new_context(
                    viewport={"width": width, "height": height}, timezone_id=TIMEZONE,
                )
                page = context.new_page()
                page.goto(f"{base}{case['route']}", wait_until="load")
                page.wait_for_selector("[data-document-rendered='true']", state="attached")
                observed = page_observations(page)
                expected = case["expected"]

                checks = {
                    "render_matches_contract": observed["gridPresent"] == expected["render"]
                    and observed["calendarSectionPresent"] == expected["render"],
                    "compact_range_kept": observed["compactRangeKept"],
                    "no_horizontal_overflow": observed["noHorizontalOverflow"],
                }
                if expected["render"]:
                    checks["reader_hierarchy"] = (
                        observed["applyBeforeCalendar"]
                        and observed["noticeBeforeCalendar"]
                        and observed["calendarBeforeProcess"]
                        and observed["fullProcessLink"]
                    )
                    # The shared component's CSS-only reading switch (640px):
                    # the grid shows at desktop width, the agenda list at
                    # narrow width.
                    checks["viewport_reading_form"] = (
                        observed["gridVisible"] if width > 640 else observed["agendaVisible"]
                    )

                shot = OUT / f"{case['case']}-{width}x{height}.png"
                page.screenshot(path=str(shot), full_page=True)
                axe_result = run_axe(page)
                axe_pass = axe_result["passes"]
                if not all(checks.values()) or not axe_pass:
                    failures.append({"case": case["case"], "viewport": [width, height],
                                     "checks": checks, "axe": axe_result})

                captures.append({
                    "case": case["case"],
                    "route": case["route"],
                    "canonical_path": case["canonical_path"],
                    "viewport": {"width": width, "height": height},
                    "timezone": TIMEZONE,
                    "today": today,
                    "date_state": case["date_state"],
                    "source_state": case["source_state"],
                    "expected": expected,
                    "observed": observed,
                    "screenshot": str(shot.relative_to(ROOT)),
                    "axe": axe_result,
                    "assertion": (
                        f"case={case['case']} at {width}x{height} rendered={observed['gridPresent']} "
                        f"expected_render={expected['render']} reason={expected['reason']} "
                        f"checks={checks} axe_passes={axe_pass}"
                    ),
                })
                context.close()
        browser.close()

    server.shutdown()

    all_axe_pass = all(c["axe"]["passes"] for c in captures)
    receipt = {
        "schema": "cityscroll.exam_calendar_evidence_receipt.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "timezone": TIMEZONE,
        "today": today,
        "all_axe_pass": all_axe_pass,
        "captures": captures,
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"wrote {len(captures)} captures under {OUT}")
    if failures:
        print(f"CAPTURE ASSERTION FAILURES: {json.dumps(failures, indent=2)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
