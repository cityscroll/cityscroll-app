#!/usr/bin/env python3
"""Headless browser evidence for exact Council-matter watch updates.

Renders occurred, scheduled, and correction specimens from
`tools/render_exact_council_matter_watch_update_fixtures.mjs`. No publisher is
contacted. Proof is the tracked manifest. Images stay in an ignored directory.

    python3 tools/capture_exact_council_matter_watch_update_evidence.py
    python3 tools/capture_exact_council_matter_watch_update_evidence.py --check
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
MANIFEST = ROOT / "docs" / "evidence" / "exact-council-matter-watch-updates" / "manifest.json"
ARTIFACTS = ROOT / ".artifacts" / "exact-council-matter-watch-updates"
SITE = ROOT / "site"
AXE = ROOT / "test" / "functional" / "assets" / "axe.min.js"
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
from a11y_gate import failing_violations  # noqa: E402

MANIFEST_SCHEMA = "cityscroll.exact_council_matter_watch_update_evidence.v1"
ENGINEERING_RECORD = "cityscroll-engineering/exact-council-matter-watch-updates"
RENDERER = "tools/render_exact_council_matter_watch_update_fixtures.mjs"
VIEWPORTS = ((390, 844), (1440, 900))
DATA_VINTAGE = "2026-08-10T13:08:13.019Z"
FORBIDDEN_COPY = ("testimony caused", "agency replied", "nothing more will happen")


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


def specimen_occurred(page, pages, width):
    page.goto(pages["occurred-update"], wait_until="load")
    text = page_text(page)
    assert_no_claim(text, "occurred-update")
    if "officials recorded" not in text.lower():
        raise AssertionError("occurred specimen must name the official action")
    if "view matter history" not in text.lower():
        raise AssertionError("occurred specimen must keep a durable matter history link")
    page.locator("summary").first.focus()
    page.keyboard.press("Enter")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("occurred specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "details_open": page.locator("details").first.get_attribute("open") is not None,
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
    }, (
        f"at {width}px an occurred matter update names the official action and a durable history link"
    )


def specimen_scheduled(page, pages, width):
    page.goto(pages["scheduled-update"], wait_until="load")
    text = page_text(page)
    if "scheduled" not in text.lower():
        raise AssertionError("scheduled specimen must say the hearing is scheduled")
    if " held" in f" {text.lower()}":
        raise AssertionError("scheduled specimen must not say the hearing was held")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("scheduled specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
    }, (
        f"at {width}px a future hearing is described as scheduled, never held"
    )


def specimen_correction(page, pages, width):
    page.goto(pages["correction-update"], wait_until="load")
    text = page_text(page)
    if "corrected" not in text.lower():
        raise AssertionError("correction specimen must label the change a correction")
    if "last known history is still shown" not in text.lower():
        raise AssertionError("stale refresh must keep last-known history visible")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("correction specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "target_size": target_sizes(page),
        "no_horizontal_overflow": overflow,
    }, (
        f"at {width}px a corrected same-event action is labelled a correction and stale history remains"
    )


def specimen_without_scripting(page, pages, width):
    page.goto(pages["occurred-update"], wait_until="load")
    if page.locator("a.matter-follow-link").count() < 1:
        raise AssertionError("native matter history links must work with scripting disabled")
    return page.screenshot(full_page=True), {
        "follow_links": page.locator("a.matter-follow-link").count(),
        "no_horizontal_overflow": no_horizontal_overflow(page),
    }, (
        f"at {width}px native matter history links remain usable with scripting disabled"
    )


def specimen_zoom(page, pages, width):
    page.goto(pages["occurred-update"], wait_until="load")
    page.evaluate("() => { document.documentElement.style.zoom = '2'; }")
    overflow = no_horizontal_overflow(page)
    if not overflow:
        raise AssertionError("zoomed specimen overflowed the viewport")
    return page.screenshot(full_page=True), {
        "no_horizontal_overflow": overflow,
        "target_size": target_sizes(page),
    }, (
        f"at {width}px zoomed to 200% the matter update reflows without horizontal overflow"
    )


SPECIMENS = (
    ("occurred-update", specimen_occurred, True),
    ("scheduled-update", specimen_scheduled, True),
    ("correction-update", specimen_correction, True),
    ("without-scripting", specimen_without_scripting, False),
    ("two-hundred-percent-zoom", specimen_zoom, True),
)

ROUTE_FOR_SPECIMEN = {
    "occurred-update": "occurred-update",
    "scheduled-update": "scheduled-update",
    "correction-update": "correction-update",
    "without-scripting": "occurred-update",
    "two-hundred-percent-zoom": "occurred-update",
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
            "Specimens render occurred, scheduled, and correction updates for an exact "
            "Council-matter watch from the committed meeting-outcomes snapshot. They "
            "describe retained official actions, not live publisher coverage."
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
            print("exact Council matter watch update evidence manifest is stale", file=sys.stderr)
            return 1
        print("Exact Council matter watch update evidence manifest is current")
        return 0

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(output, encoding="utf-8")
    print(f"wrote {MANIFEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
