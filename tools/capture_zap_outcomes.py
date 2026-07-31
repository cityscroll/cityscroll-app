#!/usr/bin/env python3
"""Capture annotated screenshots for ZAP land outcomes.

Deterministic fixture HTML from test/fixtures/zap_outcomes/join_cases.json and
parsed API payloads — no live network. Output under docs/screenshots/zap-outcomes/
with a sha256 manifest.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "zap-outcomes"
CASES = json.loads((ROOT / "test/fixtures/zap_outcomes/join_cases.json").read_text())
RECEIPT = json.loads(
    (
        ROOT
        / "site/data/zap_outcome_sources/verification_receipts"
        / "zap_api_outcomes_2026-07-30.json"
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
.badge.ok { background:#d7ebe2; color:var(--green); }
.action-chip { display:inline-block; padding:4px 8px; margin-right:4px; border:1px solid var(--rule);
  border-radius:999px; background:#f4efe5; font:700 11px/1 ui-monospace,monospace; }
details { margin-top:10px; }
summary { cursor:pointer; font-weight:700; }
"""


def page_shell(title: str, eyebrow: str, meta: str, body: str) -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>{CSS}</style></head><body><div class="page">
  <div class="mast"><div class="brand">City<span>Scroll</span></div>
    <div style="font-size:12px;color:var(--muted)">Land · ZAP outcomes</div></div>
  <div class="eyebrow">{eyebrow}</div>
  <h1>{title}</h1>
  <p class="meta">{meta}</p>
  {body}
</div></body></html>"""


def rates_html() -> str:
    r = RECEIPT["join_measurement"]["rates"]
    rows = "".join(
        f"<tr><td><code>{k}</code></td><td>{v['joined']}/{v['total']}</td>"
        f"<td><b>{v['rate']*100:.1f}%</b></td></tr>"
        for k, v in r.items()
    )
    return f"""
    <div class="panel">
      <h2>Measured join rates (2026-07-30)</h2>
      <table class="table">
        <tr><th>Metric</th><th>Joined</th><th>Rate</th></tr>
        {rows}
      </table>
      <p class="note"><span class="badge ok">Ship</span>
        {RECEIPT['join_measurement']['verdict']}</p>
    </div>"""


def joined_html() -> str:
    c = next(x for x in CASES["cases"] if x["id"] == "joined-timbale-terrace")
    od = c["open_data"]
    demo = RECEIPT["field_cases"]["demo_frame"]
    body = f"""
    <div class="panel">
      <h2>Strict project_id join · filled outcomes</h2>
      <div class="row">
        <div class="card ok">
          <div class="label">Open Data project</div>
          <div class="val">{od['project_name']}</div>
          <div class="sub">project_id <code>{od['project_id']}</code><br>
          {od['public_status']} · {od.get('borough','')} · ULURP {od.get('ulurp_numbers','')}</div>
        </div>
        <div class="card ok">
          <div class="label">ZAP API outcomes</div>
          <div class="val">Decision docs + approved actions</div>
          <div class="sub">exact_project_id · HA/PQ Approved · CB disposition votes<br>
          Document proxy: <code>/document/disposition/…</code></div>
        </div>
      </div>
      <p class="note">Deep link <code>{demo['deep_link']}</code> · portal
      <code>{demo['portal']}</code><br>{demo['why']}</p>
    </div>
    {rates_html()}
    """
    return page_shell(
        "Timbale Terrace — joined land outcomes",
        "Demo frame · 2022M0258",
        "Open Data status chips alone do not show decision PDFs or board votes. "
        "The worker joins the public ZAP project API by exact project_id.",
        body,
    )


def gap_html() -> str:
    body = f"""
    <div class="panel">
      <h2>Class-(a) gap copy when unjoined</h2>
      <div class="row">
        <div class="card gap">
          <div class="label">Not yet shown here</div>
          <div class="val">Final decision documents</div>
          <div class="sub">Not yet shown here — final decision documents and votes live in
          the Zoning Application Portal (ZAP). No decision documents or disposition votes
          were available for this project in the current join window.</div>
        </div>
        <div class="card gap">
          <div class="label">Rejected weak join</div>
          <div class="val">Title-only match</div>
          <div class="sub">project_name “Timbale Terrace” alone must not join a different
          <code>project_id</code>. Strict strategy: <code>exact_project_id</code> only.</div>
        </div>
      </div>
    </div>
    {rates_html()}
    """
    return page_shell(
        "Unjoined land outcome slot",
        "Two-register gap copy",
        "Empty slots name the public source (class a: not yet ingested / unmatched), "
        "never a blank or undifferentiated “unknown”.",
        body,
    )


def field_case_html() -> str:
    body = """
    <div class="panel">
      <h2>2024K0286 · grouped board disposition</h2>
      <div class="card ok">
        <div class="label">Community Board · April 14, 2026</div>
        <div style="margin:4px 0 8px"><span class="action-chip">ZM</span><span class="action-chip">ZR</span></div>
        <div class="val">Conditional Favorable</div>
        <div class="sub">28 for · 0 against · 0 abstaining</div>
        <details>
          <summary>Decision documents · 1 unique name</summary>
          <div class="sub" style="margin-top:8px">CB 1 Recommendation RE 200 Kent Avenue.pdf</div>
        </details>
        <details>
          <summary>Related DOB NOW filings on project tax lots</summary>
          <div class="sub" style="margin-top:8px">Collapsed until opened; long filing lists remain out of the primary reading path.</div>
        </details>
      </div>
      <p class="note">The ZAP API returned separate ZM and ZR rows with the same body, date, recommendation, and vote tally. The public card keeps both action codes while showing one board decision.</p>
    </div>
    """
    return page_shell(
        "200 Kent Avenue — no duplicate board card",
        "Field case · 2024K0286",
        "One Community Board vote, represented by two related land-use actions.",
        body,
    )


def capture(name: str, html: str, page, files: list) -> None:
    page.set_content(html, wait_until="load")
    for w, h in VIEWPORTS:
        page.set_viewport_size({"width": w, "height": h})
        page.wait_for_timeout(80)
        out = OUT / f"{name}-{w}.png"
        page.screenshot(path=str(out), full_page=True)
        buf = out.read_bytes()
        files.append(
            {
                "name": out.name,
                "bytes": len(buf),
                "sha256": hashlib.sha256(buf).hexdigest(),
                "viewport": [w, h],
            }
        )
        print("wrote", out.name, len(buf))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    files: list[dict] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        capture("joined-timbale", joined_html(), page, files)
        capture("unjoined-gap", gap_html(), page, files)
        capture("field-case-2024K0286", field_case_html(), page, files)
        browser.close()
    manifest = {
        "schema_version": 1,
        "feature": "zap-outcomes",
        "observed_on": RECEIPT["observed_on"],
        "demo_frame": RECEIPT["field_cases"]["demo_frame"],
        "files": files,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("manifest", len(files), "files")


if __name__ == "__main__":
    main()
