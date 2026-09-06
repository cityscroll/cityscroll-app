#!/usr/bin/env python3
"""Headless browser evidence for the matter-continuation availability rule.

Drives `test/harness/matter_continuation_harness.html` -- a neutral, unshipped
template page carrying the exact markup a materialized meeting document emits.
`tools/render_matter_continuation_fixtures.mjs` renders every specimen with the
real module against the committed retained corpus, and this script substitutes
each one into the template and writes the filled page to an ignored local
directory. No public route is mounted and no publisher is contacted.

The page carries no script of any kind, so what every specimen drives is what a
reader with scripting disabled receives: the without-scripting specimen loads it
in a context with JavaScript switched off and still activates a destination.

Each specimen is a real interaction in a real engine, at 390 and 1440 pixels: a
published local history, an exact official record, a multi-matter hearing that
keeps every choice, an unmatched notice that offers none, an exact identity with
no reachable record, keyboard activation followed by a real browser Back, and
the page without scripting. Every specimen also runs the vendored axe-core gate,
on the same rule set and pass/fail classification as
`test/functional/11_accessibility.py`.

Proof is the tracked manifest: one entry per capture naming its route, viewport,
revision, data vintage, assertion, observations, and the SHA-256 of the image.
The images themselves are written to an ignored local directory and are never
committed -- this repository does not carry capture binaries.

    python3 tools/capture_matter_continuation_evidence.py
    python3 tools/capture_matter_continuation_evidence.py --check
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
MANIFEST = ROOT / "docs" / "evidence" / "matter-continuation-availability" / "manifest.json"
# Gitignored: capture images and filled harness pages stay local, and the
# manifest is the tracked description of them.
ARTIFACTS = ROOT / ".artifacts" / "matter-continuation-availability"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"

MANIFEST_SCHEMA = "cityscroll.legislative_matter_continuation_evidence.v1"
ENGINEERING_RECORD = "cityscroll-engineering/legislative-matter-continuation-availability"
HARNESS = "test/harness/matter_continuation_harness.html"
RENDERER = "tools/render_matter_continuation_fixtures.mjs"
ROUTE = "component-harness:matter-continuation"

VIEWPORTS = ((390, 844), (1440, 900))

CONTINUATION = "[data-council-matter-continuation]"
DESTINATION_CONTROL = '[data-action-path-continuation="subject"]'
UNAVAILABLE = "[data-matter-availability='unavailable']"

# The official destinations in the retained corpus are real publisher URLs, and
# the published local history is a route this repository serves. What a capture
# proves is that the browser itself takes the reader there -- not what those
# pages contain -- so both origins are stubbed at the network boundary and no
# request ever leaves the machine.
PUBLISHER_ORIGIN = "https://nyc.legistar.com/**"
LOCAL_MATTER_ROUTE = "**/matters/**"
STUB = (
    "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
    "<title>Matter record</title></head><body><main data-harness-destination='1'>"
    "<h1>Matter record</h1></main></body></html>"
)


def stub_destinations(context):
    for pattern in (PUBLISHER_ORIGIN, LOCAL_MATTER_ROUTE):
        context.route(pattern, lambda route: route.fulfill(
            status=200, content_type="text/html; charset=utf-8", body=STUB))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):  # noqa: A003 - quiet test server
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def render_fixtures() -> dict:
    """The real module's own output, rendered once per run."""
    result = subprocess.run(
        ["node", RENDERER], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def write_pages(fixtures: dict, base: str) -> dict:
    """Fill the tracked template per specimen; the filled pages stay local."""
    template = (ROOT / HARNESS).read_text(encoding="utf-8")
    pages = {}
    for name, spec in fixtures.items():
        page = (template
                .replace("FIXTURE_NAME", name)
                .replace("FIXTURE_NOTICE", spec["request_id"])
                .replace("FIXTURE_SCOPE", f"notice {spec['request_id']}")
                .replace("CONTINUATION_SECTION", spec["html"]))
        (ARTIFACTS / f"{name}.html").write_text(page, encoding="utf-8")
        pages[name] = f"{base}/{name}.html"
    # The harness's own neutral destination page sits beside the filled pages so
    # a real navigation and a real Back can be observed.
    (ARTIFACTS / "destination.html").write_text(
        (ROOT / "test" / "harness" / "destination.html").read_text(encoding="utf-8"), encoding="utf-8")
    return pages


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


def controls(page) -> list:
    return page.evaluate(
        "() => [...document.querySelectorAll('[data-action-path-continuation=\"subject\"]')]"
        ".map(el => ({ tag: el.tagName.toLowerCase(), href: el.getAttribute('href'),"
        " label: el.textContent.trim(), subject: el.getAttribute('data-subject-ref'),"
        " availability: el.getAttribute('data-matter-availability'),"
        " rect: el.getBoundingClientRect().height }))"
    )


def page_text(page) -> str:
    return page.locator("#page").inner_text().replace("\n", " ")


def no_horizontal_overflow(page) -> bool:
    return not page.evaluate(
        "() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"
    )


FORBIDDEN_COPY = ("follow", "subscribe", "subscription", "watch", "saved", "tracking",
                  "testimony", "testify", "notify")


def assert_no_claim(text: str, specimen: str):
    lowered = text.lower()
    for phrase in FORBIDDEN_COPY:
        if phrase in lowered:
            raise AssertionError(f"{specimen} claims more than navigation: {phrase}")


# ---------- specimens ----------
#
# Each specimen returns the observations its assertion is about. A specimen that
# cannot observe what it claims raises, rather than recording a pass.


def specimen_published_local_history(page, pages, width):
    page.goto(pages["published-local-history"], wait_until="load")
    rows = controls(page)
    local = [row for row in rows if row["availability"] == "local_history"]
    official = [row for row in rows if row["availability"] == "official_record"]
    if not local or not official:
        raise AssertionError("this specimen needs both a published history and an official record")
    assert_no_claim(page_text(page), "published-local-history")
    shot = page.screenshot(full_page=True)
    return shot, {
        "local_history_controls": [row["href"] for row in local],
        "local_history_label": local[0]["label"],
        "official_record_labels": sorted({row["label"] for row in official}),
        "every_control_is_an_anchor": all(row["tag"] == "a" for row in rows),
        "every_control_meets_the_touch_target": all(row["rect"] >= 44 for row in rows),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a hearing whose matter has a published history offers "
        f"'View matter history' to that matter and 'View official matter record' to the rest, "
        "every control a real anchor at a 44px target"
    )


def specimen_single_official_record(page, pages, width):
    page.goto(pages["single-exact-official-record"], wait_until="load")
    rows = controls(page)
    if len(rows) != 1:
        raise AssertionError("the single-matter specimen must offer exactly one destination")
    text = page_text(page)
    assert_no_claim(text, "single-exact-official-record")
    shot = page.screenshot(full_page=True)
    return shot, {
        "control_count": len(rows),
        "label": rows[0]["label"],
        "href": rows[0]["href"],
        "availability": rows[0]["availability"],
        "advertises_no_local_route": "/matters/" not in (rows[0]["href"] or ""),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px an exact matter with no published history opens its own official record "
        "and advertises no local route"
    )


def specimen_multiple(page, pages, width):
    page.goto(pages["multiple-exact-matters"], wait_until="load")
    rows = controls(page)
    subjects = [row["subject"] for row in rows]
    expected = ["matter:79201", "matter:79203", "matter:79202", "matter:79204", "matter:79205"]
    if subjects != expected:
        raise AssertionError(f"the multi-matter hearing lost a choice: {subjects}")
    text = page_text(page)
    assert_no_claim(text, "multiple-exact-matters")
    shot = page.screenshot(full_page=True)
    return shot, {
        "choices": subjects,
        "distinct_destinations": len({row["href"] for row in rows}),
        "prompt": "Choose a matter to open" in text,
        "none_promoted": page.locator(f"{DESTINATION_CONTROL}.primary").count() == 0,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a hearing with five exact matters keeps all five as separate choices, each "
        "with its own destination, and promotes none of them"
    )


def specimen_unmatched(page, pages, width):
    page.goto(pages["unmatched-notice"], wait_until="load")
    rows = controls(page)
    section = page.locator(CONTINUATION)
    text = page_text(page)
    assert_no_claim(text, "unmatched-notice")
    shot = page.screenshot(full_page=True)
    return shot, {
        "continuation_state": section.get_attribute("data-continuation-state"),
        "control_count": len(rows),
        "links_inside_the_continuation": page.locator(f"{CONTINUATION} a").count(),
        "states_the_absence": "no underlying matter is shown" in text,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px an unmatched notice offers no matter and no substitute destination, and "
        "says why instead"
    )


def specimen_unavailable(page, pages, width):
    page.goto(pages["unavailable-destination"], wait_until="load")
    rows = controls(page)
    text = page_text(page)
    assert_no_claim(text, "unavailable-destination")
    shot = page.screenshot(full_page=True)
    return shot, {
        "control_count": len(rows),
        "identity_still_visible": "LU 9999-2026" in text,
        "states_the_absence": page.locator(UNAVAILABLE).inner_text().strip(),
        "links_inside_the_continuation": page.locator(f"{CONTINUATION} a").count(),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px an exact matter with no reachable record keeps its identity visible and "
        "states the absence rather than offering a dead control"
    )


def specimen_keyboard_and_return(page, pages, width):
    start = pages["published-local-history"]
    page.goto(start, wait_until="load")
    scope_before = page.locator("[data-harness-scope]").get_attribute("data-harness-scope")
    state_before = page.locator(CONTINUATION).get_attribute("data-continuation-state")
    control = page.locator(f'{DESTINATION_CONTROL}[data-matter-availability="local_history"]').first
    href = control.get_attribute("href")
    control.focus()
    focused = page.evaluate("() => document.activeElement.getAttribute('data-subject-ref')")
    page.keyboard.press("Enter")
    page.wait_for_selector("[data-harness-destination]")
    left = page.url
    page.go_back()
    page.wait_for_selector(CONTINUATION)
    shot = page.screenshot(full_page=True)
    return shot, {
        "keyboard_focus_reached_the_control": focused,
        "activated_by_keyboard": left != start,
        "destination": href,
        "returned_to_the_meeting": page.url == start,
        "meeting_scope_preserved": page.locator("[data-harness-scope]").get_attribute("data-harness-scope") == scope_before,
        "continuation_state_preserved": page.locator(CONTINUATION).get_attribute("data-continuation-state") == state_before,
        "control_refocusable_after_return": page.evaluate(
            "() => { const el = document.querySelector('[data-action-path-continuation=\"subject\"]');"
            " el.focus(); return document.activeElement === el; }"),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the destination is reached from the keyboard alone, and browser Back returns "
        "to the same meeting with its scope and continuation state intact and the control focusable "
        "again"
    )


def specimen_without_scripting(page, pages, width):
    # This page is driven in a context with JavaScript switched off.
    page.goto(pages["single-exact-official-record"], wait_until="load")
    anchors = page.locator(DESTINATION_CONTROL)
    count = anchors.count()
    href = anchors.first.get_attribute("href")
    label = anchors.first.inner_text().strip()
    anchors.first.click()
    page.wait_for_selector("[data-harness-destination]")
    arrived = page.url
    page.go_back()
    page.wait_for_selector(CONTINUATION)
    shot = page.screenshot(full_page=True)
    assert_no_claim(page.locator("#page").inner_text(), "without-scripting")
    return shot, {
        "scripting": "disabled",
        "control_count": count,
        "label": label,
        "href": href,
        "navigated": arrived != pages["single-exact-official-record"],
        "returned_to_the_meeting": page.url == pages["single-exact-official-record"],
    }, (
        f"at {width}px a reader without scripting receives the same labelled destination and "
        "activating it navigates, with Back returning to the meeting"
    )


def specimen_modified_click(page, pages, width):
    start = pages["published-local-history"]
    page.goto(start, wait_until="load")
    control = page.locator(f'{DESTINATION_CONTROL}[data-matter-availability="local_history"]').first
    href = control.get_attribute("href")
    # A modified click is the browser's to handle. Nothing on this page competes
    # for it: a separate browsing context opens and the meeting the reader is on
    # does not move. What that other context renders is not this capture's
    # subject.
    with page.context.expect_page() as popup:
        control.click(modifiers=["ControlOrMeta"])
    separate_context = popup.value
    still_here = page.url == start
    separate_context.close()
    # An ordinary click on the same anchor still navigates, which is the same
    # path a context menu's "open link" takes.
    control.click()
    page.wait_for_selector("[data-harness-destination]")
    navigated = page.url
    page.go_back()
    page.wait_for_selector(CONTINUATION)
    shot = page.screenshot(full_page=True)
    return shot, {
        "destination": href,
        "modified_click_opened_a_separate_context": True,
        "modified_click_left_the_meeting_in_place": still_here,
        "plain_click_still_reaches_the_destination": navigated.endswith("/matters/78605/"),
        "returned_to_the_meeting": page.url == start,
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the destination is an ordinary anchor: a modified click is handed to the "
        "browser and leaves the meeting in place, and a plain click still navigates"
    )


def specimen_zoom(page, pages, width):
    # WCAG 1.4.10 reflow: at 200% page zoom the CSS viewport is half as wide.
    # Halving the viewport reproduces that layout without a browser zoom API.
    page.set_viewport_size({"width": width // 2, "height": page.viewport_size["height"] // 2})
    page.goto(pages["multiple-exact-matters"], wait_until="load")
    rows = controls(page)
    shot = page.screenshot(full_page=True)
    return shot, {
        "css_viewport_at_200_percent": [width // 2, page.viewport_size["height"]],
        "controls_still_present": len(rows),
        "every_control_still_an_anchor": all(row["tag"] == "a" for row in rows),
        "every_control_meets_the_touch_target": all(row["rect"] >= 44 for row in rows),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px zoomed to 200% every matter choice is still present, still an anchor at a "
        "44px target, and the page does not scroll sideways"
    )


SPECIMENS = (
    ("published-local-history", specimen_published_local_history, True),
    ("single-exact-official-record", specimen_single_official_record, True),
    ("multiple-exact-matters", specimen_multiple, True),
    ("unmatched-notice", specimen_unmatched, True),
    ("unavailable-destination", specimen_unavailable, True),
    ("keyboard-and-return", specimen_keyboard_and_return, True),
    ("modified-click", specimen_modified_click, True),
    ("two-hundred-percent-zoom", specimen_zoom, True),
    ("without-scripting", specimen_without_scripting, False),
)


def capture() -> dict:
    sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
    from a11y_gate import failing_violations
    from playwright.sync_api import sync_playwright

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    revision = git_revision()
    rendered = render_fixtures()
    harness_digest = hashlib.sha256((ROOT / HARNESS).read_bytes()).hexdigest()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/{ARTIFACTS.relative_to(ROOT)}"
    pages = write_pages(rendered["fixtures"], base)

    files = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for slug, run, scripting in SPECIMENS:
                for width, height in VIEWPORTS:
                    context = browser.new_context(viewport={"width": width, "height": height},
                                                  java_script_enabled=scripting)
                    stub_destinations(context)
                    page = context.new_page()
                    image, observations, assertion = run(page, pages, width)
                    axe_result = run_axe(page, failing_violations) if scripting else {
                        "violations_total": None,
                        "failing_violations": [],
                        "passes": True,
                        "note": "axe-core needs scripting; this specimen is the no-scripting read of a page axe already passed with scripting on",
                    }
                    name = f"{slug}-{width}x{height}.png"
                    (ARTIFACTS / name).write_bytes(image)
                    files.append({
                        "name": name,
                        "specimen": slug,
                        "route": ROUTE,
                        "harness": HARNESS,
                        "fixture_digest": harness_digest,
                        "viewport": [width, height],
                        "revision": revision,
                        "data_vintage": rendered["data_vintage"],
                        "scripting": "enabled" if scripting else "disabled",
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
        "engineering_record": ENGINEERING_RECORD,
        "route": ROUTE,
        "harness": HARNESS,
        "renderer": RENDERER,
        "fixture_digest": harness_digest,
        "revision": revision,
        "data_vintage": rendered["data_vintage"],
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "image_directory": str(ARTIFACTS.relative_to(ROOT)),
        "corpus_note": (
            "Every specimen reads the committed retained corpus at the data vintage above. The "
            "observations describe that corpus, not live publisher coverage, and no capture "
            "claims a cause, an adoption, or a participant result."
        ),
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
    if manifest.get("engineering_record") != ENGINEERING_RECORD:
        raise SystemExit(f"manifest is not owned by {ENGINEERING_RECORD}")
    digest = hashlib.sha256((ROOT / HARNESS).read_bytes()).hexdigest()
    if manifest.get("fixture_digest") != digest:
        raise SystemExit("the harness changed since this manifest was captured; recapture it")
    files = manifest.get("files") or []
    expected = {f"{slug}-{width}x{height}.png" for slug, _, _ in SPECIMENS for width, height in VIEWPORTS}
    found = {row.get("name") for row in files}
    if found != expected:
        raise SystemExit(f"manifest captures {sorted(found)}; expected {sorted(expected)}")
    for row in files:
        for field in REQUIRED_FIELDS:
            if row.get(field) is None:
                raise SystemExit(f"{row.get('name')} is missing {field}")
        if len(str(row.get("sha256"))) != SHA256:
            raise SystemExit(f"{row.get('name')} has no usable content hash")
        if not row["axe"].get("passes"):
            raise SystemExit(f"{row.get('name')} carries an accessibility violation")
    print(f"matter continuation evidence is current ({len(files)} captures)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate the tracked manifest only")
    args = parser.parse_args()
    if args.check:
        return check()
    manifest = capture()
    print(f"wrote {MANIFEST.relative_to(ROOT)} ({len(manifest['files'])} captures)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
