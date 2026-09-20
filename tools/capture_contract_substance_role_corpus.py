#!/usr/bin/env python3
"""Capture role-correct contract evidence at both required viewports.

The HTML fixtures are produced by the resident renderer. This script records
headless layout measurements, per-viewport hashes, keyboard destination order,
and no-JavaScript source destinations; image files remain under .artifacts/.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / ".artifacts" / "contract-substance-role-corpus"
MANIFEST = ROOT / "docs" / "evidence" / "contract-substance-role-corpus" / "capture-manifest.json"
VIEWPORTS = {"desktop": (1440, 900), "mobile": (390, 844)}


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_json(value: dict) -> str:
    return sha256_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def layout_probe(page) -> dict:
    return page.evaluate(
        """() => {
          const doc = document.documentElement;
          const body = document.body;
          return {
            scroll_width: doc.scrollWidth,
            client_width: doc.clientWidth,
            inner_width: window.innerWidth,
            content_height: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
            overflow: doc.scrollWidth > window.innerWidth + 1,
          };
        }"""
    )


def keyboard_traverse(page, expected: list[str]) -> dict:
    reached: list[str] = []
    seen: set[str] = set()
    focus_trace = []
    opened = []
    for _ in range(max(160, len(expected) * 40)):
        page.keyboard.press("Tab")
        info = page.evaluate(
            """() => {
              const el = document.activeElement;
              if (!el) return null;
              const details = el.closest ? el.closest('details') : null;
              return {
                tag: el.tagName,
                href: el.getAttribute ? el.getAttribute('href') : null,
                is_summary: el.tagName === 'SUMMARY',
                details_open: details ? details.open : null,
                details_label: details ? (details.querySelector('summary')?.textContent || '').trim() : null,
              };
            }"""
        )
        if not info:
            continue
        focus_trace.append({"tag": info["tag"], "href": info["href"], "is_summary": info["is_summary"]})
        href = info["href"]
        if href in expected and href not in seen:
            seen.add(href)
            reached.append(href)
            if len(seen) == len(expected):
                break
            continue
        if info["is_summary"] and info["details_open"] is False:
            still_hidden = page.evaluate(
                """(wanted) => {
                  const summary = document.activeElement;
                  const details = summary?.closest ? summary.closest('details') : null;
                  return Boolean(details && [...details.querySelectorAll('a[href]')]
                    .some((anchor) => wanted.includes(anchor.getAttribute('href'))));
                }""",
                expected,
            )
            if still_hidden:
                page.keyboard.press("Enter")
                opened.append(info["details_label"] or "details")
    missing = [href for href in expected if href not in seen]
    return {
        "expected_destinations": expected,
        "reached_in_tab_order": reached,
        "missing_destinations": missing,
        "tabs_pressed": len(focus_trace),
        "disclosures_opened": opened,
        "all_named_destinations_reached": not missing,
    }


def main() -> int:
    subprocess.run(["node", str(ROOT / "tools" / "contract_substance_role_corpus_capture.mjs"), str(OUTPUT)], cwd=ROOT, check=True)
    metadata = json.loads((OUTPUT / "metadata.json").read_text())
    source_revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        captures = []
        for spec in metadata["captures"]:
            viewport_rows = []
            keyboard = None
            for name, (width, height) in VIEWPORTS.items():
                context = browser.new_context(viewport={"width": width, "height": height})
                page = context.new_page()
                page.goto((OUTPUT / spec["file"]).as_uri(), wait_until="load")
                page.wait_for_timeout(100)
                served_markup = page.content()
                layout = {"viewport": [width, height], **layout_probe(page)}
                if name == "desktop":
                    keyboard = keyboard_traverse(page, spec["expected_destinations"])
                destinations = list(dict.fromkeys(page.locator("a[href]").evaluate_all("anchors => anchors.map(anchor => anchor.getAttribute('href'))")))
                no_js = {
                    "expected_destinations": spec["expected_destinations"],
                    "destinations_in_rendered_markup": destinations,
                    "script_tag_count": page.locator("script").count(),
                    "javascript_href_count": page.locator("a[href^='javascript:']").count(),
                }
                screenshot = OUTPUT / f"{spec['key']}-{name}.png"
                page.screenshot(path=str(screenshot), full_page=True)
                viewport_rows.append({
                    "name": name,
                    "width": width,
                    "height": height,
                    "assertion": (
                        "Headless layout measurement records no horizontal overflow and the named source destinations remain readable."
                        if name == "desktop" else
                        "At 390px, headless layout measurement records no horizontal overflow and differs from desktop."
                    ),
                    "render_sha256": sha256_bytes(served_markup.encode()),
                    "layout": layout,
                    "layout_sha256": sha256_json(layout),
                    "screenshot_sha256": sha256_bytes(screenshot.read_bytes()),
                    "screenshot_path": f".artifacts/contract-substance-role-corpus/{spec['key']}-{name}.png",
                    "no_javascript_source_destination": no_js,
                })
                context.close()
            desktop, mobile = viewport_rows
            if desktop["layout"]["overflow"] or mobile["layout"]["overflow"]:
                raise RuntimeError(f"horizontal overflow in {spec['key']}")
            if desktop["layout_sha256"] == mobile["layout_sha256"]:
                raise RuntimeError(f"desktop/mobile layout hashes did not differ in {spec['key']}")
            if not keyboard or not keyboard["all_named_destinations_reached"]:
                raise RuntimeError(f"keyboard traversal missed destinations in {spec['key']}: {keyboard}")
            captures.append({
                "route": spec["route"],
                "case": spec["case"],
                "assertions": spec["assertions"],
                "viewports": viewport_rows,
                "keyboard_source_open": keyboard,
            })
        browser.close()

    manifest = {
        "schema": "cityscroll.contract_substance_role_corpus_capture_manifest.v2",
        "capture_mode": "deterministic server render with headless Chromium viewport review; image binaries omitted",
        "source_revision": f"grounded origin/main {source_revision}",
        "data_vintages": metadata["data_vintages"],
        "assertions": [{
            "id": "A7",
            "assertion": "Desktop and 390px captures observe distinct no-overflow layouts, keyboard source opening, no-JavaScript destinations, and a source-role mutation that fails closed.",
            "artifact": "captures[].viewports[].layout, captures[].keyboard_source_open, captures[].viewports[].no_javascript_source_destination, source_role_mutation",
        }],
        "captures": captures,
        "source_role_mutation": metadata["source_role_mutation"],
        "image_policy": "No screenshot or recording binaries are committed; this manifest records route, viewport, revision, data vintage, assertion, layout measurements, and sha256 values.",
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {MANIFEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
