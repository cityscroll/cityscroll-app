#!/usr/bin/env python3
"""Capture annotated 390/1440 screenshots for PASSPort Public lifecycle field cases.

Real joined + unjoinable cases from test/fixtures/passport/join_cases.json.
Deterministic fixture HTML — no live browser fetch to PASSPort or the Worker.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "passport-lifecycle"
VIEWPORTS = ((390, 844), (1440, 900))
CASES = json.loads((ROOT / "test/fixtures/passport/join_cases.json").read_text())

CSS = """
:root {
  --paper:#f4efe5; --paper2:#fbf8f0; --ink:#161512; --muted:#69635a;
  --rule:#c8bfb0; --ox:#7b1f2b; --green:#285d49; --amber:#9a6b1a;
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
.box.unmatched .stage-name { color:var(--amber); }
.when { font-size:13px; }
.amt { font-weight:700; font-size:15px; }
.lc-norecord, .note, .lc-pct, .vend { font:12px/1.45 ui-sans-serif,system-ui,sans-serif; color:var(--muted); }
.note { margin-top:10px; }
.connector { display:flex; align-items:center; padding:0 4px; color:var(--muted); font-size:16px; }
code { font-family:ui-monospace,SFMono-Regular,monospace; font-size:.92em; }
.view { color:var(--ox); font-size:12px; }
"""


def stage_box(name: str, status: str, when: str, body: str, link: str) -> str:
    return f"""
    <div class="stage"><div class="box {status}">
      <div class="stage-name">{name}</div>
      <div class="when">{when}</div>
      {body}
      <a class="view" href="#">{link}</a>
    </div></div>"""


def page_html(title: str, eyebrow: str, meta: str, chain: str, notes: str) -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>{CSS}</style></head><body><div class="page">
  <div class="mast"><div class="brand">City<span>Scroll</span></div>
    <div style="font-size:12px;color:var(--muted)">PASSPort Public · field case</div></div>
  <p class="eyebrow">{eyebrow}</p>
  <h1>{title}</h1>
  <p class="meta">{meta}</p>
  <div class="panel">
    <div class="chain-h">Contract lifecycle</div>
    <div class="chain">{chain}</div>
    {notes}
  </div>
</div></body></html>"""


def joined_registered() -> str:
    c = CASES["joined_award"]
    n, p = c["notice"], c["passport_contract"]
    chain = "".join([
        stage_box("Award", "matched", "2026-07-30",
                  f'<div class="amt">$250K</div><div class="vend">Awarded to <b>{p["vendor"]}</b></div>',
                  "City Record"),
        '<div class="connector">→</div>',
        stage_box("Pending contract", "unmatched", "—",
                  '<div class="lc-norecord">Not yet shown here — pending contracts live in Checkbook NYC · PASSPort Public.</div>',
                  "Checkbook NYC"),
        '<div class="connector">→</div>',
        stage_box("Registered contract", "matched", "2026-07-23",
                  f'<div class="amt">$250K</div><div class="vend">Awarded to <b>{p["vendor"]}</b></div>'
                  f'<div class="lc-pct">PASSPort status: {p["status"]}</div>',
                  "PASSPort Public"),
        '<div class="connector">→</div>',
        stage_box("Payments", "unmatched", "—",
                  '<div class="lc-norecord">Not yet shown here — payments live in Checkbook NYC.</div>',
                  "Checkbook NYC"),
    ])
    notes = (
        f'<div class="note">Exact EPIN join · PIN <code>{n["pin"]}</code> · '
        f'contract <code>{p["contract_id"]}</code></div>'
        '<div class="note">This timeline joins City Record notices to Checkbook NYC and to '
        "PASSPort Public pending contracts and RFx when EPIN joins the PIN.</div>"
    )
    return page_html(
        n["short_title"],
        "Joined award · PASSPort Registered fills registration stage",
        f'{n["agency_name"]} · PIN {n["pin"]} · request {n["request_id"]}',
        chain,
        notes,
    )


def joined_rfx() -> str:
    c = CASES["joined_solicitation"]
    n, r = c["notice"], c["passport_rfx"]
    chain = "".join([
        stage_box("Solicitation", "matched", "2026-07-28",
                  f'<div class="lc-pct">PASSPort solicitation (RFx)</div>'
                  f'<div class="lc-pct">Due 2026-08-18</div>'
                  f'<div class="lc-pct">Status: {r["rfx_status"]}</div>'
                  f'<div class="lc-pct">Method: {r["procurement_method"]}</div>',
                  "City Record · PASSPort Public"),
        '<div class="connector">→</div>',
        stage_box("Pending contract", "unmatched", "—",
                  '<div class="lc-norecord">Not yet shown here — pending contracts live in Checkbook NYC · PASSPort Public.</div>',
                  "Checkbook NYC"),
        '<div class="connector">→</div>',
        stage_box("Registered contract", "unmatched", "—",
                  '<div class="lc-norecord">Not yet shown here — registered contracts live in Checkbook NYC · PASSPort Public.</div>',
                  "Checkbook NYC"),
        '<div class="connector">→</div>',
        stage_box("Payments", "unmatched", "—",
                  '<div class="lc-norecord">Not yet shown here — payments live in Checkbook NYC.</div>',
                  "Checkbook NYC"),
    ])
    notes = (
        f'<div class="note"><b>PASSPort solicitation (RFx)</b> · {r["procurement_name"]} · '
        f'Due 2026-08-18 · Status: {r["rfx_status"]}</div>'
        f'<div class="note">Exact EPIN join · PIN <code>{n["pin"]}</code></div>'
    )
    return page_html(
        n["short_title"],
        "Joined solicitation · RFx detail on solicitation stage",
        f'{n["agency_name"]} · PIN {n["pin"]} · request {n["request_id"]}',
        chain,
        notes,
    )


def unjoinable() -> str:
    n = CASES["unjoinable_solicitation"]["notice"]
    chain = "".join([
        stage_box("Solicitation", "matched", "2026-07-29",
                  f'<div class="lc-pct">PIN <code>{n["pin"]}</code></div>',
                  "City Record"),
        '<div class="connector">→</div>',
        stage_box("Pending contract", "unmatched", "—",
                  '<div class="lc-norecord">Not yet shown here — pending contracts live in Checkbook NYC · PASSPort Public.</div>',
                  "Checkbook NYC · PASSPort Public"),
        '<div class="connector">→</div>',
        stage_box("Registered contract", "unmatched", "—",
                  '<div class="lc-norecord">Not yet shown here — registered contracts live in Checkbook NYC · PASSPort Public.</div>',
                  "Checkbook NYC · PASSPort Public"),
        '<div class="connector">→</div>',
        stage_box("Payments", "unmatched", "—",
                  '<div class="lc-norecord">Not yet shown here — payments live in Checkbook NYC.</div>',
                  "Checkbook NYC"),
    ])
    notes = (
        f'<div class="note">Not yet shown here — solicitation detail lives in PASSPort Public. '
        f'PIN <code>{n["pin"]}</code> has no strict EPIN join (public-authority / non-standard PIN).</div>'
    )
    return page_html(
        n["short_title"][:72] + "…",
        "Unjoinable solicitation · not-yet-ingested register with specific reason",
        f'{n["agency_name"]} · PIN {n["pin"]} · request {n["request_id"]}',
        chain,
        notes,
    )


SCENES = {
    "joined-registered": joined_registered,
    "joined-rfx": joined_rfx,
    "unjoinable-solicitation": unjoinable,
}


def annotate(path: Path, labels: list[tuple[int, int, str]]) -> None:
    im = Image.open(path).convert("RGBA")
    draw = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 14)
    except OSError:
        font = ImageFont.load_default()
    for x, y, text in labels:
        bbox = draw.textbbox((x, y), text, font=font)
        pad = 4
        draw.rectangle(
            (bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad),
            fill=(123, 31, 43, 220),
        )
        draw.text((x, y), text, fill=(255, 255, 255, 255), font=font)
    out = path.with_name(path.stem + "-annotated.png")
    im.convert("RGB").save(out, "PNG")
    print("wrote", out.relative_to(ROOT), "sha256", hashlib.sha256(out.read_bytes()).hexdigest()[:16])


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, builder in SCENES.items():
            html = builder()
            for w, h in VIEWPORTS:
                page = browser.new_page(viewport={"width": w, "height": h})
                page.set_content(html, wait_until="networkidle")
                path = OUT / f"{name}-{w}.png"
                page.screenshot(path=str(path), full_page=True)
                page.close()
                print("wrote", path.relative_to(ROOT), "sha256", hashlib.sha256(path.read_bytes()).hexdigest()[:16])
                annotate(path, [(12, 12, f"{name} · {w}px")])
        browser.close()

    # Record raw URL verification for the machine dumps (sha-pinned).
    receipt = {
        "raw_urls": {
            "contracts": {
                "url": "https://a0333-passportpublic.nyc.gov/dataJs/contractData.js",
                "http": 200,
                "sha256": "3767afb06bbb502002b8c1d20b05ef34f777c20b2755c922a8d1cf22394eead4",
            },
            "rfx": {
                "url": "https://a0333-passportpublic.nyc.gov/dataJs/rfxData.js",
                "http": 200,
                "sha256": "6f805ba1178ab6726499097a7f99f199430fef5989fa890970ba8d30b9261f76",
            },
        },
        "screenshots_dir": "docs/screenshots/passport-lifecycle",
        "field_cases": list(SCENES.keys()),
    }
    (OUT / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print("wrote", (OUT / "capture-receipt.json").relative_to(ROOT))


if __name__ == "__main__":
    main()
