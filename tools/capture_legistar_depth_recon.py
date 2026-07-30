#!/usr/bin/env python3
"""Capture annotated screenshots for Legistar depth join recon (authenticated).

Deterministic fixture HTML from test/fixtures/legistar/join_cases.json —
no live Legistar fetch. Output lands under docs/screenshots/legistar-depth-recon/
with a sha256 manifest.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "legistar-depth-recon"
CASES = json.loads((ROOT / "test/fixtures/legistar/join_cases.json").read_text())
RECEIPT = json.loads(
    (
        ROOT
        / "site/data/legistar_sources/verification_receipts"
        / "legistar_depth_2026-07-30.json"
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
.chain-h { font:700 12px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.12em;
  text-transform:uppercase; margin:14px 0 8px; }
"""


def page_shell(title: str, eyebrow: str, meta: str, body: str) -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>{CSS}</style></head><body><div class="page">
  <div class="mast"><div class="brand">City<span>Scroll</span></div>
    <div style="font-size:12px;color:var(--muted)">Legistar depth · authenticated</div></div>
  <div class="eyebrow">{eyebrow}</div>
  <h1>{title}</h1>
  <p class="meta">{meta}</p>
  {body}
</div></body></html>"""


def joined_html() -> str:
    c = next(x for x in CASES["cases"] if x["id"] == "joined-modern-landmarks-with-votes")
    n, m = c["notice"], c["meeting"]
    depth = m.get("depth_sample") or {}
    body = f"""
    <div class="panel">
      <h2>Strict event join + agenda/vote depth</h2>
      <div class="row">
        <div class="card ok">
          <div class="label">City Record notice</div>
          <div class="val">{n['short_title']}</div>
          <div class="sub">request_id <code>{n['request_id']}</code> · {n['event_date']}<br>
          agency {n['agency_name']}</div>
        </div>
        <div class="card ok">
          <div class="label">Legistar event (authenticated)</div>
          <div class="val">{m['EventBodyName']}</div>
          <div class="sub">EventId <code>{m['EventId']}</code> · method <code>{c['method']}</code><br>
          items {depth.get('items')} · matters {depth.get('matter_items')} · votes sampled {depth.get('votes_sampled')}</div>
        </div>
      </div>
      <div class="chain-h">Council meeting outcomes</div>
      <p class="note">Matched Council event: <b>{m['EventBodyName']}</b> ({n['event_date']}).
      Nested <code>EventItems</code> + <code>Votes</code> under <code>LEGISTAR_API_TOKEN</code>.</p>
      <p class="note">Demo frame deep link: <code>#notice/{n['request_id']}</code></p>
    </div>"""
    return page_shell(
        "Modern joined field case",
        "Joined · exact_date_body_tokens · votes present",
        f"request_id {n['request_id']} → EventId {m['EventId']} (Landmarks / Resiliency, 7 votes sampled).",
        body,
    )


def rejected_html() -> str:
    c = next(x for x in CASES["cases"] if x["id"] == "rejected-loose-zoning-land-use")
    n = c["notice"]
    body = f"""
    <div class="panel">
      <h2>Strict strategy rejects loose same-day body match</h2>
      <div class="row">
        <div class="card gap">
          <div class="label">City Record notice</div>
          <div class="val">{n['short_title']}</div>
          <div class="sub">request_id <code>{n['request_id']}</code> · {n['event_date']}</div>
        </div>
        <div class="card gap">
          <div class="label">Same-day Legistar body</div>
          <div class="val">Zoning and Franchises</div>
          <div class="sub">Not joined — “Land Use” is not “Franchises”. Date-only and loose token
          overlap are rejected to avoid false committee matches.</div>
        </div>
      </div>
      <p class="note">{c.get('gap_note') or ''}</p>
    </div>"""
    return page_shell(
        "Rejected weak join",
        "Strategy table · do not ship",
        "Useful modern coverage uses unique body-in-title matches only.",
        body,
    )


def measurement_html() -> str:
    jm = RECEIPT["join_measurement"]
    rates = jm["rates"]
    depth = jm["depth"]["modern"]
    rows = "".join(
        f"<tr><td>{label}</td><td>{r['joined']:,}</td><td>{r['total']:,}</td>"
        f"<td><strong>{r['rate']*100:.1f}%</strong></td></tr>"
        for label, r in [
            ("Modern product universe (≥2025-01-01)", rates["modern_notices_strict"]),
            ("Historical overlap (2019–2024)", rates["historical_notices_strict"]),
            ("Recent historical (2023–2024)", rates["historical_2023_2024_strict"]),
        ]
    )
    body = f"""
    <div class="panel">
      <h2>Authenticated strict join coverage</h2>
      <p class="note" style="margin-top:0">Strategy: <code>exact_date_body_tokens</code> on
      <code>webapi.legistar.com/v1/nyc/Events</code> with <code>LEGISTAR_API_TOKEN</code>.
      Unauthenticated: HTTP 403. Truncated first-segment token: HTTP 403.</p>
      <table class="table">
        <thead><tr><th>Universe</th><th>Joined</th><th>Total</th><th>Rate</th></tr></thead>
        <tbody>{rows}</tbody>
      </table>
      <p class="note"><span class="badge ok">Clear · above ~30%</span>
      Modern event join {rates['modern_notices_strict']['rate']*100:.0f}%. Depth on joined modern events:
      EventItems {depth.get('frac_with_items', 0)*100:.0f}% · matters {depth.get('frac_with_matters', 0)*100:.0f}% ·
      votes sampled {depth.get('frac_with_votes', 0)*100:.0f}%.</p>
    </div>
    <div class="panel">
      <h2>Follow-up ingest scope</h2>
      <div class="sub">Edge materialize Events → EventItems → Votes/Attachments with Worker secret
      <code>LEGISTAR_API_TOKEN</code> (Wrangler / GitHub Actions secret — not set in this recon PR).</div>
    </div>"""
    return page_shell(
        "Join usefulness measurement",
        "Authenticated recon · recommend materialization",
        jm["verdict"][:220] + ("…" if len(jm["verdict"]) > 220 else ""),
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
        capture(page, joined_html(), "joined-modern-votes", files)
        capture(page, rejected_html(), "rejected-loose-body", files)
        capture(page, measurement_html(), "measurement-clear", files)
        browser.close()

    # Remove obsolete stems from prior unauth recon if present
    for old in OUT.glob("*.png"):
        if old.name not in {f["name"] for f in files}:
            old.unlink(missing_ok=True)

    manifest = {
        "schema_version": 1,
        "observed_on": "2026-07-30",
        "source_contract": "nyc-council-legistar",
        "api_base": "https://webapi.legistar.com/v1/nyc/",
        "demo_frame_request_id": "20260706036",
        "files": files,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(files)} screenshots + manifest → {OUT}")


if __name__ == "__main__":
    main()
