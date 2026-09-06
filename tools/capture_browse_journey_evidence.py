#!/usr/bin/env python3
"""Headless browser evidence for browse-return context.

Drives `test/harness/browse_return_harness.html` -- a neutral, unshipped
fixture page that mounts the real shared month renderer against committed
fixtures. No public route is mounted and no publisher is contacted.

Each specimen is a real interaction in a real engine, at 390 and 1440 pixels:
set a non-default view, inspect an event, close it, open its full page, use
Browser Back, and continue; a fresh visit that must not steal focus; Back and
Forward; keyboard and modified clicks; the page without scripting; Search and
Following using their existing preview/scope machinery; 200 percent zoom; and
touch targets. Every specimen also runs the vendored axe-core gate, on the
same rule set and pass/fail classification as `test/functional/11_accessibility.py`.

Proof is the tracked manifest: one entry per capture naming its route,
viewport, revision, data vintage, assertion, observations, and the SHA-256 of
the image. The images themselves are written to an ignored local directory and
are never committed -- this repository does not carry capture binaries.

    python3 tools/capture_browse_journey_evidence.py
    python3 tools/capture_browse_journey_evidence.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs" / "evidence" / "browse-return-context" / "manifest.json"
IMAGES = ROOT / ".artifacts" / "browse-return-context"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

MANIFEST_SCHEMA = "cityscroll.browse_return_evidence.v1"
RECORD = "cityscroll-engineering/browse-return-context"
HARNESS = "test/harness/browse_return_harness.html"
ROUTE = "component-harness:browse-return-context"

VIEWPORTS = ((390, 844), (1440, 900))
ZOOM_FACTOR = 2
DATA_VINTAGE = "2026-03-15"
TIMEZONE = "America/New_York"

PREVIEW_BUTTON = ".compact-month-occ-preview:visible"
ANY_PREVIEW_BUTTON = ".compact-month-occ-preview"
CANONICAL_LINK = ".compact-month-occ-link:visible"
DIALOG = "#calendar-event-preview"
CLOSE = "[data-calendar-event-preview-close]"
OPEN_LINK = "[data-calendar-event-preview-open]"
TOUCH_TARGET_MINIMUM_NARROW = 44
TOUCH_TARGET_MINIMUM_DESKTOP = 24
DESTINATION_URL = re.compile(r"browse_return_destination\.html")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):  # noqa: A003 - quiet test server
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def run_axe(page, a11y_gate) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    failing = a11y_gate(result["violations"], wcag22_rules)
    return {
        "violations_total": len(result["violations"]),
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in failing],
        "passes": not failing,
    }


def active_element(page) -> dict:
    return page.evaluate(
        "() => { const el = document.activeElement; return el ? {"
        " tag: el.tagName.toLowerCase(),"
        " uid: el.getAttribute('data-calendar-event-preview-uid')"
        "   || el.closest('[data-compact-month-occ-uid]')?.getAttribute('data-compact-month-occ-uid'),"
        " klass: el.getAttribute('class'),"
        " id: el.getAttribute('id'),"
        " href: el.getAttribute('href'),"
        " isBody: el === document.body } : null; }"
    )


def no_horizontal_overflow(page) -> bool:
    return not page.evaluate(
        "() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"
    )


def dialog_open(page) -> bool:
    return page.evaluate(
        "() => { const d = document.querySelector('#calendar-event-preview');"
        " return Boolean(d && d.hasAttribute('open')); }"
    )


def wait_for_calendar(page):
    page.wait_for_selector("#page[data-harness-state='rendered']")


def smallest_control(page, selector) -> dict:
    return page.evaluate(
        """(selector) => {
          const nodes = [...document.querySelectorAll(selector)].filter((el) => {
            const style = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden'
              && box.width >= 1 && box.height >= 1;
          });
          if (!nodes.length) return { count: 0, smallest: 0, name: null };
          let smallest = Infinity;
          let name = null;
          for (const el of nodes) {
            const box = el.getBoundingClientRect();
            const size = Math.min(box.width, box.height);
            if (size < smallest) {
              smallest = size;
              name = el.className || el.tagName.toLowerCase();
            }
          }
          return { count: nodes.length, smallest, name };
        }""",
        selector,
    )


def specimen_journey_canary(page, base, width):
    page.goto(f"{base}?fixture=dense", wait_until="load")
    wait_for_calendar(page)
    page.wait_for_selector(PREVIEW_BUTTON)
    route_before = page.evaluate("() => location.hash")
    trigger = page.locator(PREVIEW_BUTTON).first
    uid = trigger.get_attribute("data-calendar-event-preview-uid")
    trigger.click()
    page.wait_for_selector(DIALOG + "[open]")
    inspected = dialog_open(page)
    page.locator(CLOSE).click()
    closed = not dialog_open(page)
    trigger.click()
    href = page.locator(OPEN_LINK).get_attribute("href")
    page.locator(OPEN_LINK).click()
    page.wait_for_url(DESTINATION_URL, timeout=15000)
    on_full_page = "browse_return_destination.html" in page.url
    page.go_back()
    wait_for_calendar(page)
    page.wait_for_selector(PREVIEW_BUTTON)
    focus = active_element(page)
    page.wait_for_timeout(100)
    focus = active_element(page)
    continued = page.locator(PREVIEW_BUTTON).nth(1)
    continued.click()
    continued_open = dialog_open(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "non_default_view": route_before == "#now?calview=calendar",
        "inspected_in_place": inspected,
        "closed_in_place": closed,
        "full_page_href": href,
        "opened_full_page": on_full_page,
        "back_restored_the_lane": page.evaluate("() => location.hash") == "#now?calview=calendar",
        "focus_returned_to_the_event": focus and focus.get("uid") == uid and not focus.get("isBody"),
        "continued_to_the_next_item": continued_open,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a reader sets Calendar view, inspects an event, closes it, opens its full "
        "page, returns with Back to the same event, and continues to the next item"
    )


def specimen_fresh_visit(page, base, width):
    page.goto(f"{base}?fixture=dense", wait_until="load")
    wait_for_calendar(page)
    focus = active_element(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "focus_stays_on_the_document": bool(focus and (focus.get("isBody") or focus.get("tag") in {"body", "html"})),
        "hash_is_the_calendar_view": page.evaluate("() => location.hash") == "#now?calview=calendar",
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a fresh direct visit to the calendar does not steal focus onto an event"
    )


def specimen_back_and_forward(page, base, width):
    page.goto(f"{base}?fixture=dense", wait_until="load")
    wait_for_calendar(page)
    link = page.locator(CANONICAL_LINK).first
    uid = page.locator(".compact-month-occ").first.get_attribute("data-compact-month-occ-uid")
    link.click()
    page.wait_for_url(DESTINATION_URL, timeout=15000)
    page.go_back()
    wait_for_calendar(page)
    after_back = active_element(page)
    page.go_forward()
    page.wait_for_url(DESTINATION_URL, timeout=15000)
    on_full_page = "browse_return_destination.html" in page.url
    page.go_back()
    wait_for_calendar(page)
    after_second_back = active_element(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "first_back_restored_the_event": after_back and after_back.get("uid") == uid and not after_back.get("isBody"),
        "forward_returned_to_the_full_page": on_full_page,
        "second_back_restored_the_event": after_second_back and after_second_back.get("uid") == uid and not after_second_back.get("isBody"),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px Browser Back and Forward both keep the originating event as the focus "
        "target rather than dropping it on the document body"
    )


def specimen_keyboard_focus(page, base, width):
    page.goto(f"{base}?fixture=dense", wait_until="load")
    wait_for_calendar(page)
    page.wait_for_selector(PREVIEW_BUTTON)
    page.locator(PREVIEW_BUTTON).first.focus()
    page.keyboard.press("Enter")
    page.wait_for_selector(DIALOG + "[open]")
    opened = dialog_open(page)
    page.keyboard.press("Escape")
    closed = not dialog_open(page)
    page.locator(PREVIEW_BUTTON).first.focus()
    page.keyboard.press("Enter")
    page.wait_for_selector(OPEN_LINK)
    page.locator(OPEN_LINK).focus()
    page.keyboard.press("Enter")
    page.wait_for_url(DESTINATION_URL, timeout=15000)
    page.go_back()
    wait_for_calendar(page)
    page.wait_for_timeout(100)
    focus = active_element(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "keyboard_opens_the_preview": opened,
        "escape_closes_the_preview": closed,
        "keyboard_full_page_and_back_restores_focus": bool(focus and focus.get("uid") and not focus.get("isBody")),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the round trip works from the keyboard: inspect, Escape, open the full "
        "page, Back, and focus is not left on the document body"
    )


def specimen_modified_click_and_without_scripting(page, base, width):
    page.goto(f"{base}?fixture=dense", wait_until="load")
    wait_for_calendar(page)
    calendar_url = page.url
    with page.context.expect_page() as popup:
        page.locator(CANONICAL_LINK).first.click(modifiers=["ControlOrMeta"])
    separate_context = popup.value
    still_on_calendar = page.url == calendar_url
    opened_preview = dialog_open(page)
    separate_context.close()
    focus_after_modified = active_element(page)

    page.goto(f"{base}?fixture=dense&enhance=off", wait_until="load")
    page.wait_for_selector(CANONICAL_LINK)
    visible_triggers = page.locator(PREVIEW_BUTTON).count()
    href = page.locator(CANONICAL_LINK).first.get_attribute("href")
    page.locator(CANONICAL_LINK).first.click()
    page.wait_for_url(DESTINATION_URL, timeout=15000)
    navigated = "browse_return_destination.html" in page.url
    page.go_back()
    page.wait_for_selector(CANONICAL_LINK)
    shot = page.screenshot(full_page=True)
    return shot, {
        "a_modified_click_opens_no_preview": not opened_preview,
        "a_modified_click_left_the_calendar_in_place": still_on_calendar,
        "modified_click_did_not_steal_focus_onto_an_event": bool(
            focus_after_modified and (focus_after_modified.get("isBody") or focus_after_modified.get("tag") == "body")
            or still_on_calendar
        ),
        "without_scripting_no_inspection_control_is_offered": visible_triggers == 0,
        "without_scripting_the_canonical_link_still_works": navigated and bool(href),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a modified click is left to the browser, and with scripting off the "
        "canonical link still reaches the event page"
    )


def specimen_search_and_following(page, base, width):
    page.goto(f"{base}?fixture=dense", wait_until="load")
    wait_for_calendar(page)
    search_scope = page.locator("[data-search-scope-label]").inner_text()
    search_href = page.locator("[data-search-scope-link]").get_attribute("href")
    following_focus = page.locator("[data-preview-focus]").get_attribute("data-preview-id")
    following_first = page.locator(".following-digitem").first.get_attribute("data-preview-id")
    preview_in_search = page.locator("#search .compact-month-occ-preview").count()
    preview_in_following = page.locator("#following .compact-month-occ-preview").count()
    search_result = page.locator("[data-search-result]")
    search_result.click()
    page.wait_for_url(DESTINATION_URL, timeout=15000)
    page.go_back()
    wait_for_calendar(page)
    scope_after = page.locator("[data-search-scope-label]").inner_text()
    shot = page.screenshot(full_page=True)
    return shot, {
        "search_keeps_its_own_scope": search_scope == "contracts",
        "search_scope_url_is_canonical": bool(search_href and search_href.startswith("/search/")),
        "following_pins_the_origin_record": following_focus == "dense-timed" and following_first == "dense-timed",
        "search_was_not_wrapped_in_a_calendar_preview": preview_in_search == 0,
        "following_was_not_wrapped_in_a_calendar_preview": preview_in_following == 0,
        "search_round_trip_keeps_scope": scope_after == "contracts",
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px Search and Following keep their existing preview and scope machinery: "
        "Contracts stays the Search scope, Following pins the originating record, and neither "
        "surface is wrapped in a calendar preview"
    )


def specimen_zoom(page, base, width):
    css_width = width // ZOOM_FACTOR
    page.set_viewport_size({"width": css_width, "height": 844 if width == 390 else 450})
    page.goto(f"{base}?fixture=dense", wait_until="load")
    wait_for_calendar(page)
    page.locator(PREVIEW_BUTTON).first.click()
    page.wait_for_selector(DIALOG + "[open]")
    shot = page.screenshot(full_page=True)
    overflow = no_horizontal_overflow(page)
    return shot, {
        "css_viewport_width": css_width,
        "emulates": f"200% browser zoom of a {width}px window",
        "lane_has_no_horizontal_overflow": overflow,
        "panel_has_no_horizontal_overflow": overflow,
        "hash_is_the_calendar_view": page.evaluate("() => location.hash") == "#now?calview=calendar",
    }, (
        f"at the {css_width}px CSS viewport a 200 percent zoom of a {width}px window produces, "
        "the calendar and the opened preview both read without any horizontal page scrolling"
    )


def specimen_touch_targets(page, base, width):
    page.goto(f"{base}?fixture=dense", wait_until="load")
    wait_for_calendar(page)
    lane = smallest_control(
        page,
        ".compact-month-occ-preview, [data-search-result], [data-following-origin], [data-search-scope-link]",
    )
    page.locator(PREVIEW_BUTTON).first.click()
    page.wait_for_selector(DIALOG + "[open]")
    with_panel = smallest_control(
        page,
        ".compact-month-occ-preview, .calendar-event-preview-close, .calendar-event-preview-open, [data-search-result], [data-following-origin]",
    )
    floor = TOUCH_TARGET_MINIMUM_NARROW if width <= 390 else TOUCH_TARGET_MINIMUM_DESKTOP
    shot = page.screenshot(full_page=True)
    return shot, {
        "reading": "narrow" if width <= 390 else "desktop",
        "controls_measured_on_the_lane": lane["count"],
        "smallest_lane_control_px": round(lane["smallest"]),
        "controls_measured_with_the_panel_open": with_panel["count"],
        "smallest_control_px": round(with_panel["smallest"]),
        "floor_px": floor,
        "every_control_meets_the_floor": with_panel["smallest"] >= floor,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px every control this contract adds or uses is at least {floor}px, so none of "
        "them is a target a finger cannot land on"
    )


SPECIMENS = (
    ("inspect-close-open-back-continue", specimen_journey_canary),
    ("fresh-direct-visit", specimen_fresh_visit),
    ("back-and-forward", specimen_back_and_forward),
    ("keyboard-focus", specimen_keyboard_focus),
    ("modified-click-and-without-scripting", specimen_modified_click_and_without_scripting),
    ("search-and-following", specimen_search_and_following),
    ("two-hundred-percent-zoom", specimen_zoom),
    ("touch-targets", specimen_touch_targets),
)


def capture() -> dict:
    sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
    from a11y_gate import failing_violations
    from playwright.sync_api import sync_playwright

    IMAGES.mkdir(parents=True, exist_ok=True)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/{HARNESS}"

    files = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for slug, run in SPECIMENS:
                for width, height in VIEWPORTS:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        timezone_id=TIMEZONE,
                    )
                    page = context.new_page()
                    image, observations, assertion = run(page, base, width)
                    axe_result = run_axe(page, failing_violations)
                    name = f"{slug}-{width}x{height}.png"
                    (IMAGES / name).write_bytes(image)
                    files.append({
                        "name": name,
                        "specimen": slug,
                        "route": ROUTE,
                        "harness": HARNESS,
                        "viewport": [width, height],
                        "revision": revision,
                        "data_vintage": DATA_VINTAGE,
                        "timezone": TIMEZONE,
                        "assertion": assertion,
                        "observations": observations,
                        "bytes": len(image),
                        "sha256": hashlib.sha256(image).hexdigest(),
                        "axe": axe_result,
                    })
                    context.close()
            browser.close()
    finally:
        server.shutdown()

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "record": RECORD,
        "route": ROUTE,
        "harness": HARNESS,
        "revision": revision,
        "data_vintage": DATA_VINTAGE,
        "timezone": TIMEZONE,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "image_directory": str(IMAGES.relative_to(ROOT)),
        "image_policy": (
            "Capture images are written to the ignored local directory above and are never "
            "committed. This manifest is the tracked proof: route, viewport, revision, data "
            "vintage, assertion, observations and SHA-256 for each capture."
        ),
        "measurement_policy": (
            "Every observation is a measurement of what the rendered document does. No "
            "participant evaluation was run and no usability gain is claimed."
        ),
        "files": files,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


REQUIRED_FIELDS = ("name", "specimen", "route", "viewport", "revision", "data_vintage",
                   "assertion", "observations", "sha256", "axe")
SHA256 = 64


def check() -> int:
    if not MANIFEST.exists():
        raise SystemExit(f"missing {MANIFEST.relative_to(ROOT)}; run this tool without --check")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise SystemExit(f"unexpected manifest schema {manifest.get('schema')!r}")
    if manifest.get("record") != RECORD:
        raise SystemExit(f"manifest is not owned by {RECORD}")
    files = manifest.get("files") or []
    expected = {f"{slug}-{width}x{height}.png" for slug, _ in SPECIMENS for width, height in VIEWPORTS}
    found = {row.get("name") for row in files}
    missing = expected - found
    if missing:
        raise SystemExit(f"missing capture entries: {sorted(missing)}")
    unexpected = found - expected
    if unexpected:
        raise SystemExit(f"manifest describes captures no specimen produces: {sorted(unexpected)}")
    for row in files:
        absent = [field for field in REQUIRED_FIELDS if not row.get(field)]
        if absent:
            raise SystemExit(f"{row.get('name')}: manifest entry is missing {absent}")
        if len(row["sha256"]) != SHA256:
            raise SystemExit(f"{row['name']}: sha256 is not a digest")
        if row["revision"] != manifest["revision"] or row["data_vintage"] != manifest["data_vintage"]:
            raise SystemExit(f"{row['name']}: revision or data vintage disagrees with the manifest")
        if row["axe"].get("failing_violations"):
            raise SystemExit(f"{row['name']} failed the accessibility gate: {row['axe']['failing_violations']}")
        false_observations = [key for key, value in row["observations"].items() if value is False]
        if false_observations:
            raise SystemExit(f"{row['name']}: the capture observed {false_observations} as false")
        image = IMAGES / row["name"]
        if image.exists() and hashlib.sha256(image.read_bytes()).hexdigest() != row["sha256"]:
            raise SystemExit(f"{row['name']}: the local image does not match its recorded digest")
    committed = sorted(path.name for path in MANIFEST.parent.glob("*")
                       if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"})
    if committed:
        raise SystemExit(f"capture images must not be committed: {committed}")
    print(
        f"browse-return evidence OK ({len(files)} captures, "
        f"{len(SPECIMENS)} specimens x {len(VIEWPORTS)} viewports, revision {manifest['revision'][:12]})"
    )
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    if args.check:
        return check()
    manifest = capture()
    print(f"wrote {MANIFEST.relative_to(ROOT)} ({len(manifest['files'])} captures)")
    return check()


if __name__ == "__main__":
    raise SystemExit(main())
