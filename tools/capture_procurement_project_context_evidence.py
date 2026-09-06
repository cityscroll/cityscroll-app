#!/usr/bin/env python3
"""Headless evidence capture for the wider-project section on procurement detail.

Renders the real production HTML for six named cases -- a matched project context, a
partially matched bundle, a project whose scope the city published blank, a
qualification route, the in-place inspection journey, and a control with no
materialization supplied -- and records, per case and viewport:

  * an accessibility run (axe, WCAG 2.2 AA rules)
  * whether the page overflows horizontally
  * the smallest interactive target in the section
  * whether the section renders at all

plus, for the inspection case, a real browser journey: inspect in place,
dismiss, open the full page, and go Back, checking that the reader's scroll
position, their selected event and the section they were reading all survive; and
a failed-detail-load run proving the pursuit facts and the official link are
left exactly as they were.

Follows tools/capture_procurement_related_context_evidence.py: screenshot
binaries are NOT committed. They are written to an external directory (default:
a `docs-evidence/` sibling of the repository root; override with
CAPTURE_EXTERNAL_OUT) and only the manifest -- route, viewport, revision, data
vintage, the assertion each capture demonstrates, and a sha256 content hash --
is committed under
docs/evidence/procurement-project-context/capture-manifest.json.

Nothing here changes production code; this is evidence tooling only.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_DIR = ROOT / "docs" / "evidence" / "procurement-project-context"
EXTERNAL_OUT = Path(
    os.environ.get("CAPTURE_EXTERNAL_OUT")
    or (ROOT.parent / "docs-evidence" / "procurement-project-context")
)
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

MATERIALIZATION = json.loads((ROOT / "site" / "data" / "procurement_project_context.json").read_text())
DATA_VINTAGE = (
    "Committed project-context materialization: "
    f"{MATERIALIZATION['source_scope']['solicitations']['rows']} published procurement notices through "
    f"{MATERIALIZATION['source_scope']['solicitations']['extract_date']}, joined to the "
    f"{MATERIALIZATION['source_scope']['capital_projects']['reporting_period']} capital project reporting period"
)

# The narrow phone width and the desktop width this repository captures at,
# plus the reflow width a reader gets when they zoom the desktop view to 200%.
VIEWPORTS = [
    (390, 844, "narrow phone"),
    (1440, 900, "desktop"),
    (720, 450, "desktop at 200% zoom"),
]

# WCAG 2.5.8 minimum target size.
MIN_TARGET_PX = 24

CASES = [
    (
        "project-context-matched",
        "A matched construction solicitation whose notice names one published project code.",
        "The section states the wider project's published scope, sponsor, phase, project budget, recorded "
        "project spending and project forecast completion beside the existing pursuit facts, attributes them "
        "to the whole project rather than the advertised package, and keeps the official City Record notice "
        "reachable.",
    ),
    (
        "project-context-partial-component",
        "A bundled solicitation naming two components, only one of which the city publishes as a project code.",
        "Only the resolved component's project renders; the unjoined component is named as not covered, and "
        "no schedule number is shown for a project that publishes none.",
    ),
    (
        "project-context-blank-scope",
        "A matched project whose published description column is the publisher's blank marker.",
        "No scope paragraph and no empty row render; the published facts that do exist are unaffected, and "
        "the blank marker never reaches a reader.",
    ),
    (
        "project-context-qualification-route",
        "A matched notice whose structured identifier is a qualification-list route.",
        "The section says the published date belongs to a qualified vendor list rather than a construction bid "
        "deadline.",
    ),
    (
        "project-context-in-place-inspection",
        "The matched project context on a page whose opportunity month carries enough dated milestones to paint a "
        "calendar (the extra milestone dates are constructed by the fixture, not published).",
        "The in-place inspection control sits beside the canonical anchor rather than replacing it, and the "
        "section is reachable without leaving the page.",
    ),
    (
        "project-context-absent",
        "The same solicitation rendered with no materialization supplied.",
        "No section, no heading and no empty panel render; the page keeps its existing sections and its "
        "official record link.",
    ),
]

TARGET_SELECTOR = (
    ".project-context a, .project-context button, .project-context summary, "
    ".compact-month-occ-preview, .compact-month-occ-link"
)


class SiteHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def render_fixtures() -> dict:
    result = subprocess.run(
        ["node", str(ROOT / "tools" / "render_procurement_project_context_capture_fixtures.mjs")],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def fulfill_html(html: str):
    def handler(route):
        route.fulfill(status=200, content_type="text/html", body=html)
    return handler


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


def measure_layout(page) -> dict:
    return page.evaluate(
        """(selector) => {
          const doc = document.documentElement;
          const targets = [...document.querySelectorAll(selector)]
            .map((node) => node.getBoundingClientRect())
            .filter((rect) => rect.width > 0 && rect.height > 0);
          const smallest = targets.reduce(
            (acc, rect) => Math.min(acc, Math.min(rect.width, rect.height)),
            Number.POSITIVE_INFINITY,
          );
          const section = document.querySelector('[data-project-context="1"]');
          return {
            document_scroll_width: doc.scrollWidth,
            document_client_width: doc.clientWidth,
            horizontal_overflow: doc.scrollWidth > doc.clientWidth + 1,
            interactive_targets: targets.length,
            smallest_target_px: Number.isFinite(smallest) ? Math.round(smallest * 10) / 10 : null,
            renders_project_context: Boolean(section),
            section_overflows: section ? section.scrollWidth > section.clientWidth + 1 : false,
          };
        }""",
        TARGET_SELECTOR,
    )


def focus_order(page) -> list[str]:
    """Tab through the page and record where focus lands inside the section."""
    page.evaluate("() => document.body.focus()")
    seen = []
    for _ in range(60):
        page.keyboard.press("Tab")
        info = page.evaluate(
            """() => {
              const el = document.activeElement;
              if (!el || el === document.body) return null;
              const inBrief = Boolean(el.closest('[data-project-context="1"]'));
              const style = getComputedStyle(el);
              return {
                inBrief,
                tag: el.tagName.toLowerCase(),
                label: (el.textContent || '').trim().slice(0, 40),
                outline: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
              };
            }"""
        )
        if info and info["inBrief"]:
            seen.append(f"{info['tag']}:{info['label']}:{'focus-visible' if info['outline'] else 'no-indicator'}")
    return seen


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# The canonical destination is a production URL. Captures route it to the
# repository's neutral harness page so the journey exercises a real navigation
# and a real browser Back without reaching the public internet.
DESTINATION = (ROOT / "test" / "harness" / "destination.html").read_text()


def route_destination(page) -> None:
    page.route(
        "https://cityscroll.org/**",
        lambda route: route.fulfill(status=200, content_type="text/html", body=DESTINATION),
    )


def visible_preview_button(page):
    return page.locator(".compact-month-occ-preview").locator("visible=true").first


def wait_for_dialog_closed(page) -> None:
    page.wait_for_function("() => !document.getElementById('calendar-event-preview')?.open", timeout=5000)


def inspection_journey(page, base: str, route: str) -> dict:
    """Inspect in place, dismiss, open the full page, and come back."""
    route_destination(page)
    page.goto(f"{base}{route}", wait_until="networkidle", timeout=20000)
    context_before = page.inner_text('[data-project-context="1"]')

    button = visible_preview_button(page)
    selected_uid = button.get_attribute("data-calendar-event-preview-uid")
    # Scroll the reader to the event they are about to inspect, and read the
    # position back afterwards: activating a control scrolls it into view on its
    # own, so a position captured before that is not the position under test.
    button.scroll_into_view_if_needed()
    scrolled = page.evaluate("() => Math.round(window.scrollY)")
    event_title = button.get_attribute("aria-label").replace("Preview: ", "", 1)
    button.click()
    page.wait_for_selector("#calendar-event-preview[open]", timeout=5000)
    dialog_text = page.inner_text("#calendar-event-preview")
    page_scroll_after_open = page.evaluate("() => Math.round(window.scrollY)")
    open_href = page.get_attribute("[data-calendar-event-preview-open]", "href")

    page.keyboard.press("Escape")
    wait_for_dialog_closed(page)
    after_dismiss = page.evaluate("() => Math.round(window.scrollY)")

    page.goto(open_href, wait_until="domcontentloaded", timeout=20000)
    left_for = page.url
    page.go_back(wait_until="networkidle", timeout=20000)
    back_scroll = page.evaluate("() => Math.round(window.scrollY)")
    context_after = page.inner_text('[data-project-context="1"]')

    return {
        "scrolled_to": scrolled,
        "inspection_opened_in_place": "Wider project:" in dialog_text,
        "event_facts_preserved_in_dialog": event_title in dialog_text,
        "scroll_preserved_while_open": page_scroll_after_open == scrolled,
        "full_page_link": open_href,
        "scroll_preserved_on_dismiss": after_dismiss == scrolled,
        "left_for": left_for,
        "scroll_restored_on_back": back_scroll == scrolled,
        "project_context_preserved": context_after == context_before,
        "selected_event_preserved": page.locator(
            f'[data-calendar-event-preview-uid="{selected_uid}"]'
        ).count() > 0,
    }


def failed_detail_journey(page, base: str, route: str, html: str) -> dict:
    """The same page with the inlined detail block corrupted."""
    broken = html.replace(
        '<script type="application/json" data-project-context-inspect="1">',
        '<script type="application/json" data-project-context-inspect="1">{ not json ',
        1,
    )
    route_destination(page)
    page.route(f"{base}{route}", fulfill_html(broken))
    page.goto(f"{base}{route}", wait_until="networkidle", timeout=20000)
    visible_preview_button(page).click()
    page.wait_for_selector("#calendar-event-preview[open]", timeout=5000)
    dialog_text = page.inner_text("#calendar-event-preview")
    return {
        "inspection_stays_open": True,
        "recovery_stated": "did not load" in dialog_text,
        "no_half_built_context": "Wider project:" not in dialog_text,
        "full_page_link_works": bool(page.get_attribute("[data-calendar-event-preview-open]", "href")),
        "official_notice_on_page": page.locator('a[href*="a856-cityrecord.nyc.gov"]').count() > 0,
    }


def main() -> int:
    EXTERNAL_OUT.mkdir(parents=True, exist_ok=True)
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    fixtures = render_fixtures()

    server = ThreadingHTTPServer(("127.0.0.1", 0), SiteHandler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    entries = []
    journeys = []
    with sync_playwright() as p:
        browser = p.chromium.launch()

        for label, data_vintage, assertion in CASES:
            html = fixtures[label]
            route_path = f"/_capture/{label}"
            for width, height, note in VIEWPORTS:
                context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
                page = context.new_page()
                page.route("https://fonts.googleapis.com/**", lambda r: r.abort())
                page.route("https://fonts.gstatic.com/**", lambda r: r.abort())
                page.route(f"{base}{route_path}", fulfill_html(html))
                page.goto(f"{base}{route_path}", wait_until="networkidle", timeout=20000)
                layout = measure_layout(page)
                axe_result = run_axe(page)
                focus = focus_order(page)
                filename = f"{label}-{width}x{height}.png"
                shot = EXTERNAL_OUT / filename
                page.screenshot(path=str(shot), full_page=True)
                entries.append({
                    "case": label,
                    "surface": "procurement-detail",
                    "route": route_path,
                    "viewport": {"width": width, "height": height, "note": note},
                    "revision": revision,
                    "data_vintage": f"{DATA_VINTAGE}. {data_vintage}",
                    "assertion": assertion,
                    "renders_project_context": layout["renders_project_context"],
                    "layout": {
                        "horizontal_overflow": layout["horizontal_overflow"],
                        "section_overflows": layout["section_overflows"],
                        "document_scroll_width": layout["document_scroll_width"],
                        "document_client_width": layout["document_client_width"],
                        "interactive_targets": layout["interactive_targets"],
                        "smallest_target_px": layout["smallest_target_px"],
                        "meets_minimum_target_size": (
                            layout["smallest_target_px"] is None
                            or layout["smallest_target_px"] >= MIN_TARGET_PX
                        ),
                    },
                    "keyboard_focus_order": focus,
                    "external_filename": filename,
                    "sha256": sha256_of(shot),
                    "bytes": shot.stat().st_size,
                    "axe": axe_result,
                })
                page.close()
                context.close()

        journey_label = "project-context-in-place-inspection"
        journey_html = fixtures[journey_label]
        journey_route = f"/_capture/{journey_label}"
        for width, height, note in ((390, 844, "narrow phone"), (1440, 900, "desktop")):
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()
            page.route(f"{base}{journey_route}", fulfill_html(journey_html))
            journeys.append({
                "journey": "inspect, dismiss, open full page, Back",
                "route": journey_route,
                "viewport": {"width": width, "height": height, "note": note},
                "revision": revision,
                "result": inspection_journey(page, base, journey_route),
            })
            page.close()
            context.close()

            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()
            journeys.append({
                "journey": "requested detail fails to load",
                "route": journey_route,
                "viewport": {"width": width, "height": height, "note": note},
                "revision": revision,
                "result": failed_detail_journey(page, base, journey_route, journey_html),
            })
            page.close()
            context.close()

        browser.close()

    server.shutdown()

    manifest = {
        "schema": "cityscroll.procurement_project_context_capture_manifest.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revision": revision,
        "note": (
            "Wider-project context on procurement detail. Screenshot binaries are not committed to this "
            "repository; they are written to an external directory (default a docs-evidence/ sibling of the "
            "repository root, override with CAPTURE_EXTERNAL_OUT) named by 'external_filename' below, and "
            "this manifest is the reproducible, reviewable record of what each capture shows and why."
        ),
        "external_output_directory_note": (
            "Not committed; see external_filename per capture. Re-run this script to regenerate "
            "byte-identical captures (same sha256) at this revision."
        ),
        "minimum_target_size_px": MIN_TARGET_PX,
        "captures": entries,
        "journeys": journeys,
    }
    (MANIFEST_DIR / "capture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(entries)} manifest entries and {len(journeys)} journeys")
    print(f"wrote {len(entries)} PNGs to {EXTERNAL_OUT} (not committed)")
    failures = [e for e in entries if not e["axe"]["passes"] or e["layout"]["horizontal_overflow"]]
    if failures:
        for entry in failures:
            print(f"FAIL {entry['case']} {entry['viewport']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
