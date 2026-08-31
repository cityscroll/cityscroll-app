#!/usr/bin/env python3
"""Capture the source-backed Land E-Designation digest at required viewports."""
import argparse, hashlib, json, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/screenshots/e-designation-digest"
VIEWPORTS = ((390, 844), (1440, 900))
RENDER = r'''import fs from "node:fs"; import {eDesignationDigestHTML} from "./site/e_designation_digest_view.mjs"; const p=JSON.parse(fs.readFileSync("site/data/e_designation_project_digest.json")); const esc=v=>String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); process.stdout.write(eDesignationDigestHTML(p.digests["2026Q0210"],{escape:esc}));'''

def render():
    return subprocess.run(["node", "--input-type=module", "-e", RENDER], cwd=ROOT, check=True, capture_output=True, text=True).stdout

def capture():
    OUT.mkdir(parents=True, exist_ok=True)
    panel = render()
    files = []
    css = "body{margin:0;background:#f4f1ea;color:#1c1917;font:16px/1.45 system-ui,sans-serif}.card{max-width:900px;margin:24px auto;padding:24px;background:white;border:1px solid #d6d3cd;border-radius:12px}h2,h3{font-family:Georgia,serif}a{color:#174ea6}.note{color:#5c5852}li{margin:.55rem 0}"
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        for state, content in (("before", "<p class='note'>No retained environmental-requirements digest was available for this project.</p>"), ("after", panel)):
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.set_content(f"<!doctype html><meta name='viewport' content='width=device-width'><style>{css}</style><main class='card'><h2>Atlantic Avenue Demapping</h2>{content}</main>")
                dest = OUT / f"{state}-{width}.png"
                page.locator("main").screenshot(path=str(dest), animations="disabled")
                data = dest.read_bytes(); files.append({"name": dest.name, "viewport": [width,height], "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
                page.close()
        browser.close()
    (OUT / "manifest.json").write_text(json.dumps({"schema_version":1,"project_id":"2026Q0210","files":files}, indent=2)+"\n")

def check():
    manifest = json.loads((OUT / "manifest.json").read_text())
    expected = {f"{s}-{w}.png" for s in ("before","after") for w,_ in VIEWPORTS}
    assert {f["name"] for f in manifest["files"]} == expected
    assert all((OUT / name).stat().st_size > 1000 for name in expected)

if __name__ == "__main__":
    parser=argparse.ArgumentParser(); parser.add_argument("--check",action="store_true"); args=parser.parse_args()
    check() if args.check else capture()
