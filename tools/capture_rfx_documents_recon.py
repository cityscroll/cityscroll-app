#!/usr/bin/env python3
"""Capture annotated screenshots for PASSPort RFx package-document join recon.

Deterministic HTML from the verification receipt — no live network fetch.
Output lands under docs/screenshots/rfx-documents-recon/ with a sha256
manifest for pin verification.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "rfx-documents-recon"
RECEIPT = json.loads(
    (
        ROOT
        / "site/data/passport_sources/verification_receipts"
        / "passport_rfx_documents_2026-07-30.json"
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
.badge { display:inline-block; font:700 11px/1 ui-sans-serif,system-ui,sans-serif;
  letter-spacing:.08em; text-transform:uppercase; padding:4px 8px; border-radius:999px;
  background:#e8dfd0; color:var(--ink); }
.badge.stop { background:#f3e0c8; color:var(--amber); }
.lc-docs-gap { border:1px dashed var(--rule); border-radius:8px; padding:12px 14px;
  background:#fff; font-size:14px; line-height:1.45; margin-top:8px; }
"""


def page_shell(title: str, eyebrow: str, meta: str, body: str) -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>{CSS}</style></head><body><div class="page">
  <div class="mast"><div class="brand">City<span>Scroll</span></div>
    <div style="font-size:12px;color:var(--muted)">RFx package docs · recon</div></div>
  <p class="eyebrow">{eyebrow}</p>
  <h1>{title}</h1>
  <p class="meta">{meta}</p>
  {body}
</div></body></html>"""


def kill_page() -> str:
    kill = RECEIPT["kill_criterion"]
    epin = kill["rfx_epin_join"]
    docs = kill["rfx_document_url_join"]
    modern = RECEIPT["join_measurement"]["rates"]["modern_solicitation_document_url"]
    ocp = RECEIPT["companion_fills"]["ocp_document_links_2025_plus"]
    body = f"""
    <div class="panel">
      <h2>Kill criterion · 50 open solicitations with PIN</h2>
      <div class="row">
        <div class="card ok">
          <div class="label">RFx EPIN join</div>
          <div class="val">{epin['joined']}/{epin['total']} · {epin['rate']*100:.0f}%</div>
          <div class="sub">Joining key works (exact EPIN↔PIN).</div>
        </div>
        <div class="card gap">
          <div class="label">RFx document URL join</div>
          <div class="val">{docs['joined']}/{docs['total']} · {docs['rate']*100:.0f}%</div>
          <div class="sub">public_rfx_data has no document URL columns. Threshold 30%.</div>
        </div>
      </div>
      <p class="note"><span class="badge stop">Stop</span>
        Below usefulness — no package-document edge materialization from the RFx dump.
        Modern universe document URL join also {modern['joined']}/{modern['total']} ({modern['rate']*100:.0f}%).
        OCP 2025+ document_links fill {ocp['joined']}/{ocp['total']}.</p>
    </div>
    <div class="panel">
      <h2>Reader-facing gap register (class b)</h2>
      <div class="lc-docs-gap">The city does not publish package documents as an open feed for this notice —
        they would appear in <a href="https://a856-cityrecord.nyc.gov/Search/GetFile">City Record file attachments</a>
        if released.</div>
      <p class="note">Pointer host: <code>a856-cityrecord.nyc.gov/Search/GetFile</code>
        (historical pre-2025 GetFile attachments still exist; modern fill is empty).</p>
    </div>
    """
    return page_shell(
        "PASSPort RFx package documents",
        "Measured recon · 2026-07-30",
        "Kill criterion failed at 0% document-URL join. Gap reclassified not_published.",
        body,
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    html = kill_page()
    (OUT / "recon.html").write_text(html)
    manifest = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for w, h in VIEWPORTS:
            page = browser.new_page(viewport={"width": w, "height": h})
            page.set_content(html, wait_until="load")
            name = f"rfx-docs-recon-{w}.png"
            path = OUT / name
            page.screenshot(path=str(path), full_page=True)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            manifest[name] = {
                "sha256": digest,
                "bytes": path.stat().st_size,
                "viewport": [w, h],
            }
            page.close()
        browser.close()
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"out": str(OUT), "frames": list(manifest)}, indent=2))


if __name__ == "__main__":
    main()
