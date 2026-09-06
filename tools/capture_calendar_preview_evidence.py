#!/usr/bin/env python3
"""Headless browser evidence for the in-place calendar event preview (PX-01).

Drives `test/harness/calendar_event_preview_harness.html` -- a neutral,
unshipped fixture page that mounts the real shared month renderer and the real
shared preview binder against the committed fixtures in
`test/fixtures/compact_calendar_fixtures.mjs`. No public route is mounted and no
publisher is contacted.

Each specimen is a real interaction in a real engine, at 390 and 1440 pixels:
opening a preview, closing it with the visible control and with Escape, the
focus that comes back, the explicit full-page journey and the browser Back that
follows it, a modified click, a failed optional detail load, a stale detail
response, cancelled and date-only events, a repeated identity, a dynamic
rerender, and the page as a reader without scripting receives it. Every
specimen also runs the vendored axe-core gate, on the same rule set and
pass/fail classification as `test/functional/11_accessibility.py`.

Proof is the tracked manifest: one entry per capture naming its route,
viewport, revision, data vintage, assertion, observations, and the SHA-256 of
the image. The images themselves are written to an ignored local directory and
are never committed -- this repository does not carry capture binaries.

    python3 tools/capture_calendar_preview_evidence.py
    python3 tools/capture_calendar_preview_evidence.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs" / "evidence" / "calendar-event-preview" / "manifest.json"
# Gitignored: capture images stay local and are described by the manifest.
IMAGES = ROOT / ".artifacts" / "calendar-event-preview"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

MANIFEST_SCHEMA = "cityscroll.calendar_event_preview_evidence.v1"
CARD = "cityscroll-resident-ux/px-01-preview-calendar-events"
HARNESS = "test/harness/calendar_event_preview_harness.html"
ROUTE = "component-harness:calendar-event-preview"

VIEWPORTS = ((390, 844), (1440, 900))
# The committed fixture corpus pins the day every view is built for, so a
# capture describes a fixed data vintage rather than whenever it happened to run.
DATA_VINTAGE = "2026-03-15"
TIMEZONE = "America/New_York"

# The month renders a grid and a parallel agenda, and CSS alone chooses which
# one a viewport reads; the hidden form's controls are in the document but are
# not the ones a reader can reach. Every interaction below therefore addresses
# only the visible form.
PREVIEW_BUTTON = ".compact-month-occ-preview:visible"
ANY_PREVIEW_BUTTON = ".compact-month-occ-preview"
CANONICAL_LINK = ".compact-month-occ-link:visible"
DIALOG = "#calendar-event-preview"
CLOSE = "[data-calendar-event-preview-close]"
OPEN_LINK = "[data-calendar-event-preview-open]"


# The canonical destinations in the committed fixture corpus are real
# cityscroll.org URLs. What a capture is proving is that the browser itself
# takes the reader there -- not what that page contains -- so the origin is
# stubbed at the network boundary and no request ever leaves the machine.
CANONICAL_ORIGIN = "https://cityscroll.org/**"
CANONICAL_STUB = (
    "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
    "<title>Event page</title></head><body><main><h1>Event page</h1></main></body></html>"
)


def stub_canonical_origin(context):
    context.route(CANONICAL_ORIGIN, lambda route: route.fulfill(
        status=200, content_type="text/html; charset=utf-8", body=CANONICAL_STUB))


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
        " uid: el.getAttribute('data-calendar-event-preview-uid'),"
        " klass: el.getAttribute('class'),"
        " inDialog: Boolean(el.closest('#calendar-event-preview')) } : null; }"
    )


def dialog_state(page) -> dict:
    return page.evaluate(
        "() => { const d = document.querySelector('#calendar-event-preview');"
        " return { present: Boolean(d), open: d ? d.hasAttribute('open') : false,"
        " count: document.querySelectorAll('#calendar-event-preview').length,"
        " text: d ? d.innerText.replace(/\\s+/g, ' ').trim() : '' }; }"
    )


def no_horizontal_overflow(page) -> bool:
    return not page.evaluate(
        "() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"
    )


# ---------- specimens ----------
#
# Each specimen returns the observations its assertion is about. A specimen
# that cannot observe what it claims raises, rather than recording a pass.


def specimen_open_and_close(page, base, width):
    page.goto(f"{base}?fixture=dense", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    before = page.evaluate("() => ({ month: document.querySelector('.compact-month').dataset.compactMonth,"
                           " cells: document.querySelectorAll('.compact-month-occ').length,"
                           " url: location.href })")
    page.locator(PREVIEW_BUTTON).first.click()
    opened = dialog_state(page)
    focus_on_open = active_element(page)
    shot = page.screenshot(full_page=True)
    page.locator(CLOSE).click()
    closed = dialog_state(page)
    focus_after = active_element(page)
    after = page.evaluate("() => ({ month: document.querySelector('.compact-month').dataset.compactMonth,"
                          " cells: document.querySelectorAll('.compact-month-occ').length,"
                          " url: location.href })")
    return shot, {
        "opened": opened["open"],
        "focus_moved_into_dialog": focus_on_open["inDialog"],
        "closed": not closed["open"],
        "focus_returned_to_trigger": focus_after["klass"] == "compact-month-occ-preview",
        "month_preserved": before["month"] == after["month"],
        "cells_preserved": before["cells"] == after["cells"],
        "url_unchanged": before["url"] == after["url"],
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the preview opens in place with focus inside, Close returns focus to the "
        "invoking control, and the month, its cells and the address are untouched"
    )


def specimen_escape(page, base, width):
    page.goto(f"{base}?fixture=dense", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    page.locator(PREVIEW_BUTTON).first.click()
    shot = page.screenshot(full_page=True)
    page.keyboard.press("Escape")
    state = dialog_state(page)
    focus = active_element(page)
    return shot, {
        "closed_by_escape": not state["open"],
        "focus_returned_to_trigger": focus["klass"] == "compact-month-occ-preview",
    }, f"at {width}px Escape dismisses the preview and focus returns to the invoking control"


def specimen_keyboard_activation(page, base, width):
    page.goto(f"{base}?fixture=dense", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    page.locator(PREVIEW_BUTTON).first.focus()
    page.keyboard.press("Enter")
    opened = dialog_state(page)
    focus_in = active_element(page)
    # Tab through the dialog and confirm focus never escapes it.
    escapes = []
    for _ in range(6):
        page.keyboard.press("Tab")
        escapes.append(active_element(page)["inDialog"])
    shot = page.screenshot(full_page=True)
    return shot, {
        "opened_by_keyboard": opened["open"],
        "focus_moved_into_dialog": focus_in["inDialog"],
        "focus_contained_through_tabs": all(escapes),
    }, f"at {width}px Enter on the trigger opens the preview and Tab stays inside it"


def specimen_full_page_journey(page, base, width):
    page.goto(f"{base}?fixture=dense", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    calendar_url = page.url
    page.locator(PREVIEW_BUTTON).first.click()
    destination = page.locator(OPEN_LINK).get_attribute("href")
    # The preview's own destination is an ordinary link; the harness supplies a
    # neutral local page so a real navigation and a real Back can be observed.
    page.locator(CLOSE).click()
    page.locator("#destination").click()
    page.wait_for_selector("[data-harness-destination]")
    left = page.url
    page.go_back()
    page.wait_for_selector(PREVIEW_BUTTON)
    shot = page.screenshot(full_page=True)
    resumed = dialog_state(page)
    page.locator(PREVIEW_BUTTON).first.click()
    return shot, {
        "preview_destination": destination,
        "navigated_away": left != calendar_url,
        "returned_to_calendar": page.url == calendar_url,
        "no_dialog_after_back": not resumed["open"],
        "preview_works_after_back": dialog_state(page)["open"],
    }, (
        f"at {width}px the preview offers an explicit full-page destination, and after a real "
        "navigation and browser Back the calendar is back and its preview still works"
    )


def specimen_modified_click(page, base, width):
    page.goto(f"{base}?fixture=dense", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    calendar_url = page.url
    anchor = page.locator(CANONICAL_LINK).first
    href = anchor.get_attribute("href")
    # A modified click is the browser's to handle. What is under test is that
    # the enhancement does not take it: a separate browsing context opens, no
    # preview appears, and the calendar the reader is on does not move. What
    # that other context eventually renders is not this capture's subject.
    with page.context.expect_page() as popup:
        anchor.click(modifiers=["ControlOrMeta"])
    separate_context = popup.value
    intercepted = dialog_state(page)
    still_on_calendar = page.url == calendar_url
    separate_context.close()
    # And an ordinary click on the same enhanced anchor still navigates, which
    # is the same path a context menu's "open link" takes.
    anchor.click()
    page.wait_for_url(href, timeout=15000)
    navigated = page.url
    page.go_back()
    page.wait_for_selector(PREVIEW_BUTTON)
    shot = page.screenshot(full_page=True)
    return shot, {
        "anchor_href": href,
        "modified_click_opened_a_separate_context": True,
        "modified_click_opened_no_preview": not intercepted["open"],
        "modified_click_left_the_calendar_in_place": still_on_calendar,
        "plain_click_still_reaches_the_canonical_destination": navigated == href,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the canonical link keeps its own behaviour under enhancement: a modified "
        "click is handed to the browser and opens no preview, and an ordinary click still "
        "navigates to the canonical destination"
    )


def specimen_without_scripting(page, base, width):
    page.goto(f"{base}?fixture=dense&enhance=off", wait_until="load")
    page.wait_for_selector(CANONICAL_LINK)
    visible_triggers = page.locator(PREVIEW_BUTTON).count()
    href = page.locator(CANONICAL_LINK).first.get_attribute("href")
    page.locator(CANONICAL_LINK).first.click()
    page.wait_for_load_state("domcontentloaded")
    navigated = page.url
    page.go_back()
    page.wait_for_selector(CANONICAL_LINK)
    shot = page.screenshot(full_page=True)
    return shot, {
        "no_visible_trigger_without_enhancement": visible_triggers == 0,
        "canonical_href": href,
        "link_navigates": navigated.startswith("https://cityscroll.org/"),
    }, (
        f"at {width}px an unenhanced calendar shows no preview affordance at all and activating an "
        "event navigates straight to its full page — which is both the behaviour a reader without "
        "scripting still gets and, because the anchor is unchanged, the before state this work "
        "starts from"
    )


def specimen_failed_detail(page, base, width):
    page.goto(f"{base}?fixture=dense&detail=fail", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    page.locator(PREVIEW_BUTTON).first.click()
    page.wait_for_selector(".calendar-event-preview-detail-status")
    state = dialog_state(page)
    href = page.locator(OPEN_LINK).get_attribute("href")
    title = page.locator("#calendar-event-preview-title").inner_text()
    shot = page.screenshot(full_page=True)
    return shot, {
        "title_retained": title,
        "date_retained": "Date" in state["text"],
        "status_shown": "did not load" in state["text"],
        "full_page_link_retained": href,
        "link_is_usable": bool(href and href.startswith("https://")),
    }, (
        f"at {width}px a failed optional detail load leaves the event's own facts and a working "
        "full-page link untouched"
    )


def specimen_stale_detail(page, base, width):
    page.goto(f"{base}?fixture=dense&detail=slow", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    triggers = page.locator(PREVIEW_BUTTON)
    first_title = triggers.nth(0).get_attribute("aria-label")
    triggers.nth(0).click()
    # The reader leaves the first event before its slow answer arrives. The
    # modal is genuinely modal, so this is the only route to a second one.
    page.keyboard.press("Escape")
    triggers.nth(1).click()
    second_title = page.locator("#calendar-event-preview-title").inner_text()
    # Outlast the slow hook, so the first selection's answer has certainly landed.
    page.wait_for_timeout(1600)
    state = dialog_state(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "first_selection": first_title,
        "showing_after_stale_response": page.locator("#calendar-event-preview-title").inner_text(),
        "newer_selection_retained": page.locator("#calendar-event-preview-title").inner_text() == second_title,
        "stale_detail_absent": f"Late detail for {first_title.removeprefix('Preview: ')}." not in state["text"],
    }, (
        f"at {width}px a detail response for a selection the reader has left never replaces the "
        "newer one on screen"
    )


def specimen_lifecycle(page, base, width):
    page.goto(f"{base}?fixture=lifecycle", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    cancelled = page.locator('[data-calendar-event-preview-uid="lifecycle-cancelled"]:visible').first
    cancelled.click()
    cancelled_text = dialog_state(page)["text"]
    page.keyboard.press("Escape")
    past = page.locator('[data-calendar-event-preview-uid="lifecycle-past"]:visible').first
    past.click()
    past_text = dialog_state(page)["text"]
    shot = page.screenshot(full_page=True)
    return shot, {
        "cancellation_stated": "This event is cancelled." in cancelled_text,
        "cancellation_before_action": cancelled_text.index("cancelled") < cancelled_text.index("Open the"),
        "past_state_stated": "This date has passed." in past_text,
        "no_clock_time_on_a_date_only_event": ":" not in past_text.split("Date")[-1].split("Open the")[0],
    }, (
        f"at {width}px a cancelled event says so before offering an action, a past event says its "
        "date has passed, and a date-only event acquires no clock time"
    )


def specimen_repeated_identity_and_rerender(page, base, width):
    page.goto(f"{base}?fixture=crowded", wait_until="load")
    page.wait_for_selector(PREVIEW_BUTTON)
    # The shared renderer emits the same month twice -- a grid for wide
    # viewports and a parallel agenda for narrow ones -- and a crowded day's
    # remainder is in the document in both, so one event identity is rendered
    # in several places at once. Every one of them must resolve to the same
    # single preview.
    uid_counts = page.evaluate(
        "() => { const seen = {}; for (const el of document.querySelectorAll('[data-calendar-event-preview-uid]'))"
        " { const uid = el.dataset.calendarEventPreviewUid; seen[uid] = (seen[uid] || 0) + 1; } return seen; }"
    )
    repeated = sorted(uid for uid, count in uid_counts.items() if count > 1)
    if not repeated:
        raise SystemExit("the crowded fixture no longer renders any identity more than once")
    subject = repeated[0]
    page.locator(f'[data-calendar-event-preview-uid="{subject}"]:visible').last.click()
    repeated_state = dialog_state(page)
    expected_title = page.locator(
        f'[data-calendar-event-preview-uid="{subject}"]').first.get_attribute("aria-label").removeprefix("Preview: ")
    shown_title = page.locator("#calendar-event-preview-title").inner_text()
    page.keyboard.press("Escape")

    page.locator("#repaint").click()
    page.wait_for_selector("[data-harness-repainted]")
    page.locator(PREVIEW_BUTTON).first.click()
    after_rerender = dialog_state(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "identities_rendered_more_than_once": len(repeated),
        "repeated_identity_opens_one_dialog": repeated_state["count"] == 1,
        "repeated_identity_shows_its_own_event": shown_title == expected_title,
        "works_after_rerender": after_rerender["open"],
        "single_dialog_after_rerender": after_rerender["count"] == 1,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px an event identity rendered in several places at once -- the grid and the "
        "parallel agenda, each carrying the crowded day's remainder -- opens the one shared preview "
        "for that event, and a repaint leaves exactly one dialog still working"
    )


def specimen_sparse(page, base, width):
    page.goto(f"{base}?fixture=sparse", wait_until="load")
    page.wait_for_selector("#page[data-harness-state='non-render']")
    shot = page.screenshot(full_page=True)
    return shot, {
        "renders_no_month": page.locator(".compact-month").count() == 0,
        "offers_no_trigger": page.locator(ANY_PREVIEW_BUTTON).count() == 0,
    }, (
        f"at {width}px a bundle below the density rule renders no month and therefore offers no "
        "preview affordance either"
    )


SPECIMENS = (
    ("open-and-close", specimen_open_and_close),
    ("escape-dismissal", specimen_escape),
    ("keyboard-activation", specimen_keyboard_activation),
    ("full-page-journey", specimen_full_page_journey),
    ("modified-click", specimen_modified_click),
    ("before-state-and-without-scripting", specimen_without_scripting),
    ("failed-optional-detail", specimen_failed_detail),
    ("stale-detail-response", specimen_stale_detail),
    ("cancelled-and-date-only", specimen_lifecycle),
    ("repeated-identity-and-rerender", specimen_repeated_identity_and_rerender),
    ("sparse-no-calendar", specimen_sparse),
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
                    context = browser.new_context(viewport={"width": width, "height": height},
                                                  timezone_id=TIMEZONE)
                    stub_canonical_origin(context)
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
        "card": CARD,
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
            "vintage, assertion and SHA-256 for each capture."
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
    if manifest.get("card") != CARD:
        raise SystemExit(f"manifest is not owned by {CARD}")
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
        # Images are local-only by policy, so their absence is not a failure;
        # when one is present it must still be the image the manifest describes.
        image = IMAGES / row["name"]
        if image.exists() and hashlib.sha256(image.read_bytes()).hexdigest() != row["sha256"]:
            raise SystemExit(f"{row['name']}: the local image does not match its recorded digest")
    committed = sorted(path.name for path in MANIFEST.parent.glob("*")
                       if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"})
    if committed:
        raise SystemExit(f"capture images must not be committed: {committed}")
    print(f"calendar event preview evidence OK ({len(files)} captures, "
          f"{len(SPECIMENS)} specimens x {len(VIEWPORTS)} viewports, revision {manifest['revision'][:12]})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate the tracked manifest without a browser")
    args = parser.parse_args()
    if args.check:
        return check()
    manifest = capture()
    print(f"captured {len(manifest['files'])} calendar event preview specimens into "
          f"{IMAGES.relative_to(ROOT)} (manifest: {MANIFEST.relative_to(ROOT)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
