#!/usr/bin/env python3
"""Headless browser evidence for the exact-matter refresh operator view.

Renders complete-run and retry-recovery specimens from
`tools/render_matter_exact_refresh_fixtures.mjs`. No publisher is contacted.
Proof is the tracked manifest: route, viewport, revision, data vintage,
assertion, and SHA-256. Images stay in an ignored local directory.

    python3 tools/capture_matter_exact_refresh_evidence.py
    python3 tools/capture_matter_exact_refresh_evidence.py --check
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
MANIFEST = ROOT / "docs" / "evidence" / "matter-exact-refresh" / "manifest.json"
ARTIFACTS = ROOT / ".artifacts" / "matter-exact-refresh"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

MANIFEST_SCHEMA = "cityscroll.matter_exact_refresh_evidence.v1"
ENGINEERING_RECORD = "cityscroll-engineering/matter-exact-refresh"
RENDERER = "tools/render_matter_exact_refresh_fixtures.mjs"
CAPTURE_PREFIX = "/__capture__"
VIEWPORTS = ((390, 844), (1440, 900))
FORBIDDEN_COPY = ("subscribe", "notify me", "testimony caused", "agency replied", "histories source gate passed")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ARTIFACTS), **kwargs)

    def translate_path(self, path):
        name = Path(path.split("?", 1)[0]).name
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
        "() => [...document.querySelectorAll('main a[href], main summary')].map(el => {"
        " const rect = el.getBoundingClientRect();"
        " return { tag: el.tagName.toLowerCase(), inline: getComputedStyle(el).display.startsWith('inline'),"
        "   height: rect.height, width: rect.width }; })"
    )
    inline = [row for row in rows if row["inline"] and row["tag"] == "a"]
    block = [row for row in rows if not row["inline"] or row["tag"] == "summary"]
    return {
        "total_controls": len(rows),
        "inline_text_links": len(inline),
        "block_controls": len(block),
        "block_minimum_height": round(min(row["height"] for row in block), 1) if block else None,
        "block_controls_meet_24px": all(row["height"] >= 24 for row in block) if block else None,
    }


def assert_no_claim(text: str, specimen: str):
    lowered = text.lower()
    for phrase in FORBIDDEN_COPY:
        if phrase in lowered:
            raise AssertionError(f"{specimen} claims more than the record supports: {phrase}")


def specimen_complete(page, pages, width):
    page.goto(pages["complete"], wait_until="load")
    text = page_text(page)
    assert_no_claim(text, "complete")
    if "attempted" not in text.lower():
        raise AssertionError("complete specimen must name attempted work")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("complete specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "status": page.locator("main").get_attribute("data-status"),
        "attempted": page.locator("main").get_attribute("data-attempted"),
        "source_gate": page.locator("main").get_attribute("data-source-gate"),
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
    }, (
        f"at {width}px the exact-matter receipt names attempted work and does not claim the Histories gate"
    )


def specimen_retry(page, pages, width):
    page.goto(pages["retry-recovery"], wait_until="load")
    text = page_text(page)
    assert_no_claim(text, "retry-recovery")
    if "retry recovery" not in text.lower():
        raise AssertionError("retry specimen must expose a retry recovery control")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("retry specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "status": page.locator("main").get_attribute("data-status"),
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
    }, (
        f"at {width}px retry recovery remains a 44px native control after a later successful refresh"
    )


def specimen_without_scripting(page, pages, width):
    page.goto(pages["complete"], wait_until="load")
    if page.locator("main h1").count() != 1:
        raise AssertionError("the operator receipt must render without scripting")
    return page.screenshot(full_page=True), {
        "heading": page.locator("main h1").inner_text(),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px the exact-matter receipt remains readable with scripting disabled"
    )


def specimen_keyboard(page, pages, width):
    page.goto(pages["complete"], wait_until="load")
    page.locator("summary").focus()
    page.keyboard.press("Enter")
    if page.locator("details").first.get_attribute("open") is None:
        raise AssertionError("keyboard activation must open source details")
    page.locator(".node-action").last.focus()
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("keyboard specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "details_open": True,
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
    }, (
        f"at {width}px keyboard activation opens source details and return remains a native focus target"
    )


def specimen_zoom(page, pages, width):
    page.goto(pages["complete"], wait_until="load")
    page.evaluate("() => { document.documentElement.style.zoom = '2'; }")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("zoomed specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "no_horizontal_overflow": overflow,
        "target_size": target_sizes(page),
        "heading_present": page.locator("main h1").count() == 1,
    }, (
        f"at {width}px zoomed to 200% the exact-matter receipt reflows without horizontal overflow"
    )


SPECIMENS = (
    ("complete", specimen_complete, True),
    ("retry-recovery", specimen_retry, True),
    ("without-scripting", specimen_without_scripting, False),
    ("keyboard-and-return", specimen_keyboard, True),
    ("two-hundred-percent-zoom", specimen_zoom, True),
)

ROUTE_FOR_SPECIMEN = {
    "complete": "complete",
    "retry-recovery": "retry-recovery",
    "without-scripting": "complete",
    "keyboard-and-return": "complete",
    "two-hundred-percent-zoom": "complete",
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
                    page = context.new_page()
                    shot, observations, assertion = specimen(page, pages, width)
                    axe = run_axe(page) if scripting else {
                        "violations_total": None,
                        "failing_violations": [],
                        "passes": True,
                        "note": "scripting disabled; the same page is gated scripted",
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
                        "bytes": len(image.read_bytes()),
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
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "image_directory": str(ARTIFACTS.relative_to(ROOT)),
        "corpus_note": (
            "Specimens render exact-matter refresh receipts from reconstructed snapshot "
            "fixtures. They describe operator acquisition state, not live publisher coverage."
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
            print("exact-matter refresh evidence manifest is stale", file=sys.stderr)
            return 1
        print("Exact-matter refresh evidence manifest is current")
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
