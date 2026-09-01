#!/usr/bin/env python3
"""Capture the Administrative Code provision page before and after the historical-backfill batch."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/screenshots/law-ledger-historical-backfill"
CITATION = "21-955"
VIEWPORTS = ((390, 844), (1440, 900))
RENDER = r'''
import { readFileSync } from "node:fs";
import { lookupAdminCodeCitation, renderAdminCodeProvisionDocument } from "./site/admin_code.mjs";
import { provisionBackfill, provisionHistoricalChanges } from "./site/code_history_backfill.mjs";

const citation = process.env.CITYSCROLL_CAPTURE_CITATION;
const state = process.env.CITYSCROLL_CAPTURE_STATE;
const entry = lookupAdminCodeCitation(citation);
const row = JSON.parse(readFileSync(`site/data/legal_code/${entry.shard}`, "utf8"))
  .rows.find((candidate) => candidate.id === entry.id);
const after = state === "after";
process.stdout.write(renderAdminCodeProvisionDocument(row, {
  currentHref: `https://cityscroll.org/administrative-code/${citation}/`,
  backfill: after ? provisionBackfill(row.id) : null,
  changes: after ? provisionHistoricalChanges(row.id) : [],
}));
'''


def render(state):
    return subprocess.run(
        ["node", "--input-type=module", "-e", RENDER],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        env={
            **dict(__import__("os").environ),
            "CITYSCROLL_CAPTURE_CITATION": CITATION,
            "CITYSCROLL_CAPTURE_STATE": state,
        },
    ).stdout


def capture():
    OUT.mkdir(parents=True, exist_ok=True)
    files = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        for state in ("before", "after"):
            html = render(state)
            anchor = "#historical-coverage" if state == "after" else "#history"
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.set_content(html)
                page.locator(anchor).scroll_into_view_if_needed()
                dest = OUT / f"{state}-{width}.png"
                page.screenshot(path=str(dest), animations="disabled")
                data = dest.read_bytes()
                files.append({
                    "name": dest.name,
                    "viewport": [width, height],
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                })
                page.close()
        browser.close()
    manifest = {
        "schema_version": 1,
        "citation": f"§ {CITATION}",
        "provision_id": f"nyc-administrative-code:{CITATION}",
        "surface": "Administrative Code provision page, historical coverage section",
        "files": files,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def check():
    manifest = json.loads((OUT / "manifest.json").read_text())
    expected = {f"{state}-{width}.png" for state in ("before", "after") for width, _ in VIEWPORTS}
    assert {item["name"] for item in manifest["files"]} == expected, "capture manifest names every viewport"
    for name in expected:
        assert (OUT / name).stat().st_size > 1000, f"{name} is a real capture"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    check() if args.check else capture()
