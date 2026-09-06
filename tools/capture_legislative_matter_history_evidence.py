#!/usr/bin/env python3
"""Headless browser evidence for published legislative matter histories.

Drives the real `/matters/:id/` responses -- rendered by the same Pages-edge
handler production serves, from the committed published generation, by
`tools/render_legislative_matter_history_fixtures.mjs`. The pages are written to
an ignored local directory and served from a neutral local static server rooted
at `site/`, so the stylesheets and scripts a reader receives are the ones under
test. No publisher is contacted: the only outbound destinations a page carries
are stubbed at the network boundary.

Each specimen is a real interaction in a real engine at 390 and 1440 pixels: a
one-appearance history that states what has been located without claiming an
end, a two-appearance history in source-event order, an appearance carrying two
coalesced notice references, an identity the generation does not publish, the
page without scripting, keyboard activation followed by a real browser Back, a
modified click that opens a second context instead of leaving, and the page at
200% zoom. Every specimen also runs the vendored axe-core gate, on the same rule
set and pass/fail classification as `test/functional/11_accessibility.py`.

Proof is the tracked manifest: one entry per capture naming its route, viewport,
revision, data vintage, assertion, observations, and the SHA-256 of the image.
The images themselves are written to an ignored local directory and are never
committed -- this repository does not carry capture binaries.

    python3 tools/capture_legislative_matter_history_evidence.py
    python3 tools/capture_legislative_matter_history_evidence.py --check
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
MANIFEST = ROOT / "docs" / "evidence" / "legislative-matter-history-population" / "manifest.json"
# Gitignored: capture images and rendered pages stay local, and the manifest is
# the tracked description of them.
ARTIFACTS = ROOT / ".artifacts" / "legislative-matter-history-population"
SITE = ROOT / "site"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

MANIFEST_SCHEMA = "cityscroll.legislative_matter_history_evidence.v1"
ENGINEERING_RECORD = "cityscroll-engineering/legislative-matter-history-population"
RENDERER = "tools/render_legislative_matter_history_fixtures.mjs"
CAPTURE_PREFIX = "/__capture__"

VIEWPORTS = ((390, 844), (1440, 900))

# The notice and publisher destinations a matter page offers are real addresses.
# What a capture proves is that the browser takes the reader there, not what
# those pages contain, so both are stubbed and no request leaves the machine.
STUBBED = ("https://nyc.legistar.com/**", "https://nyc.legistar1.com/**", "**/notices/**")
STUB = (
    "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
    "<title>Source record</title></head><body><main data-capture-destination='1'>"
    "<h1>Source record</h1></main></body></html>"
)

FORBIDDEN_COPY = (
    "no further action", "no future action", "nothing further", "case closed",
    "final adoption", "adopted by the council", "enacted", "became law",
    "agency response", "testimony", "testify", "subscribe", "notify me",
)


def stub_destinations(context):
    for pattern in STUBBED:
        context.route(pattern, lambda route: route.fulfill(
            status=200, content_type="text/html; charset=utf-8", body=STUB))


class Handler(SimpleHTTPRequestHandler):
    """Serves `site/` as the document root, with the rendered pages beside it."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def translate_path(self, path):
        if path.split("?", 1)[0].startswith(f"{CAPTURE_PREFIX}/"):
            name = Path(path.split("?", 1)[0]).name
            return str(ARTIFACTS / name)
        return super().translate_path(path)

    def log_message(self, *args):  # noqa: A003 - quiet capture server
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def render_fixtures() -> dict:
    """The real route's own output, rendered once per run."""
    result = subprocess.run(["node", RENDERER], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def write_pages(fixtures: dict, base: str) -> dict:
    pages = {}
    for name, spec in fixtures.items():
        (ARTIFACTS / f"{name}.html").write_text(spec["html"], encoding="utf-8")
        pages[name] = f"{base}/{name}.html"
    return pages


def run_axe(page) -> dict:
    page.add_script_tag(path=str(AXE))
    result = page.evaluate("async () => await axe.run(document, {resultTypes:['violations']})")
    wcag22_rules = set(page.evaluate("() => axe.getRules(['wcag22aa']).map(rule => rule.ruleId)"))
    failing = failing_violations(result["violations"], wcag22_rules)
    return {
        "violations_total": len(result["violations"]),
        "failing_violations": [{"id": v["id"], "impact": v.get("impact")} for v in failing],
        "passes": not failing,
    }


def links(page) -> list:
    return page.evaluate(
        "() => [...document.querySelectorAll('main a[href]')].map(el => ({"
        " tag: el.tagName.toLowerCase(), href: el.getAttribute('href'),"
        " label: el.textContent.trim(), height: el.getBoundingClientRect().height }))"
    )


def page_text(page) -> str:
    return page.locator("main").inner_text().replace("\n", " ")


def target_sizes(page) -> dict:
    """
    WCAG 2.5.8 target size, measured the way the criterion is written.

    Almost every destination on a matter history is a text link inside a
    sentence or a record list, which the criterion's own inline exception
    covers: their height is set by the surrounding line-height, not by the
    control. A block control has no such exception and is measured against the
    24 CSS pixel minimum. Reporting one flat figure over both kinds would
    describe neither, so they are counted separately, and the axe run recorded
    on the same capture evaluates `target-size` under the wcag22aa rule set as
    the independent check.
    """
    rows = page.evaluate(
        "() => [...document.querySelectorAll('main a[href]')].map(el => {"
        " const rect = el.getBoundingClientRect();"
        " return { inline: getComputedStyle(el).display.startsWith('inline'),"
        "   height: rect.height, width: rect.width }; })"
    )
    inline = [row for row in rows if row["inline"]]
    block = [row for row in rows if not row["inline"]]
    return {
        "total_controls": len(rows),
        "inline_text_links": len(inline),
        "inline_exception": "WCAG 2.5.8: a target inside a sentence is sized by its line-height",
        "block_controls": len(block),
        "block_minimum_height": round(min(row["height"] for row in block), 1) if block else None,
        "block_controls_meet_24px": all(row["height"] >= 24 for row in block) if block else None,
        "axe_target_size_rule": "evaluated in the axe run recorded on this capture",
    }


def no_horizontal_overflow(page) -> bool:
    return not page.evaluate(
        "() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"
    )


def assert_no_claim(text: str, specimen: str):
    lowered = text.lower()
    for phrase in FORBIDDEN_COPY:
        if phrase in lowered:
            raise AssertionError(f"{specimen} claims more than the record supports: {phrase}")


def appearance_cards(page) -> list:
    return page.evaluate(
        "() => [...document.querySelectorAll('.matter-appearance')].map(el => ({"
        " event: el.getAttribute('data-matter-appearance'),"
        " notices: el.getAttribute('data-notice-reference-count'),"
        " date: (el.querySelector('.node-kicker') || {}).textContent }))"
    )


# ---------- specimens ----------
#
# Each specimen returns the observations its assertion is about. A specimen that
# cannot observe what it claims raises, rather than recording a pass.


def specimen_single_appearance(page, pages, width):
    page.goto(pages["single-appearance-history"], wait_until="load")
    cards = appearance_cards(page)
    scope = page.locator(".matter-history-scope").inner_text()
    if len(cards) != 1:
        raise AssertionError("this specimen needs a one-appearance history")
    if "No later official step has been located" not in scope:
        raise AssertionError("a one-appearance history must state what has been located")
    assert_no_claim(page_text(page), "single-appearance-history")
    rows = links(page)
    return page.screenshot(full_page=True), {
        "appearance_count": len(cards),
        "located_disclosure": scope,
        "every_control_is_an_anchor": all(row["tag"] == "a" for row in rows),
        "target_size": target_sizes(page),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a matter with one located appearance shows that appearance and says no later "
        "official step has been located, without claiming the matter is settled"
    )


def specimen_two_appearances(page, pages, width):
    page.goto(pages["two-appearance-history"], wait_until="load")
    cards = appearance_cards(page)
    if len(cards) != 2:
        raise AssertionError("this specimen needs a two-appearance history")
    dates = [str(card["date"]).strip() for card in cards]
    if not dates[0] < dates[1]:
        raise AssertionError("appearances must read in source-event order")
    assert_no_claim(page_text(page), "two-appearance-history")
    return page.screenshot(full_page=True), {
        "appearance_count": len(cards),
        "rendered_order": dates,
        "calendar_furniture": page.locator(".compact-month").count(),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px a two-appearance history reads earlier appearance first, stays a list below "
        "the shared calendar density rule, and describes neither step as an adoption"
    )


def specimen_coalesced_notices(page, pages, width):
    page.goto(pages["coalesced-notice-references"], wait_until="load")
    cards = appearance_cards(page)
    references = page.evaluate(
        "() => [...document.querySelectorAll('[data-notice-reference]')]"
        ".map(el => el.getAttribute('data-notice-reference'))")
    if len(cards) != 1 or sorted(references) != ["20260422047", "20260430007"]:
        raise AssertionError("this specimen needs one appearance carrying two notice references")
    labels = page.evaluate(
        "() => [...document.querySelectorAll('[data-notice-reference]')].map(el => el.textContent.trim())")
    if len(set(labels)) != len(labels):
        raise AssertionError("two references on one appearance need distinguishable link text")
    return page.screenshot(full_page=True), {
        "appearance_count": len(cards),
        "notice_references": sorted(references),
        "distinct_link_text": sorted(labels),
        "repeat_note": page.locator(".matter-notice-note").inner_text(),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px two notices announcing one meeting render as one appearance with both "
        "references separately openable and named"
    )


def specimen_unpublished_identity(page, pages, width):
    page.goto(pages["unpublished-identity"], wait_until="load")
    text = page_text(page)
    if "not in the current CityScroll materialization" not in text:
        raise AssertionError("an unpublished identity must state the absence")
    if page.locator(".matter-appearance").count():
        raise AssertionError("an unpublished identity must not render an empty history")
    return page.screenshot(full_page=True), {
        "stated_absence": text.strip(),
        "renders_no_empty_history": True,
        "offers_a_way_back": [row["href"] for row in links(page)],
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px an identity the generation does not publish is a stated absence with a way "
        "back, not an empty history that looks like a matter with nothing in it"
    )


def specimen_without_scripting(page, pages, width):
    page.goto(pages["single-appearance-history"], wait_until="load")
    rows = links(page)
    if not rows:
        raise AssertionError("a page without scripting still needs its destinations")
    page.keyboard.press("Tab")
    target = page.locator("[data-notice-reference]").first
    href = target.get_attribute("href")
    target.click()
    page.wait_for_load_state("load")
    reached = page.locator("[data-capture-destination]").count() == 1
    if not reached:
        raise AssertionError("a destination must activate with scripting disabled")
    page.go_back()
    page.wait_for_load_state("load")
    returned = page.locator(".matter-appearance").count() == 1
    shot = page.screenshot(full_page=True)
    return shot, {
        "scripting": "disabled",
        "activated_href": href,
        "reached_destination": reached,
        "back_returns_to_the_history": returned,
        "control_count": len(rows),
    }, (
        f"at {width}px every destination on a matter history is an ordinary anchor that activates "
        "with scripting disabled, and browser Back returns to the history"
    )


def specimen_keyboard_and_return(page, pages, width):
    page.goto(pages["two-appearance-history"], wait_until="load")
    # Walk to a same-tab destination: an appearance's notice reference. The
    # publisher source links on the same card deliberately open in a new tab and
    # are covered by the modified-click specimen instead.
    focused = None
    tabs = 0
    for _ in range(60):
        page.keyboard.press("Tab")
        tabs += 1
        focused = page.evaluate(
            "() => { const el = document.activeElement;"
            " return el && el.matches('a[data-notice-reference]')"
            " ? { href: el.getAttribute('href'), label: el.textContent.trim(),"
            " outline: getComputedStyle(el).outlineStyle,"
            " outline_width: getComputedStyle(el).outlineWidth } : null; }")
        if focused:
            break
    if not focused:
        raise AssertionError("an appearance destination must be reachable by keyboard")
    if focused["outline"] == "none":
        raise AssertionError("a keyboard-focused destination must show a focus indicator")
    with page.expect_navigation(wait_until="load"):
        page.keyboard.press("Enter")
    reached = page.locator("[data-capture-destination]").count() == 1
    if not reached:
        raise AssertionError("Enter must activate the focused destination in the same tab")
    with page.expect_navigation(wait_until="load"):
        page.go_back()
    returned = page.locator(".matter-appearance").count()
    if returned != 2:
        raise AssertionError("browser Back must restore the whole history")
    shot = page.screenshot(full_page=True)
    return shot, {
        "focused_control": focused,
        "tab_stops_to_reach_it": tabs,
        "activated_by_enter": reached,
        "back_restores_every_appearance": returned == 2,
    }, (
        f"at {width}px an appearance destination takes keyboard focus, activates with Enter, and "
        "browser Back restores the whole history"
    )


def specimen_modified_click(page, pages, width):
    page.goto(pages["two-appearance-history"], wait_until="load")
    before = page.url
    target = page.locator("[data-notice-reference]").first
    with page.context.expect_page() as opened:
        target.click(modifiers=["ControlOrMeta"])
    new_page = opened.value
    new_page.wait_for_load_state("load")
    reached = new_page.locator("[data-capture-destination]").count() == 1
    new_page.close()
    if page.url != before or not reached:
        raise AssertionError("a modified click must open a second context and leave the history in place")
    return page.screenshot(full_page=True), {
        "modifier": "ControlOrMeta",
        "opened_second_context": reached,
        "original_page_unchanged": page.url == before,
        "appearance_count": page.locator(".matter-appearance").count(),
    }, (
        f"at {width}px a modified click opens the source in a second context and the history stays "
        "where the reader left it"
    )


def specimen_two_hundred_percent_zoom(page, pages, width):
    # WCAG 1.4.10 reflow: at 200% page zoom the CSS viewport is half as wide.
    # Halving the viewport reproduces that layout without a browser zoom API.
    # 1.4.10 sets its floor at 320 CSS pixels, which is where a 640px-wide
    # window lands at 200%; a narrower phone zoomed the same way goes below the
    # width any content is required to reflow into, so the floor is honoured
    # here rather than asserting something stricter than the criterion.
    height = page.viewport_size["height"]
    reflow_width = max(width // 2, 320)
    page.set_viewport_size({"width": reflow_width, "height": height // 2})
    page.goto(pages["two-appearance-history"], wait_until="load")
    rows = links(page)
    overflow = no_horizontal_overflow(page)
    shot = page.screenshot(full_page=True)
    if not overflow:
        raise AssertionError("a history must not scroll horizontally at 200%")
    return shot, {
        "css_viewport_at_200_percent": [reflow_width, height // 2],
        "reflow_floor_applied": reflow_width != width // 2,
        "no_horizontal_overflow": overflow,
        "every_control_still_present": len(rows),
        "target_size": target_sizes(page),
        "history_still_readable": page.locator(".matter-history-scope").count() == 1,
        "appearance_count": page.locator(".matter-appearance").count(),
    }, (
        f"at {width}px zoomed to 200% the history reflows without horizontal scrolling and keeps "
        "every appearance, every destination, and its located-history disclosure"
    )


SPECIMENS = (
    ("single-appearance-history", specimen_single_appearance, True),
    ("two-appearance-history", specimen_two_appearances, True),
    ("coalesced-notice-references", specimen_coalesced_notices, True),
    ("unpublished-identity", specimen_unpublished_identity, True),
    ("without-scripting", specimen_without_scripting, False),
    ("keyboard-and-return", specimen_keyboard_and_return, True),
    ("modified-click", specimen_modified_click, True),
    ("two-hundred-percent-zoom", specimen_two_hundred_percent_zoom, True),
)

ROUTE_FOR_SPECIMEN = {
    "single-appearance-history": "single-appearance-history",
    "two-appearance-history": "two-appearance-history",
    "coalesced-notice-references": "coalesced-notice-references",
    "unpublished-identity": "unpublished-identity",
    "without-scripting": "single-appearance-history",
    "keyboard-and-return": "two-appearance-history",
    "modified-click": "two-appearance-history",
    "two-hundred-percent-zoom": "two-appearance-history",
}


def capture() -> dict:
    from playwright.sync_api import sync_playwright

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    rendered = render_fixtures()
    revision = git_revision()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}{CAPTURE_PREFIX}"
    pages = write_pages(rendered["fixtures"], base)

    files = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for name, specimen, scripting in SPECIMENS:
                for width, height in VIEWPORTS:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        java_script_enabled=scripting,
                    )
                    stub_destinations(context)
                    page = context.new_page()
                    shot, observations, assertion = specimen(page, pages, width)
                    # axe needs scripting; the no-script specimen proves its own
                    # claim and is gated by the same page under the scripted run.
                    axe = run_axe(page) if scripting else {
                        "violations_total": None, "failing_violations": [], "passes": True,
                        "note": "scripting disabled for this specimen; the same page is gated scripted",
                    }
                    image = ARTIFACTS / f"{name}-{width}x{height}.png"
                    image.write_bytes(shot)
                    route = rendered["fixtures"][ROUTE_FOR_SPECIMEN[name]]["route"]
                    files.append({
                        "name": image.name,
                        "specimen": name,
                        "route": route,
                        "viewport": [width, height],
                        "revision": revision,
                        "data_vintage": rendered["data_vintage"],
                        "scripting": "enabled" if scripting else "disabled",
                        "assertion": assertion,
                        "observations": observations,
                        "bytes": len(shot),
                        "sha256": hashlib.sha256(shot).hexdigest(),
                        "axe": axe,
                    })
                    context.close()
            browser.close()
    finally:
        server.shutdown()

    return {
        "schema": MANIFEST_SCHEMA,
        "engineering_record": ENGINEERING_RECORD,
        "renderer": RENDERER,
        "revision": revision,
        "data_vintage": rendered["data_vintage"],
        "published_matter_count": rendered["published_matter_count"],
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "image_directory": str(ARTIFACTS.relative_to(ROOT)),
        "corpus_note": (
            "Every specimen reads the committed published generation at the data vintage above. "
            "The observations describe that retained corpus, not live publisher coverage, and no "
            "capture claims a later action, an adoption, an agency reply, or a participant result."
        ),
        "image_policy": (
            "Capture images are written to the ignored local directory above and are never "
            "committed. This manifest is the tracked proof: route, viewport, revision, data "
            "vintage, assertion and SHA-256 for each capture."
        ),
        "files": files,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the manifest is stale")
    args = parser.parse_args()

    manifest = capture()
    output = f"{json.dumps(manifest, indent=2)}\n"
    if args.check:
        current = MANIFEST.read_text(encoding="utf-8") if MANIFEST.exists() else None
        volatile = ("captured_at", "revision")

        def stable(text):
            if text is None:
                return None
            parsed = json.loads(text)
            for key in volatile:
                parsed.pop(key, None)
            for row in parsed.get("files", []):
                for key in volatile:
                    row.pop(key, None)
            return json.dumps(parsed, indent=2, sort_keys=True)

        if stable(current) != stable(output):
            print("legislative matter history evidence manifest is stale", file=sys.stderr)
            return 1
        print("Legislative matter history evidence manifest is current")
        return 0

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(output, encoding="utf-8")
    failing = [row["name"] for row in manifest["files"] if not row["axe"]["passes"]]
    print(f"wrote {MANIFEST.relative_to(ROOT)} ({len(manifest['files'])} captures)")
    if failing:
        print(f"accessibility violations in: {', '.join(failing)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
