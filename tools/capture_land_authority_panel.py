#!/usr/bin/env python3
"""Headless desktop/mobile captures for the Land “Where this stands” panel.

Renders the committed authority_summary specimens through the resident panel
module and the Land detail CSS, then screenshots at 390 and 1440.

    python3 tools/capture_land_authority_panel.py
    python3 tools/capture_land_authority_panel.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "land-authority-panel"
VIEWPORTS = ((390, 844), (1440, 900))
SPECIMENS = (
    ("2025M0252", "cpc"),
    ("2025K0305", "multi-cd-draft"),
    ("2026Q0210", "council"),
)

RENDER_JS = r"""
import { readFileSync } from "node:fs";
import { landAuthoritySummaryHTML } from "./site/land_authority_summary_view.mjs";

const payload = JSON.parse(readFileSync("site/data/land_authority_summary.json", "utf8"));
const i18n = readFileSync("site/i18n.js", "utf8");
const copy = {};
for (const match of i18n.matchAll(/^\s+(land_[a-z0-9_]+):\s*"((?:\\.|[^"\\])*)"/gm)) {
  copy[match[1]] = match[2].replace(/\\"/g, '"');
}
function t(key, vars) {
  let text = copy[key] || key;
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (all, name) => Object.hasOwn(vars, name) ? String(vars[name] ?? "") : all);
  }
  return text;
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
const ids = ["2025M0252", "2025K0305", "2026Q0210"];
const panels = {};
for (const id of ids) {
  panels[id] = landAuthoritySummaryHTML(payload.summaries[id], { t, escape: esc });
}
process.stdout.write(JSON.stringify(panels));
"""


def panel_css() -> str:
    html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
    rules = re.findall(r"(\.land-authority-[^{]+\{[^}]+\})", html)
    root = (
        ":root{--rule:#d6d3cd;--oxblood:#7a1f2b;--muted:#5c5852;--ink:#1c1917;}"
        "body{margin:16px;background:#f4f1ea;font:16px/1.4 ui-sans-serif,system-ui,sans-serif;}"
        "a{color:#174ea6}"
        ".act{display:inline-block;padding:6px 10px;border:1px solid var(--rule);border-radius:8px;text-decoration:none;color:var(--ink);background:#fff}"
    )
    return root + "".join(rules)


def render_panels() -> dict[str, str]:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", RENDER_JS],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def page_html(panel_html: str) -> str:
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        f"<style>{panel_css()}</style></head><body>{panel_html}</body></html>"
    )


def capture() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    panels = render_panels()
    files: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for project_id, slug in SPECIMENS:
            html = panels.get(project_id) or ""
            if 'data-land-authority-summary="1"' not in html:
                raise SystemExit(f"missing panel markup for {project_id}")
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.set_content(page_html(html), wait_until="domcontentloaded")
                panel = page.locator("[data-land-authority-summary='1']").first
                panel.wait_for(state="visible")
                assert panel.get_attribute("data-project-id") == project_id
                dest = OUT / f"{slug}-{width}.png"
                panel.screenshot(path=str(dest), animations="disabled")
                data = dest.read_bytes()
                files.append({
                    "name": dest.name,
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "viewport": [width, height],
                    "project_id": project_id,
                })
                page.close()
        browser.close()
    manifest = {
        "schema_version": 1,
        "feature": "land-authority-panel",
        "files": files,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def check() -> int:
    manifest_path = OUT / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit("missing docs/screenshots/land-authority-panel/manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {f"{slug}-{width}.png" for _, slug in SPECIMENS for width, _ in VIEWPORTS}
    found = {row["name"] for row in manifest.get("files") or []}
    missing = expected - found
    if missing:
        raise SystemExit(f"missing captures: {sorted(missing)}")
    for row in manifest["files"]:
        path = OUT / row["name"]
        if not path.exists() or path.stat().st_size < 1000:
            raise SystemExit(f"empty or missing capture {row['name']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check()
    capture()
    print("captured", len(SPECIMENS) * len(VIEWPORTS), "land authority panel screenshots")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
