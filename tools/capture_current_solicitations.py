#!/usr/bin/env python3
"""Capture solicitation-stage package enrichment for Current Solicitations (3khw-qi8f).

Renders notice-detail lifecycle HTML offline with real field cases:
  - joined package documents (request_id 20240816113)
  - not-yet-ingested documents gap (request_id 20260709023)

Outputs 390 + 1440 PNG pairs under docs/screenshots/current-solicitations/.
"""
from __future__ import annotations

import base64
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "current-solicitations"
VIEWPORTS = ((390, 844), (1440, 900))

CSS = """
:root {
  --paper:#f4efe5; --paper2:#fbf8f0; --ink:#161512; --muted:#69635a;
  --rule:#c8bfb0; --ox:#7b1f2b; --green:#285d49; --amber:#9a6b1a; --blue:#315e72;
}
* { box-sizing:border-box; }
html,body { margin:0; background:var(--paper); color:var(--ink);
  font-family:ui-sans-serif,system-ui,sans-serif; }
.page { padding:18px clamp(14px,3vw,42px) 28px; max-width:980px; margin:0 auto; }
.mast { display:flex; justify-content:space-between; align-items:baseline;
  border-bottom:3px double var(--ink); padding-bottom:10px; margin-bottom:18px; }
.brand { font-family:Georgia,serif; font-weight:900; font-size:26px; letter-spacing:-.03em; }
.brand span { color:var(--ox); }
.eyebrow { color:var(--ox); font-size:11px; font-weight:800; letter-spacing:.12em;
  text-transform:uppercase; margin:0 0 6px; }
h1 { font-family:Georgia,serif; font-size:clamp(22px,3.4vw,36px); line-height:1.05;
  margin:0 0 8px; letter-spacing:-.03em; }
.meta { color:var(--muted); font-size:13px; margin:0 0 16px; }
.panel { background:var(--paper2); border:1px solid var(--rule); border-radius:8px;
  padding:16px 18px; }
.ftype { font:600 12px/1.3 ui-sans-serif,system-ui,sans-serif; letter-spacing:.08em;
  text-transform:uppercase; color:var(--muted); margin-bottom:6px; }
.rolename { font-family:Georgia,serif; font-size:22px; margin:0 0 14px; line-height:1.2; }
.chain-h { font:700 12px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.12em;
  text-transform:uppercase; color:var(--ink); margin:16px 0 10px; }
.chain { display:flex; gap:0; flex-wrap:wrap; align-items:stretch; }
.stage { flex:1 1 140px; min-width:120px; }
.box { border:1px solid var(--rule); border-top:3px solid var(--rule); border-radius:8px;
  background:#fff; padding:11px 12px; display:flex; flex-direction:column; gap:5px;
  min-height:120px; }
.box.matched { border-top-color:var(--green); }
.box.unmatched { border-top-style:dashed; border-top-color:var(--amber); }
.stage-name { font:700 11px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.1em;
  text-transform:uppercase; color:var(--muted); }
.box.matched .stage-name { color:var(--green); }
.box.unmatched .stage-name { color:var(--amber); }
.when { font-size:13px; }
.lc-norecord, .note { font:12px/1.45 ui-sans-serif,system-ui,sans-serif; color:var(--muted); }
.lc-docs { margin-top:4px; }
.lc-docs-h { font:600 12px/1.3 ui-sans-serif,system-ui,sans-serif; color:var(--ink); }
.lc-docs-links a { font-size:12px; }
.lc-due { font-size:12px; color:var(--muted); }
.connector { display:flex; align-items:center; padding:0 4px; color:var(--muted); font-size:16px; }
.view { font-size:12px; color:var(--blue); }
code { font-family:ui-monospace,SFMono-Regular,monospace; font-size:.92em; }
@media(max-width:560px){.connector{transform:rotate(90deg);height:24px}.stage{flex-basis:100%}}
"""

CASES = {
    "joined-documents": {
        "title": "Package documents joined",
        "subtitle": "request_id 20240816113 · PIN 85725P0001 · Citywide Administrative Services",
        "html": """
<div class="chain-h">Contract lifecycle</div>
<div class="chain">
  <div class="stage"><div class="box matched">
    <div class="stage-name">Solicitation</div>
    <div class="when">Oct 1, 2024</div>
    <div class="lc-docs">
      <div class="lc-docs-h">1 package document</div>
      <div class="lc-due">Responses due Oct 7, 2024</div>
      <div class="lc-docs-links"><a class="view" href="#">Document 1</a></div>
    </div>
    <a class="view" href="#">City Record</a>
  </div></div>
  <div class="connector">→</div>
  <div class="stage"><div class="box unmatched">
    <div class="stage-name">Pending contract</div>
    <div class="when">—</div>
    <div class="lc-norecord">Not yet shown here — pending contracts live in Checkbook NYC.</div>
    <a class="view" href="#">Checkbook NYC</a>
  </div></div>
  <div class="connector">→</div>
  <div class="stage"><div class="box unmatched">
    <div class="stage-name">Registered contract</div>
    <div class="when">—</div>
    <div class="lc-norecord">Not yet shown here — registered contracts live in Checkbook NYC.</div>
    <a class="view" href="#">Checkbook NYC</a>
  </div></div>
</div>
<div class="note">Timeline joins City Record notices to Checkbook NYC and Current Solicitations (Open Data) package rows by request_id / PIN.</div>
""",
    },
    "documents-gap": {
        "title": "Package documents not yet shown",
        "subtitle": "request_id 20260709023 · PIN 85726B0067 · Current Solicitations join without document_links",
        "html": """
<div class="chain-h">Contract lifecycle</div>
<div class="chain">
  <div class="stage"><div class="box matched">
    <div class="stage-name">Solicitation</div>
    <div class="when">Jul 10, 2026</div>
    <div class="lc-due">Responses due Aug 19, 2026</div>
    <div class="lc-norecord lc-docs-gap">Not yet shown here — solicitation package details live in Current Solicitations (Open Data).</div>
    <a class="view" href="#">City Record</a>
  </div></div>
  <div class="connector">→</div>
  <div class="stage"><div class="box unmatched">
    <div class="stage-name">Pending contract</div>
    <div class="when">—</div>
    <div class="lc-norecord">Not yet shown here — pending contracts live in Checkbook NYC.</div>
    <a class="view" href="#">Checkbook NYC</a>
  </div></div>
  <div class="connector">→</div>
  <div class="stage"><div class="box unmatched">
    <div class="stage-name">Registered contract</div>
    <div class="when">—</div>
    <div class="lc-norecord">Not yet shown here — registered contracts live in Checkbook NYC.</div>
    <a class="view" href="#">Checkbook NYC</a>
  </div></div>
</div>
<div class="note">Empty package slot uses the not-yet-ingested register and names Current Solicitations (Open Data) as the public home.</div>
""",
    },
}


def page_html(case: dict) -> str:
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{case["title"]}</title>
<style>{CSS}</style>
</head><body>
<div class="page">
  <div class="mast"><div class="brand">City<span>Scroll</span></div><div class="meta">Current Solicitations join</div></div>
  <p class="eyebrow">Procurement lifecycle</p>
  <h1>{case["title"]}</h1>
  <p class="meta">{case["subtitle"]}</p>
  <div class="panel">
    <div class="ftype">Solicitation</div>
    <div class="rolename">{case["title"]}</div>
    {case["html"]}
  </div>
</div>
</body></html>"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for slug, case in CASES.items():
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.set_content(page_html(case), wait_until="networkidle")
                out = OUT / f"{slug}-{width}.png"
                page.locator(".page").screenshot(path=str(out))
                page.close()
                print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size} bytes)")
        browser.close()


if __name__ == "__main__":
    main()
