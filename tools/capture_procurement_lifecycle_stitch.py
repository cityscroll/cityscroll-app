#!/usr/bin/env python3
"""Capture before/after notice-detail slots for the procurement lifecycle stitch.

Produces annotated 390 + 1440 pairs under docs/screenshots/procurement-lifecycle-stitch/
using real joined field values (HNTB registration, HANYC prior award, IDA subsidy gap,
Council meeting-outcome gap). No live browser navigation to production — fixtures are
self-contained so captures stay deterministic.
"""

from __future__ import annotations

import base64
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "procurement-lifecycle-stitch"
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
.box.unknown { border-top-style:dashed; border-top-color:var(--rule); }
.stage-name { font:700 11px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.1em;
  text-transform:uppercase; color:var(--muted); }
.box.matched .stage-name { color:var(--green); }
.box.unmatched .stage-name { color:var(--amber); }
.when { font-size:13px; }
.amt { font-weight:700; font-size:15px; }
.lc-norecord, .note { font:12px/1.45 ui-sans-serif,system-ui,sans-serif; color:var(--muted); }
.note { margin-top:10px; }
.connector { display:flex; align-items:center; padding:0 4px; color:var(--muted); font-size:16px; }
.slot-empty { border:1px dashed var(--rule); border-radius:8px; background:rgba(255,255,255,.4);
  padding:22px 14px; color:var(--muted); font:13px/1.4 ui-sans-serif,system-ui,sans-serif;
  text-align:center; margin:12px 0; }
.apply { margin-top:14px; border:1px solid var(--rule); border-radius:8px; background:#fff; }
.apply h3 { margin:0; padding:12px 14px; border-bottom:1px solid var(--rule);
  font:700 14px/1.2 ui-sans-serif,system-ui,sans-serif; }
.apply .body { padding:12px 14px; }
.apply dl { display:grid; grid-template-columns:auto 1fr; gap:6px 12px; margin:0; font-size:13px; }
.apply dt { color:var(--muted); }
.lbar { height:7px; background:#eee; border-radius:99px; overflow:hidden; }
.lbar span { display:block; height:100%; background:var(--green); }
.prior { border:1px solid var(--rule); border-radius:8px; background:#fff; padding:12px 14px; margin-top:10px; }
.prior b { display:block; margin-bottom:4px; }
code { font-family:ui-monospace,SFMono-Regular,monospace; font-size:.92em; }
"""


def shell(title: str, body: str) -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>{CSS}</style></head><body>
<div class="page">
  <div class="mast"><div class="brand">City<span>Scroll</span></div>
    <div class="eyebrow">Notice detail</div></div>
  {body}
</div></body></html>"""


BEFORE_BODY = """
<div class="eyebrow">Before — slots left blank</div>
<h1>Procurement notice detail</h1>
<p class="meta">Award · Transportation · PIN <code>84124P0003001</code></p>
<div class="panel">
  <div class="ftype">Award · Procurement · Transportation</div>
  <h2 class="rolename" lang="en">TD/CSS for 21st Ave Bridge Over NYCTA-BMT Sea Beach Line</h2>
  <div class="chain-h">Contract lifecycle</div>
  <div class="slot-empty">Unknown — registration and payment not shown</div>
  <div class="chain-h">Follow the dollars</div>
  <div class="slot-empty">Unknown — Checkbook join not surfaced</div>
  <div class="chain-h">Subsidy lifecycle</div>
  <div class="slot-empty">Unknown — Build NYC join not on this screen</div>
  <div class="chain-h">Council meeting outcomes</div>
  <div class="slot-empty">Unknown — Council votes not on this screen</div>
  <div class="chain-h">Looks recurring — prior award cycles</div>
  <div class="slot-empty">Unknown — prior awards not on this screen</div>
</div>
"""

AFTER_PROC = """
<div class="eyebrow">After — joined procurement arc</div>
<h1>Registration + payment signals on the award</h1>
<p class="meta">Real notice <code>20260623008</code> · PIN <code>84124P0003001</code> · HNTB</p>
<div class="panel">
  <div class="ftype">Award · Procurement · Transportation</div>
  <h2 class="rolename" lang="en">TD/CSS for 21st Ave Bridge Over NYCTA-BMT Sea Beach Line</h2>
  <div class="chain-h">Contract lifecycle</div>
  <div class="chain">
    <div class="stage"><div class="box matched">
      <div class="stage-name">Award</div>
      <div class="when">2026-06-29</div>
      <div class="amt">$13.53M</div>
      <div class="note">HNTB New York Engineering…</div>
    </div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box unmatched">
      <div class="stage-name">Pending contract</div>
      <div class="when">—</div>
      <div class="lc-norecord">No pending contract found in Checkbook NYC. It may have already moved to registration.</div>
    </div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box matched">
      <div class="stage-name">Registered contract</div>
      <div class="when">2026-06-22</div>
      <div class="amt">$13.53M</div>
      <div class="note"><code>CT184120268807929</code> · $0 / $13.53M (0%)</div>
    </div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box unknown">
      <div class="stage-name">Payments</div>
      <div class="when">—</div>
      <div class="lc-norecord">Could not reach Checkbook NYC to check this step.</div>
    </div></div>
  </div>
  <div class="apply"><h3>Follow the dollars — Checkbook NYC</h3>
    <div class="body">
      <dl>
        <dt>Contract</dt><dd><code>CT184120268807929</code> · registered 2026-06-22</dd>
        <dt>Committed</dt><dd><b>$13.53M</b></dd>
        <dt>Paid to date</dt><dd><b>$0</b> (0%)
          <div class="lbar" style="max-width:220px;margin-top:5px"><span style="width:0%"></span></div></dd>
        <dt>Term</dt><dd>2024-10-11 → 2032-10-10</dd>
      </dl>
      <div class="note">From the precomputed lifecycle join to Checkbook NYC, matched by PIN <code>84124P0003001</code>.</div>
    </div>
  </div>
</div>
"""

AFTER_SUBSIDY = """
<div class="eyebrow">After — subsidy slot on notice detail</div>
<h1>IDA hearing: explicit Build NYC gap</h1>
<p class="meta">Real notice <code>20260617040</code> · Industrial Development Agency</p>
<div class="panel">
  <div class="ftype">Public Hearings · Industrial Development Agency</div>
  <h2 class="rolename" lang="en">NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY — NOTICE OF PUBLIC HEARING — July 16th, 2026</h2>
  <div class="chain-h">Subsidy lifecycle</div>
  <div class="note">No registration record found for “NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY - NOTICE OF PUBLIC HEARING - July 16th, 2026” — No matching NYCIDA/Build NYC project record was linked to this notice from public sources.</div>
  <div class="chain">
    <div class="stage"><div class="box unknown"><div class="stage-name">Application</div><div class="when">—</div><div class="lc-norecord">No Application record found in Build NYC / NYCIDA for this notice.</div></div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box unknown"><div class="stage-name">Hearing</div><div class="when">—</div><div class="lc-norecord">No Hearing record found in Build NYC / NYCIDA for this notice.</div></div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box unknown"><div class="stage-name">Board decision</div><div class="when">—</div><div class="lc-norecord">No Board decision record found in Build NYC / NYCIDA for this notice.</div></div></div>
  </div>
</div>
"""

AFTER_PRIOR = """
<div class="eyebrow">After — recurring bid prior awards</div>
<h1>Prior award history on the detail view</h1>
<p class="meta">Real notice <code>20260722019</code> · Homeless Services renewal</p>
<div class="panel">
  <div class="ftype">Award · Procurement · Homeless Services</div>
  <h2 class="rolename" lang="en">Hotel Management Services for DHS Emergency Programs</h2>
  <div class="chain-h">Looks recurring — prior award cycles</div>
  <div class="prior">
    <b lang="en">Hotel Management Services for DHS Emergency Programs</b>
    <div class="note">HANYC Foundation Inc. · 2025-06-18 · prior award on same agency/title pattern</div>
  </div>
  <div class="note">Matched by agency and title, not by a shared PIN. Check dates and vendor before relying on the link.</div>
</div>
"""

AFTER_MEET = """
<div class="eyebrow">After — council outcomes slot</div>
<h1>Hearing notice: specific Council gap</h1>
<p class="meta">Real notice <code>20260714002</code> · City Planning Commission</p>
<div class="panel">
  <div class="ftype">Public Hearings · Agency Rules · City Planning Commission</div>
  <h2 class="rolename" lang="en">CPC and DCP Proposed Rules: Expedited Land Use Review Procedure…</h2>
  <div class="chain-h">Council meeting outcomes</div>
  <div class="note">No Council meeting or vote record found for this notice — No Council event matched this City Record notice on title/date/agency confidence.</div>
</div>
"""


def annotate(path: Path, labels: list[tuple[str, tuple[int, int]]]) -> None:
    im = Image.open(path).convert("RGBA")
    overlay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 18)
        font_sm = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 14)
    except Exception:
        font = ImageFont.load_default()
        font_sm = font
    for text, (x, y) in labels:
        # banner
        tw = max(120, len(text) * 9)
        draw.rectangle((x, y, x + tw, y + 28), fill=(123, 31, 43, 220))
        draw.text((x + 8, y + 5), text, fill=(255, 255, 255, 255), font=font_sm)
        draw.rectangle((x, y + 28, x + 4, y + 90), fill=(123, 31, 43, 200))
    out = Image.alpha_composite(im, overlay).convert("RGB")
    out.save(path.with_name(path.stem + "-annotated.png"))


def capture_html(page, name: str, html: str, labels: list[tuple[str, tuple[int, int]]]) -> None:
    data = base64.b64encode(html.encode("utf-8")).decode("ascii")
    for width, height in VIEWPORTS:
        page.set_viewport_size({"width": width, "height": height})
        page.goto(f"data:text/html;base64,{data}", wait_until="networkidle")
        path = OUT / f"{name}-{width}.png"
        page.screenshot(path=str(path), full_page=True)
        # scale label positions lightly for mobile
        scaled = [(t, (int(x * width / 1440), y if width > 500 else max(40, y - 20))) for t, (x, y) in labels]
        annotate(path, scaled)
        print(f"wrote {path.relative_to(ROOT)}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        capture_html(page, "before", shell("Before", BEFORE_BODY), [
            ("blank slots", (40, 220)),
        ])
        capture_html(page, "after-procurement", shell("After procurement", AFTER_PROC), [
            ("registration filled", (40, 280)),
            ("specific gap", (520, 280)),
        ])
        capture_html(page, "after-subsidy", shell("After subsidy", AFTER_SUBSIDY), [
            ("per-notice gap", (40, 250)),
        ])
        capture_html(page, "after-prior", shell("After prior", AFTER_PRIOR), [
            ("prior award", (40, 230)),
        ])
        capture_html(page, "after-meeting", shell("After meeting", AFTER_MEET), [
            ("council gap", (40, 230)),
        ])
        browser.close()
    print(f"evidence in {OUT}")


if __name__ == "__main__":
    main()
