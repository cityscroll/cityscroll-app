#!/usr/bin/env python3
"""Headless browser evidence for matter coverage and recovery operator views.

Renders specimens from `tools/render_matter_coverage_recovery_fixtures.mjs`.
No publisher is contacted. Proof is the tracked manifest. Images stay in an
ignored directory.

    python3 tools/capture_matter_coverage_recovery_evidence.py
    python3 tools/capture_matter_coverage_recovery_evidence.py --check
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
MANIFEST = ROOT / "docs" / "evidence" / "matter-coverage-recovery" / "manifest.json"
ARTIFACTS = ROOT / ".artifacts" / "matter-coverage-recovery"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

MANIFEST_SCHEMA = "cityscroll.matter_coverage_recovery_evidence.v1"
ENGINEERING_RECORD = "cityscroll-engineering/matter-coverage-recovery"
RENDERER = "tools/render_matter_coverage_recovery_fixtures.mjs"
VIEWPORTS = ((390, 844), (1440, 900))
FORBIDDEN_COPY = ("notify me", "testimony caused", "agency replied", "@example.com", "subscribe@")


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
        if phrase.lower() in lowered:
            raise AssertionError(f"{specimen} leaked forbidden copy: {phrase}")


def render_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def specimen_named(page, pages, width, name, must_contain):
    page.goto(pages[name], wait_until="load")
    text = page_text(page)
    assert_no_claim(text, name)
    for phrase in must_contain:
        if phrase.lower() not in text.lower():
            raise AssertionError(f"{name} missing {phrase!r}")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError(f"{name} overflowed the viewport")
    return page.screenshot(full_page=True), {
        "failure_class": page.locator("main").get_attribute("data-failure-class"),
        "active_watches": page.locator("main").get_attribute("data-active-watches"),
        "pending_outbox": page.locator("main").get_attribute("data-pending-outbox"),
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
        "render_hash": render_hash(text),
        "fixture_vintage": "2026-08-10T13:08:13.019Z",
    }, f"at {width}px the {name.replace('-', ' ')} receipt stays usable and omits subscriber addresses"


def specimen_without_scripting(page, pages, width):
    page.goto(pages["healthy"], wait_until="load")
    if page.locator("main h1").count() != 1:
        raise AssertionError("the coverage receipt must render without scripting")
    text = page_text(page)
    return page.screenshot(full_page=True), {
        "heading": page.locator("main h1").inner_text(),
        "no_horizontal_overflow": no_horizontal_overflow(page),
        "render_hash": render_hash(text),
        "fixture_vintage": "2026-08-10T13:08:13.019Z",
    }, f"at {width}px the coverage receipt remains readable with scripting disabled"


def specimen_keyboard(page, pages, width):
    page.goto(pages["healthy"], wait_until="load")
    page.locator("summary").focus()
    page.keyboard.press("Enter")
    if page.locator("details").first.get_attribute("open") is None:
        raise AssertionError("keyboard activation must open recovery details")
    page.locator(".node-action").last.focus()
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("keyboard specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "details_open": True,
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
        "render_hash": render_hash(page_text(page)),
        "fixture_vintage": "2026-08-10T13:08:13.019Z",
    }, f"at {width}px keyboard activation opens recovery details and return remains a native focus target"


def specimen_zoom(page, pages, width):
    page.goto(pages["healthy"], wait_until="load")
    page.evaluate("() => { document.documentElement.style.zoom = '2'; }")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("zoomed specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "no_horizontal_overflow": overflow,
        "target_size": target_sizes(page),
        "heading_present": page.locator("main h1").count() == 1,
        "zoom": "200%",
        "render_hash": render_hash(page_text(page)),
        "fixture_vintage": "2026-08-10T13:08:13.019Z",
    }, f"at {width}px zoomed to 200% the coverage receipt reflows without horizontal overflow"


SPECIMENS = (
    ("healthy", lambda page, pages, width: specimen_named(page, pages, width, "healthy", ("active watches", "retry recovery")), True),
    ("stale-refresh", lambda page, pages, width: specimen_named(page, pages, width, "stale-refresh", ("last complete refresh age", "retry recovery")), True),
    ("publication-lag", lambda page, pages, width: specimen_named(page, pages, width, "publication-lag", ("publication lag", "retry recovery")), True),
    ("delivery-lag", lambda page, pages, width: specimen_named(page, pages, width, "delivery-lag", ("pending outbox", "retry recovery")), True),
    ("recovered", lambda page, pages, width: specimen_named(page, pages, width, "recovered", ("retry recovery", "recovery playbook")), True),
    ("without-scripting", specimen_without_scripting, False),
    ("keyboard-and-return", specimen_keyboard, True),
    ("two-hundred-percent-zoom", specimen_zoom, True),
)

ROUTE_FOR_SPECIMEN = {
    "healthy": "healthy",
    "stale-refresh": "stale-refresh",
    "publication-lag": "publication-lag",
    "delivery-lag": "delivery-lag",
    "recovered": "recovered",
    "without-scripting": "healthy",
    "keyboard-and-return": "healthy",
    "two-hundred-percent-zoom": "healthy",
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
            "Specimens render operator coverage and recovery receipts from frozen "
            "snapshot replay and labelled durability faults. They describe retained "
            "CityScroll state, not live publisher coverage."
        ),
        "image_policy": (
            "Capture images are written to the ignored local directory above and are never "
            "committed. This manifest is the tracked proof: route, viewport, revision, data "
            "vintage, assertion, and SHA-256 for each capture."
        ),
        "replay_counts": rendered.get("replay_counts"),
        "acceptance": rendered.get("acceptance"),
        "canary": rendered.get("canary"),
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
            print("matter coverage recovery evidence manifest is stale", file=sys.stderr)
            return 1
        print("Matter coverage recovery evidence manifest is current")
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
