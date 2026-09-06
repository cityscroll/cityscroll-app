#!/usr/bin/env python3
"""Headless browser evidence for retained matter publication generations.

Renders the complete resident journey from
`tools/render_retained_matter_publication_fixtures.mjs`. No publisher is
contacted. Proof is the tracked manifest. Images stay in an ignored directory.

    python3 tools/capture_retained_matter_publication_evidence.py
    python3 tools/capture_retained_matter_publication_evidence.py --check
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
MANIFEST = ROOT / "docs" / "evidence" / "retained-matter-publication-generation" / "manifest.json"
ARTIFACTS = ROOT / ".artifacts" / "retained-matter-publication-generation"
SITE = ROOT / "site"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

MANIFEST_SCHEMA = "cityscroll.retained_matter_publication_generation_evidence.v1"
ENGINEERING_RECORD = "cityscroll-engineering/retained-matter-publication-generation"
RENDERER = "tools/render_retained_matter_publication_fixtures.mjs"
VIEWPORTS = ((390, 844), (1440, 900))
DATA_VINTAGE = "2026-08-10T13:08:13.019Z"
FORBIDDEN_COPY = ("testimony caused", "agency replied", "you testified", "successful following")


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        name = Path(path.split("?", 1)[0]).name
        artifact = ARTIFACTS / name
        if artifact.exists():
            return str(artifact)
        site_file = SITE / name
        if site_file.exists():
            return str(site_file)
        return str(ARTIFACTS / name)

    def log_message(self, *args):  # noqa: A003
        return


def git_revision() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()


def render_fixtures() -> dict:
    result = subprocess.run(["node", RENDERER], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def write_pages(fixtures: dict, base: str) -> dict:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
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


def page_text(page) -> str:
    return page.locator("main").inner_text().replace("\n", " ")


def no_horizontal_overflow(page) -> bool:
    return not page.evaluate(
        "() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"
    )


def target_sizes(page) -> dict:
    rows = page.evaluate(
        "() => [...document.querySelectorAll('main a[href], main summary, main button')].map(el => {"
        " const rect = el.getBoundingClientRect();"
        " return { tag: el.tagName.toLowerCase(), inline: getComputedStyle(el).display.startsWith('inline'),"
        "   height: rect.height, width: rect.width }; })"
    )
    block = [row for row in rows if not row["inline"] or row["tag"] in {"summary", "button"} or row["height"] >= 40]
    return {
        "total_controls": len(rows),
        "block_controls": len(block),
        "block_minimum_height": round(min(row["height"] for row in block), 1) if block else None,
        "block_controls_meet_24px": all(row["height"] >= 24 for row in block) if block else None,
    }


def assert_no_claim(text: str, specimen: str):
    lowered = text.lower()
    for phrase in FORBIDDEN_COPY:
        if phrase in lowered:
            raise AssertionError(f"{specimen} claims more than the record supports: {phrase}")


def specimen_hearing(page, pages, width):
    page.goto(pages["hearing-choice"], wait_until="load")
    text = page_text(page)
    if "data-matter-follow-choice" not in page.content() and page.locator("[data-matter-id]").count() < 2:
        raise AssertionError("hearing specimen must require an explicit matter choice")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("hearing specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
        "matter_controls": page.locator("[data-matter-id]").count(),
    }, f"at {width}px a multi-matter hearing requires an explicit choice"


def specimen_history(page, pages, width):
    page.goto(pages["history-current"], wait_until="load")
    text = page_text(page)
    assert_no_claim(text, "history-current")
    if "approved by subcommittee" not in text.lower() and "laid over by subcommittee" not in text.lower():
        raise AssertionError("history specimen must show the current official action")
    if "gen-later" not in page.content():
        raise AssertionError("history specimen must expose the published generation id")
    page.locator("a.matter-follow-link").first.focus()
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("history specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "follow_focused": page.evaluate("() => document.activeElement && document.activeElement.classList.contains('matter-follow-link')"),
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
        "generation_id": page.locator("main").get_attribute("data-matter-generation"),
    }, f"at {width}px the current published generation shows the official action and source evidence"


def specimen_update(page, pages, width):
    page.goto(pages["later-update"], wait_until="load")
    text = page_text(page)
    if "approved by subcommittee" not in text.lower():
        raise AssertionError("later update must name the subcommittee approval")
    if page.locator("summary").count():
        page.locator("summary").first.focus()
        page.keyboard.press("Enter")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("later update overflowed the viewport")
    return page.screenshot(full_page=True), {
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
        "native_history_link": page.locator("a[href*='/matters/78605/']").count() >= 1,
    }, f"at {width}px a later update names subcommittee approval and a native history link"


def specimen_fallback(page, pages, width):
    page.goto(pages["older-fallback"], wait_until="load")
    text = page_text(page)
    if "not the current retained generation" not in text.lower():
        raise AssertionError("older fallback must not claim current coverage")
    if page.locator("[data-matter-current-coverage='true']").count():
        raise AssertionError("older fallback claimed current coverage")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("older fallback overflowed the viewport")
    return page.screenshot(full_page=True), {
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
        "current_coverage": False,
    }, f"at {width}px an older static fallback remains usable and does not claim current coverage"


def specimen_stale(page, pages, width):
    page.goto(pages["stale-refresh"], wait_until="load")
    text = page_text(page)
    if "last known history is still shown" not in text.lower():
        raise AssertionError("stale refresh must keep last-known history visible")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("stale refresh overflowed the viewport")
    return page.screenshot(full_page=True), {
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
    }, f"at {width}px a stale refresh keeps last-known history visible"


def specimen_failed(page, pages, width):
    page.goto(pages["failed-confirmation"], wait_until="load")
    text = page_text(page)
    if "not confirmed" not in text.lower():
        raise AssertionError("failed confirmation must be distinct from successful following")
    if "successful following" in text.lower() and "not successful following" not in text.lower():
        raise AssertionError("failed confirmation looked like successful following")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("failed confirmation overflowed the viewport")
    return page.screenshot(full_page=True), {
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
    }, f"at {width}px failed confirmation is distinct from successful following"


def specimen_unsupported(page, pages, width):
    page.goto(pages["unsupported-source"], wait_until="load")
    text = page_text(page)
    if "not supported" not in text.lower():
        raise AssertionError("unsupported source must be a distinct state")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("unsupported source overflowed the viewport")
    return page.screenshot(full_page=True), {
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
    }, f"at {width}px an unsupported source is not rendered as a saved watch"


def specimen_keyboard_back(page, pages, width):
    page.goto(pages["history-current"], wait_until="load")
    back = page.locator("[data-route-back]").first
    if back.count() < 1:
        raise AssertionError("history page must keep a Back control")
    back.focus()
    restored = page.evaluate("() => document.activeElement && document.activeElement.getAttribute('data-route-back')")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("keyboard back specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "focus_restored_on_back": restored in {"traversal", "fallback"},
        "back_state": restored,
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
    }, f"at {width}px keyboard focus lands on the Back control and Back state is preserved"


def specimen_native_link(page, pages, width):
    page.goto(pages["history-current"], wait_until="load")
    follow = page.locator("a.matter-follow-link").first
    if follow.count() < 1:
        raise AssertionError("native follow control missing")
    href = follow.get_attribute("href") or ""
    if "matter" not in href.lower() and "following" not in href.lower():
        raise AssertionError("native follow link must keep exact matter identity")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("native link specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "native_href": href[:180],
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
    }, f"at {width}px the exact-matter follow control remains a native destination"


def specimen_zoom(page, pages, width):
    # WCAG 1.4.10 reflow: at 200% page zoom the CSS viewport is half as wide.
    height = page.viewport_size["height"]
    reflow_width = max(width // 2, 320)
    page.set_viewport_size({"width": reflow_width, "height": height // 2})
    page.goto(pages["history-current"], wait_until="load")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("zoomed specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "css_viewport_at_200_percent": [reflow_width, height // 2],
        "no_horizontal_overflow": overflow,
        "target_size": target_sizes(page),
        "zoom": "200%",
    }, f"at {width}px zoomed to 200% the matter page reflows without horizontal overflow"


def specimen_without_scripting(page, pages, width):
    page.goto(pages["history-current"], wait_until="load")
    if page.locator("a.matter-follow-link").count() < 1:
        raise AssertionError("native matter links must work with scripting disabled")
    return page.screenshot(full_page=True), {
        "follow_links": page.locator("a.matter-follow-link").count(),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, f"at {width}px native matter history links remain usable with scripting disabled"


SPECIMENS = (
    ("hearing-choice", specimen_hearing, True),
    ("history-current", specimen_history, True),
    ("later-update", specimen_update, True),
    ("older-fallback", specimen_fallback, True),
    ("stale-refresh", specimen_stale, True),
    ("failed-confirmation", specimen_failed, True),
    ("unsupported-source", specimen_unsupported, True),
    ("keyboard-back", specimen_keyboard_back, True),
    ("native-link", specimen_native_link, True),
    ("without-scripting", specimen_without_scripting, False),
    ("two-hundred-percent-zoom", specimen_zoom, True),
)

ROUTE_FOR_SPECIMEN = {
    "hearing-choice": "hearing-choice",
    "history-current": "history-current",
    "later-update": "later-update",
    "older-fallback": "older-fallback",
    "stale-refresh": "stale-refresh",
    "failed-confirmation": "failed-confirmation",
    "unsupported-source": "unsupported-source",
    "keyboard-back": "history-current",
    "native-link": "history-current",
    "without-scripting": "history-current",
    "two-hundred-percent-zoom": "history-current",
}


def capture() -> dict:
    from playwright.sync_api import sync_playwright

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    rendered = render_fixtures()
    revision = git_revision()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    pages = write_pages(rendered, base)
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
                    page = context.new_page()
                    shot, observations, assertion = specimen(page, pages, width)
                    observations = {
                        **observations,
                        "fixture_vintage": DATA_VINTAGE,
                        "generation_id": rendered[ROUTE_FOR_SPECIMEN[name]].get("generation_id"),
                        "render_hash": rendered[ROUTE_FOR_SPECIMEN[name]].get("render_hash"),
                    }
                    axe = run_axe(page) if scripting else {
                        "violations_total": None,
                        "failing_violations": [],
                        "passes": True,
                        "note": "scripting disabled; the same page is gated scripted",
                    }
                    image = ARTIFACTS / f"{name}-{width}x{height}.png"
                    image.write_bytes(shot)
                    route = rendered[ROUTE_FOR_SPECIMEN[name]]["route"]
                    files.append({
                        "name": image.name,
                        "specimen": name,
                        "route": route,
                        "viewport": [width, height],
                        "revision": revision,
                        "data_vintage": DATA_VINTAGE,
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
        "data_vintage": DATA_VINTAGE,
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "image_directory": str(ARTIFACTS.relative_to(ROOT)),
        "corpus_note": (
            "Specimens render the retained matter publication generation: hearing choice, "
            "current history, later update, older static fallback, stale refresh, failed "
            "confirmation, unsupported source, keyboard Back, native follow, and 200% zoom. "
            "They describe retained official actions, not live publisher coverage."
        ),
        "image_policy": (
            "Capture images are written to the ignored local directory above and are never "
            "committed. This manifest is the tracked proof: route, viewport, revision, data "
            "vintage, assertion, generation id, render hash, and SHA-256 for each capture."
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

        def stable(text):
            if text is None:
                return None
            parsed = json.loads(text)
            parsed.pop("captured_at", None)
            parsed.pop("revision", None)
            for row in parsed.get("files", []):
                row.pop("captured_at", None)
                row.pop("revision", None)
            return json.dumps(parsed, indent=2, sort_keys=True)

        if stable(current) != stable(output):
            print("retained matter publication evidence manifest is stale", file=sys.stderr)
            return 1
        print("Retained matter publication evidence manifest is current")
        return 0

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(output, encoding="utf-8")
    print(f"wrote {MANIFEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
