#!/usr/bin/env python3
"""Capture OCP Recent Contract Awards side-car UI for the procurement lifecycle.

Produces 390 + 1440 PNGs under docs/screenshots/ocp-award-sidecar/ using fixture
HTML that mirrors the real joined field cases (Make it Zesty LLC catering award;
disagreement on amount/date; unmatched not-yet-ingested gap). Deterministic — no
live browser navigation to production.
"""

from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "ocp-award-sidecar"
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
.stage { flex:1 1 120px; min-width:110px; }
.box { border:1px solid var(--rule); border-top:3px solid var(--rule); border-radius:8px;
  background:#fff; padding:11px 12px; display:flex; flex-direction:column; gap:5px;
  min-height:110px; }
.box.matched { border-top-color:var(--green); }
.box.unmatched { border-top-style:dashed; border-top-color:var(--amber); }
.stage-name { font:700 11px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.1em;
  text-transform:uppercase; color:var(--muted); }
.box.matched .stage-name { color:var(--green); }
.when { font-size:13px; }
.amt { font-weight:700; font-size:15px; }
.note { font:12px/1.45 ui-sans-serif,system-ui,sans-serif; color:var(--muted); margin-top:10px; }
.note.warn { color:var(--ox); }
.connector { display:flex; align-items:center; padding:0 4px; color:var(--muted); font-size:16px; }
a { color:var(--blue); }
code { font-family:ui-monospace,SFMono-Regular,monospace; font-size:.92em; }
"""


def page_html(title: str, body: str) -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>{CSS}</style></head><body><div class="page">
  <div class="mast"><div class="brand">City<span>Scroll</span></div>
  <div style="font-size:12px;color:var(--muted)">OCP award side-car</div></div>
  <p class="eyebrow">Procurement · award notice</p>
  <h1>{title}</h1>
  <p class="meta">Precomputed lifecycle join · no live client fetch</p>
  <div class="panel">{body}</div>
</div></body></html>"""


MATCHED = page_html(
    "Catering Services",
    """
    <div class="ftype">Award · Health and Mental Hygiene</div>
    <div class="rolename">Catering Services · PIN <code>81626W0043001</code></div>
    <div class="chain-h">Contract lifecycle</div>
    <div class="chain">
      <div class="stage"><div class="box matched"><div class="stage-name">Award</div>
        <div class="when">July 30, 2026</div><div class="amt">$250,000</div>
        <div>awarded to <b>Make it Zesty LLC</b></div>
        <a href="#">City Record</a></div></div>
      <div class="connector">→</div>
      <div class="stage"><div class="box unmatched"><div class="stage-name">Pending contract</div>
        <div class="when">—</div>
        <div class="note">Not yet shown here — pending contracts live in Checkbook NYC.</div>
      </div></div>
    </div>
    <div class="note"><b>OCP award record</b> Joined from
      <a href="https://data.cityofnewyork.us/d/qyyg-4tf5">Recent Contract Awards (OCP)</a>:
      <b>Make it Zesty LLC</b> · $250,000 on July 30, 2026.
      City Record and Recent Contract Awards (OCP) agree on award date and amount.</div>
    <div class="note">This timeline joins City Record notices to Checkbook NYC registrations
      and payments, matched by PIN <code>81626W0043001</code>.</div>
    """,
)

DISAGREE = page_html(
    "Catering Services (disagreement case)",
    """
    <div class="ftype">Award · Health and Mental Hygiene</div>
    <div class="rolename">Catering Services · PIN <code>81626W0043001</code></div>
    <div class="chain-h">Contract lifecycle</div>
    <div class="chain">
      <div class="stage"><div class="box matched"><div class="stage-name">Award</div>
        <div class="when">July 15, 2026</div><div class="amt">$999,999</div>
        <div>awarded to <b>Make it Zesty LLC</b></div>
        <a href="#">City Record</a></div></div>
    </div>
    <div class="note warn"><b>OCP award record</b> Joined from
      <a href="https://data.cityofnewyork.us/d/qyyg-4tf5">Recent Contract Awards (OCP)</a>:
      <b>Make it Zesty LLC</b> · $250,000 on July 30, 2026.
      City Record and Recent Contract Awards (OCP) disagree — both shown with sources named.
      Amount: City Record $999,999; Recent Contract Awards (OCP) $250,000.
      Date: City Record July 15, 2026; Recent Contract Awards (OCP) July 30, 2026.</div>
    """,
)

UNMATCHED = page_html(
    "Collection Services",
    """
    <div class="ftype">Award · Sanitation</div>
    <div class="rolename">Collection Services · PIN <code>08250R0001001</code></div>
    <div class="chain-h">Contract lifecycle</div>
    <div class="chain">
      <div class="stage"><div class="box matched"><div class="stage-name">Award</div>
        <div class="when">January 10, 2025</div><div class="amt">$5,000,000</div>
      </div></div>
    </div>
    <div class="note"><b>OCP award record</b> Not yet shown here — recent OCP awards live in
      <a href="https://data.cityofnewyork.us/d/qyyg-4tf5">Recent Contract Awards (OCP)</a>.</div>
    """,
)

SCENES = {
    "matched-agree": MATCHED,
    "matched-disagree": DISAGREE,
    "unmatched-gap": UNMATCHED,
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, html in SCENES.items():
            for width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.set_content(html, wait_until="networkidle")
                out = OUT / f"{name}-{width}.png"
                page.screenshot(path=str(out), full_page=True)
                page.close()
                print(f"wrote {out.relative_to(ROOT)}")
        browser.close()


if __name__ == "__main__":
    main()
