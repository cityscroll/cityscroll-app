#!/usr/bin/env python3
"""Capture the cross-source evidence receipt before and after its addition."""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "site" / "media" / "review" / "cross-source-evidence-receipt"
VIEWPORTS = ((390, 844), (1440, 900))

CSS = """
:root { --paper:#f4efe5; --panel:#fffdf7; --ink:#161512; --muted:#69635a;
  --rule:#c8bfb0; --ox:#7b1f2b; --green:#285d49; --amber:#9a6b1a; --blue:#315e72; }
* { box-sizing:border-box; }
html,body { margin:0; background:var(--paper); color:var(--ink);
  font-family:ui-sans-serif,system-ui,sans-serif; }
.page { max-width:980px; margin:0 auto; padding:18px clamp(14px,3vw,42px) 30px; }
.mast { display:flex; justify-content:space-between; border-bottom:3px double var(--ink);
  padding-bottom:10px; margin-bottom:18px; }
.brand { font:bold 26px Georgia,serif; letter-spacing:-.03em; }
.brand span { color:var(--ox); }
.eyebrow { color:var(--ox); font-size:11px; font-weight:800; letter-spacing:.12em;
  text-transform:uppercase; margin:0 0 6px; }
h1 { font:900 clamp(23px,3.5vw,36px)/1.05 Georgia,serif; letter-spacing:-.03em; margin:0 0 8px; }
.meta { color:var(--muted); font-size:13px; margin:0 0 16px; }
.panel { background:var(--panel); border:1px solid var(--rule); border-radius:8px; padding:16px 18px; }
.type { color:var(--muted); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
.title { font:22px/1.2 Georgia,serif; margin:5px 0 14px; }
.receipt { border-top:3px solid var(--green); background:#fbfaf4; padding:14px; }
.receipt h2 { font:700 17px Georgia,serif; margin:0 0 5px; }
.summary { color:var(--muted); font-size:13px; margin:0 0 14px; }
.sources { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.source, .fact { border:1px solid var(--rule); border-radius:7px; background:#fff; padding:11px 12px; min-width:0; }
.source h3 { margin:0 0 7px; font-size:14px; }
.source p, .fact p { margin:4px 0; font-size:12px; line-height:1.4; }
.label { color:var(--muted); font-size:10px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
.source a { color:var(--blue); overflow-wrap:anywhere; }
.facts { display:grid; gap:8px; margin-top:12px; }
.fact { display:grid; grid-template-columns:100px minmax(0,1fr); gap:8px; }
.fact dt { color:var(--muted); font-size:12px; font-weight:800; }
.fact dd { margin:0; font-size:13px; }
.agree { color:var(--green); font-weight:800; }
.disagree { color:var(--ox); font-weight:800; }
.honesty { color:var(--ox); background:#fff7f4; border-inline-start:3px solid var(--ox);
  border-radius:0 6px 6px 0; padding:9px 10px; margin-top:12px; font-size:13px; line-height:1.4; }
code { font:12px ui-monospace,SFMono-Regular,monospace; }
@media (max-width:620px) { .sources { grid-template-columns:1fr; } .fact { grid-template-columns:86px minmax(0,1fr); } }
"""


def shell(title: str, content: str, badge: str) -> str:
    return f"""<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>{CSS}</style></head>
<body><main class=\"page\"><header class=\"mast\"><div class=\"brand\">City<span>Scroll</span></div>
<div style=\"color:var(--muted);font-size:12px\">{badge}</div></header>
<p class=\"eyebrow\">Procurement · canonical record</p><h1>{title}</h1>
<p class=\"meta\">Source-qualified contract identity · deterministic review fixture</p>
<section class=\"panel\">{content}</section></main></body></html>"""


BEFORE = shell(
    "Catering Services",
    """
    <div class=\"type\">Award · Health and Mental Hygiene</div>
    <div class=\"title\">Catering Services · PIN <code>81626W0043001</code></div>
    <div class=\"source\"><h3>Contract facts</h3>
      <p><span class=\"label\">Vendor</span><br>Make it Zesty LLC</p>
      <p><span class=\"label\">Amount</span><br>$999,999</p>
      <p><span class=\"label\">Publisher</span><br><a href=\"#\">City Record award notice</a></p>
    </div>
    """,
    "Before · single-source view",
)

AFTER = shell(
    "Catering Services",
    """
    <div class=\"type\">Award · Health and Mental Hygiene</div>
    <div class=\"title\">Catering Services · PIN <code>81626W0043001</code></div>
    <section class=\"receipt\" data-cross-source-evidence-receipt>
      <h2>Cross-source evidence receipt</h2>
      <p class=\"summary\">2 sources · Exact PIN / EPIN · field scope: vendor, amount, award date</p>
      <div class=\"sources\">
        <article class=\"source\"><h3>City Record</h3>
          <p><span class=\"label\">Source-native ID</span><br><code>81626W0043001</code></p>
          <p><span class=\"label\">Provenance</span><br><a href=\"#\">Official publisher record</a></p>
          <p><span class=\"label\">Coverage</span><br>Available · as of 2026-08-27</p></article>
        <article class=\"source\"><h3>Recent Contract Awards (OCP)</h3>
          <p><span class=\"label\">Source-native ID</span><br><code>81626W0043001</code></p>
          <p><span class=\"label\">Provenance</span><br><a href=\"https://data.cityofnewyork.us/d/qyyg-4tf5\">OCP publisher dataset</a></p>
          <p><span class=\"label\">Coverage</span><br>Available · as of 2026-08-27</p></article>
      </div>
      <dl class=\"facts\">
        <div class=\"fact\"><dt>Vendor</dt><dd><span class=\"agree\">Agrees</span> · Make it Zesty LLC</dd></div>
        <div class=\"fact\"><dt>Amount</dt><dd><span class=\"disagree\">Disagrees</span> · City Record $999,999 · OCP $250,000</dd></div>
        <div class=\"fact\"><dt>Award date</dt><dd><span class=\"disagree\">Disagrees</span> · 2026-07-15 · 2026-07-30</dd></div>
      </dl>
      <div class=\"honesty\">Each publisher's value is shown as reported; CityScroll has not selected a winning value.</div>
    </section>
    """,
    "After · evidence receipt",
)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    frames = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for name, html in (("before", BEFORE), ("after", AFTER)):
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
                page.set_content(html, wait_until="networkidle")
                if name == "after":
                    page.locator("[data-cross-source-evidence-receipt]").wait_for()
                    assert page.get_by_text("has not selected a winning value", exact=False).count() == 1
                destination = OUT / f"{name}-{width}.png"
                page.screenshot(path=str(destination), full_page=True)
                frames.append(str(destination.relative_to(ROOT)))
                print(f"wrote {destination.relative_to(ROOT)}")
                page.close()
        browser.close()
    (OUT / "receipt.json").write_text(json.dumps({"frames": frames}, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {(OUT / 'receipt.json').relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
