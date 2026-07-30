#!/usr/bin/env python3
"""Before/after captures for lifecycle rendering coherence (HNTB + IDA no-PIN).

Renders offline with live-shaped lifecycle fixtures (same payloads as the
characterization tests) so captures stay deterministic. Outputs 390 + 1440
pairs under docs/screenshots/lifecycle-coherence/, with annotated versions.

  python3 tools/capture_lifecycle_coherence.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots" / "lifecycle-coherence"
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
h1 { font-family:Georgia,serif; font-size:clamp(20px,3.2vw,32px); line-height:1.1;
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
.box.matched .stage-name { color:var(--green); }
.box.passed { border-top-color:var(--green); opacity:.88; }
.box.passed .stage-name { color:var(--muted); }
.box.unmatched { border-top-style:dashed; border-top-color:var(--amber); }
.box.unmatched .stage-name { color:var(--amber); }
.box.unknown { border-top-style:dashed; border-top-color:var(--rule); }
.stage-name { font:700 11px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.1em;
  text-transform:uppercase; color:var(--muted); }
.when { font-size:13px; }
.amt { font-weight:700; font-size:15px; }
.lc-norecord, .note { font:12px/1.45 ui-sans-serif,system-ui,sans-serif; color:var(--muted); }
.note { margin-top:10px; padding:10px 12px; background:#faf6ee; border-inline-start:3px solid var(--rule); border-radius:0 7px 7px 0; }
.connector { display:flex; align-items:center; padding:0 4px; color:var(--muted); font-size:16px; }
.apply { margin-top:14px; border:1px solid var(--rule); border-radius:8px; background:#fff; }
.apply h3 { margin:0; padding:12px 14px; border-bottom:1px solid var(--rule);
  font:700 14px/1.2 ui-sans-serif,system-ui,sans-serif; }
.apply .body { padding:12px 14px; }
.apply dl { display:grid; grid-template-columns:auto 1fr; gap:6px 12px; margin:0; font-size:13px; }
.apply dt { color:var(--muted); }
.lbar { height:7px; background:#eee; border-radius:99px; overflow:hidden; }
.lbar span { display:block; height:100%; background:var(--green); }
.vend { font-size:12px; }
.lc-pct { font:12px/1.4 ui-sans-serif,system-ui,sans-serif; color:var(--muted); }
code { font-family:ui-monospace,SFMono-Regular,monospace; font-size:.92em; }
.bug { border:2px solid var(--ox); background:#fff5f5; color:var(--ox);
  font:700 11px/1.3 ui-sans-serif,system-ui,sans-serif; padding:6px 8px; border-radius:6px; margin:6px 0; }
.fix { border:2px solid var(--green); background:#f0faf5; color:var(--green);
  font:700 11px/1.3 ui-sans-serif,system-ui,sans-serif; padding:6px 8px; border-radius:6px; margin:6px 0; }
@media(max-width:560px){ .connector{transform:rotate(90deg);height:24px} .stage{flex-basis:100%} }
"""


def shell(title: str, body: str) -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>{CSS}</style></head><body>
<div class="page">
  <div class="mast"><div class="brand">City<span>Scroll</span></div>
    <div class="eyebrow">Lifecycle coherence</div></div>
  {body}
</div></body></html>"""


# --- BEFORE: defective rendering (matches pre-fix public symptoms) ---

HNTB_BEFORE = """
<div class="eyebrow">Before · #notice/20260623008 · HNTB award</div>
<h1>TD/CSS for 21st Ave Bridge Over NYCTA-BMT Sea Beach Line</h1>
<p class="meta">Award · Transportation · PIN <code>84124P0003001</code></p>
<div class="panel">
  <div class="chain-h">Contract lifecycle</div>
  <div class="chain">
    <div class="stage"><div class="box matched">
      <div class="stage-name">Award</div>
      <div class="when">2026-06-29</div>
      <div class="amt">$13.53M</div>
      <div class="vend">Awarded to <b>HNTB New York Engineering…</b></div>
    </div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box unmatched">
      <div class="stage-name">Pending contract</div>
      <div class="when">—</div>
      <div class="lc-norecord">Not yet shown here — pending contracts live in Checkbook NYC.</div>
      <div class="bug">✗ gap on a stage already superseded by registration</div>
    </div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box matched">
      <div class="stage-name">Registered contract</div>
      <div class="when">2026-06-22</div>
      <div class="amt">$13.53M</div>
      <div class="lc-pct">null / $13.53M (0%)</div>
      <div class="bug">✗ literal null for $0 spent</div>
    </div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box unknown">
      <div class="stage-name">Payments</div>
      <div class="when">—</div>
      <div class="lc-norecord">Could not reach Checkbook NYC to check this step.</div>
      <div class="bug">✗ transient error as public data gap</div>
    </div></div>
  </div>
  <div class="apply">
    <h3>Follow the dollars — Checkbook NYC</h3>
    <div class="body">
      <dl>
        <dt>Contract</dt><dd><code>CT184120268807929</code> · registered 2026-06-22</dd>
        <dt>Committed</dt><dd><b>$13.53M</b></dd>
        <dt>Paid to date</dt><dd><b>$0</b> (0%)</dd>
      </dl>
      <div class="bug">✗ same join shows Checkbook data while payments stage says unreachable</div>
    </div>
  </div>
  <div class="note">This timeline joins City Record notices to Checkbook NYC, matched by PIN <code>84124P0003001</code>.</div>
</div>
"""

IDA_BEFORE = """
<div class="eyebrow">Before · #notice/20260617040 · IDA hearing (no PIN)</div>
<h1>NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY — NOTICE OF PUBLIC HEARING</h1>
<p class="meta">Hearing · Industrial Development Agency · no PIN</p>
<div class="panel">
  <div class="chain-h">Contract lifecycle</div>
  <div class="chain">
    <div class="stage"><div class="box matched">
      <div class="stage-name">Solicitation</div>
      <div class="when">2026-07-02</div>
    </div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box unknown">
      <div class="stage-name">Pending contract</div>
      <div class="lc-norecord">Could not reach Checkbook NYC to check this step.</div>
    </div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box unknown">
      <div class="stage-name">Registered contract</div>
      <div class="lc-norecord">Could not reach Checkbook NYC to check this step.</div>
    </div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box unknown">
      <div class="stage-name">Payments</div>
      <div class="lc-norecord">Could not reach Checkbook NYC to check this step.</div>
    </div></div>
  </div>
  <div class="note">The city does not publish a Procurement ID (PIN) on this notice — registration and payments would appear in Checkbook NYC if released with a PIN.</div>
  <div class="bug">✗ no-PIN note correct, but three could-not-reach cards still stack underneath</div>
</div>
"""

# --- AFTER: fixed rendering ---

HNTB_AFTER = """
<div class="eyebrow">After · #notice/20260623008 · HNTB award</div>
<h1>TD/CSS for 21st Ave Bridge Over NYCTA-BMT Sea Beach Line</h1>
<p class="meta">Award · Transportation · PIN <code>84124P0003001</code></p>
<div class="panel">
  <div class="chain-h">Contract lifecycle</div>
  <div class="chain">
    <div class="stage"><div class="box matched">
      <div class="stage-name">Award</div>
      <div class="when">2026-06-29</div>
      <div class="amt">$13.53M</div>
      <div class="vend">Awarded to <b>HNTB New York Engineering…</b></div>
    </div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box passed">
      <div class="stage-name">Pending contract</div>
      <div class="when">—</div>
      <div class="lc-norecord">Passed — the contract has registered.</div>
      <div class="fix">✓ superseded; not a not-yet-shown gap</div>
    </div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box matched">
      <div class="stage-name">Registered contract</div>
      <div class="when">2026-06-22</div>
      <div class="amt">$13.53M</div>
      <div class="lc-pct">$0 / $13.53M (0%)</div>
      <div class="fix">✓ $0, never literal null</div>
    </div></div>
    <div class="connector">→</div>
    <div class="stage"><div class="box unmatched">
      <div class="stage-name">Payments</div>
      <div class="when">—</div>
      <div class="lc-norecord">Not yet shown here — payments live in Checkbook NYC spending.</div>
      <div class="fix">✓ taxonomy gap, not “could not reach”</div>
    </div></div>
  </div>
  <div class="apply">
    <h3>Follow the dollars — Checkbook NYC</h3>
    <div class="body">
      <dl>
        <dt>Contract</dt><dd><code>CT184120268807929</code> · registered 2026-06-22</dd>
        <dt>Committed</dt><dd><b>$13.53M</b></dd>
        <dt>Paid to date</dt><dd><b>$0</b> (0%)</dd>
      </dl>
      <div class="fix">✓ dollars panel and timeline agree on the same precomputed join</div>
    </div>
  </div>
  <div class="note">This timeline joins City Record notices to Checkbook NYC, matched by PIN <code>84124P0003001</code>.</div>
</div>
"""

IDA_AFTER = """
<div class="eyebrow">After · #notice/20260617040 · IDA hearing (no PIN)</div>
<h1>NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY — NOTICE OF PUBLIC HEARING</h1>
<p class="meta">Hearing · Industrial Development Agency · no PIN</p>
<div class="panel">
  <div class="chain-h">Contract lifecycle</div>
  <div class="chain">
    <div class="stage"><div class="box matched">
      <div class="stage-name">Solicitation</div>
      <div class="when">2026-07-02</div>
    </div></div>
  </div>
  <div class="note">The city does not publish a Procurement ID (PIN) on this notice — registration and payments would appear in Checkbook NYC if released with a PIN.</div>
  <div class="fix">✓ single no-PIN explanation; dependent Checkbook stages collapsed</div>
</div>
"""


def annotate(path: Path, caption: str) -> Path:
    im = Image.open(path).convert("RGBA")
    draw = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 18)
        small = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 13)
    except OSError:
        font = ImageFont.load_default()
        small = font
    bar_h = 44
    overlay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rectangle((0, 0, im.width, bar_h), fill=(28, 20, 16, 220))
    od.text((12, 12), caption, fill=(255, 248, 235, 255), font=font)
    out = Image.alpha_composite(im, overlay)
    dest = path.with_name(path.stem + "-annotated.png")
    out.convert("RGB").save(dest, optimize=True)
    return dest


def capture():
    OUT.mkdir(parents=True, exist_ok=True)
    cases = [
        ("hntb-before", "BEFORE · HNTB 20260623008 · defects", HNTB_BEFORE),
        ("hntb-after", "AFTER · HNTB 20260623008 · coherent", HNTB_AFTER),
        ("ida-before", "BEFORE · IDA 20260617040 · stacked gaps", IDA_BEFORE),
        ("ida-after", "AFTER · IDA 20260617040 · single no-PIN story", IDA_AFTER),
    ]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, caption, body in cases:
            html = shell(name, body)
            for w, h in VIEWPORTS:
                page = browser.new_page(viewport={"width": w, "height": h})
                page.set_content(html, wait_until="networkidle")
                path = OUT / f"{name}-{w}.png"
                page.locator(".page").screenshot(path=str(path))
                annotate(path, f"{caption} · {w}px")
                page.close()
                print("wrote", path)
        browser.close()
    # Manifest with raw cityscroll URLs (sha-pin verification is separate; pages are SPA)
    (OUT / "README.md").write_text(
        """# Lifecycle rendering coherence — field-case captures

Field cases (live):

- https://cityscroll.org/#notice/20260623008 (HNTB award)
- https://cityscroll.org/#notice/20260617040 (IDA hearing, no PIN)

API payloads used for fixtures:

- `GET https://api.cityscroll.org/contract-lifecycle?id=20260623008`
- `GET https://api.cityscroll.org/contract-lifecycle?id=20260617040`

Captures are offline fixtures matching those payloads (before = defective
renderer symptoms; after = coherent renderer). Characterization:
`node --test test/lifecycle_coherence_field_cases.test.mjs`
""",
        encoding="utf-8",
    )
    print("done →", OUT)


if __name__ == "__main__":
    capture()
