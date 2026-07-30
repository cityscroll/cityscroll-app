#!/usr/bin/env python3
"""Capture annotated screenshots for Bid Tabulations Historical join recon.

Deterministic fixture HTML from test/fixtures/bid_tabulations/join_cases.json —
no live Socrata fetch. Output lands under docs/screenshots/bid-tabulations-recon/
with a sha256 manifest for curl-independent pin verification in tests.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "bid-tabulations-recon"
CASES = json.loads((ROOT / "test/fixtures/bid_tabulations/join_cases.json").read_text())
RECEIPT = json.loads(
    (
        ROOT
        / "site/data/bid_tabulation_sources/verification_receipts"
        / "bid_tabulations_historical_2026-07-30.json"
    ).read_text()
)
VIEWPORTS = ((390, 844), (1440, 900))

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
  padding:16px 18px; margin-bottom:14px; }
.panel h2 { font:700 12px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.12em;
  text-transform:uppercase; margin:0 0 10px; }
.row { display:flex; gap:12px; flex-wrap:wrap; }
.card { flex:1 1 220px; border:1px solid var(--rule); border-top:3px solid var(--rule);
  border-radius:8px; background:#fff; padding:12px 14px; min-height:120px; }
.card.ok { border-top-color:var(--green); }
.card.gap { border-top-style:dashed; border-top-color:var(--amber); }
.label { font:700 11px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.1em;
  text-transform:uppercase; color:var(--muted); margin-bottom:6px; }
.card.ok .label { color:var(--green); }
.card.gap .label { color:var(--amber); }
.val { font-size:15px; font-weight:700; margin:0 0 4px; }
.sub { font-size:12px; color:var(--muted); line-height:1.45; }
.note { font-size:12px; color:var(--muted); line-height:1.45; margin-top:8px; }
code { font-family:ui-monospace,SFMono-Regular,monospace; font-size:.92em; }
.table { width:100%; border-collapse:collapse; font-size:13px; }
.table th, .table td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--rule); }
.table th { color:var(--muted); font-weight:700; font-size:11px; letter-spacing:.08em;
  text-transform:uppercase; }
.badge { display:inline-block; font:700 11px/1 ui-sans-serif,system-ui,sans-serif;
  letter-spacing:.08em; text-transform:uppercase; padding:4px 8px; border-radius:999px;
  background:#e8dfd0; color:var(--ink); }
.badge.stop { background:#f3e0c8; color:var(--amber); }
"""


def page_shell(title: str, eyebrow: str, meta: str, body: str) -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>{CSS}</style></head><body><div class="page">
  <div class="mast"><div class="brand">City<span>Scroll</span></div>
    <div style="font-size:12px;color:var(--muted)">Bid Tabulations · recon</div></div>
  <div class="eyebrow">{eyebrow}</div>
  <h1>{title}</h1>
  <p class="meta">{meta}</p>
  {body}
</div></body></html>"""


def joined_html() -> str:
    c = next(x for x in CASES["cases"] if x["id"] == "joined-agency-prefix-solicitation")
    n, b = c["notice"], c["bid"]
    body = f"""
    <div class="panel">
      <h2>Strict join accepted</h2>
      <div class="row">
        <div class="card ok">
          <div class="label">City Record notice</div>
          <div class="val">{n['short_title']}</div>
          <div class="sub">PIN <code>{n['pin']}</code> · {n['type_of_notice_description']}<br>
          request_id {n['request_id']} · {n['start_date']}</div>
        </div>
        <div class="card ok">
          <div class="label">Bid tabulation 9k82-ys7w</div>
          <div class="val">{b['bidder_count']} bidders</div>
          <div class="sub">bid_number <code>{b['bid_number']}</code> · opened {b['bid_opening_date']}<br>
          method <code>{c['method']}</code></div>
        </div>
      </div>
      <p class="note">DCAS commodity PINs encode agency code <code>857</code> + 7-digit bid number.
      Sample bidders: {', '.join(b.get('sample_bidders') or [])}.</p>
    </div>"""
    return page_shell(
        "Historical join field case",
        "Joined · agency_prefix_bid_suffix",
        "PIN 8571600131 → bid_number 1600131 (AIR MATTRESS, 9 bidders).",
        body,
    )


def unjoined_html() -> str:
    c = next(x for x in CASES["cases"] if x["id"] == "unjoinable-modern-award")
    n = c["notice"]
    body = f"""
    <div class="panel">
      <h2>Modern notice · no bid tabulation row</h2>
      <div class="row">
        <div class="card gap">
          <div class="label">City Record notice</div>
          <div class="val">{n['short_title']}</div>
          <div class="sub">PIN <code>{n['pin']}</code> · {n['type_of_notice_description']}<br>
          request_id {n['request_id']} · {n['start_date']}</div>
        </div>
        <div class="card gap">
          <div class="label">Bid counts</div>
          <div class="val">Not yet shown here</div>
          <div class="sub">This lives in Bid Tabulations Historical (Open Data <code>9k82-ys7w</code>)
          when a strict PIN↔bid_number join exists. Openings in that dataset end 2021-03-24;
          measured modern join rate is 0%.</div>
        </div>
      </div>
      <p class="note">{c['gap_note']}</p>
    </div>"""
    return page_shell(
        "Modern unjoined field case",
        "Gap class (a) · not yet ingested",
        "Product universe notices since 2025-01-01 do not join this historical source under strict strategies.",
        body,
    )


def measurement_html() -> str:
    jm = RECEIPT["join_measurement"]
    rates = jm["rates"]
    rows = "".join(
        f"<tr><td>{label}</td><td>{r['joined']:,}</td><td>{r['total']:,}</td>"
        f"<td><strong>{r['rate']*100:.2f}%</strong></td></tr>"
        for label, r in [
            ("Modern product universe (≥2025-01-01)", rates["modern_notices_strict"]),
            ("Historical overlap (2016–2021)", rates["historical_notices_strict"]),
            ("Historical DCAS 857* PIN subset", rates["historical_857_prefix_subset"]),
        ]
    )
    body = f"""
    <div class="panel">
      <h2>Measured strict join coverage</h2>
      <p class="note" style="margin-top:0">Strategy: <code>exact</code> |
      <code>agency_prefix_bid_suffix</code>. Weak title-unique and digit-containment joins rejected.</p>
      <table class="table">
        <thead><tr><th>Universe</th><th>Joined</th><th>Total</th><th>Rate</th></tr></thead>
        <tbody>{rows}</tbody>
      </table>
      <p class="note"><span class="badge stop">Stop · below ~30%</span>
      {jm['verdict']}</p>
    </div>
    <div class="panel">
      <h2>Source freeze</h2>
      <div class="sub">57,704 rows · 945 bid numbers · openings 2016-01-05 → 2021-03-24 ·
      publisher Last-Modified 2023-09-16 · no PIN/EPIN column on <code>9k82-ys7w</code>.</div>
    </div>"""
    return page_shell(
        "Join usefulness measurement",
        "Reconnaissance · ship contract only",
        "Usefulness threshold ~30%. Rates are notice-side strict joins to Bid Tabulations Historical.",
        body,
    )


def capture(page, html: str, stem: str, files: list[dict]) -> None:
    page.set_content(html, wait_until="load")
    for w, h in VIEWPORTS:
        page.set_viewport_size({"width": w, "height": h})
        page.wait_for_timeout(80)
        name = f"{stem}-{w}.png"
        path = OUT / name
        page.screenshot(path=str(path), full_page=True)
        buf = path.read_bytes()
        files.append(
            {
                "name": name,
                "bytes": len(buf),
                "sha256": hashlib.sha256(buf).hexdigest(),
                "viewport": [w, h],
                "stem": stem,
            }
        )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    files: list[dict] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        capture(page, joined_html(), "joined-historical", files)
        capture(page, unjoined_html(), "unjoined-modern-gap", files)
        capture(page, measurement_html(), "measurement-stop", files)
        browser.close()

    manifest = {
        "schema_version": 1,
        "observed_on": "2026-07-30",
        "source_contract": "bid-tabulations-historical",
        "dataset_id": "9k82-ys7w",
        "files": files,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(files)} screenshots + manifest → {OUT}")


if __name__ == "__main__":
    main()
